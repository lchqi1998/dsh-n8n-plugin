/**
 * Offline workflow-JSON validation: everything worth checking before the
 * document is sent to the instance, without a node-type catalogue dependency
 * and without touching the network. Four passes:
 *
 *  1. Structure  — top-level shape, per-node fields, duplicate ids/names,
 *                  connection shape and dangling references, executionOrder,
 *                  webhook responseNode pairing.
 *  2. Parameters — a light per-type catalogue for the nodes that fail most
 *                  often when written by hand (webhook, scheduleTrigger, code,
 *                  httpRequest, set, if, respondToWebhook, AI agent).
 *  3. Graph      — trigger presence, reachability from triggers, unwired
 *                  branch outputs, SplitInBatches loop wiring, orphan nodes,
 *                  agent nodes without a language model, cycles.
 *  4. Expressions— every `{{ … }}` occurrence inside parameters: balanced
 *                  braces, non-empty body, and the `=`-prefix rule (a string
 *                  that is not prefixed with `=` is NOT evaluated by n8n).
 *
 * The result shape is stable: `{ valid, errors, warnings }` — errors block,
 * warnings advise. All messages are user-facing Chinese.
 */

/** Node types that can start an execution — any of them seeds the reachability pass. */
const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  '@n8n/n8n-nodes-langchain.chatTrigger',
])

/** Branch node types whose outputs are indexed from 0 and easy to leave unwired. */
const BRANCH_TYPES = new Set([
  'n8n-nodes-base.if',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.switch',
])

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const WEBHOOK_RESPONSE_MODES = new Set(['onReceived', 'lastNode', 'responseNode'])
const CODE_MODES = new Set(['runOnceForAllItems', 'runOnceForEachItem'])

/** Node parameters whose string values are code, not expressions — exempt from the lint. */
const EXPRESSION_EXEMPT_KEYS = new Set(['jsCode', 'pythonCode'])

/** Short quoted preview of a value for error messages. */
function snippet(value) {
  const text = String(value)
  return `'${text.length > 60 ? text.slice(0, 57) + '…' : text}'`
}

/**
 * Validate one workflow document.
 * @param workflow - the candidate JSON.
 * @returns structural errors and non-fatal warnings.
 */
