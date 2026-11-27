/**
 * Tests for lib/workflow-validate.js and the bundled knowledge/templates.
 * Run with `npm test` (node --test). No network, no instance — pure offline.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateWorkflow } from '../lib/workflow-validate.js'

/** Build a minimal valid two-node workflow; tests mutate from here. */
function baseWorkflow(overrides = {}) {
  return {
    name: '测试流程',
    nodes: [
      { id: 'trigger1', name: '开始', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [250, 300], parameters: {} },
      { id: 'set1', name: '处理', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: { mode: 'manual', assignments: { assignments: [{ id: 'a1', name: 'x', value: '1', type: 'string' }] }, options: {} } },
    ],
    connections: { 开始: { main: [[{ node: '处理', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' },
    ...overrides,
  }
}

test('最小合法工作流通过且无警告', () => {
  const result = validateWorkflow(baseWorkflow())
  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
})

test('缺少 name 报错', () => {
  const workflow = baseWorkflow()
  delete workflow.name
  const result = validateWorkflow(workflow)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(error => error.includes('name')))
})

test('节点名称重复报错', () => {
  const workflow = baseWorkflow()
  workflow.nodes[1].name = '开始'
  const result = validateWorkflow(workflow)
  assert.ok(result.errors.some(error => error.includes('重复')))
})

test('连线指向不存在的节点报错', () => {
  const workflow = baseWorkflow()
  workflow.connections['开始'].main[0][0].node = '不存在'
  const result = validateWorkflow(workflow)
  assert.ok(result.errors.some(error => error.includes('不存在')))
})

test('webhook responseNode 缺少响应节点报错', () => {
  const workflow = baseWorkflow({
    nodes: [
      { id: 'w1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [250, 300], parameters: { path: 'hook', httpMethod: 'POST', responseMode: 'responseNode' } },
    ],
    connections: {},
  })
  const result = validateWorkflow(workflow)
  assert.ok(result.errors.some(error => error.includes('Respond to Webhook')))
})

test('webhook 非法 httpMethod 与 responseMode 报错', () => {
  const workflow = baseWorkflow({
    nodes: [
      { id: 'w1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [250, 300], parameters: { path: 'hook', httpMethod: 'FETCH', responseMode: 'whenever' } },
      { id: 'r1', name: '响应', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4, position: [450, 300], parameters: {} },
    ],
    connections: { Webhook: { main: [[{ node: '响应', type: 'main', index: 0 }]] } },
  })
  const result = validateWorkflow(workflow)
  assert.ok(result.errors.some(error => error.includes('httpMethod 非法')))
  assert.ok(result.errors.some(error => error.includes('responseMode 非法')))
})

test('scheduleTrigger 缺少 rule.interval 报错', () => {
  const workflow = baseWorkflow({
    nodes: [{ id: 's1', name: '定时', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [250, 300], parameters: {} }],
    connections: {},
  })
  const result = validateWorkflow(workflow)
  assert.ok(result.errors.some(error => error.includes('rule.interval')))
})

test('httpRequest 缺少 url 报错', () => {
  const workflow = baseWorkflow({
    nodes: [{ id: 'h1', name: '请求', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [250, 300], parameters: { method: 'GET' } }],
    connections: {},
  })
  const result = validateWorkflow(workflow)
  assert.ok(result.errors.some(error => error.includes('缺少 url')))
})

test('code 节点缺少代码报错；非法 mode 报错', () => {
  const workflow = baseWorkflow({
    nodes: [{ id: 'c1', name: '代码', type: 'n8n-nodes-base.code', typeVersion: 2, position: [250, 300], parameters: { mode: 'runOnceForever' } }],
    connections: {},
  })
  const result = validateWorkflow(workflow)
  assert.ok(result.errors.some(error => error.includes('jsCode 或 pythonCode')))
  assert.ok(result.errors.some(error => error.includes('mode 非法')))
})

test('表达式大括号不配对报错', () => {
  const workflow = baseWorkflow()
  workflow.nodes[1].parameters = { mode: 'manual', assignments: { assignments: [{ id: 'a1', name: 'x', value: '={{ $json.a }', type: 'string' }] }, options: {} }
  const result = validateWorkflow(workflow)
  assert.ok(result.errors.some(error => error.includes('大括号不配对')))
})

test('空表达式报错', () => {
  const workflow = baseWorkflow()
  workflow.nodes[1].parameters = { mode: 'manual', assignments: { assignments: [{ id: 'a1', name: 'x', value: '={{}}', type: 'string' }] }, options: {} }
  const result = validateWorkflow(workflow)
  assert.ok(result.errors.some(error => error.includes('空表达式')))
})

test('含 {{ }} 但缺 = 前缀给出警告', () => {
  const workflow = baseWorkflow()
  workflow.nodes[1].parameters = { mode: 'manual', assignments: { assignments: [{ id: 'a1', name: 'x', value: 'Hello {{ $json.name }}', type: 'string' }] }, options: {} }
  const result = validateWorkflow(workflow)
  assert.equal(result.valid, true)
  assert.ok(result.warnings.some(warning => warning.includes("'=' 开头")))
})

test('code 节点里的 {{ }} 不触发表达式警告（jsCode 豁免）', () => {
  const trigger = baseWorkflow().nodes[0]
  const code = { id: 'c1', name: '代码', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300], parameters: { jsCode: 'const s = \'{{ "x": 1 }}\'; return [{ json: { s } }];' } }
  const workflow = baseWorkflow({ nodes: [trigger, code], connections: { 开始: { main: [[{ node: '代码', type: 'main', index: 0 }]] } } })
  const result = validateWorkflow(workflow)
  assert.deepEqual(result.warnings, [])
})

test('IF 第二个输出未接线给出警告，接线后消除', () => {
  const ifNode = { id: 'if1', name: '判断', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [450, 300], parameters: { conditions: { options: {}, conditions: [{ id: 'c1', leftValue: '={{ $json.a }}', rightValue: '1', operator: { type: 'number', operation: 'equals' } }], combinator: 'and' }, options: {} } }
  const next = { id: 'n1', name: '后续', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [650, 300], parameters: {} }
  const trigger = { id: 't1', name: '开始', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [250, 300], parameters: {} }
  const wired = baseWorkflow({ nodes: [trigger, ifNode, next], connections: { 开始: { main: [[{ node: '判断', type: 'main', index: 0 }]] }, 判断: { main: [[{ node: '后续', type: 'main', index: 0 }], [{ node: '后续', type: 'main', index: 0 }]] } } })
  assert.equal(validateWorkflow(wired).warnings.length, 0)

  const unwired = baseWorkflow({ nodes: [trigger, ifNode, next], connections: { 开始: { main: [[{ node: '判断', type: 'main', index: 0 }]] }, 判断: { main: [[{ node: '后续', type: 'main', index: 0 }]] } } })
  const result = validateWorkflow(unwired)
  assert.ok(result.warnings.some(warning => warning.includes('第 2 个输出')))
})

test('无触发器给出警告', () => {
  const workflow = baseWorkflow({ nodes: [baseWorkflow().nodes[1]], connections: {} })
  const result = validateWorkflow(workflow)
  assert.ok(result.warnings.some(warning => warning.includes('触发器')))
})

test('触发器不可达的节点给出警告', () => {
  const workflow = baseWorkflow()
  workflow.nodes.push({ id: 'orphan1', name: '孤岛', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [850, 300], parameters: {} })
  const result = validateWorkflow(workflow)
  assert.ok(result.warnings.some(warning => warning.includes('不可达')))
})

test('SplitInBatches 缺回边给出警告', () => {
  const split = { id: 's1', name: '分批', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [450, 300], parameters: { batchSize: 10 } }
  const workflow = baseWorkflow({ nodes: [split], connections: {} })
  const result = validateWorkflow(workflow)
  assert.ok(result.warnings.some(warning => warning.includes('SplitInBatches')))
})

test('SplitInBatches 循环回边不误报错误', () => {
  const split = { id: 's1', name: '分批', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [450, 300], parameters: { batchSize: 10 } }
  const step = { id: 'n1', name: '处理', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [650, 300], parameters: {} }
  const workflow = baseWorkflow({ nodes: [split, step], connections: { 分批: { main: [[{ node: '处理', type: 'main', index: 0 }], [{ node: '处理', type: 'main', index: 0 }]] }, 处理: { main: [[{ node: '分批', type: 'main', index: 0 }]] } } })
  const result = validateWorkflow(workflow)
  assert.equal(result.valid, true)
  assert.ok(result.warnings.some(warning => warning.includes('检测到循环')))
})

test('AI Agent 缺少语言模型连接给出警告', () => {
  const agent = { id: 'a1', name: '助手', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.7, position: [450, 300], parameters: { promptType: 'define', text: 'hi' } }
  const workflow = baseWorkflow({ nodes: [agent], connections: {} })
  const result = validateWorkflow(workflow)
  assert.ok(result.warnings.some(warning => warning.includes('ai_languageModel')))
})

test('position 重叠给出警告', () => {
  const workflow = baseWorkflow()
  workflow.nodes[1].position = [250, 300]
  const result = validateWorkflow(workflow)
  assert.ok(result.warnings.some(warning => warning.includes('遮挡')))
})

test('嵌套对象字面量与引号内的 }} 不误报大括号不配对', () => {
  const workflow = baseWorkflow()
  workflow.nodes[1].parameters = {
    mode: 'manual',
    assignments: {
      assignments: [
        { id: 'a1', name: 'nested', value: '={{ {a: {b: 1}} }}', type: 'string' },
        { id: 'a2', name: 'quoted', value: '={{ $json.text + "}}" }}', type: 'string' },
      ],
    },
    options: {},
  }
  const result = validateWorkflow(workflow)
  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
})

test('stickyNote 便签节点不误报不可达', () => {
  const workflow = baseWorkflow()
  workflow.nodes.push({ id: 'note1', name: '说明', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [50, 100], parameters: { content: '注释' } })
  const result = validateWorkflow(workflow)
  assert.equal(result.valid, true)
  assert.deepEqual(result.warnings, [])
})

test('第三方 Trigger 节点（*Trigger 后缀）被识别为触发器', () => {
  const workflow = baseWorkflow({
    nodes: [
      { id: 'tg1', name: 'Telegram', type: 'n8n-nodes-base.telegramTrigger', typeVersion: 1.1, position: [250, 300], parameters: { updates: ['message'] } },
      { id: 's1', name: '处理', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [450, 300], parameters: {} },
    ],
    connections: { Telegram: { main: [[{ node: '处理', type: 'main', index: 0 }]] } },
  })
  const result = validateWorkflow(workflow)
  assert.equal(result.valid, true)
  assert.deepEqual(result.warnings, [])
})

test('四个内置模板全部 0 错误', () => {
  const dir = fileURLToPath(new URL('../knowledge/templates/', import.meta.url))
  const files = readdirSync(dir).filter(file => file.endsWith('.json'))
  assert.equal(files.length, 4)
  for (const file of files) {
    const template = JSON.parse(readFileSync(dir + file, 'utf8'))
    const result = validateWorkflow(template)
    assert.deepEqual(result.errors, [], `${file} 应当 0 错误`)
  }
})
