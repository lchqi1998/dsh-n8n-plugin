/**
 * Agent tools: the model-facing surface over the same instance registry and
 * transport the Settings page uses. A workflow deployed from the GUI is
 * immediately operable by any agent, and vice versa.
 *
 * Instance CRUD is deliberately absent: agents may read the registry (aliases,
 * base URLs, masked keys) but only the user creates or edits an instance in the
 * GUI. This keeps an API key from being dictated through a conversation.
 *
 * This module returns plain tool definitions — the `defineTool()` wrapper from
 * `@deepseek-ai/dsh-tools` is applied in `./tools.js`.
 */

import { N8N_TOOL_NAMES } from './guidance.js'
import { delay, extractWebhookPaths } from './n8n.js'
import {
  renderClone,
  renderExecutions,
  renderExecutionCancel,
  renderInstances,
  renderTag,
  renderTagTable,
  renderWaitResult,
  renderWebhookCall,
  renderExecutionDetail,
  renderWorkflows,
  table,
  text,
} from './render.js'
import { validateWorkflow } from './workflow-validate.js'

/** The instance list tool. */
export function n8nInstancesTool(store) {
  return {
    name: 'n8n_instances',
    description: '列出已配置的 n8n 实例（别名、实例地址、掩码 API Key、默认标记）。别名是其他所有 n8n_* 工具指定目标实例的方式。实例只能由用户在 设置 → n8n 实例 中创建和修改，Agent 无权更改。',
    parameters: {
      query: { type: 'string', description: '可选。对别名、实例地址与备注做模糊匹配。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          instances: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          defaultAlias: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.instances.length === 0
        ? '尚未配置任何 n8n 实例——请用户在 设置 → n8n 实例 中添加'
        : renderInstances(value.instances) + (value.defaultAlias !== undefined ? `\n\n默认实例: ${value.defaultAlias}` : '')),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const instances = store.list()
        .map(entry => store.summarize(entry))
        .filter(instance => query === ''
          || instance.alias.toLowerCase().includes(query)
          || instance.baseUrl.toLowerCase().includes(query)
          || (instance.description ?? '').toLowerCase().includes(query))
      const defaultAlias = store.defaultAlias()
      return defaultAlias === undefined ? { instances } : { instances, defaultAlias }
    },
  }
}

/** The workflow list tool. */
export function n8nWorkflowsTool(client) {
  return {
    name: 'n8n_workflows',
    description: '列出某个实例上的 n8n 工作流（id、名称、发布状态、更新时间、标签）。用返回的 nextCursor 翻页。需要完整节点图时用 n8n_workflow_get。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      active: { type: 'boolean', description: '按发布（激活）状态过滤。' },
      name: { type: 'string', description: '按工作流名称精确过滤。' },
      tags: { type: 'array', items: { type: 'string' }, description: '按标签名过滤。' },
      limit: { type: 'integer', description: '每页数量（1-250，默认 100）。' },
      cursor: { type: 'string', description: '上一页返回的 nextCursor。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => text(renderWorkflows(value)),
    },
    async execute(args, exec) {
      return client.listWorkflows(args.alias, {
        limit: args.limit,
        cursor: args.cursor,
        active: args.active,
        name: args.name,
        tags: args.tags,
        signal: exec.signal,
      })
    },
  }
}

/** The full-workflow read tool. */
export function n8nWorkflowGetTool(client) {
  return {
    name: 'n8n_workflow_get',
    description: '完整读取一个 n8n 工作流（名称、节点、连线、设置、标签、发布状态）。更新工作流前先读取，保证未改动的字段原样保留。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '工作流 ID。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => text(`工作流 ${value.id ?? args.id}：${value.name ?? '（未命名）'} [${value.active === true ? '已发布' : '未发布'}]\n` + JSON.stringify(value, null, 2)),
    },
    async execute(args, exec) {
      return client.getWorkflow(args.alias, args.id, { signal: exec.signal })
    },
  }
}

