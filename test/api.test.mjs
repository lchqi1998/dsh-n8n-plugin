/**
 * Local-only checks for the clone / tag / cancel additions (test/ is ignored by
 * git). Run with `node --test test/`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { N8nClient, rowFilterQuery, toWorkflowClonePayload, validateDataTableColumn, validateDataTableName, validateRowFilter, validateTagName, validateVariableKey, validateVariableValue } from '../lib/n8n.js'
import { toolSpecs } from '../lib/tool-specs.js'
import { N8N_TOOL_NAMES } from '../lib/guidance.js'
import { matchExecutionErrorPatterns } from '../lib/execution-errors.js'
import { renderExecutionDetail } from '../lib/render.js'
import { InstanceStore, resolveApiKey } from '../lib/store.js'
import { appendAudit, readAudit } from '../lib/audit.js'
import { collectHealth } from '../lib/routes.js'
import { isLoopbackRequest, isProxiedRequest } from '../lib/http.js'
import { applyWorkflowPatch } from '../lib/workflow-patch.js'

const store = { require: alias => ({ alias, baseUrl: 'https://n8n.test', apiKey: 'secret-key' }) }

function makeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url))
    const key = `${init.method} ${parsed.pathname}`
    calls.push({
      method: init.method,
      path: parsed.pathname,
      search: parsed.search,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    })
    const handler = routes[key]
    if (handler === undefined) throw new Error(`unexpected request: ${key}`)
    const response = typeof handler === 'function' ? handler(calls[calls.length - 1]) : handler
    // 204/304 forbid a body — pass null so `new Response` does not throw.
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

const sourceWorkflow = {
  id: '7',
  name: 'Daily sync',
  active: true,
  nodes: [{ id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'daily-sync' } }],
  connections: {},
  settings: { executionOrder: 'v1' },
  staticData: { lastRun: 1 },
  pinData: {},
  tags: [{ id: 't1', name: 'Prod' }],
  versionId: 'v3',
}

test('clone payload keeps the definition and drops identity/runtime state', () => {
  const payload = toWorkflowClonePayload(sourceWorkflow)
  assert.equal(payload.name, 'Daily sync（副本）')
  assert.deepEqual(payload.nodes, sourceWorkflow.nodes)
  assert.deepEqual(payload.connections, {})
  assert.deepEqual(payload.settings, { executionOrder: 'v1' })
  assert.equal(payload.id, undefined)
  assert.equal(payload.active, undefined)
  assert.equal(payload.staticData, undefined)
  assert.equal(payload.versionId, undefined)
  assert.equal(payload.tags, undefined)
  assert.equal(payload.name, 'Daily sync（副本）')
  assert.equal(toWorkflowClonePayload(sourceWorkflow, '  Manual copy  ').name, 'Manual copy')
})

test('cloneWorkflow copies tags and leaves the clone unpublished', async () => {
  const { fetchImpl, calls } = makeFetch({
    'GET /api/v1/workflows/7': { body: sourceWorkflow },
    'POST /api/v1/workflows': { status: 201, body: { id: '8', name: 'Daily sync（副本）', active: false, nodes: sourceWorkflow.nodes } },
    'PUT /api/v1/workflows/8/tags': { body: [{ id: 't1', name: 'Prod' }] },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  const result = await client.cloneWorkflow('lchqi', '7')

  assert.equal(result.id, '8')
  assert.equal(result.active, false)
  assert.equal(result.source.active, true)
  assert.deepEqual(result.tags, [{ id: 't1', name: 'Prod' }])

  const create = calls.find(call => call.method === 'POST' && call.path === '/api/v1/workflows')
  assert.equal(create.body.name, 'Daily sync（副本）')
  assert.equal(create.body.active, undefined)
  assert.equal(create.body.tags, undefined)
  assert.equal(create.body.staticData, undefined)

  const tagWrite = calls.find(call => call.method === 'PUT' && call.path === '/api/v1/workflows/8/tags')
  assert.deepEqual(tagWrite.body, [{ id: 't1' }])
  assert.equal(calls.some(call => call.path.includes('publish')), false)
})

test('cloneWorkflow reports a tag failure without failing the clone', async () => {
  const { fetchImpl } = makeFetch({
    'GET /api/v1/workflows/7': { body: sourceWorkflow },
    'POST /api/v1/workflows': { status: 201, body: { id: '8', name: 'Daily sync（副本）', active: false, nodes: [] } },
    'PUT /api/v1/workflows/8/tags': { status: 403, body: { message: 'forbidden' } },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  const result = await client.cloneWorkflow('lchqi', '7')
  assert.equal(result.id, '8')
  assert.match(result.tagsError, /forbidden/)
})

test('tag names are bounded to the 24-char n8n limit', () => {
  assert.equal(validateTagName('  生产  '), '生产')
  assert.throws(() => validateTagName(''), /不能为空/)
  assert.throws(() => validateTagName('x'.repeat(25)), /最多 24 个字符/)
  assert.equal(validateTagName('y'.repeat(24)).length, 24)
})

test('tag CRUD hits the public-API endpoints', async () => {
  const { fetchImpl, calls } = makeFetch({
    'POST /api/v1/tags': { status: 201, body: { id: 't2', name: 'Staging' } },
    'PUT /api/v1/tags/t2': { body: { id: 't2', name: 'Stage' } },
    'DELETE /api/v1/tags/t2': { body: { id: 't2', name: 'Stage' } },
    'GET /api/v1/tags': { body: { data: [{ id: 't1', name: 'Prod' }], nextCursor: 'c1' } },
  })
  // The second page needs its own response; swap it in after the first read.
  let tagPages = 0
  const client = new N8nClient(store, {
    fetch: async (url, init) => {
      if (String(url).endsWith('/api/v1/tags?limit=250') || (init.method === 'GET' && String(url).includes('/api/v1/tags'))) {
        tagPages += 1
        const body = tagPages === 1
          ? { data: [{ id: 't1', name: 'Prod' }], nextCursor: 'c1' }
          : { data: [{ id: 't2', name: 'Stage' }] }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return fetchImpl(url, init)
    },
  })

  assert.deepEqual(await client.createTag('lchqi', 'Staging'), { id: 't2', name: 'Staging' })
  assert.deepEqual(await client.updateTag('lchqi', 't2', 'Stage'), { id: 't2', name: 'Stage' })
  assert.deepEqual(await client.deleteTag('lchqi', 't2'), { deleted: true, id: 't2', name: 'Stage' })

  const all = await client.listAllTags('lchqi')
  assert.deepEqual(all.map(tag => tag.id), ['t1', 't2'])

  assert.deepEqual(calls.find(call => call.method === 'POST' && call.path === '/api/v1/tags').body, { name: 'Staging' })
  assert.deepEqual(calls.find(call => call.method === 'PUT' && call.path === '/api/v1/tags/t2').body, { name: 'Stage' })
})

test('workflow tags use the dedicated array endpoint', async () => {
  const { fetchImpl, calls } = makeFetch({
    'GET /api/v1/workflows/42/tags': { body: [{ id: 't1', name: 'Prod' }] },
    'PUT /api/v1/workflows/42/tags': { body: [{ id: 't1', name: 'Prod' }, { id: 't2', name: 'Stage' }] },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  assert.deepEqual((await client.getWorkflowTags('lchqi', '42')).data, [{ id: 't1', name: 'Prod' }])
  const updated = await client.setWorkflowTags('lchqi', '42', ['t1', 't2'])
  assert.equal(updated.data.length, 2)
  assert.deepEqual(calls.find(call => call.method === 'PUT').body, [{ id: 't1' }, { id: 't2' }])
})

test('stopExecution posts to /executions/{id}/stop', async () => {
  const { fetchImpl, calls } = makeFetch({
    'POST /api/v1/executions/9/stop': { body: { id: '9', workflowId: '7', status: 'canceled', mode: 'manual' } },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  const result = await client.stopExecution('lchqi', '9')
  assert.equal(result.status, 'canceled')
  assert.equal(calls[0].path, '/api/v1/executions/9/stop')
})

test('stopExecution reports the settled state when the execution already ended', async () => {
  const { fetchImpl } = makeFetch({
    'POST /api/v1/executions/9/stop': {
      status: 409,
      body: { message: 'Only running or waiting executions can be stopped and 9 is currently success' },
    },
    'GET /api/v1/executions/9': { body: { id: '9', workflowId: '7', status: 'success' } },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  const result = await client.stopExecution('lchqi', '9')
  assert.equal(result.status, 'success')
  assert.equal(result.id, '9')
})

function makeToolHarness(overrides = {}, storeOverrides = {}) {
  const calls = []
  const audits = []
  const client = new Proxy({}, {
    get(_target, method) {
      return async (...args) => {
        calls.push({ method, args })
        const handler = overrides[method]
        if (handler === undefined) throw new Error(`unexpected client.${String(method)}`)
        return handler(...args)
      }
    },
  })
  const fakeStore = {
    list: () => [],
    summarize: entry => entry,
    defaultAlias: () => undefined,
    require: alias => ({ alias, baseUrl: 'https://n8n.test', apiKey: 'secret-key', ...storeOverrides.entry }),
    ...storeOverrides,
  }
  const tools = toolSpecs({ store: fakeStore, client, audit: record => audits.push(record) })
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
  return { tools, byName, calls, audits }
}

test('every registered tool is named in the guidance', () => {
  const { tools } = makeToolHarness()
  assert.equal(tools.length, 25)
  assert.deepEqual(tools.map(tool => tool.name), N8N_TOOL_NAMES)
})

test('clone tool defaults copyTags to true and warns about shared webhook paths', async () => {
  const { byName, calls } = makeToolHarness({
    cloneWorkflow: async () => ({
      id: '8',
      name: 'Daily sync（副本）',
      active: false,
      source: { id: '7', name: 'Daily sync', active: true },
      nodes: sourceWorkflow.nodes,
    }),
  })
  const result = await byName.n8n_workflow_clone.execute({ alias: 'lchqi', id: '7' }, { signal: undefined })
  assert.equal(result.warnings.length, 2)
  assert.equal(calls[0].args[2].copyTags, true)
  assert.equal(calls[0].args[2].publish, false)
  const rendered = byName.n8n_workflow_clone.output.render({}, result)
  assert.match(rendered[0].text, /已克隆工作流 8/)
  assert.match(rendered[0].text, /daily-sync/)
})

test('workflow tags tool resolves names to ids before writing', async () => {
  const { byName, calls } = makeToolHarness({
    listAllTags: async () => [{ id: 't1', name: 'Prod' }, { id: 't2', name: 'Stage' }],
    setWorkflowTags: async () => ({ data: [{ id: 't1', name: 'Prod' }] }),
  })
  await byName.n8n_workflow_tags.execute({ alias: 'lchqi', id: '42', action: 'set', tagNames: ['Prod'] }, {})
  assert.deepEqual(calls.find(call => call.method === 'setWorkflowTags').args.slice(0, 3), ['lchqi', '42', ['t1']])

  await assert.rejects(
    () => byName.n8n_workflow_tags.execute({ alias: 'lchqi', id: '42', action: 'set', tagNames: ['Nope'] }, {}),
    /标签不存在：Nope/,
  )
})

test('cancel tool renders canceled / already-finished outcomes', () => {
  const { byName } = makeToolHarness()
  const tool = byName.n8n_execution_cancel
  assert.match(tool.output.render({}, { id: '9', status: 'canceled' })[0].text, /已取消执行 9/)
  assert.match(tool.output.render({}, { id: '9', status: 'success' })[0].text, /已经结束/)
})

test('callWebhook keeps a reverse-proxy path prefix from the base URL', async () => {
  const calls = []
  const prefixed = { require: () => ({ alias: 'proxy', baseUrl: 'https://n8n.test/n8n', apiKey: 'secret-key' }) }
  const client = new N8nClient(prefixed, {
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init.method })
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await client.callWebhook('proxy', { path: 'daily-sync', method: 'POST', body: { a: 1 } })
  assert.equal(calls[0].url, 'https://n8n.test/n8n/webhook/daily-sync')
  assert.equal(result.url, 'https://n8n.test/n8n/webhook/daily-sync')
  assert.equal(result.ok, true)
})

test('callWebhook on a root-mounted instance stays at the origin', async () => {
  const calls = []
  const client = new N8nClient(store, {
    fetch: async (url) => {
      calls.push(String(url))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await client.callWebhook('lchqi', { path: '/hook', mode: 'test' })
  assert.equal(calls[0], 'https://n8n.test/webhook-test/hook')
})

test('updateWorkflow refuses to overwrite a newer version', async () => {
  const { fetchImpl, calls } = makeFetch({
    'GET /api/v1/workflows/7': { body: { ...sourceWorkflow, versionId: 'v4', updatedAt: '2026-01-01T00:00:00.000Z' } },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  await assert.rejects(
    () => client.updateWorkflow('lchqi', '7', { ...sourceWorkflow, versionId: 'v3' }),
    error => error.status === 409
      && error.code === 'WORKFLOW_VERSION_CONFLICT'
      && /v3/.test(error.message)
      && /v4/.test(error.message),
  )
  assert.equal(calls.some(call => call.method === 'PUT'), false)
})

test('updateWorkflow forwards the base version and reports the guard', async () => {
  const { fetchImpl, calls } = makeFetch({
    'GET /api/v1/workflows/7': { body: sourceWorkflow },
    'PUT /api/v1/workflows/7': { body: { ...sourceWorkflow } },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  const result = await client.updateWorkflow('lchqi', '7', sourceWorkflow)
  assert.equal(result.concurrency, 'checked')
  assert.equal(calls.find(call => call.method === 'PUT').body.versionId, 'v3')
})

test('updateWorkflow skips the guard when the instance has no versionId', async () => {
  const withoutVersion = { ...sourceWorkflow }
  delete withoutVersion.versionId
  const { fetchImpl, calls } = makeFetch({
    'GET /api/v1/workflows/7': { body: withoutVersion },
    'PUT /api/v1/workflows/7': { body: { ...withoutVersion } },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  const result = await client.updateWorkflow('lchqi', '7', { ...sourceWorkflow, versionId: 'v3' })
  assert.equal(result.concurrency, 'unsupported')
  assert.equal(calls.find(call => call.method === 'PUT').body.versionId, undefined)
})

test('update tool render explains an unguarded write', () => {
  const { byName } = makeToolHarness()
  const rendered = byName.n8n_workflow_update.output.render({}, { id: '7', name: '流程', active: false, concurrency: 'unchecked' })[0].text
  assert.match(rendered, /未提供 versionId/)
  const guarded = byName.n8n_workflow_update.output.render({}, { id: '7', name: '流程', active: false, concurrency: 'checked' })[0].text
  assert.doesNotMatch(guarded, /并发保护/)
})

const webhookWorkflow = {
  id: '7',
  name: 'Hook 流程',
  active: true,
  nodes: [{ id: 'w1', name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'hook', httpMethod: 'POST' } }],
  connections: {},
}

test('webhook_call attributes the run created after the call and warns when ambiguous', async () => {
  let listings = 0
  const waitCalls = []
  const { byName } = makeToolHarness({
    getWorkflow: async () => webhookWorkflow,
    listExecutions: async () => {
      listings += 1
      if (listings === 1) {
        return { data: [{ id: '100', status: 'success', startedAt: '2026-01-01T00:00:00.000Z' }] }
      }
      return {
        data: [
          { id: '102', status: 'running', startedAt: '2026-01-01T00:00:02.000Z' },
          { id: '101', status: 'running', startedAt: '2026-01-01T00:00:01.000Z' },
          { id: '100', status: 'success', startedAt: '2026-01-01T00:00:00.000Z' },
        ],
      }
    },
    callWebhook: async () => ({ url: 'https://n8n.test/webhook/hook', status: 200, ok: true, durationMs: 3, body: { ok: true } }),
    waitExecution: async (_alias, id) => {
      waitCalls.push(id)
      return { execution: { id, status: 'success' }, waitedMs: 5, timedOut: false }
    },
  })
  const result = await byName.n8n_webhook_call.execute({ alias: 'lchqi', id: '7' }, {})
  assert.deepEqual(waitCalls, ['101'])
  assert.equal(result.execution.id, '101')
  assert.ok(result.warnings.some(warning => /2 条新执行/.test(warning)))
})

test('webhook_call ignores executions that started before the call', async () => {
  let listings = 0
  const waitCalls = []
  const { byName } = makeToolHarness({
    getWorkflow: async () => webhookWorkflow,
    listExecutions: async () => {
      listings += 1
      if (listings === 1) {
        return { data: [{ id: '100', status: 'success', startedAt: '2026-01-01T00:00:10.000Z' }] }
      }
      return {
        data: [
          { id: '101', status: 'running', startedAt: '2026-01-01T00:00:12.000Z' },
          { id: '099', status: 'running', startedAt: '2026-01-01T00:00:01.000Z' },
          { id: '100', status: 'running', startedAt: '2026-01-01T00:00:10.000Z' },
        ],
      }
    },
    callWebhook: async () => ({ url: 'https://n8n.test/webhook/hook', status: 200, ok: true, durationMs: 3, body: { ok: true } }),
    waitExecution: async (_alias, id) => {
      waitCalls.push(id)
      return { execution: { id, status: 'success' }, waitedMs: 5, timedOut: false }
    },
  })
  const result = await byName.n8n_webhook_call.execute({ alias: 'lchqi', id: '7' }, {})
  assert.deepEqual(waitCalls, ['101'])
  assert.equal(result.warnings.some(warning => /条新执行/.test(warning)), false)
})

// ---------------------------------------------------------------------------
// P1 安全：凭证间接引用 / 只读实例 / 审计日志
// ---------------------------------------------------------------------------

test('resolveApiKey prefers env over file over inline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-n8n-key-'))
  const file = join(dir, 'key.txt')
  writeFileSync(file, 'file-key-123\n', 'utf8')
  process.env.N8N_TEST_P1_KEY = 'env-key-123'
  try {
    assert.equal(
      resolveApiKey({ alias: 'a', apiKey: 'inline-key', apiKeyEnv: 'N8N_TEST_P1_KEY', apiKeyFile: file }),
      'env-key-123',
    )
  } finally {
    delete process.env.N8N_TEST_P1_KEY
  }
  assert.equal(
    resolveApiKey({ alias: 'a', apiKey: 'inline-key', apiKeyFile: file }),
    'file-key-123',
  )
  assert.equal(resolveApiKey({ alias: 'a', apiKey: 'inline-key' }), 'inline-key')
})

test('resolveApiKey explains missing env, unreadable and empty key files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-n8n-key-'))
  const empty = join(dir, 'empty.txt')
  writeFileSync(empty, '   \n', 'utf8')
  assert.throws(
    () => resolveApiKey({ alias: 'a', apiKeyEnv: 'N8N_TEST_MISSING_KEY' }),
    /N8N_TEST_MISSING_KEY 未设置或为空/,
  )
  assert.throws(
    () => resolveApiKey({ alias: 'a', apiKeyFile: join(dir, 'nope.txt') }),
    /无法读取/,
  )
  assert.throws(() => resolveApiKey({ alias: 'a', apiKeyFile: empty }), /是空的/)
  assert.throws(() => resolveApiKey({ alias: 'a' }), /没有可用的 API Key/)
})

test('InstanceStore persists credential references and readOnly across reloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-n8n-store-'))
  const path = join(dir, 'store.json')
  const first = new InstanceStore(path)
  const entry = first.create({ alias: 'prod', baseUrl: 'https://n8n.example.com/', apiKeyEnv: 'N8N_PROD_KEY', readOnly: true })
  assert.equal(entry.apiKeyEnv, 'N8N_PROD_KEY')
  assert.equal(entry.readOnly, true)
  assert.equal(entry.apiKey, undefined)

  const second = new InstanceStore(path)
  const reloaded = second.require('prod')
  assert.equal(reloaded.apiKeyEnv, 'N8N_PROD_KEY')
  assert.equal(reloaded.readOnly, true)
  const summary = second.summarize(reloaded)
  assert.equal(summary.credentialSource, 'env')
  assert.equal(summary.apiKeyConfigured, true)
  assert.equal(summary.readOnly, true)

  // 不能移除实例的全部凭证：仅剩 env 引用时清空它会被拒绝，且磁盘内容不变。
  assert.throws(
    () => second.update('prod', { apiKeyEnv: '' }),
    /不能移除实例的全部凭证/,
  )
  assert.equal(second.require('prod').apiKeyEnv, 'N8N_PROD_KEY')

  // 提供替代凭证后才能移除 env 引用；readOnly 可以单独关闭。
  second.update('prod', { apiKeyEnv: '', apiKey: 'inline-key' })
  const after = second.require('prod')
  assert.equal(after.apiKeyEnv, undefined)
  assert.equal(after.apiKey, 'inline-key')
  assert.equal(second.summarize(after).credentialSource, 'inline')

  second.update('prod', { readOnly: false })
  assert.equal(second.summarize(second.require('prod')).readOnly, false)
})

test('a read-only instance blocks write tools and records the refusal', async () => {
  const { byName, audits } = makeToolHarness({
    deleteWorkflow: async () => { throw new Error('should not be called') },
  }, { entry: { readOnly: true } })
  await assert.rejects(
    () => byName.n8n_workflow_delete.execute({ alias: 'lchqi', id: '7' }, {}),
    /只读模式/,
  )
  assert.equal(audits.length, 1)
  assert.equal(audits[0].ok, false)
  assert.equal(audits[0].tool, 'n8n_workflow_delete')
  assert.equal(audits[0].alias, 'lchqi')
  assert.match(audits[0].error, /只读/)
})

test('workflow tag writes are guarded on read-only instances while reads pass', async () => {
  const { byName, audits } = makeToolHarness({
    getWorkflowTags: async () => ({ data: [{ id: 't1', name: 'Prod' }] }),
  }, { entry: { readOnly: true } })
  const read = await byName.n8n_workflow_tags.execute({ alias: 'lchqi', id: '7', action: 'get' }, {})
  assert.deepEqual(read.data, [{ id: 't1', name: 'Prod' }])
  assert.equal(audits.length, 0)

  await assert.rejects(
    () => byName.n8n_workflow_tags.execute({ alias: 'lchqi', id: '7', action: 'set', tagIds: ['1'] }, {}),
    /只读模式/,
  )
  assert.equal(audits.length, 1)
  assert.equal(audits[0].ok, false)
})

test('n8n_api on a read-only instance rejects writes and allows un-audited reads', async () => {
  const { byName, audits, calls } = makeToolHarness({
    raw: async (_alias, request) => ({ status: 200, ok: true, ...request }),
  }, { entry: { readOnly: true } })
  await assert.rejects(
    () => byName.n8n_api.execute({ alias: 'lchqi', method: 'DELETE', path: '/workflows/7' }, {}),
    /只读模式/,
  )
  assert.equal(audits.length, 1)
  assert.equal(audits[0].target, 'DELETE /workflows/7')
  assert.equal(calls.length, 0)

  const read = await byName.n8n_api.execute({ alias: 'lchqi', method: 'GET', path: '/workflows' }, {})
  assert.equal(read.method, 'GET')
  assert.equal(audits.length, 1)
  assert.equal(calls.length, 1)
})

test('successful writes are audited with a duration', async () => {
  const { byName, audits } = makeToolHarness({ deleteWorkflow: async () => ({ id: '7' }) })
  await byName.n8n_workflow_delete.execute({ alias: 'lchqi', id: '7' }, {})
  assert.equal(audits.length, 1)
  assert.equal(audits[0].ok, true)
  assert.equal(audits[0].target, '7')
  assert.equal(audits[0].actor, 'agent')
  assert.equal(typeof audits[0].durationMs, 'number')
})

test('appendAudit and readAudit round-trip newest first and skip torn lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-n8n-audit-'))
  const path = join(dir, 'audit.log')
  for (let index = 1; index <= 3; index += 1) {
    appendAudit({ actor: 'agent', tool: 't', alias: 'a', ok: true, seq: index }, { path })
  }
  writeFileSync(path, readFileSync(path, 'utf8') + '{torn\n', 'utf8')
  const newestTwo = readAudit({ limit: 2, path })
  assert.equal(newestTwo.length, 2)
  assert.equal(newestTwo[0].seq, 3)
  assert.equal(newestTwo[1].seq, 2)
  assert.equal(readAudit({ path }).length, 3)
  assert.equal(readAudit({ path: join(dir, 'missing.log') }).length, 0)
})

test('appendAudit rotates oversized logs and never throws on an unwritable path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-n8n-audit-'))
  const path = join(dir, 'audit.log')
  const filler = 'x'.repeat(2000)
  writeFileSync(
    path,
    Array.from({ length: 600 }, (_, index) => JSON.stringify({ seq: index, filler })).join('\n') + '\n',
    'utf8',
  )
  appendAudit({ actor: 'agent', ok: true, seq: 'new' }, { path })
  const entries = readAudit({ limit: 1000, path })
  assert.equal(entries.length, 501)
  assert.equal(entries[0].seq, 'new')
  assert.equal(entries[entries.length - 1].seq, 100)

  const blocker = join(dir, 'blocker.txt')
  writeFileSync(blocker, 'not a directory', 'utf8')
  assert.doesNotThrow(() => appendAudit({ ok: true }, { path: join(blocker, 'audit.log') }))
})

// ---------------------------------------------------------------------------
// P0 additions: variables, data tables, instance probe, error patterns.
// ---------------------------------------------------------------------------

test('variable keys and values are validated before any request', () => {
  assert.throws(() => validateVariableKey(''), /key 不能为空/)
  assert.throws(() => validateVariableKey('9bad'), /不合法/)
  assert.throws(() => validateVariableKey('a'.repeat(51)), /最多 50/)
  assert.equal(validateVariableKey(' api_KEY1 '), 'api_KEY1')
  assert.throws(() => validateVariableValue({ a: 1 }), /JSON\.stringify/)
  assert.throws(() => validateVariableValue('x'.repeat(1001)), /最多 1000/)
  assert.equal(validateVariableValue(42), '42')
  assert.equal(validateVariableValue(true), 'true')
})

test('setVariable upserts: create when the key is missing, PUT when it exists', async () => {
  const { fetchImpl, calls } = makeFetch({
    'GET /api/v1/variables': { status: 200, body: { data: [{ id: 'v1', key: 'existing', value: 'old' }], nextCursor: null } },
    'POST /api/v1/variables': { status: 201, body: '' },
    'PUT /api/v1/variables/v1': { status: 204 },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  const updated = await client.setVariable('lchqi', 'existing', 'new')
  assert.deepEqual(updated, { id: 'v1', key: 'existing', value: 'new', created: false })
  const created = await client.setVariable('lchqi', 'brand_new', '1')
  assert.equal(created.created, true)
  const post = calls.find(call => call.method === 'POST')
  assert.deepEqual(post.body, { key: 'brand_new', value: '1' })
  const put = calls.find(call => call.method === 'PUT')
  assert.deepEqual(put.body, { key: 'existing', value: 'new' })
})

test('data table CRUD validates names and columns before sending', async () => {
  assert.throws(() => validateDataTableName('  '), /名称不能为空/)
  assert.throws(() => validateDataTableColumn({ name: '9bad', type: 'string' }), /列名/)
  assert.throws(() => validateDataTableColumn({ name: 'ok', type: 'text' }), /类型/)
  const { fetchImpl, calls } = makeFetch({
    'GET /api/v1/data-tables': { status: 200, body: { data: [{ id: 'dt1', name: 'runs', columns: [] }], nextCursor: null } },
    'POST /api/v1/data-tables': { status: 201, body: { id: 'dt2', name: 'leads', columns: [{ id: 'c1', name: 'email', type: 'string', index: 0 }] } },
    'GET /api/v1/data-tables/dt1': { status: 200, body: { id: 'dt1', name: 'runs', columns: [] } },
    'DELETE /api/v1/data-tables/dt1': { status: 204 },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  const created = await client.createDataTable('lchqi', { name: ' leads ', columns: [{ name: 'Email', type: 'string' }] })
  assert.equal(created.id, 'dt2')
  assert.deepEqual(calls.find(call => call.method === 'POST').body, { name: 'leads', columns: [{ name: 'Email', type: 'string' }] })
  const got = await client.getDataTable('lchqi', 'dt1')
  assert.equal(got.name, 'runs')
  await client.deleteDataTable('lchqi', 'dt1')
  const listing = await client.listDataTables('lchqi')
  assert.equal(listing.data[0].id, 'dt1')
})

test('data table rows: filter serialization and mutation shapes', async () => {
  const filter = { type: 'and', filters: [{ columnName: 'status', condition: 'eq', value: 'active' }] }
  const { fetchImpl, calls } = makeFetch({
    'GET /api/v1/data-tables/dt1/rows': { status: 200, body: { data: [{ id: 1, status: 'active' }], nextCursor: null } },
    'POST /api/v1/data-tables/dt1/rows': { status: 201, body: { success: true, insertedRows: 2 } },
    'PATCH /api/v1/data-tables/dt1/rows/update': { status: 200, body: true },
    'POST /api/v1/data-tables/dt1/rows/upsert': { status: 200, body: true },
    'DELETE /api/v1/data-tables/dt1/rows': { status: 200, body: true },
    'DELETE /api/v1/data-tables/dt1/rows/clear': { status: 200, body: { deletedCount: 5 } },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  await client.listDataTableRows('lchqi', 'dt1', { filter, limit: 50 })
  await client.insertDataTableRows('lchqi', 'dt1', [{ status: 'a' }, { status: 'b' }])
  await client.updateDataTableRows('lchqi', 'dt1', { filter, data: { status: 'idle' } })
  await client.upsertDataTableRows('lchqi', 'dt1', { filter, data: { status: 'new' } })
  await client.deleteDataTableRows('lchqi', 'dt1', { filter })
  await client.clearDataTableRows('lchqi', 'dt1')
  const listParams = new URL('https://x.test/' + calls[0].search).searchParams
  assert.equal(listParams.get('limit'), '50')
  assert.deepEqual(JSON.parse(listParams.get('filter')), filter)
  const insert = calls[1]
  assert.equal(insert.body.data.length, 2)
  assert.equal(insert.body.returnType, undefined)
  assert.deepEqual(calls[2].body, { filter, data: { status: 'idle' } })
  assert.deepEqual(calls[3].body, { filter, data: { status: 'new' } })
  const deleteParams = new URL('https://x.test/' + calls[4].search).searchParams
  assert.deepEqual(JSON.parse(deleteParams.get('filter')), filter)
  await assert.rejects(() => client.deleteDataTableRows('lchqi', 'dt1', { filter: { type: 'and', filters: [] } }), /不能为空/)
  await assert.rejects(() => client.deleteDataTableRows('lchqi', 'dt1', {}), /filter 是必填项/)
  assert.throws(() => validateRowFilter({ type: 'and', filters: [] }, { required: true }), /不能为空/)
  assert.throws(() => validateRowFilter({ filters: [{ columnName: 'a', condition: 'regex', value: 1 }] }), /不支持的过滤条件/)
  assert.equal(rowFilterQuery(undefined), undefined)
})

test('probeInstance classifies endpoint availability by HTTP status', async () => {
  const { fetchImpl, calls } = makeFetch({
    'GET /api/v1/workflows': { status: 200, body: { data: [] } },
    'GET /api/v1/executions': { status: 200, body: { data: [] } },
    'GET /api/v1/tags': { status: 200, body: { data: [] } },
    'GET /api/v1/credentials': { status: 200, body: { data: [] } },
    'GET /api/v1/variables': { status: 403, body: { message: 'License required' } },
    'GET /api/v1/data-tables': { status: 404, body: { message: 'Not Found' } },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  const probe = await client.probeInstance('lchqi')
  assert.equal(probe.reachable, true)
  assert.equal(probe.capabilities.workflows.available, true)
  assert.equal(probe.capabilities.variables.available, false)
  assert.equal(probe.capabilities.variables.kind, 'forbidden')
  assert.equal(probe.capabilities.dataTables.kind, 'absent')
  assert.equal(calls.length, N8nClient.PROBE_ENDPOINTS.length)
})

test('probeInstance reports a transport failure once and stops', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed')
  }
  const client = new N8nClient(store, { fetch: fetchImpl })
  const probe = await client.probeInstance('lchqi')
  assert.equal(probe.reachable, false)
  assert.match(probe.errorMessage, /n8n 请求失败/)
})

test('variables tool: set/delete are audited, get filters locally', async () => {
  const { byName, calls, audits } = makeToolHarness({
    listVariables: async () => ({ data: [{ id: 'v1', key: 'existing', value: 'old' }], nextCursor: null }),
    listAllVariables: async () => [{ id: 'v1', key: 'existing', value: 'old' }],
    setVariable: async (_alias, key, value) => ({ id: 'v1', key, value, created: false }),
    deleteVariable: async () => ({ deleted: true, id: 'v1' }),
  })
  const variables = byName.n8n_variables
  const set = await variables.execute({ alias: 'lchqi', action: 'set', key: 'existing', value: 'new' }, { signal: undefined })
  assert.equal(set.created, false)
  await variables.execute({ alias: 'lchqi', action: 'delete', key: 'existing' }, { signal: undefined })
  assert.equal(calls.some(call => call.method === 'deleteVariable'), true)
  const got = await variables.execute({ alias: 'lchqi', action: 'get', key: 'exist' }, { signal: undefined })
  assert.equal(got.data.length, 1)
  assert.match(variables.output.render({ action: 'set' }, set)[0].text, /已更新/)
  await assert.rejects(() => variables.execute({ alias: 'lchqi', action: 'delete', key: 'missing' }, { signal: undefined }), /不存在/)
  assert.deepEqual(audits.map(entry => entry.target), ['existing', 'existing', 'missing'])
})

test('data tables and rows tool writes are audited with precise targets', async () => {
  const { byName, audits } = makeToolHarness({
    deleteDataTable: async () => ({ deleted: true, id: 'dt9' }),
    insertDataTableRows: async () => ({ success: true, insertedRows: 1 }),
    listDataTableRows: async () => ({ data: [], nextCursor: null }),
  })
  await byName.n8n_datatables.execute({ alias: 'lchqi', action: 'delete', dataTableId: 'dt9' }, { signal: undefined })
  await byName.n8n_datatable_rows.execute({ alias: 'lchqi', action: 'insert', dataTableId: 'dt9', rows: [{ a: 1 }] }, { signal: undefined })
  const list = await byName.n8n_datatable_rows.execute({ alias: 'lchqi', action: 'list', dataTableId: 'dt9' }, { signal: undefined })
  assert.deepEqual(list.data, [])
  assert.deepEqual(audits.map(entry => entry.target), ['dt9', 'insert dt9'])
})

test('read-only instances refuse variable/table/row writes but allow reads', async () => {
  const { byName, audits } = makeToolHarness({
    listVariables: async () => ({ data: [], nextCursor: null }),
    listDataTables: async () => ({ data: [], nextCursor: null }),
    listDataTableRows: async () => ({ data: [], nextCursor: null }),
  }, { entry: { readOnly: true } })
  await byName.n8n_variables.execute({ alias: 'lchqi', action: 'get' }, { signal: undefined })
  await byName.n8n_datatables.execute({ alias: 'lchqi', action: 'list' }, { signal: undefined })
  await byName.n8n_datatable_rows.execute({ alias: 'lchqi', action: 'list', dataTableId: 'dt1' }, { signal: undefined })
  await assert.rejects(() => byName.n8n_variables.execute({ alias: 'lchqi', action: 'set', key: 'a', value: 'b' }, { signal: undefined }), /只读模式/)
  await assert.rejects(() => byName.n8n_datatables.execute({ alias: 'lchqi', action: 'create', name: 'x', columns: [] }, { signal: undefined }), /只读模式/)
  await assert.rejects(() => byName.n8n_datatable_rows.execute({ alias: 'lchqi', action: 'clear', dataTableId: 'dt1' }, { signal: undefined }), /只读模式/)
  assert.equal(audits.filter(entry => entry.ok === false).length, 3)
})

test('probe renders reachable capabilities and transport failures', () => {
  const { byName } = makeToolHarness({
    probeInstance: async () => ({ alias: 'lchqi', baseUrl: 'https://n8n.test', reachable: true, capabilities: { workflows: { available: true }, variables: { available: false, kind: 'forbidden' } } }),
  })
  const probe = byName.n8n_instances
  const reachable = probe.output.render({ action: 'probe' }, { probe: { alias: 'x', reachable: false, errorMessage: 'boom', capabilities: {} } })
  assert.match(reachable[0].text, /不可达/)
})

test('execution error patterns match the common failure classes', () => {
  const hints = matchExecutionErrorPatterns('Cannot read properties of undefined (reading id) — HTTP 429 Too Many Requests')
  assert.equal(hints.length, 2)
  assert.match(hints[0], /限流/)
  assert.match(hints[1], /undefined/)
  assert.deepEqual(matchExecutionErrorPatterns('all good here'), [])
  assert.deepEqual(matchExecutionErrorPatterns(''), [])
})

test('failed execution render appends error-pattern hints', () => {
  const rendered = renderExecutionDetail({
    id: 'e1',
    workflowId: 'w1',
    status: 'error',
    data: {
      resultData: {
        runData: { 'HTTP Request': [{ error: { message: '401 Unauthorized' } }] },
        error: { message: '401 Unauthorized' },
      },
    },
  })
  assert.match(rendered, /错误模式提示/)
  assert.match(rendered, /凭证/)
})

// ---------------------------------------------------------------------------
// instance health (client aggregation + route-level degradation)
// ---------------------------------------------------------------------------

test('N8nClient.health 汇总工作流分页总数与执行抽样', async () => {
  const { fetchImpl, calls } = makeFetch({
    'GET /api/v1/workflows': (call) => (call.search.includes('cursor=')
      ? { status: 200, body: { data: [{ id: 'w3', active: true }], nextCursor: '' } }
      : { status: 200, body: { data: [{ id: 'w1', active: true }, { id: 'w2', active: false }], nextCursor: 'p2' } }),
    'GET /api/v1/executions': {
      status: 200,
      body: {
        data: [
          { id: 'e1', status: 'success' },
          { id: 'e2', status: 'error' },
          { id: 'e3', status: 'running' },
          { id: 'e4', status: 'crashed' },
        ],
      },
    },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  const health = await client.health('lchqi')
  assert.equal(health.ok, true)
  assert.equal(health.alias, 'lchqi')
  assert.equal(health.baseUrl, 'https://n8n.test')
  assert.equal(health.workflows.total, 3)
  assert.equal(health.workflows.active, 2)
  assert.equal(health.workflows.truncated, false)
  assert.equal(health.executions.sampled, 4)
  assert.equal(health.executions.counts.success, 1)
  assert.equal(health.executions.counts.running, 1)
  assert.equal(health.executions.finished, 3)
  assert.equal(health.executions.failed, 2)
  assert.ok(Math.abs(health.executions.failureRate - 2 / 3) < 1e-9)
  // Walk order: workflow pages first (2 calls), then the execution sample.
  assert.deepEqual(calls.map(call => call.path), ['/api/v1/workflows', '/api/v1/workflows', '/api/v1/executions'])
  assert.match(calls[0].search, /limit=250/)
  assert.match(calls[1].search, /cursor=p2/)
  assert.match(calls[2].search, /limit=100/)
})

test('N8nClient.health 在页数预算耗尽时标记 truncated', async () => {
  const { fetchImpl } = makeFetch({
    'GET /api/v1/workflows': { status: 200, body: { data: [{ id: 'w1', active: false }], nextCursor: 'more' } },
    'GET /api/v1/executions': { status: 200, body: { data: [] } },
  })
  const client = new N8nClient(store, { fetch: fetchImpl })
  const health = await client.health('lchqi')
  assert.equal(health.workflows.total, 4)
  assert.equal(health.workflows.truncated, true)
  assert.equal(health.executions.sampled, 0)
  assert.equal(health.executions.failureRate, null)
})

test('collectHealth 将单实例失败降级为 ok:false 条目', async () => {
  const fakeStore = { list: () => [{ alias: 'good' }, { alias: 'bad' }] }
  const fakeClient = {
    health: async (alias) => {
      if (alias === 'bad') throw new Error('connect ECONNREFUSED')
      return {
        ok: true,
        alias,
        baseUrl: 'https://n8n.test',
        latencyMs: 3,
        workflows: { total: 1, active: 1, truncated: false },
        executions: { sampled: 0, counts: {}, finished: 0, failed: 0, failureRate: null },
      }
    },
  }
  const instances = await collectHealth(fakeStore, fakeClient)
  assert.equal(instances.length, 2)
  assert.equal(instances[0].ok, true)
  assert.equal(instances[0].alias, 'good')
  assert.equal(instances[1].ok, false)
  assert.equal(instances[1].alias, 'bad')
  assert.equal(instances[1].error, 'connect ECONNREFUSED')
})

// ---------------------------------------------------------------------------
// P0 fixes: output.schema alignment, variables paging, render data.main,
// apiKeyFile tilde expansion, and InstanceStore cache isolation.
// ---------------------------------------------------------------------------

function matchesSchema(value, schema) {
  if (schema === undefined) return true
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.some(branch => matchesSchema(value, branch))
  }
  if (schema.type === 'null') return value === null
  if (schema.type === 'boolean') return typeof value === 'boolean'
  if (schema.type === 'number') return typeof value === 'number'
  if (schema.type === 'string') return typeof value === 'string'
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return false
    return schema.items === undefined || value.every(item => matchesSchema(item, schema.items))
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const props = schema.properties ?? {}
    for (const [key, propSchema] of Object.entries(props)) {
      if (propSchema.required === true && !(key in value)) return false
      if (key in value && value[key] !== undefined && !matchesSchema(value[key], propSchema)) return false
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) return false
      }
    }
    return true
  }
  return true
}

test('composite tools and n8n_api return values satisfy their output.schema', async () => {
  const { byName } = makeToolHarness({
    probeInstance: async () => ({ alias: 'lchqi', baseUrl: 'https://n8n.test', reachable: true, capabilities: {} }),
    listVariables: async () => ({ data: [{ id: 'v1', key: 'k', value: 'v' }], nextCursor: null }),
    listAllVariables: async () => [{ id: 'v1', key: 'k', value: 'v' }],
    setVariable: async (_alias, key, value) => ({ key, value, created: true }),
    deleteVariable: async () => ({ deleted: true, id: 'v1' }),
    listDataTables: async () => ({ data: [], nextCursor: null }),
    getDataTable: async () => ({ id: 'dt1', name: 't', columns: [] }),
    createDataTable: async () => ({ id: 'dt1', name: 't', columns: [] }),
    deleteDataTable: async () => ({ deleted: true, id: 'dt1' }),
    listDataTableRows: async () => ({ data: [{ id: 1 }], nextCursor: null }),
    insertDataTableRows: async () => ({ success: true, insertedRows: 1 }),
    raw: async () => [{ id: 't1', name: 'Prod' }],
  })

  assert.equal(matchesSchema(await byName.n8n_instances.execute({ action: 'list' }, {}), byName.n8n_instances.output.schema), true)
  assert.equal(matchesSchema(await byName.n8n_instances.execute({ action: 'probe', alias: 'lchqi' }, {}), byName.n8n_instances.output.schema), true)
  assert.equal(matchesSchema(await byName.n8n_variables.execute({ alias: 'lchqi', action: 'get' }, {}), byName.n8n_variables.output.schema), true)
  assert.equal(matchesSchema(await byName.n8n_variables.execute({ alias: 'lchqi', action: 'set', key: 'k', value: 'v' }, {}), byName.n8n_variables.output.schema), true)
  assert.equal(matchesSchema(await byName.n8n_variables.execute({ alias: 'lchqi', action: 'delete', id: 'v1' }, {}), byName.n8n_variables.output.schema), true)
  assert.equal(matchesSchema(await byName.n8n_datatables.execute({ alias: 'lchqi', action: 'list' }, {}), byName.n8n_datatables.output.schema), true)
  assert.equal(matchesSchema(await byName.n8n_datatables.execute({ alias: 'lchqi', action: 'get', dataTableId: 'dt1' }, {}), byName.n8n_datatables.output.schema), true)
  assert.equal(matchesSchema(await byName.n8n_datatables.execute({ alias: 'lchqi', action: 'delete', dataTableId: 'dt1' }, {}), byName.n8n_datatables.output.schema), true)
  assert.equal(matchesSchema(await byName.n8n_datatable_rows.execute({ alias: 'lchqi', action: 'list', dataTableId: 'dt1' }, {}), byName.n8n_datatable_rows.output.schema), true)
  assert.equal(matchesSchema(await byName.n8n_datatable_rows.execute({ alias: 'lchqi', action: 'insert', dataTableId: 'dt1', rows: [{ a: 1 }] }, {}), byName.n8n_datatable_rows.output.schema), true)
  assert.equal(matchesSchema(await byName.n8n_api.execute({ alias: 'lchqi', method: 'GET', path: '/workflows/1/tags' }, {}), byName.n8n_api.output.schema), true)
})

test('n8n_variables get with key filter searches across all pages when cursor is omitted', async () => {
  const { byName, calls } = makeToolHarness({
    listAllVariables: async () => [
      { id: 'v1', key: 'ALPHA', value: '1' },
      { id: 'v2', key: 'TARGET_PAGE2', value: '2' },
    ],
  })
  const result = await byName.n8n_variables.execute({ alias: 'lchqi', action: 'get', key: 'page2' }, { signal: undefined })
  assert.equal(calls.some(call => call.method === 'listAllVariables'), true)
  assert.deepEqual(result.data, [{ id: 'v2', key: 'TARGET_PAGE2', value: '2' }])
  assert.equal(result.nextCursor, null)
})

test('renderExecutionDetail extracts last node output from data.main and lastNodeExecuted', () => {
  const rendered = renderExecutionDetail({
    id: 'e2',
    workflowId: 'w1',
    status: 'success',
    data: {
      resultData: {
        lastNodeExecuted: 'Final',
        runData: {
          Start: [{ status: 'success', data: { main: [[{ json: { step: 1 } }]] } }],
          Final: [{ status: 'success', data: { main: [[{ json: { answer: 42 } }]] } }],
          Trailing: [{ status: 'success', data: { main: [[{ json: { step: 3 } }]] } }],
        },
      },
    },
  })
  assert.match(rendered, /末节点输出：\{"answer":42\}/)
})

test('resolveApiKey expands leading tilde in apiKeyFile', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-n8n-home-'))
  const secretPath = join(fakeHome, 'n8n.key')
  writeFileSync(secretPath, 'tilde-secret-key\n', 'utf8')
  assert.equal(resolveApiKey({ alias: 'a', apiKeyFile: '~/n8n.key' }, fakeHome), 'tilde-secret-key')
})

test('InstanceStore.update keeps cache clean when a later field validation fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-n8n-cache-'))
  const storeFile = join(dir, 'store.json')
  const instanceStore = new InstanceStore(storeFile)
  instanceStore.create({ alias: 'prod', baseUrl: 'https://n8n.example.com', apiKey: 'k1' })
  assert.throws(
    () => instanceStore.update('prod', { baseUrl: 'https://n8n.example.com/subpath', isDefault: 'invalid-bool' }),
    /isDefault 必须是布尔值/,
  )
  assert.equal(instanceStore.require('prod').baseUrl, 'https://n8n.example.com')
})

// ---------------------------------------------------------------------------
// P1 fixes: path traversal guard, origin change key protection, proxy/CSRF
// fence, and concurrent probeInstance.
// ---------------------------------------------------------------------------

test('N8nClient.request rejects path traversal outside /api/v1', async () => {
  const { fetchImpl, calls } = makeFetch({})
  const prefixed = { require: () => ({ alias: 'proxy', baseUrl: 'https://n8n.test/n8n', apiKey: 'secret' }) }
  const client = new N8nClient(prefixed, { fetch: fetchImpl })
  await assert.rejects(
    () => client.raw('proxy', { method: 'GET', path: '/../../rest/settings' }),
    error => error.code === 'INVALID_API_PATH' && /非法 API 路径/.test(error.message),
  )
  await assert.rejects(
    () => client.raw('proxy', { method: 'GET', path: '/../other' }),
    /非法 API 路径/,
  )
  assert.equal(calls.length, 0)
})

test('InstanceStore.update refuses changing baseUrl origin while retaining an inline apiKey', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-n8n-origin-'))
  const storeFile = join(dir, 'store.json')
  const instanceStore = new InstanceStore(storeFile)
  instanceStore.create({ alias: 'prod', baseUrl: 'https://prod.n8n.test', apiKey: 'prod-secret' })

  // Same origin (path change) is allowed without re-entering apiKey.
  const updatedPath = instanceStore.update('prod', { baseUrl: 'https://prod.n8n.test/subpath' })
  assert.equal(updatedPath.baseUrl, 'https://prod.n8n.test/subpath')

  // Different origin with retained inline key is rejected.
  assert.throws(
    () => instanceStore.update('prod', { baseUrl: 'https://attacker.example.com' }),
    /请重新填写 API Key/,
  )
  assert.equal(instanceStore.require('prod').baseUrl, 'https://prod.n8n.test/subpath')

  // Different origin with a new apiKey succeeds.
  const updatedOrigin = instanceStore.update('prod', { baseUrl: 'https://new.n8n.test', apiKey: 'new-secret' })
  assert.equal(updatedOrigin.baseUrl, 'https://new.n8n.test')
  assert.equal(updatedOrigin.apiKey, 'new-secret')
})

test('isProxiedRequest and isLoopbackRequest enforce proxy headers and CSRF header on writes', () => {
  assert.equal(isProxiedRequest({ headers: { forwarded: 'for=1.2.3.4' } }), true)
  assert.equal(isProxiedRequest({ headers: { 'x-real-ip': '1.2.3.4' } }), true)
  assert.equal(isProxiedRequest({ headers: { 'x-forwarded-host': 'evil.test' } }), true)

  const baseReq = (method, extraHeaders = {}) => ({
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:3000', ...extraHeaders },
  })
  assert.equal(isLoopbackRequest(baseReq('GET')), true)
  assert.equal(isLoopbackRequest(baseReq('DELETE')), false)
  assert.equal(isLoopbackRequest(baseReq('POST', { 'x-dsh-n8n-client': '1' })), true)
  assert.equal(isLoopbackRequest(baseReq('GET', { 'x-real-ip': '10.0.0.1' })), false)
})

// ---------------------------------------------------------------------------
// P2: default alias fallback, pinData/summaryOnly, n8n_workflow_patch, n8n_api clip.
// ---------------------------------------------------------------------------

test('tools fall back to store.defaultAlias when alias is omitted', async () => {
  const { byName, calls, audits } = makeToolHarness({
    listWorkflows: async () => ({ data: [], nextCursor: null }),
    deleteWorkflow: async () => ({ deleted: true, id: '7' }),
  }, { defaultAlias: () => 'prod' })

  await byName.n8n_workflows.execute({}, {})
  assert.equal(calls[0].args[0], 'prod')

  await byName.n8n_workflow_delete.execute({ id: '7' }, {})
  assert.equal(calls[1].args[0], 'prod')
  assert.equal(audits[0].alias, 'prod')

  const noDefault = makeToolHarness({}, { defaultAlias: () => undefined })
  await assert.rejects(() => noDefault.byName.n8n_workflows.execute({}, {}), /缺少实例别名/)
})

test('n8n_workflow_get omits pinData by default and supports summaryOnly', async () => {
  const wfWithPin = {
    ...sourceWorkflow,
    pinData: { Webhook: [{ json: { huge: 'x'.repeat(500) } }] },
  }
  const { byName } = makeToolHarness({
    getWorkflow: async () => wfWithPin,
  })
  const full = await byName.n8n_workflow_get.execute({ alias: 'lchqi', id: '7' }, {})
  const defaultRendered = byName.n8n_workflow_get.output.render({ id: '7' }, full)[0].text
  assert.match(defaultRendered, /已省略 pinData：Webhook/)
  assert.doesNotMatch(defaultRendered, /xxxxx/)

  const withPinRendered = byName.n8n_workflow_get.output.render({ id: '7', includePinData: true }, full)[0].text
  assert.match(withPinRendered, /xxxxx/)

  const summary = await byName.n8n_workflow_get.execute({ alias: 'lchqi', id: '7', summaryOnly: true }, {})
  assert.equal(summary.nodes[0].parameters, undefined)
  assert.equal(summary.nodes[0].name, 'Webhook')
})

test('applyWorkflowPatch supports node/connection/settings/rename operations', () => {
  const base = {
    name: 'Old',
    nodes: [
      { id: 't1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [250, 300], parameters: {} },
      { id: 'n1', name: 'Step1', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [450, 300], parameters: {} },
    ],
    connections: { Trigger: { main: [[{ node: 'Step1', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' },
  }
  const patched = applyWorkflowPatch(base, [
    { op: 'rename', name: 'New' },
    { op: 'updateSettings', settings: { timezone: 'Asia/Shanghai' } },
    { op: 'updateNode', name: 'Step1', newName: 'StepOne', patchParameters: { keep: true } },
    { op: 'addNode', node: { id: 'n2', name: 'Step2', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [650, 300], parameters: {} } },
    { op: 'connect', from: 'StepOne', to: 'Step2' },
    { op: 'disconnect', from: 'Trigger', to: 'StepOne' },
    { op: 'connect', from: 'Trigger', to: 'StepOne' },
  ])
  assert.equal(patched.name, 'New')
  assert.equal(patched.settings.timezone, 'Asia/Shanghai')
  assert.equal(patched.connections.Trigger.main[0][0].node, 'StepOne')
  assert.equal(patched.connections.StepOne.main[0][0].node, 'Step2')
})

test('n8n_workflow_patch validates before writing and preserves versionId', async () => {
  const validWf = {
    id: '7',
    name: 'Hook',
    versionId: 'v9',
    nodes: [
      { id: 't1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [250, 300], parameters: {} },
    ],
    connections: {},
    settings: { executionOrder: 'v1' },
  }
  const { byName, calls, audits } = makeToolHarness({
    getWorkflow: async () => validWf,
    updateWorkflow: async (_alias, id, wf, opts) => ({ id, ...wf, concurrency: 'checked', opts }),
  })

  // Invalid patch (missing httpRequest url) is rejected before updateWorkflow.
  await assert.rejects(
    () => byName.n8n_workflow_patch.execute({
      alias: 'lchqi',
      id: '7',
      operations: [{ op: 'addNode', node: { id: 'h1', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [450, 300], parameters: {} } }],
    }, {}),
    /校验未通过/,
  )
  assert.equal(calls.some(call => call.method === 'updateWorkflow'), false)
  assert.equal(audits[0].ok, false)

  // Valid patch passes expectedVersionId and succeeds.
  const ok = await byName.n8n_workflow_patch.execute({
    alias: 'lchqi',
    id: '7',
    operations: [{ op: 'rename', name: 'Renamed' }],
  }, {})
  assert.equal(ok.name, 'Renamed')
  const updateCall = calls.find(call => call.method === 'updateWorkflow')
  assert.equal(updateCall.args[3].expectedVersionId, 'v9')
  assert.equal(audits[1].ok, true)
})

test('n8n_api output.render clips oversized payloads', () => {
  const { byName } = makeToolHarness()
  const huge = { data: 'a'.repeat(20_000) }
  const rendered = byName.n8n_api.output.render({}, huge)[0].text
  assert.match(rendered, /截断，共/)
})