export function validateWorkflow(workflow) {
  const errors = []
  const warnings = []
  if (typeof workflow !== 'object' || workflow === null || Array.isArray(workflow)) {
    return { valid: false, errors: ['workflow 必须是 JSON 对象'], warnings }
  }
  if (typeof workflow.name !== 'string' || workflow.name.trim() === '') {
    errors.push('缺少 name（工作流名称）')
  }
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    errors.push('nodes 必须是非空数组')
    return { valid: false, errors, warnings }
  }

  // ── Pass 1: structure ────────────────────────────────────────────────────

  const ids = new Set()
  const names = new Set()
  workflow.nodes.forEach((node, index) => {
    const label = `nodes[${index}]`
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      errors.push(`${label} 必须是对象`)
      return
    }
    if (typeof node.id !== 'string' || node.id.trim() === '') errors.push(`${label}.id 必填`)
    else if (ids.has(node.id)) errors.push(`节点 id 重复：'${node.id}'`)
    else ids.add(node.id)

    if (typeof node.name !== 'string' || node.name.trim() === '') errors.push(`${label}.name 必填`)
    else if (names.has(node.name)) errors.push(`节点名称重复：'${node.name}'（名称必须唯一——connections 以名称为键）`)
    else names.add(node.name)

    if (typeof node.type !== 'string' || node.type.trim() === '') errors.push(`${label}.type 必填`)
    if (typeof node.typeVersion !== 'number' || !Number.isFinite(node.typeVersion)) errors.push(`${label}.typeVersion 必须是数字`)
    if (!Array.isArray(node.position) || node.position.length < 2 || node.position.some(value => typeof value !== 'number')) {
      errors.push(`${label}.position 必须是 [x, y] 数字数组`)
    }
    if (node.parameters !== undefined && (typeof node.parameters !== 'object' || node.parameters === null || Array.isArray(node.parameters))) {
      errors.push(`${label}.parameters 必须是对象`)
    }
  })

  if (workflow.connections !== undefined) {
    if (typeof workflow.connections !== 'object' || workflow.connections === null || Array.isArray(workflow.connections)) {
      errors.push('connections 必须是以源节点名称为键的对象')
    } else {
      for (const [source, outputs] of Object.entries(workflow.connections)) {
        if (!names.has(source)) {
          errors.push(`connections 引用了源节点 '${source}'，但它不是本工作流中的节点名称`)
          continue
        }
        // n8n shape: { "<node>": { "main": [[{node,type,index}]], "<otherOutput>": [...] } }
        if (typeof outputs !== 'object' || outputs === null || Array.isArray(outputs)) {
          errors.push(`connections['${source}'] 必须是以输出类型为键的对象（如 {"main": [[...]]}）`)
          continue
        }
        for (const [outputType, branches] of Object.entries(outputs)) {
          if (!Array.isArray(branches)) {
            errors.push(`connections['${source}']['${outputType}'] 必须是输出分支数组`)
            continue
          }
          branches.forEach((branch, branchIndex) => {
            const where = `connections['${source}']['${outputType}'][${branchIndex}]`
            if (branch === null) return
            if (!Array.isArray(branch)) {
              errors.push(`${where} 必须是数组或 null`)
              return
            }
            for (const link of branch) {
              if (typeof link !== 'object' || link === null) {
                errors.push(`${where} 中包含非对象链接项`)
                continue
              }
              if (typeof link.node !== 'string' || !names.has(link.node)) {
                errors.push(`${where} 指向 '${String(link.node)}'，但它不是本工作流中的节点名称`)
              }
              if (link.type !== undefined && typeof link.type !== 'string') {
                errors.push(`${where}.type 必须是字符串`)
              }
              if (link.index !== undefined && (!Number.isInteger(link.index) || link.index < 0)) {
                errors.push(`${where}.index 必须是非负整数`)
              }
              if (link.node === source) {
                warnings.push(`connections['${source}'] 把节点连接到了自身——请确认这是有意的`)
              }
            }
          })
        }
      }
    }
  }

  if (workflow.settings !== undefined && (typeof workflow.settings !== 'object' || workflow.settings === null || Array.isArray(workflow.settings))) {
    errors.push('settings 必须是对象')
  } else if (workflow.settings?.executionOrder !== 'v1') {
    warnings.push('settings.executionOrder 建议设为 "v1"（当前 n8n 的执行顺序）')
  }

  const nodes = workflow.nodes.filter(node => typeof node === 'object' && node !== null && typeof node.name === 'string')
  const types = new Set(nodes.map(node => node.type))
  const connections = workflow.connections ?? {}

  // ── Pass 2: per-node parameter catalogue ─────────────────────────────────

  workflow.nodes.forEach((node, index) => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return
    const label = `节点 '${node.name ?? node.id ?? `nodes[${index}]`}'（${node.type ?? '未知类型'}）`
    checkNodeParameters(node, label, errors, warnings)
    checkNameHygiene(node, warnings)
  })

  // webhook responseNode must be answered by a responder node.
  for (const node of nodes) {
    if (node.type === 'n8n-nodes-base.webhook' && node.parameters?.responseMode === 'responseNode' && !types.has('n8n-nodes-base.respondToWebhook')) {
      errors.push(`webhook 节点 '${node.name}' 使用 responseMode "responseNode"，但工作流中没有 Respond to Webhook 节点`)
    }
  }

  // ── Pass 3: graph analysis ───────────────────────────────────────────────

  checkGraph(nodes, connections, errors, warnings)

  // ── Pass 4: expression lint ──────────────────────────────────────────────

  checkExpressions(workflow.nodes, errors, warnings)

  return { valid: errors.length === 0, errors, warnings }
}