/** The workflow create tool. */
export function n8nWorkflowCreateTool(client) {
  return {
    name: 'n8n_workflow_create',
    description: '用工作流 JSON 创建 n8n 工作流（名称、节点、连线、设置）。可用 publish:true 直接发布，或保持未发布状态、之后用 n8n_workflow_publish 发布。创建前先用 n8n_workflow_validate 校验 JSON。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      workflow: { type: 'json', required: true, description: '工作流文档：{name, nodes[], connections{}, settings{executionOrder:"v1"}}。' },
      publish: { type: 'boolean', description: '创建后立即发布（激活）（默认 false）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(`已创建工作流 ${value.id}：${value.name ?? ''}` + (value.publishError !== undefined ? `\n发布失败：${value.publishError}` : '')),
    },
    async execute(args, exec) {
      return client.createWorkflow(args.alias, args.workflow, { publish: args.publish === true, signal: exec.signal })
    },
  }
}

/** The workflow update tool. */
export function n8nWorkflowUpdateTool(client) {
  return {
    name: 'n8n_workflow_update',
    description: '用完整工作流文档更新既有 n8n 工作流（先用 n8n_workflow_get 读取，只改需要的部分，再发送完整文档）。可在同一次调用中发布或取消发布。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '工作流 ID。' },
      workflow: { type: 'json', required: true, description: '完整的工作流文档。' },
      publish: { type: 'boolean', description: '更新之后：true 发布，false 取消发布；省略则保持现状。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(`已更新工作流 ${value.id}：${value.name ?? ''} [${value.active === true ? '已发布' : '未发布'}]` + (value.publishError !== undefined ? `\n发布状态修改失败：${value.publishError}` : '')),
    },
    async execute(args, exec) {
      return client.updateWorkflow(args.alias, args.id, args.workflow, {
        publish: args.publish,
        signal: exec.signal,
      })
    },
  }
}

/** The workflow delete tool. */
export function n8nWorkflowDeleteTool(client) {
  return {
    name: 'n8n_workflow_delete',
    description: '永久删除一个 n8n 工作流。删除已发布的工作流会停掉它的触发器——调用前先向用户确认。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '工作流 ID。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { deleted: { type: 'boolean', required: true }, id: { type: 'string', required: true } },
      },
      render: (_args, value) => text(`已删除工作流 ${value.id}`),
    },
    async execute(args, exec) {
      return client.deleteWorkflow(args.alias, args.id, { signal: exec.signal })
    },
  }
}

/** The publish / unpublish tool. */
export function n8nWorkflowPublishTool(client) {
  return {
    name: 'n8n_workflow_publish',
    description: '发布（激活）或取消发布（停用）一个 n8n 工作流。发布会启动它的触发器（webhook/定时）——先向用户确认。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '工作流 ID。' },
      publish: { type: 'boolean', required: true, description: 'true 发布（激活）；false 取消发布（停用）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => text(`工作流 ${value.id ?? args.id}：${args.publish ? '已发布' : '已取消发布'} [${value.active === true ? '已发布' : '未发布'}]`),
    },
    async execute(args, exec) {
      return client.setPublished(args.alias, args.id, args.publish, { signal: exec.signal })
    },
  }
}

/** The offline validation tool. */
export function n8nWorkflowValidateTool() {
  return {
    name: 'n8n_workflow_validate',
    description: '创建/更新之前离线校验工作流 JSON。四类检查：① 结构（name/nodes/connections/settings、id 与名称唯一、连线指向真实节点、executionOrder、webhook 响应配对）；② 常见节点参数（webhook/scheduleTrigger/code/httpRequest/set/IF/Respond to Webhook）；③ 拓扑（触发器、可达性、IF 第二输出、SplitInBatches 接线、循环、AI Agent 模型连接）；④ 表达式（{{ }} 配对、= 前缀）。不访问任何实例。',
    parameters: {
      workflow: { type: 'json', required: true, description: '要校验的工作流文档。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => text([
        value.valid ? '校验通过' : '校验未通过',
        ...value.errors.map(error => '错误：' + error),
        ...value.warnings.map(warning => '警告：' + warning),
      ].join('\n')),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return validateWorkflow(args.workflow)
    },
  }
}

