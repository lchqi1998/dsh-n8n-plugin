/**
 * n8n REST client: one thin, fetch-based wrapper over the n8n public API v1
 * (`/api/v1`, `X-N8N-API-KEY`). Every call resolves its target instance from
 * the alias in the store, so the GUI and the agent share one registry and one
 * transport.
 *
 * Version tolerance: n8n added `publish`/`unpublish` endpoints after the
 * classic `activate`/`deactivate` pair, and older self-hosted builds expose
 * only the latter. {@link N8nClient.setPublished} tries the modern endpoint
 * first and falls back only on a 404 (endpoint absent), never on a real error.
 */

import { maskApiKey } from './store.js'

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** One failed n8n request: HTTP status, endpoint, and the server's own message. */
export class N8nError extends Error {
  /**
   * @param message - user-facing message.
   * @param options - status/body/path metadata.
   */
  constructor(message, { status, body, path, alias } = {}) {
    super(message)
    this.name = 'N8nError'
    this.status = status
    this.body = body
    this.path = path
    this.alias = alias
  }
}

/** Build the versioned base URL for one stored instance. */
export function apiBase(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '') + '/api/v1'
}

/** Turn a fetch failure into an actionable message. */
function describeFetchError(error) {
  const cause = error?.cause ?? error
  const code = cause?.code ?? error?.code
  if (code === 'ECONNREFUSED') return 'connection refused — is the n8n instance running and the URL/port correct?'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found — check the instance URL/DNS'
  if (code === 'ETIMEDOUT' || error?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'request timed out — check the instance URL and network reachability'
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return 'TLS certificate rejected by the host — use a trusted certificate for the instance'
  }
  if (code === 'ECONNRESET') return 'connection reset by the n8n instance'
  return cause?.message ?? error?.message ?? 'request failed'
}

/** Pick the most useful message out of an n8n error payload. */
function errorMessage(body, status) {
  if (typeof body === 'object' && body !== null) {
    if (typeof body.message === 'string' && body.message !== '') return body.message
    if (typeof body.error === 'string' && body.error !== '') return body.error
  }
  if (typeof body === 'string' && body !== '') return body
  return `HTTP ${status}`
}

