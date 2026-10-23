/**
 * Offline workflow-JSON validation: the structural rules an n8n workflow must
 * satisfy before it is worth sending to the instance. This is deliberately a
 * cheap pre-flight (no node-type catalogue), so it catches the mistakes that
 * otherwise come back as an opaque 400 from the n8n API: duplicate ids or
 * names, a connection naming a node that does not exist, a missing
 * `executionOrder`, or a webhook in `responseNode` mode without its responder.
 */

/** Node types whose second output is a branch (documented for the warning pass). */
const MULTI_OUTPUT_HINTS = new Set([
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.filter',
])

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
  } else {
    const settings = workflow.settings ?? {}
    if (settings.executionOrder !== 'v1') {
      warnings.push('settings.executionOrder 建议设为 "v1"（当前 n8n 的执行顺序）')
    }
  }

  const nodes = workflow.nodes.filter(node => typeof node === 'object' && node !== null)
  const types = new Set(nodes.map(node => node.type))
  for (const node of nodes) {
    if (MULTI_OUTPUT_HINTS.has(node.type)) {
      warnings.push(`节点 '${node.name ?? node.id}'（${node.type}）有多个输出——请确认 connections 使用了正确的输出索引`)
    }
    if (node.type === 'n8n-nodes-base.if' && node.parameters?.conditions === undefined && node.parameters?.conditionsVersion === undefined) {
      warnings.push(`IF 节点 '${node.name ?? node.id}' 未配置条件`)
    }
  }
  for (const node of nodes) {
    const responseMode = node.parameters?.responseMode
    if (node.type === 'n8n-nodes-base.webhook' && responseMode === 'responseNode' && !types.has('n8n-nodes-base.respondToWebhook')) {
      errors.push(`webhook 节点 '${node.name ?? node.id}' 使用 responseMode "responseNode"，但工作流中没有 Respond to Webhook 节点`)
    }
  }
  if (types.has('n8n-nodes-base.webhook')) {
    const webhook = nodes.find(node => node.type === 'n8n-nodes-base.webhook')
    const path = webhook?.parameters?.path
    if (typeof path === 'string' && path.trim() === '') {
      errors.push('webhook 的 path 不能为空')
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}