/** The workflow clone tool. */
export function n8nWorkflowCloneTool(client) {
  return {
    name: 'n8n_workflow_clone',
    description: '克隆一个 n8n 工作流：复制节点、连线、设置与（默认）标签，生成一个新的未发布工作流。name 可指定副本名称（默认「原名（副本）」）；copyTags:false 不复制标签；publish:true 克隆后立即发布（会启动触发器，先向用户确认）。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '要克隆的工作流 ID。' },
      name: { type: 'string', description: '副本名称（默认「<原名>（副本）」）。' },
      copyTags: { type: 'boolean', description: '是否把源工作流的标签复制到副本（默认 true）。' },
      publish: { type: 'boolean', description: '克隆后立即发布副本（默认 false）。发布会启动 webhook/定时触发器——先向用户确认。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderClone(value)),
    },
    async execute(args, exec) {
      const result = await client.cloneWorkflow(args.alias, args.id, {
        name: args.name,
        copyTags: args.copyTags !== false,
        publish: args.publish === true,
        signal: exec.signal,
      })
      const warnings = []
      if (result.source?.active === true && result.active !== true) {
        warnings.push('源工作流已发布，副本保持未发布')
      }
      const hooks = extractWebhookPaths(result).map(hook => hook.path)
      if (hooks.length > 0) {
        warnings.push(`副本含 Webhook 触发器（${hooks.join('、')}）；发布副本前建议先改 path，否则会与源工作流争用同一路径`)
      }
      return warnings.length === 0 ? result : { ...result, warnings }
    },
  }
}

/**
 * Resolve tag names to ids against the instance's tag registry. An unknown name
 * fails the call with the available names, so the model can correct it instead
 * of creating a near-duplicate tag.
 */
async function resolveTagIds(client, alias, names, signal) {
  const tags = await client.listAllTags(alias, { signal })
  const byName = new Map()
  for (const tag of tags) {
    if (typeof tag?.name === 'string') byName.set(tag.name, String(tag.id))
  }
  const ids = []
  const missing = []
  for (const name of names) {
    const id = byName.get(name)
    if (id === undefined) missing.push(name)
    else if (!ids.includes(id)) ids.push(id)
  }
  if (missing.length > 0) {
    const available = tags.map(tag => tag?.name).filter(name => typeof name === 'string')
    throw new Error(`标签不存在：${missing.join('、')}${available.length > 0 ? `；可用标签：${available.join('、')}` : '；当前实例还没有任何标签（先用 n8n_tag_create 创建）'}`)
  }
  return ids
}

/** The workflow-tags tool: read or replace one workflow's tags. */
export function n8nWorkflowTagsTool(client) {
  return {
    name: 'n8n_workflow_tags',
    description: '读取或替换一个 n8n 工作流的标签。action:"get" 列出当前标签；action:"set" 用 tagIds 或 tagNames 整体替换（先用 n8n_tags 查 id；空数组表示清空）。工作流文档里的 tags 字段是只读的，改标签必须用本工具（PUT /workflows/{id}/tags）。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '工作流 ID。' },
      action: { type: 'string', required: true, enum: ['get', 'set'], description: 'get 读取标签；set 整体替换标签。' },
      tagIds: { type: 'array', items: { type: 'string' }, description: 'set 时的标签 id 列表（与 tagNames 二选一）。' },
      tagNames: { type: 'array', items: { type: 'string' }, description: 'set 时的标签名列表（自动解析为 id，与 tagIds 二选一）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (args, value) => text(args.action === 'set'
        ? (value.data.length === 0
            ? `工作流 ${args.id} 的标签已清空`
            : `工作流 ${args.id} 的标签已更新：${value.data.map(tag => tag.name ?? tag.id).join('、')}`)
        : renderTagTable(value.data)),
    },
    async execute(args, exec) {
      if (args.action === 'get') {
        return client.getWorkflowTags(args.alias, args.id, { signal: exec.signal })
      }
      const ids = Array.isArray(args.tagIds) ? args.tagIds.map(String) : undefined
      const names = Array.isArray(args.tagNames) ? args.tagNames.map(String) : undefined
      if (ids !== undefined && names !== undefined) throw new Error('tagIds 与 tagNames 只能二选一')
      let resolved = ids
      if (resolved === undefined) {
        if (names === undefined) throw new Error('action:"set" 需要 tagIds 或 tagNames（传空数组表示清空标签）')
        resolved = await resolveTagIds(client, args.alias, names, exec.signal)
      }
      return client.setWorkflowTags(args.alias, args.id, resolved, { signal: exec.signal })
    },
  }
}