/** One n8n client bound to an instance store. */
export class N8nClient {
  /**
   * @param store - the instance store (alias → base URL + API key).
   * @param options - `fetch` override (tests) and default timeout.
   */
  constructor(store, options = {}) {
    this.store = store
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Perform one request against the instance behind `alias`.
   * @returns the parsed JSON body (or an empty object for 204/no content).
   */
  async request(alias, method, path, options = {}) {
    const entry = this.store.require(alias)
    const base = apiBase(entry.baseUrl)
    const normalizedPath = path.startsWith('/') ? path : '/' + path
    const url = new URL(base + normalizedPath)
    const query = options.query ?? {}
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item))
      } else {
        url.searchParams.set(key, String(value))
      }
    }
    const headers = {
      'X-N8N-API-KEY': entry.apiKey,
      accept: 'application/json',
      // The DSH host installs an undici wrapper that drops automatic
      // decompression; a plain fetch of a compressed body would return noise.
      'accept-encoding': 'identity',
    }
    const init = { method, headers, signal: this.#signal(options.timeoutMs, options.signal) }
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    let response
    try {
      response = await this.fetchImpl(url, init)
    } catch (error) {
      if (options.signal?.aborted) throw new Error('request cancelled')
      throw new N8nError(`n8n request failed: ${describeFetchError(error)}`, { alias, path: normalizedPath })
    }
    const text = await response.text()
    let parsed
    if (text !== '') {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    if (!response.ok) {
      throw new N8nError(`n8n API ${method} ${normalizedPath} → HTTP ${response.status}: ${errorMessage(parsed, response.status)}`, {
        status: response.status,
        body: parsed,
        path: normalizedPath,
        alias,
      })
    }
    return parsed === undefined ? {} : parsed
  }

  /** Test connectivity and credentials: one cheap workflow page read. */
  async test(alias, { signal } = {}) {
    const started = Date.now()
    const entry = this.store.require(alias)
    const body = await this.request(alias, 'GET', '/workflows', { query: { limit: 1 }, signal })
    return {
      ok: true,
      alias,
      baseUrl: entry.baseUrl,
      apiKey: maskApiKey(entry.apiKey),
      workflowCount: Array.isArray(body.data) ? body.data.length : 0,
      hasMore: typeof body.nextCursor === 'string' && body.nextCursor !== '',
      latencyMs: Math.max(1, Date.now() - started),
    }
  }

  /** List workflows (summaries only; the full node graph is one get away). */
  async listWorkflows(alias, { limit, cursor, active, name, tags, excludePinnedData, signal } = {}) {
    const body = await this.request(alias, 'GET', '/workflows', {
      signal,
      query: {
        limit,
        cursor,
        active: active === undefined ? undefined : String(active),
        name,
        tags: Array.isArray(tags) ? tags.join(',') : tags,
        excludePinnedData: excludePinnedData === undefined ? undefined : String(excludePinnedData),
      },
    })
    return {
      data: (Array.isArray(body.data) ? body.data : []).map(toWorkflowSummary),
      nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
    }
  }

  /** Fetch one workflow in full (nodes, connections, settings). */
  async getWorkflow(alias, workflowId, { signal } = {}) {
    return this.request(alias, 'GET', `/workflows/${encodeURIComponent(workflowId)}`, { signal })
  }

  /** Create a workflow; optionally publish it right after creation. */
  async createWorkflow(alias, workflow, { publish = false, signal } = {}) {
    const created = await this.request(alias, 'POST', '/workflows', { body: workflow, signal })
    if (publish && created?.id !== undefined) {
      try {
        await this.setPublished(alias, String(created.id), true, { signal })
      } catch (error) {
        return { ...created, publishError: error instanceof Error ? error.message : String(error) }
      }
    }
    return created
  }

  /** Replace a workflow definition (PUT), optionally publishing afterwards. */
  async updateWorkflow(alias, workflowId, workflow, { publish, signal } = {}) {
    const updated = await this.request(alias, 'PUT', `/workflows/${encodeURIComponent(workflowId)}`, { body: workflow, signal })
    if (publish !== undefined && updated?.id !== undefined) {
      try {
        await this.setPublished(alias, String(updated.id), publish, { signal })
      } catch (error) {
        return { ...updated, publishError: error instanceof Error ? error.message : String(error) }
      }
    }
    return updated
  }

  /** Delete a workflow. */
  async deleteWorkflow(alias, workflowId, { signal } = {}) {
    await this.request(alias, 'DELETE', `/workflows/${encodeURIComponent(workflowId)}`, { signal })
    return { deleted: true, id: workflowId }
  }

  /**
   * Publish (activate) or unpublish (deactivate) a workflow. Modern n8n exposes
   * `POST /workflows/{id}/publish|unpublish`; older builds expose
   * `POST /workflows/{id}/activate|deactivate`. A 404 falls back; any other
   * failure is surfaced as-is.
   */
  async setPublished(alias, workflowId, published, { signal } = {}) {
    const id = encodeURIComponent(workflowId)
    const modern = published ? 'publish' : 'unpublish'
    const legacy = published ? 'activate' : 'deactivate'
    try {
      return await this.request(alias, 'POST', `/workflows/${id}/${modern}`, { signal })
    } catch (error) {
      if (error instanceof N8nError && error.status === 404) {
        return this.request(alias, 'POST', `/workflows/${id}/${legacy}`, { signal })
      }
      throw error
    }
  }

  /** List executions, optionally for one workflow or status. */
  async listExecutions(alias, { limit, cursor, workflowId, status, includeData, signal } = {}) {
    const body = await this.request(alias, 'GET', '/executions', {
      signal,
      query: {
        limit,
        cursor,
        workflowId,
        status,
        includeData: includeData === undefined ? undefined : String(includeData),
      },
    })
    return {
      data: (Array.isArray(body.data) ? body.data : []).map(toExecutionSummary),
      nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
    }
  }

  /** Fetch one execution, optionally with its data payload. */
  async getExecution(alias, executionId, { includeData = true, signal } = {}) {
    return this.request(alias, 'GET', `/executions/${encodeURIComponent(executionId)}`, {
      query: includeData ? { includeData: 'true' } : undefined,
      signal,
    })
  }

  /** List tags. */
  async listTags(alias, { limit, cursor, signal } = {}) {
    const body = await this.request(alias, 'GET', '/tags', { query: { limit, cursor }, signal })
    return {
      data: Array.isArray(body.data) ? body.data : [],
      nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
    }
  }

  /** List credentials (id, name, type only — the API never returns secrets). */
  async listCredentials(alias, { limit, cursor, signal } = {}) {
    const body = await this.request(alias, 'GET', '/credentials', { query: { limit, cursor }, signal })
    return {
      data: (Array.isArray(body.data) ? body.data : []).map(credential => ({
        id: credential.id,
        name: credential.name,
        type: credential.type,
      })),
      nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
    }
  }

  /** Escape hatch: one arbitrary public-API request. */
  async raw(alias, { method, path, query, body, timeoutMs, signal }) {
    return this.request(alias, method ?? 'GET', path, { query, body, timeoutMs, signal })
  }

  /** Combine the caller's cancellation with this request's timeout. */
  #signal(timeoutMs, callerSignal) {
    const timeout = timeoutMs ?? this.defaultTimeoutMs
    const timeoutSignal = AbortSignal.timeout(timeout)
    if (callerSignal === undefined) return timeoutSignal
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([callerSignal, timeoutSignal])
    return callerSignal
  }
}

/** Project one workflow onto the list row shape (the node graph is omitted). */
export function toWorkflowSummary(workflow) {
  return {
    id: workflow.id,
    name: workflow.name,
    active: workflow.active === true,
    ...(workflow.createdAt !== undefined ? { createdAt: workflow.createdAt } : {}),
    ...(workflow.updatedAt !== undefined ? { updatedAt: workflow.updatedAt } : {}),
    ...(Array.isArray(workflow.tags) ? { tags: workflow.tags.map(tag => tag.name).filter(name => typeof name === 'string') } : {}),
  }
}

/** Project one execution onto the list row shape. */
export function toExecutionSummary(execution) {
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    status: execution.status,
    ...(execution.mode !== undefined ? { mode: execution.mode } : {}),
    ...(execution.startedAt !== undefined ? { startedAt: execution.startedAt } : {}),
    ...(execution.stoppedAt !== undefined ? { stoppedAt: execution.stoppedAt } : {}),
    ...(execution.finished !== undefined ? { finished: execution.finished } : {}),
  }
}