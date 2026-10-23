/**
 * The /api/dsh-n8n-plugin route family: instance CRUD and a connection test for the
 * Settings → n8n instances page.
 *
 * Every handler sits behind the loopback fence (see {@link isLoopbackRequest}):
 * these endpoints write and read n8n API keys, so a LAN-exposed dsh web
 * deployment must not serve them. Responses never contain a full key — the
 * store projection masks it.
 */

import { isJsonObject, isLoopbackRequest, queryParam, readJsonBody, writeJson } from './http.js'

/** Route family paths (also mirrored in the browser half). */
export const N8N_API = {
  instances: '/api/dsh-n8n-plugin/instances',
  test: '/api/dsh-n8n-plugin/test',
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
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
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
            writeJson(res, 400, { error: 'body must be a JSON object' })
            return
          }
          try {
            const entry = store.create(body)
            writeJson(res, 201, { instance: store.summarize(entry), ...list() })
          } catch (error) {
            writeJson(res, 400, { error: message(error) })
          }
          return
        }
        if (method !== 'PATCH' && method !== 'DELETE') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        if (alias === undefined) {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        if (method === 'DELETE') {
          try {
            store.delete(alias)
            writeJson(res, 200, { ok: true, ...list() })
          } catch (error) {
            writeJson(res, 400, { error: message(error) })
          }
          return
        }
        const body = await readJsonBody(req)
        if (!isJsonObject(body)) {
          writeJson(res, 400, { error: 'body must be a JSON object' })
          return
        }
        try {
          const entry = store.update(alias, body)
          writeJson(res, 200, { instance: store.summarize(entry), ...list() })
        } catch (error) {
          writeJson(res, 400, { error: message(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: N8N_API.test,
      async handler(req, res) {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? 'GET') !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const body = await readJsonBody(req)
        if (!isJsonObject(body) || typeof body.alias !== 'string') {
          writeJson(res, 400, { error: 'body must be {"alias": "<alias>"}' })
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
  ]
  return routes
}

/** Narrow an unknown throwable to a message. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}