/** The executions list tool. */
export function n8nExecutionsTool(client) {
  return {
    name: 'n8n_executions',
    description: '列出 n8n 执行记录（id、工作流、状态、模式、起止时间）。可按工作流 ID 或状态过滤，用于排查运行历史。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      workflowId: { type: 'string', description: '只看该工作流的执行记录。' },
      status: { type: 'string', enum: ['success', 'error', 'waiting', 'canceled', 'crashed', 'new', 'running'], description: '只看该状态的执行记录。' },
      limit: { type: 'integer', description: '每页数量（1-250，默认 100）。' },
      cursor: { type: 'string', description: '上一页返回的 nextCursor。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => text(renderExecutions(value)),
    },
    async execute(args, exec) {
      return client.listExecutions(args.alias, {
        limit: args.limit,
        cursor: args.cursor,
        workflowId: args.workflowId,
        status: args.status,
        signal: exec.signal,
      })
    },
  }
}

/** The execution read tool (includes run data by default). */
export function n8nExecutionGetTool(client) {
  return {
    name: 'n8n_execution_get',
    description: '读取一条 n8n 执行记录，默认附带数据（每个节点的输入/输出）。先用 n8n_executions 找到 id。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '执行记录 ID。' },
      includeData: { type: 'boolean', description: '是否附带执行数据（默认 true）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => text(renderExecutionDetail(value)),
    },
    async execute(args, exec) {
      return client.getExecution(args.alias, args.id, { includeData: args.includeData !== false, signal: exec.signal })
    },
  }
}

/** The execution cancel tool: stop a running execution. */
export function n8nExecutionCancelTool(client) {
  return {
    name: 'n8n_execution_cancel',
    description: '取消（停止）一条正在运行的 n8n 执行：立即中止其后续节点，最终状态为 canceled。已结束的执行会原样返回其状态、无需取消。取消会中断正在进行的业务处理——操作前先向用户确认。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '执行记录 ID（来自 n8n_executions 或 n8n_webhook_call）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => text(renderExecutionCancel({ ...value, id: value?.id ?? args.id })),
    },
    async execute(args, exec) {
      return client.stopExecution(args.alias, args.id, { signal: exec.signal })
    },
  }
}

/** The wait-for-execution tool: poll one execution until it settles. */
export function n8nWaitExecutionTool(client) {
  return {
    name: 'n8n_wait_execution',
    description: '轮询等待一条 n8n 执行记录结束（success/error/canceled/crashed 即返回；waiting 视为已挂起立即返回）。适合在 n8n_webhook_call 触发「立即响应」的工作流后等待其跑完。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '执行记录 ID（来自 n8n_executions 或 n8n_webhook_call）。' },
      timeoutMs: { type: 'integer', description: '最长等待毫秒数（默认 60000，上限 600000）。' },
      pollMs: { type: 'integer', description: '轮询间隔毫秒数（默认 2000，最小 500）。' },
      includeData: { type: 'boolean', description: '结束时是否附带各节点执行数据（默认 true）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderWaitResult(value)),
    },
    async execute(args, exec) {
      return client.waitExecution(args.alias, args.id, {
        timeoutMs: args.timeoutMs,
        pollMs: args.pollMs,
        includeData: args.includeData !== false,
        signal: exec.signal,
      })
    },
  }
}

