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
import { renderExecutions, renderInstances, renderWorkflows, table, text } from './render.js'
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
    description: '创建/更新之前离线校验工作流 JSON（节点 id 与名称唯一、连线指向真实节点、webhook 响应模式、executionOrder）。不访问任何实例。',
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
      render: (args, value) => text(JSON.stringify(value, null, 2)),
    },
    async execute(args, exec) {
      return client.getExecution(args.alias, args.id, { includeData: args.includeData !== false, signal: exec.signal })
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
    n8nExecutionsTool(client),
    n8nExecutionGetTool(client),
    n8nTagsTool(client),
    n8nCredentialsTool(client),
    n8nApiTool(client),
  ]
}

export { N8N_TOOL_NAMES }