/** Per-type parameter checks for the node types most often misconfigured by hand. */
function checkNodeParameters(node, label, errors, warnings) {
  const params = node.parameters ?? {}
  switch (node.type) {
    case 'n8n-nodes-base.webhook': {
      if (typeof params.path !== 'string' || params.path.trim() === '') errors.push(`${label} 的 path 不能为空`)
      if (params.httpMethod !== undefined && !HTTP_METHODS.has(String(params.httpMethod).toUpperCase())) {
        errors.push(`${label} 的 httpMethod 非法：${snippet(params.httpMethod)}（应为 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS）`)
      }
      if (params.responseMode !== undefined && !WEBHOOK_RESPONSE_MODES.has(params.responseMode)) {
        errors.push(`${label} 的 responseMode 非法：${snippet(params.responseMode)}（应为 onReceived/lastNode/responseNode）`)
      }
      break
    }
    case 'n8n-nodes-base.scheduleTrigger': {
      const interval = params.rule?.interval
      if (!Array.isArray(interval) || interval.length === 0) {
        errors.push(`${label} 缺少 rule.interval（定时规则数组，如 [{"field":"hours","hoursInterval":1}]）`)
      } else if (interval.some(item => typeof item !== 'object' || item === null || typeof item.field !== 'string')) {
        warnings.push(`${label} 的 rule.interval 中存在缺少 field 的条目`)
      }
      break
    }
    case 'n8n-nodes-base.code': {
      const hasJs = typeof params.jsCode === 'string' && params.jsCode.trim() !== ''
      const hasPy = typeof params.pythonCode === 'string' && params.pythonCode.trim() !== ''
      if (!hasJs && !hasPy) errors.push(`${label} 未提供代码（需要 jsCode 或 pythonCode）`)
      if (params.mode !== undefined && !CODE_MODES.has(params.mode)) {
        errors.push(`${label} 的 mode 非法：${snippet(params.mode)}（应为 runOnceForAllItems/runOnceForEachItem）`)
      }
      break
    }
    case 'n8n-nodes-base.httpRequest': {
      if (typeof params.url !== 'string' || params.url.trim() === '') errors.push(`${label} 缺少 url`)
      if (params.method !== undefined && !HTTP_METHODS.has(String(params.method).toUpperCase())) {
        errors.push(`${label} 的 method 非法：${snippet(params.method)}`)
      }
      break
    }
    case 'n8n-nodes-base.set': {
      if ((params.mode === undefined || params.mode === 'manual') && !hasAssignments(params)) {
        warnings.push(`${label}（manual 模式）没有配置任何 assignments——节点不会输出新字段`)
      }
      break
    }
    case 'n8n-nodes-base.respondToWebhook': {
      if (params.respondWith === 'json' || params.respondWith === 'text') {
        const body = params.responseBody
        if (typeof body !== 'string' || body.trim() === '') {
          warnings.push(`${label} 的 respondWith 为 '${params.respondWith}' 但 responseBody 为空——客户端会收到空响应`)
        }
      }
      if (params.responseCode !== undefined && (!Number.isInteger(params.responseCode) || params.responseCode < 100 || params.responseCode > 599)) {
        errors.push(`${label} 的 responseCode 必须是 100–599 的整数`)
      }
      break
    }
    case 'n8n-nodes-base.if': {
      const conditions = params.conditions
      if (conditions === undefined) {
        warnings.push(`IF 节点 '${node.name ?? node.id}' 未配置条件`)
      } else if (typeof conditions === 'object' && conditions !== null) {
        if (Array.isArray(conditions.conditions) && conditions.conditions.length === 0) {
          warnings.push(`${label} 的条件列表为空——所有项都会走 true 分支`)
        }
        if (conditions.combinator !== undefined && conditions.combinator !== 'and' && conditions.combinator !== 'or') {
          errors.push(`${label} 的 combinator 非法：${snippet(conditions.combinator)}（应为 and/or）`)
        }
      }
      break
    }
    default: {
      if (node.type === '@n8n/n8n-nodes-langchain.agent') {
        if ((params.promptType === undefined || params.promptType === 'define') && (typeof params.text !== 'string' || params.text.trim() === '')) {
          warnings.push(`${label}（define 模式）未提供提示词 text`)
        }
      }
    }
  }
}

/** Set v3 wraps entries as parameters.assignments.assignments. */
function hasAssignments(params) {
  const assignments = params.assignments?.assignments
  return Array.isArray(assignments) && assignments.length > 0
}

/** Names are connection keys and expression references — flag the foot-guns. */
function checkNameHygiene(node, warnings) {
  const name = node.name
  if (typeof name !== 'string') return
  if (name.trim() !== name) warnings.push(`节点名称首尾含空白：${snippet(name)}——connections 与表达式引用容易踩坑`)
  if (name.includes('"') || name.includes('\n')) warnings.push(`节点名称含引号或换行：${snippet(name)}——引用该节点（$node["…"]）容易出错`)
}