/**
 * Find the execution a webhook trigger just created: list the workflow's
 * recent executions, pick the first id that was not in the pre-call snapshot.
 * Bounded so a slow-to-index instance cannot stall the tool.
 */
async function findNewExecution(client, alias, workflowId, before, { budgetMs, signal }) {
  const started = Date.now()
  for (;;) {
    const page = await client.listExecutions(alias, { workflowId, limit: 20, includeData: false, signal }).catch(() => null)
    const fresh = (Array.isArray(page?.data) ? page.data : []).find(item => !before.has(String(item.id)))
    if (fresh !== undefined) return { id: String(fresh.id), searchedMs: Date.now() - started }
    if (Date.now() - started >= budgetMs) return null
    await delay(1_000, signal)
  }
}

/** The on-demand run tool: call a workflow's Webhook trigger, optionally waiting for the run. */
export function n8nWebhookCallTool(client) {
  return {
    name: 'n8n_webhook_call',
    description: '通过 Webhook 触发器手动运行一个 n8n 工作流：自动定位工作流里的 Webhook 节点并请求其 URL（无需 n8n_run API），默认等待本次执行结束并返回逐节点结构化结果。生产 URL 要求工作流已发布；mode:"test" 走测试 URL（需编辑器正在监听测试事件）。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '工作流 ID（用于定位 Webhook 节点与跟踪执行）。' },
      path: { type: 'string', description: 'Webhook 路径。省略时自动取工作流里唯一的 Webhook 节点；有多个节点时必填。' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP 方法（默认取节点 httpMethod，再默认 GET）。' },
      query: { type: 'json', description: '查询参数（JSON 对象）。' },
      body: { type: 'json', description: 'JSON 请求体（POST/PUT/PATCH 等；GET/HEAD 不支持）。' },
      mode: { type: 'string', enum: ['production', 'test'], description: 'production 请求 /webhook/{path}（默认），test 请求 /webhook-test/{path}。' },
      waitForCompletion: { type: 'boolean', description: '触发后等待本次执行结束再返回（默认 true）。' },
      waitTimeoutMs: { type: 'integer', description: '等待执行结束的最长毫秒数（默认 60000，上限 300000）。' },
      includeData: { type: 'boolean', description: '结束时是否附带各节点执行数据（默认 true）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderWebhookCall(value)),
    },
    async execute(args, exec) {
      const workflow = await client.getWorkflow(args.alias, args.id, { signal: exec.signal })
      const hooks = extractWebhookPaths(workflow)
      let target
      if (typeof args.path === 'string' && args.path !== '') {
        const clean = args.path.replace(/^\/+/, '')
        target = hooks.find(hook => hook.path === args.path || hook.path === clean) ?? { path: clean, method: 'GET' }
      } else {
        if (hooks.length === 0) {
          throw new Error('该工作流没有 Webhook 触发器节点——请先添加 n8n-nodes-base.webhook 节点并设置 path 参数')
        }
        if (hooks.length > 1) {
          throw new Error(`该工作流有多个 Webhook 节点（${hooks.map(hook => hook.path).join('、')}）——请用 path 参数指定要调用的那个`)
        }
        target = hooks[0]
      }
      if (target.path.startsWith('=')) {
        throw new Error(`Webhook path 是表达式（${target.path}）——请用 path 参数显式给出解析后的路径`)
      }
      const mode = args.mode === 'test' ? 'test' : 'production'
      const method = String(args.method ?? target.method ?? 'GET').toUpperCase()
      const waitForCompletion = args.waitForCompletion !== false
      const warnings = []
      if (workflow.active !== true && mode === 'production') {
        warnings.push('工作流未发布——生产 URL 通常返回 404；可先 n8n_workflow_publish 发布，或改用 mode:"test"（需编辑器正在监听测试事件）')
      }
      const before = new Set()
      if (waitForCompletion) {
        const page = await client.listExecutions(args.alias, { workflowId: String(args.id), limit: 20, includeData: false, signal: exec.signal }).catch(() => ({ data: [] }))
        for (const item of page.data) before.add(String(item.id))
      }
      const response = await client.callWebhook(args.alias, {
        path: target.path,
        method,
        mode,
        query: args.query,
        body: args.body,
        signal: exec.signal,
      })
      const value = {
        workflow: { id: workflow.id ?? args.id, name: workflow.name, active: workflow.active === true },
        webhook: { path: target.path, method, mode, url: response.url },
        response: { status: response.status, ok: response.ok, contentType: response.contentType, durationMs: response.durationMs, body: response.body },
        warnings,
      }
      if (!response.ok) {
        warnings.push(`Webhook 返回 HTTP ${response.status}，未等待执行`)
        return value
      }
      if (!waitForCompletion) return value
      const waitTimeoutMs = Math.min(Math.max(args.waitTimeoutMs ?? 60_000, 1_000), 300_000)
      const found = await findNewExecution(client, args.alias, String(args.id), before, {
        budgetMs: Math.min(15_000, waitTimeoutMs),
        signal: exec.signal,
      })
      if (found === null) {
        warnings.push('未能从执行列表定位本次触发的执行记录（可能延迟入列）；响应体若已含结果可直接使用，或稍后用 n8n_executions 查询')
        return value
      }
      const wait = await client.waitExecution(args.alias, found.id, {
        timeoutMs: Math.max(1_000, waitTimeoutMs - found.searchedMs),
        pollMs: 2_000,
        includeData: args.includeData !== false,
        signal: exec.signal,
      })
      value.execution = wait.execution
      value.wait = { waitedMs: found.searchedMs + wait.waitedMs, timedOut: wait.timedOut }
      return value
    },
  }
}

/** The tags list tool. */
export function n8nTagsTool(client) {
  return {
    name: 'n8n_tags',
    description: '列出 n8n 实例上定义的标签。更新工作流的 tags 数组时用的是标签 id。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      limit: { type: 'integer', description: '每页数量（1-250，默认 100）。' },
      cursor: { type: 'string', description: '上一页返回的 nextCursor。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => text(table(
        ['ID', '名称'],
        value.data.map(tag => [tag.id, tag.name]),
      )),
    },
    async execute(args, exec) {
      return client.listTags(args.alias, { limit: args.limit, cursor: args.cursor, signal: exec.signal })
    },
  }
}

