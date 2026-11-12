/**
 * The /api/dsh-n8n-plugin route family: instance CRUD and a connection test for the
 * Settings → n8n instances page.
 *
 * Every handler sits behind the loopback fence (see {@link isLoopbackRequest}):
 * these endpoints write and read n8n API keys, so a LAN-exposed dsh web
 * deployment must not serve them. Responses never contain a full key — the
 * store projection masks it.
 */

import { appendAudit, readAudit } from './audit.js'
import { isJsonObject, isLoopbackRequest, queryParam, readJsonBody, writeJson } from './http.js'

/** Route family paths (also mirrored in the browser half). */
export const N8N_API = {
  instances: '/api/dsh-n8n-plugin/instances',
  test: '/api/dsh-n8n-plugin/test',
  audit: '/api/dsh-n8n-plugin/audit',
  health: '/api/dsh-n8n-plugin/health',
}

/**
 * Build the dsh-n8n-plugin routes.
 * @param deps - the instance store and the n8n client.
 * @returns exact web routes for the host webserver.
 */
export function makeRoutes({ store, client }) {
  const list = () => ({
    instances: store.list().map(entry => store.summarize(entry)),
    defaultAlias: store.defaultAlias() ?? null,
  })

  const routes = [
    {
      kind: 'exact',
      path: N8N_API.instances,
      async handler(req, res) {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: '禁止访问：仅限本机回环连接' })
          return
        }
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          writeJson(res, 200, list())
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (!isJsonObject(body)) {
            writeJson(res, 400, { error: '请求体必须是 JSON 对象' })
            return
          }
          try {
            const entry = store.create(body)
            appendAudit({ actor: 'web', action: 'instance.create', alias: entry.alias, target: entry.alias, ok: true })
            writeJson(res, 201, { instance: store.summarize(entry), ...list() })
          } catch (error) {
            appendAudit({
              actor: 'web',
              action: 'instance.create',
              alias: typeof body.alias === 'string' ? body.alias : '(未知)',
              target: typeof body.alias === 'string' ? body.alias : '(未知)',
              ok: false,
              error: message(error).slice(0, 300),
            })
            writeJson(res, 400, { error: message(error) })
          }
          return
        }
        if (method !== 'PATCH' && method !== 'DELETE') {
          writeJson(res, 405, { error: `不支持的请求方法：${method}` })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        if (alias === undefined) {
          writeJson(res, 400, { error: '缺少 alias 查询参数' })
          return
        }
        if (method === 'DELETE') {
          try {
            store.delete(alias)
            appendAudit({ actor: 'web', action: 'instance.delete', alias, target: alias, ok: true })
            writeJson(res, 200, { ok: true, ...list() })
          } catch (error) {
            appendAudit({ actor: 'web', action: 'instance.delete', alias, target: alias, ok: false, error: message(error).slice(0, 300) })
            writeJson(res, 400, { error: message(error) })
          }
          return
        }
        const body = await readJsonBody(req)
        if (!isJsonObject(body)) {
          writeJson(res, 400, { error: '请求体必须是 JSON 对象' })
          return
        }
        try {
          const entry = store.update(alias, body)
          appendAudit({ actor: 'web', action: 'instance.update', alias, target: entry.alias, ok: true })
          writeJson(res, 200, { instance: store.summarize(entry), ...list() })
        } catch (error) {
          appendAudit({ actor: 'web', action: 'instance.update', alias, target: alias, ok: false, error: message(error).slice(0, 300) })
          writeJson(res, 400, { error: message(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: N8N_API.audit,
      async handler(req, res) {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: '禁止访问：仅限本机回环连接' })
          return
        }
        if ((req.method ?? 'GET') !== 'GET') {
          writeJson(res, 405, { error: `不支持的请求方法：${req.method}` })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rawLimit = Number(queryParam(url, 'limit'))
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50
        writeJson(res, 200, { entries: readAudit({ limit }) })
      },
    },
    {
      kind: 'exact',
      path: N8N_API.test,
      async handler(req, res) {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: '禁止访问：仅限本机回环连接' })
          return
        }
        if ((req.method ?? 'GET') !== 'POST') {
          writeJson(res, 405, { error: `不支持的请求方法：${req.method}` })
          return
        }
        const body = await readJsonBody(req)
        if (!isJsonObject(body) || typeof body.alias !== 'string') {
          writeJson(res, 400, { error: '请求体必须是 {"alias": "<别名>"}' })
          return
        }
        try {
          const result = await client.test(body.alias)
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 502, { ok: false, alias: body.alias, error: message(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: N8N_API.health,
      async handler(req, res) {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: '禁止访问：仅限本机回环连接' })
          return
        }
        if ((req.method ?? 'GET') !== 'GET') {
          writeJson(res, 405, { error: `不支持的请求方法：${req.method}` })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        // Read-only aggregation: always 200, one entry per alias — a failing
        // instance degrades to `{alias, ok:false, error}` instead of the route.
        if (typeof alias === 'string') {
          writeJson(res, 200, {
            instances: [await healthOne(client, alias)],
            generatedAt: new Date().toISOString(),
          })
          return
        }
        writeJson(res, 200, {
          instances: await collectHealth(store, client),
          generatedAt: new Date().toISOString(),
        })
      },
    },
  ]
  return routes
}

/**
 * Gather health for every registered instance. One failing instance (offline,
 * bad key, slow) degrades only its own entry: the aggregate always resolves.
 * @returns one entry per alias — `ok:true` plus the health payload, or
 *   `ok:false` plus the error message.
 */
export async function collectHealth(store, client) {
  const aliases = store.list().map(entry => entry.alias)
  const settled = await Promise.allSettled(aliases.map(alias => client.health(alias)))
  return settled.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : { alias: aliases[index], ok: false, error: message(result.reason) })
}

/** Health of one instance; any failure degrades to `{alias, ok:false, error}`. */
async function healthOne(client, alias) {
  try {
    return await client.health(alias)
  } catch (error) {
    return { alias, ok: false, error: message(error) }
  }
}

/** Narrow an unknown throwable to a message. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}