/**
 * Graph pass: triggers, reachability, branch-output wiring, orphans, cycles.
 * Only `main` edges carry the flow; `ai_*` edges mark sub-nodes and are used
 * to exclude them from orphan/reachability warnings.
 */
function checkGraph(nodes, connections, errors, warnings) {
  const outMain = new Map()   // name -> [{ to, outputIndex }]
  const outAi = new Map()     // name -> Set of `type:target`
  const inMainCount = new Map()
  const aiLanguageModelTargets = new Set()

  for (const [source, outputs] of Object.entries(connections)) {
    for (const [outputType, branches] of Object.entries(outputs ?? {})) {
      if (!Array.isArray(branches)) continue
      branches.forEach((branch, branchIndex) => {
        for (const link of branch ?? []) {
          if (typeof link?.node !== 'string') continue
          if (outputType === 'main') {
            if (!outMain.has(source)) outMain.set(source, [])
            outMain.get(source).push({ to: link.node, outputIndex: branchIndex })
            inMainCount.set(link.node, (inMainCount.get(link.node) ?? 0) + 1)
          } else {
            if (!outAi.has(source)) outAi.set(source, new Set())
            outAi.get(source).add(`${outputType}:${link.node}`)
            if (outputType === 'ai_languageModel') aiLanguageModelTargets.add(link.node)
          }
        }
      })
    }
  }

  const named = nodes.filter(node => typeof node.name === 'string')
  const triggers = named.filter(node => TRIGGER_TYPES.has(node.type))

  // Trigger presence.
  if (triggers.length === 0) {
    warnings.push('工作流没有任何触发器节点（webhook/scheduleTrigger/manualTrigger/errorTrigger 等）——发布后不会自动运行，请确认')
  } else if (triggers.length > 1) {
    const list = triggers.map(node => `'${node.name}'`).join('、')
    warnings.push(`工作流有 ${triggers.length} 个触发器节点（${list}）——任一触发都会启动整个流程，请确认是有意的`)
  }

  // Reachability from triggers over main edges.
  const visited = new Set(triggers.map(node => node.name))
  const queue = [...visited]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const { to } of outMain.get(current) ?? []) {
      if (!visited.has(to)) { visited.add(to); queue.push(to) }
    }
  }
  const unreachable = named.filter(node => !visited.has(node.name) && !outAi.has(node.name))
  if (unreachable.length > 0 && unreachable.length <= 4) {
    for (const node of unreachable) {
      warnings.push(`节点 '${node.name}'（${node.type}）从任何触发器都不可达——普通执行不会经过它（AI 子节点/工具节点可忽略）`)
    }
  } else if (unreachable.length > 4) {
    const list = unreachable.slice(0, 4).map(node => `'${node.name}'`).join('、')
    warnings.push(`有 ${unreachable.length} 个节点从任何触发器都不可达（${list} 等）——请检查它们与主流的连接`)
  }

  // Branch-output wiring and per-node graph patterns.
  for (const node of named) {
    const branches = connections[node.name]?.main
    const label = `${node.type === 'n8n-nodes-base.switch' ? 'Switch' : node.type === 'n8n-nodes-base.filter' ? 'Filter' : 'IF'} 节点 '${node.name}'`
    if (BRANCH_TYPES.has(node.type)) {
      const firstWired = Array.isArray(branches?.[0]) && branches[0].length > 0
      const secondWired = Array.isArray(branches?.[1]) && branches[1].length > 0
      if (!firstWired) warnings.push(`${label} 的第 1 个输出未接线——通过（true）分支的项会被丢弃`)
      if (node.type !== 'n8n-nodes-base.switch' && !secondWired) {
        warnings.push(`${label} 的第 2 个输出未接线——拒绝（false）分支的项会被静默丢弃，如非有意请补上`)
      }
    }
    if (node.type === 'n8n-nodes-base.splitInBatches') {
      const loopWired = Array.isArray(branches?.[0]) && branches[0].length > 0
      const doneWired = Array.isArray(branches?.[1]) && branches[1].length > 0
      if (!loopWired || !doneWired) {
        warnings.push(`SplitInBatches 节点 '${node.name}' 的两个输出（loop 与 done）未全部接线——请确认循环回边与完成分支`)
      }
    }
    if (node.type === 'n8n-nodes-base.respondToWebhook' && !inMainCount.has(node.name)) {
      warnings.push(`Respond to Webhook 节点 '${node.name}' 没有任何输入连接——响应永远不会被发送`)
    }
    if (node.type === '@n8n/n8n-nodes-langchain.agent' && !aiLanguageModelTargets.has(node.name)) {
      warnings.push(`AI Agent 节点 '${node.name}' 未连接任何语言模型（缺少 ai_languageModel 连接）`)
    }
  }

  // Cycles over main edges (self-loops are already warned in pass 1).
  for (const cycle of findCycles(outMain).slice(0, 3)) {
    warnings.push(`检测到循环：${cycle.join(' → ')}——若为 SplitInBatches 循环或等待重试回路则属正常模式`)
  }

  // Layout: overlapping positions are invisible collisions on the canvas.
  const byPosition = new Map()
  for (const node of named) {
    if (!Array.isArray(node.position) || node.position.length < 2) continue
    const key = `${node.position[0]},${node.position[1]}`
    if (!byPosition.has(key)) byPosition.set(key, [])
    byPosition.get(key).push(node.name)
  }
  let overlapReported = 0
  for (const group of byPosition.values()) {
    if (group.length < 2 || overlapReported >= 3) continue
    warnings.push(`以下节点 position 完全相同，画布上会互相遮挡：${group.map(name => `'${name}'`).join('、')}`)
    overlapReported += 1
  }
}