/** The tag create tool. */
export function n8nTagCreateTool(client) {
  return {
    name: 'n8n_tag_create',
    description: '在 n8n 实例上创建一个标签（名称需唯一，最多 24 个字符——n8n 的存储上限）。给工作流打标签用 n8n_workflow_tags；可用返回的 id 或名称指定标签。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      name: { type: 'string', required: true, description: '标签名称。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(`已创建标签 ${value.id}：${value.name}`),
    },
    async execute(args, exec) {
      const tag = await client.createTag(args.alias, args.name, { signal: exec.signal })
      return { id: String(tag.id), name: tag.name }
    },
  }
}

/** The tag rename tool. */
export function n8nTagUpdateTool(client) {
  return {
    name: 'n8n_tag_update',
    description: '重命名一个已有的 n8n 标签（按标签 id，最多 24 个字符）。改名会立即反映到所有引用该标签的工作流上。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '标签 ID（来自 n8n_tags）。' },
      name: { type: 'string', required: true, description: '新的标签名称。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (args, value) => text(`已重命名标签 ${value.id}：${value.name ?? args.name}`),
    },
    async execute(args, exec) {
      const tag = await client.updateTag(args.alias, args.id, args.name, { signal: exec.signal })
      return { id: String(tag?.id ?? args.id), name: tag?.name ?? args.name }
    },
  }
}

