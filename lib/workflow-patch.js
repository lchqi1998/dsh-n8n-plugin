/**
 * Pure, deterministic patcher for n8n workflow documents.
 *
 * Applies a sequence of small structural/parameter operations onto a cloned
 * workflow so the agent can edit one node or connection without regenerating
 * the entire workflow JSON.
 */

/**
 * Apply an ordered list of patch operations to a workflow document.
 * @param {object} workflow - source workflow from `getWorkflow`.
 * @param {Array<object>} operations - patch operations.
 * @returns {object} a new workflow object with the operations applied.
 */
export function applyWorkflowPatch(workflow, operations) {
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new Error('源工作流必须是 JSON 对象')
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error('operations 必须是非空操作数组')
  }

  const next = structuredClone(workflow)
  if (!Array.isArray(next.nodes)) next.nodes = []
  if (next.connections === null || typeof next.connections !== 'object' || Array.isArray(next.connections)) {
    next.connections = {}
  }
  if (next.settings === null || typeof next.settings !== 'object' || Array.isArray(next.settings)) {
    next.settings = {}
  }

  for (let index = 0; index < operations.length; index += 1) {
    const op = operations[index]
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new Error(`operations[${index}] 必须是对象`)
    }
    switch (op.op) {
      case 'rename': {
        if (typeof op.name !== 'string' || op.name.trim() === '') {
          throw new Error(`operations[${index}].name 不能为空`)
        }
        next.name = op.name.trim()
        break
      }
      case 'updateSettings': {
        if (op.settings === null || typeof op.settings !== 'object' || Array.isArray(op.settings)) {
          throw new Error(`operations[${index}].settings 必须是对象`)
        }
        next.settings = { ...next.settings, ...op.settings }
        break
      }
      case 'addNode': {
        const node = op.node
        if (node === null || typeof node !== 'object' || Array.isArray(node)) {
          throw new Error(`operations[${index}].node 必须是对象`)
        }
        if (typeof node.name !== 'string' || node.name.trim() === '') {
          throw new Error(`operations[${index}].node.name 必填`)
        }
        if (next.nodes.some(existing => existing?.name === node.name)) {
          throw new Error(`节点名称已存在：'${node.name}'`)
        }
        if (typeof node.id === 'string' && node.id !== '' && next.nodes.some(existing => existing?.id === node.id)) {
          throw new Error(`节点 id 已存在：'${node.id}'`)
        }
        next.nodes.push(structuredClone(node))
        break
      }
      case 'removeNode': {
        const name = requireNodeName(op.name, index)
        const pos = next.nodes.findIndex(node => node?.name === name)
        if (pos < 0) throw new Error(`找不到节点：'${name}'`)
        next.nodes.splice(pos, 1)
        delete next.connections[name]
        pruneIncomingConnections(next.connections, name)
        break
      }
      case 'updateNode': {
        const name = requireNodeName(op.name, index)
        const node = next.nodes.find(candidate => candidate?.name === name)
        if (node === undefined) throw new Error(`找不到节点：'${name}'`)
        if (op.parameters !== undefined) {
          if (op.parameters === null || typeof op.parameters !== 'object' || Array.isArray(op.parameters)) {
            throw new Error(`operations[${index}].parameters 必须是对象`)
          }
          node.parameters = structuredClone(op.parameters)
        }
        if (op.patchParameters !== undefined) {
          if (op.patchParameters === null || typeof op.patchParameters !== 'object' || Array.isArray(op.patchParameters)) {
            throw new Error(`operations[${index}].patchParameters 必须是对象`)
          }
          node.parameters = { ...(node.parameters ?? {}), ...structuredClone(op.patchParameters) }
        }
        if (op.disabled !== undefined) {
          if (typeof op.disabled !== 'boolean') throw new Error(`operations[${index}].disabled 必须是布尔值`)
          node.disabled = op.disabled
        }
        if (op.position !== undefined) {
          if (!Array.isArray(op.position) || op.position.length < 2 || op.position.some(v => typeof v !== 'number')) {
            throw new Error(`operations[${index}].position 必须是 [x, y] 数字数组`)
          }
          node.position = [...op.position]
        }
        if (op.newName !== undefined) {
          const newName = requireNodeName(op.newName, index, 'newName')
          if (newName !== name) {
            if (next.nodes.some(candidate => candidate?.name === newName)) {
              throw new Error(`目标节点名称已存在：'${newName}'`)
            }
            node.name = newName
            renameNodeInConnections(next.connections, name, newName)
          }
        }
        break
      }
      case 'connect': {
        const from = requireNodeName(op.from, index, 'from')
        const to = requireNodeName(op.to, index, 'to')
        if (!next.nodes.some(node => node?.name === from)) throw new Error(`找不到源节点：'${from}'`)
        if (!next.nodes.some(node => node?.name === to)) throw new Error(`找不到目标节点：'${to}'`)
        const outputType = typeof op.outputType === 'string' && op.outputType !== '' ? op.outputType : 'main'
        const outputIndex = Number.isInteger(op.outputIndex) && op.outputIndex >= 0 ? op.outputIndex : 0
        const inputIndex = Number.isInteger(op.inputIndex) && op.inputIndex >= 0 ? op.inputIndex : 0
        const sourceOutputs = (next.connections[from] ??= {})
        const branches = (sourceOutputs[outputType] ??= [])
        while (branches.length <= outputIndex) branches.push([])
        const branch = (branches[outputIndex] ??= [])
        const exists = branch.some(link => link?.node === to && (link?.type ?? 'main') === outputType && (link?.index ?? 0) === inputIndex)
        if (!exists) branch.push({ node: to, type: outputType, index: inputIndex })
        break
      }
      case 'disconnect': {
        const from = requireNodeName(op.from, index, 'from')
        const to = requireNodeName(op.to, index, 'to')
        const sourceOutputs = next.connections[from]
        if (sourceOutputs === undefined || typeof sourceOutputs !== 'object') break
        const types = typeof op.outputType === 'string' && op.outputType !== ''
          ? [op.outputType]
          : Object.keys(sourceOutputs)
        for (const outputType of types) {
          const branches = sourceOutputs[outputType]
          if (!Array.isArray(branches)) continue
          branches.forEach((branch, branchIdx) => {
            if (!Array.isArray(branch)) return
            if (Number.isInteger(op.outputIndex) && op.outputIndex !== branchIdx) return
            branches[branchIdx] = branch.filter(link => link?.node !== to)
          })
        }
        break
      }
      default:
        throw new Error(`不支持的补丁操作 op: '${String(op.op)}'`)
    }
  }

  return next
}

function requireNodeName(value, index, field = 'name') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`operations[${index}].${field} 不能为空`)
  }
  return value.trim()
}

function pruneIncomingConnections(connections, targetName) {
  for (const outputs of Object.values(connections)) {
    if (outputs === null || typeof outputs !== 'object') continue
    for (const branches of Object.values(outputs)) {
      if (!Array.isArray(branches)) continue
      branches.forEach((branch, i) => {
        if (Array.isArray(branch)) {
          branches[i] = branch.filter(link => link?.node !== targetName)
        }
      })
    }
  }
}

function renameNodeInConnections(connections, oldName, newName) {
  if (Object.hasOwn(connections, oldName)) {
    connections[newName] = connections[oldName]
    delete connections[oldName]
  }
  for (const outputs of Object.values(connections)) {
    if (outputs === null || typeof outputs !== 'object') continue
    for (const branches of Object.values(outputs)) {
      if (!Array.isArray(branches)) continue
      for (const branch of branches) {
        if (!Array.isArray(branch)) continue
        for (const link of branch) {
          if (link !== null && typeof link === 'object' && link.node === oldName) {
            link.node = newName
          }
        }
      }
    }
  }
}