/** Find cycles in the main-edge graph via DFS back edges; deduped, self-loops skipped. */
function findCycles(outMain) {
  const color = new Map() // 1 = on stack, 2 = done
  const stack = []
  const cycles = []
  const seen = new Set()
  const visit = name => {
    color.set(name, 1)
    stack.push(name)
    for (const { to } of outMain.get(name) ?? []) {
      if (to === name) continue
      const state = color.get(to)
      if (state === 1) {
        const start = stack.indexOf(to)
        const cycle = stack.slice(start).concat(to)
        const key = [...cycle].sort().join('|')
        if (!seen.has(key)) { seen.add(key); cycles.push(cycle) }
      } else if (state === undefined) {
        visit(to)
      }
    }
    stack.pop()
    color.set(name, 2)
  }
  for (const name of outMain.keys()) {
    if (!color.has(name)) visit(name)
  }
  return cycles
}

/** Lint every `{{ … }}` occurrence inside node parameters. */
function checkExpressions(nodes, errors, warnings) {
  for (const [index, node] of nodes.entries()) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) continue
    if (node.parameters === undefined || typeof node.parameters !== 'object' || node.parameters === null) continue
    const who = `nodes[${index}]（'${node.name ?? node.id ?? '?'}'）.parameters`
    walkStrings(node.parameters, who, '', errors, warnings)
  }
}

/** Depth-first walk of string leaves; `key` names the property currently visited. */
function walkStrings(value, who, key, errors, warnings) {
  if (typeof value === 'string') {
    if (EXPRESSION_EXEMPT_KEYS.has(key)) return
    checkExpressionString(value, `${who}.${key}`, errors, warnings)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStrings(item, `${who}.${key}[${i}]`, key, errors, warnings))
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [childKey, child] of Object.entries(value)) {
      walkStrings(child, `${who}.${key}`, childKey, errors, warnings)
    }
  }
}

/** Apply the three expression rules to one string value. */
function checkExpressionString(value, path, errors, warnings) {
  if (!value.includes('{{') && !value.includes('}}')) return
  const rest = value.replace(/\{\{[\s\S]*?\}\}/g, '')
  if (rest.includes('{{') || rest.includes('}}')) {
    errors.push(`${path} 的表达式大括号不配对：${snippet(value)}`)
    return
  }
  if (value.includes('{{') && !value.startsWith('=')) {
    warnings.push(`${path} 含 {{ }} 但未以 '=' 开头——n8n 不会将其作为表达式求值，会按字面文本处理：${snippet(value)}`)
  }
  for (const match of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    if (match[1].trim() === '') errors.push(`${path} 存在空表达式 '{{}}'`)
  }
}