/** The tag delete tool. */
export function n8nTagDeleteTool(client) {
  return {
    name: 'n8n_tag_delete',
    description: '永久删除一个 n8n 标签（按 id）：该标签会从所有工作流上移除，工作流本身不受影响。删除前先向用户确认。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      id: { type: 'string', required: true, description: '标签 ID（来自 n8n_tags）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          name: { type: 'string' },
        },
      },
      render: (_args, value) => text(`已删除标签 ${value.id}${typeof value.name === 'string' ? `：${value.name}` : ''}`),
    },
    async execute(args, exec) {
      return client.deleteTag(args.alias, args.id, { signal: exec.signal })
    },
  }
}

/** The credentials list tool. */
export function n8nCredentialsTool(client) {
  return {
    name: 'n8n_credentials',
    description: '列出 n8n 实例上已配置的凭据名称与类型（仅 id——API 不会返回密钥值）。节点需要凭据时先在此确认。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      limit: { type: 'integer', description: '每页数量（1-250，默认 100）。' },
      cursor: { type: 'string', description: '上一页返回的 nextCursor。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => text(table(
        ['ID', '名称', '类型'],
        value.data.map(credential => [credential.id, credential.name, credential.type]),
      )),
    },
    async execute(args, exec) {
      return client.listCredentials(args.alias, { limit: args.limit, cursor: args.cursor, signal: exec.signal })
    },
  }
}

/** The raw-request escape hatch. */
export function n8nApiTool(client) {
  return {
    name: 'n8n_api',
    description: '发送任意一个 n8n 公共 API v1 请求（路径相对于 /api/v1，如 "/workflows"、"/workflows/{id}"、"/executions"）。命名工具未覆盖的端点（如节点类型、实例元数据）用它。',
    parameters: {
      alias: { type: 'string', required: true, description: '实例别名（来自 n8n_instances）。' },
      method: { type: 'string', required: true, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP 方法。' },
      path: { type: 'string', required: true, description: '/api/v1 下的路径，以 "/" 开头。' },
      query: { type: 'json', description: '查询参数（JSON 对象）。' },
      body: { type: 'json', description: 'JSON 请求体（用于 POST/PUT/PATCH）。' },
      timeoutMs: { type: 'integer', description: '超时毫秒数（默认 30000）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => text(JSON.stringify(value, null, 2)),
    },
    async execute(args, exec) {
      if (!args.path.startsWith('/')) throw new Error('path 必须以 "/" 开头')
      return client.raw(args.alias, {
        method: args.method,
        path: args.path,
        query: args.query,
        body: args.body,
        timeoutMs: args.timeoutMs,
        signal: exec.signal,
      })
    },
  }
}

/**
 * Every tool this plugin registers, in list order, as plain definitions.
 * @param deps - the instance store and the n8n client.
 */
export function toolSpecs({ store, client }) {
  return [
    n8nInstancesTool(store),
    n8nWorkflowsTool(client),
    n8nWorkflowGetTool(client),
    n8nWorkflowCreateTool(client),
    n8nWorkflowUpdateTool(client),
    n8nWorkflowDeleteTool(client),
    n8nWorkflowPublishTool(client),
    n8nWorkflowValidateTool(),
    n8nWorkflowCloneTool(client),
    n8nWorkflowTagsTool(client),
    n8nExecutionsTool(client),
    n8nExecutionGetTool(client),
    n8nExecutionCancelTool(client),
    n8nWaitExecutionTool(client),
    n8nWebhookCallTool(client),
    n8nTagsTool(client),
    n8nTagCreateTool(client),
    n8nTagUpdateTool(client),
    n8nTagDeleteTool(client),
    n8nCredentialsTool(client),
    n8nApiTool(client),
  ]
}

export { N8N_TOOL_NAMES }