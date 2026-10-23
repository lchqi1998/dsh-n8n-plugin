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
    return { valid: false, errors: ['workflow must be a JSON object'], warnings }
  }
  if (typeof workflow.name !== 'string' || workflow.name.trim() === '') {
    errors.push('name is required')
  }
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    errors.push('nodes must be a non-empty array')
    return { valid: false, errors, warnings }
  }

  const ids = new Set()
  const names = new Set()
  workflow.nodes.forEach((node, index) => {
    const label = `nodes[${index}]`
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      errors.push(`${label} must be an object`)
      return
    }
    if (typeof node.id !== 'string' || node.id.trim() === '') errors.push(`${label}.id is required`)
    else if (ids.has(node.id)) errors.push(`duplicate node id '${node.id}'`)
    else ids.add(node.id)

    if (typeof node.name !== 'string' || node.name.trim() === '') errors.push(`${label}.name is required`)
    else if (names.has(node.name)) errors.push(`duplicate node name '${node.name}' (names must be unique — connections key on them)`)
    else names.add(node.name)

    if (typeof node.type !== 'string' || node.type.trim() === '') errors.push(`${label}.type is required`)
    if (typeof node.typeVersion !== 'number' || !Number.isFinite(node.typeVersion)) errors.push(`${label}.typeVersion must be a number`)
    if (!Array.isArray(node.position) || node.position.length < 2 || node.position.some(value => typeof value !== 'number')) {
      errors.push(`${label}.position must be [x, y] numbers`)
    }
    if (node.parameters !== undefined && (typeof node.parameters !== 'object' || node.parameters === null || Array.isArray(node.parameters))) {
      errors.push(`${label}.parameters must be an object`)
    }
  })

  if (workflow.connections !== undefined) {
    if (typeof workflow.connections !== 'object' || workflow.connections === null || Array.isArray(workflow.connections)) {
      errors.push('connections must be an object keyed by source node name')
    } else {
      for (const [source, outputs] of Object.entries(workflow.connections)) {
        if (!names.has(source)) {
          errors.push(`connections names source node '${source}', which is not a node name in this workflow`)
          continue
        }
        // n8n shape: { "<node>": { "main": [[{node,type,index}]], "<otherOutput>": [...] } }
        if (typeof outputs !== 'object' || outputs === null || Array.isArray(outputs)) {
          errors.push(`connections['${source}'] must be an object keyed by output type (e.g. {"main": [[...]]})`)
          continue
        }
        for (const [outputType, branches] of Object.entries(outputs)) {
          if (!Array.isArray(branches)) {
            errors.push(`connections['${source}']['${outputType}'] must be an array of output branches`)
            continue
          }
          branches.forEach((branch, branchIndex) => {
            const where = `connections['${source}']['${outputType}'][${branchIndex}]`
            if (branch === null) return
            if (!Array.isArray(branch)) {
              errors.push(`${where} must be an array or null`)
              return
            }
            for (const link of branch) {
              if (typeof link !== 'object' || link === null) {
                errors.push(`${where} contains a non-object link`)
                continue
              }
              if (typeof link.node !== 'string' || !names.has(link.node)) {
                errors.push(`${where} targets '${String(link.node)}', which is not a node name in this workflow`)
              }
              if (link.type !== undefined && typeof link.type !== 'string') {
                errors.push(`${where}.type must be a string`)
              }
              if (link.index !== undefined && (!Number.isInteger(link.index) || link.index < 0)) {
                errors.push(`${where}.index must be a non-negative integer`)
              }
              if (link.node === source) {
                warnings.push(`connections['${source}'] links the node to itself — confirm that is intentional`)
              }
            }
          })
        }
      }
    }
  }

  if (workflow.settings !== undefined && (typeof workflow.settings !== 'object' || workflow.settings === null || Array.isArray(workflow.settings))) {
    errors.push('settings must be an object')
  } else {
    const settings = workflow.settings ?? {}
    if (settings.executionOrder !== 'v1') {
      warnings.push('settings.executionOrder should be "v1" (the current n8n execution order)')
    }
  }

  const nodes = workflow.nodes.filter(node => typeof node === 'object' && node !== null)
  const types = new Set(nodes.map(node => node.type))
  for (const node of nodes) {
    if (MULTI_OUTPUT_HINTS.has(node.type)) {
      warnings.push(`node '${node.name ?? node.id}' (${node.type}) has multiple outputs — make sure connections use the right output index`)
    }
    if (node.type === 'n8n-nodes-base.if' && node.parameters?.conditions === undefined && node.parameters?.conditionsVersion === undefined) {
      warnings.push(`IF node '${node.name ?? node.id}' has no conditions configured`)
    }
  }
  for (const node of nodes) {
    const responseMode = node.parameters?.responseMode
    if (node.type === 'n8n-nodes-base.webhook' && responseMode === 'responseNode' && !types.has('n8n-nodes-base.respondToWebhook')) {
      errors.push(`webhook '${node.name ?? node.id}' uses responseMode "responseNode" but the workflow has no Respond to Webhook node`)
    }
  }
  if (types.has('n8n-nodes-base.webhook')) {
    const webhook = nodes.find(node => node.type === 'n8n-nodes-base.webhook')
    const path = webhook?.parameters?.path
    if (typeof path === 'string' && path.trim() === '') {
      errors.push('webhook path must not be empty')
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}