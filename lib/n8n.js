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

import { maskApiKey, resolveApiKey } from './store.js'

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** The n8n Webhook trigger node type. */
export const WEBHOOK_NODE_TYPE = 'n8n-nodes-base.webhook'

/**
 * Execution statuses that end a wait. `waiting` is deliberately excluded from
 * "still running" handling instead: a parked execution never finishes on its
 * own, so pollers surface it immediately instead of burning their budget.
 */
export const EXECUTION_TERMINAL_STATUSES = new Set(['success', 'error', 'canceled', 'crashed'])

/** Statuses the health panel counts as failures (its failure-rate numerator). */
export const HEALTH_FAILURE_STATUSES = new Set(['error', 'crashed'])

/** Statuses that count as finished — the failure-rate denominator. */
export const HEALTH_FINISHED_STATUSES = new Set(['success', 'error', 'canceled', 'crashed'])

/** Resolve after `ms`; rejects early when `signal` aborts. */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('请求已取消'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('请求已取消'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener?.('abort', onAbort)
  })
}

/** One failed n8n request: HTTP status, endpoint, and the server's own message. */
export class N8nError extends Error {
  /**
   * @param message - user-facing message.
   * @param options - status/body/path metadata.
   */
  constructor(message, { status, body, path, alias, code } = {}) {
    super(message)
    this.name = 'N8nError'
    this.status = status
    this.body = body
    this.path = path
    this.alias = alias
    this.code = code
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
  if (code === 'ECONNREFUSED') return '连接被拒绝——请确认 n8n 实例正在运行、地址与端口正确'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '主机未找到——请检查实例地址/DNS'
  if (code === 'ETIMEDOUT' || error?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return '请求超时——请检查实例地址与网络连通性'
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return 'TLS 证书被拒绝——请为实例使用受信任的证书'
  }
  if (code === 'ECONNRESET') return '连接被 n8n 实例重置'
  return cause?.message ?? error?.message ?? '请求失败'
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

/**
 * n8n stores tag names in a varchar(24) and rejects longer ones with a
 * misleading 409 "Tag already exists", so catch it before the request.
 */
export function validateTagName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('标签名称不能为空')
  const trimmed = name.trim()
  if (trimmed.length > 24) throw new Error(`标签名称最多 24 个字符（当前 ${trimmed.length} 个）：${trimmed}`)
  return trimmed
}

/** Variable key grammar per the n8n API (and the Variables UI). */
export const VARIABLE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validate a variable key before sending: non-empty, at most 50 characters,
 * letters/digits/underscores with a non-digit head. n8n rejects anything else
 * with a terse 400.
 */
export function validateVariableKey(key) {
  if (typeof key !== 'string' || key.trim() === '') throw new Error('变量 key 不能为空')
  const trimmed = key.trim()
  if (trimmed.length > 50) throw new Error(`变量 key 最多 50 个字符（当前 ${trimmed.length} 个）：${trimmed}`)
  if (!VARIABLE_KEY_RE.test(trimmed)) {
    throw new Error(`变量 key 只能包含字母、数字与下划线，且以字母或下划线开头（不合法：${trimmed}）；工作流里用 $vars.${trimmed} 引用`)
  }
  return trimmed
}

/**
 * Normalize a variable value to the string the API expects: primitives are
 * stringified, objects/arrays are refused with a hint (JSON-stringify them in
 * the tool call if that is really what should be stored).
 */
export function validateVariableValue(value) {
  if (typeof value === 'string') {
    if (value.length > 1000) throw new Error(`变量 value 最多 1000 个字符（当前 ${value.length} 个）`)
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new Error('变量 value 必须是字符串（变量在 n8n 里一律按字符串存储）；对象请先 JSON.stringify')
}

/** Row-filter conditions the data-tables API accepts. */
const ROW_FILTER_CONDITIONS = new Set(['eq', 'neq', 'like', 'ilike', 'gt', 'gte', 'lt', 'lte'])

/**
 * Validate a rows filter ({type:'and'|'or', filters:[{columnName,condition,value}]})
 * and render it to the JSON string the query-string variants carry.
 * @param filter - the filter object (tool `json` argument).
 * @param options - `required`: list may omit the filter; delete/update/upsert may not.
 * @returns the JSON string for query use, or the object for body use.
 */
export function validateRowFilter(filter, { required = false } = {}) {
  if (filter === undefined || filter === null) {
    if (required) throw new Error('filter 是必填项——不带条件的删除/更新会波及整表，n8n API 也拒绝空 filter')
    return undefined
  }
  if (typeof filter !== 'object' || Array.isArray(filter)) throw new Error('filter 必须是对象：{"type":"and","filters":[{"columnName","condition","value"}]}')
  const filters = Array.isArray(filter.filters) ? filter.filters : []
  if (filters.length === 0) throw new Error('filter.filters 不能为空——至少给出一个条件（空条件会被 n8n 拒绝）')
  for (const item of filters) {
    if (typeof item !== 'object' || item === null || typeof item.columnName !== 'string' || item.columnName === '') {
      throw new Error('filter.filters 的每一项都需要 columnName/condition/value')
    }
    if (typeof item.condition === 'string' && !ROW_FILTER_CONDITIONS.has(item.condition)) {
      throw new Error(`不支持的过滤条件 ${item.condition}——可用：${[...ROW_FILTER_CONDITIONS].join('/')}`)
    }
  }
  const type = filter.type === 'or' ? 'or' : 'and'
  return { type, filters }
}

/** Serialize a validated filter for the query-string endpoints (list/delete rows). */
export function rowFilterQuery(filter) {
  const normalized = validateRowFilter(filter)
  return normalized === undefined ? undefined : JSON.stringify(normalized)
}

/** Data-table name grammar: non-empty, at most 128 characters. */
export function validateDataTableName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('数据表名称不能为空')
  const trimmed = name.trim()
  if (trimmed.length > 128) throw new Error(`数据表名称最多 128 个字符（当前 ${trimmed.length} 个）：${trimmed}`)
  return trimmed
}

/** Column name grammar per the n8n API: ≤63 chars, letter first, then letters/digits/underscores. */
const DATA_TABLE_COLUMN_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/
const DATA_TABLE_COLUMN_TYPES = new Set(['string', 'number', 'boolean', 'date'])

/** Validate one column definition; returns the normalized {name, type}. */
export function validateDataTableColumn(column) {
  if (column === null || typeof column !== 'object' || Array.isArray(column)) {
    throw new Error('列定义必须是 {name, type} 对象')
  }
  const name = typeof column.name === 'string' ? column.name.trim() : ''
  if (name === '') throw new Error('列名不能为空')
  if (name.length > 63) throw new Error(`列名最多 63 个字符（当前 ${name.length} 个）：${name}`)
  if (!DATA_TABLE_COLUMN_NAME_RE.test(name)) {
    throw new Error(`列名只能以字母开头，包含字母/数字/下划线（不合法：${name}）`)
  }
  if (!DATA_TABLE_COLUMN_TYPES.has(column.type)) {
    throw new Error(`列 ${name} 的类型必须是 ${[...DATA_TABLE_COLUMN_TYPES].join('/')}（当前：${String(column.type)}）`)
  }
  return { name, type: column.type }
}

/** A rows mutation body needs a non-empty object of column→value pairs. */
export function requireRowObject(data, field) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${field} 必须是列名→值的对象`)
  }
  if (Object.keys(data).length === 0) throw new Error(`${field} 不能为空对象——至少要给出一列的新值`)
  return data
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
      'X-N8N-API-KEY': resolveApiKey(entry),
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
      if (options.signal?.aborted) throw new Error('请求已取消')
      throw new N8nError(`n8n 请求失败：${describeFetchError(error)}`, { alias, path: normalizedPath })
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

  // ------------------------------------------------------------------
  // Instance health: workflow totals plus a bounded sample of recent
  // executions, for the Settings page health panel. Read-only and bounded —
  // at most `maxWorkflowPages` workflow pages and one execution page, under
  // one total time budget — so a huge or slow instance cannot stall the UI.
  // ------------------------------------------------------------------

  /**
   * Aggregate one instance's health.
   * @returns `{ ok, alias, baseUrl, latencyMs, workflows:{total,active,truncated}, executions:{sampled,counts,finished,failed,failureRate} }`.
   */
  async health(alias, { executionLimit = 100, workflowPageLimit = 250, maxWorkflowPages = 4, timeoutMs = 8_000, signal } = {}) {
    const started = Date.now()
    const entry = this.store.require(alias)
    // One total budget for the whole walk (AbortSignal.timeout timers are
    // unref'ed, so a pending budget never keeps the event loop alive).
    const budget = AbortSignal.timeout(25_000)
    const combined = signal === undefined
      ? budget
      : (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, budget]) : signal)
    try {
      let total = 0
      let active = 0
      let cursor
      for (let page = 0; page < maxWorkflowPages; page += 1) {
        const body = await this.request(alias, 'GET', '/workflows', {
          query: { limit: workflowPageLimit, cursor },
          timeoutMs,
          signal: combined,
        })
        const rows = Array.isArray(body?.data) ? body.data : []
        total += rows.length
        for (const row of rows) {
          if (row?.active === true) active += 1
        }
        if (typeof body?.nextCursor !== 'string' || body.nextCursor === '') {
          cursor = undefined
          break
        }
        cursor = body.nextCursor
      }
      const truncated = cursor !== undefined
      const executionBody = await this.request(alias, 'GET', '/executions', {
        query: { limit: executionLimit },
        timeoutMs,
        signal: combined,
      })
      const executions = Array.isArray(executionBody?.data) ? executionBody.data : []
      const counts = {}
      for (const execution of executions) {
        const status = typeof execution?.status === 'string' && execution.status !== '' ? execution.status : 'unknown'
        counts[status] = (counts[status] ?? 0) + 1
      }
      let finished = 0
      let failed = 0
      for (const status of HEALTH_FINISHED_STATUSES) finished += counts[status] ?? 0
      for (const status of HEALTH_FAILURE_STATUSES) failed += counts[status] ?? 0
      return {
        ok: true,
        alias,
        baseUrl: entry.baseUrl,
        latencyMs: Math.max(1, Date.now() - started),
        workflows: { total, active, truncated },
        executions: {
          sampled: executions.length,
          counts,
          finished,
          failed,
          failureRate: finished > 0 ? failed / finished : null,
        },
      }
    } catch (error) {
      if (combined.aborted) {
        throw new N8nError('健康检查超时：实例长时间未完成响应', { alias, code: 'HEALTH_TIMEOUT' })
      }
      throw error
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

  /**
   * Replace a workflow definition (PUT), optionally publishing afterwards.
   *
   * A PUT carries the whole document, so two writers racing on the same
   * workflow silently overwrite each other. When the version this edit was
   * based on is known (`expectedVersionId`, or the document's own
   * `versionId` — both come from {@link getWorkflow}) the current workflow is
   * read first and a mismatch aborts with a conflict instead of writing. The
   * base version is then forwarded in the PUT body so n8n enforces the same
   * rule. Instances that do not expose versioning (older n8n) skip the guard
   * and report `concurrency: "unsupported"`.
   */
  async updateWorkflow(alias, workflowId, workflow, { publish, signal, expectedVersionId } = {}) {
    const baseVersion = typeof expectedVersionId === 'string' && expectedVersionId !== ''
      ? expectedVersionId
      : (typeof workflow?.versionId === 'string' && workflow.versionId !== '' ? workflow.versionId : undefined)
    let body = workflow
    let concurrency = 'unchecked'
    if (baseVersion !== undefined) {
      const current = await this.getWorkflow(alias, workflowId, { signal })
      const currentVersion = typeof current?.versionId === 'string' && current.versionId !== '' ? current.versionId : undefined
      if (currentVersion !== undefined && currentVersion !== baseVersion) {
        throw new N8nError(
          `工作流 ${workflowId} 已被他人修改（本次基于版本 ${baseVersion}，实例当前为 ${currentVersion}）：未写入。请重新 n8n_workflow_get 取回最新文档，合并后再提交。`,
          {
            status: 409,
            code: 'WORKFLOW_VERSION_CONFLICT',
            path: `/workflows/${workflowId}`,
            alias,
            body: {
              expectedVersionId: baseVersion,
              currentVersion,
              current: { id: current?.id, name: current?.name, updatedAt: current?.updatedAt },
            },
          },
        )
      }
      if (currentVersion === undefined) {
        concurrency = 'unsupported'
        // The instance does not version workflows: drop the field the caller may
        // have carried in, so an unknown property cannot trip request validation.
        if (workflow !== null && typeof workflow === 'object' && 'versionId' in workflow) {
          body = { ...workflow }
          delete body.versionId
        }
      } else {
        concurrency = 'checked'
        body = { ...workflow, versionId: baseVersion }
      }
    }
    const updated = await this.request(alias, 'PUT', `/workflows/${encodeURIComponent(workflowId)}`, { body, signal })
    // Always reported so the tool can tell the user whether this write was guarded.
    if (updated !== null && typeof updated === 'object') updated.concurrency = concurrency
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

  /**
   * Clone a workflow: read the source, create a fresh workflow from its
   * definition, then copy its tags and optionally publish. Identity and runtime
   * state (id, active, versionId, staticData, meta) are never carried over;
   * tags are applied through the dedicated tags endpoint because the workflow
   * document itself treats `tags` as read-only.
   */
  async cloneWorkflow(alias, workflowId, { name, copyTags = true, publish = false, signal } = {}) {
    const source = await this.getWorkflow(alias, workflowId, { signal })
    const created = await this.request(alias, 'POST', '/workflows', {
      body: toWorkflowClonePayload(source, name),
      signal,
    })
    const result = {
      ...created,
      source: { id: String(source?.id ?? workflowId), name: source?.name, active: source?.active === true },
    }
    if (copyTags !== false) {
      const tagIds = (Array.isArray(source?.tags) ? source.tags : [])
        .map(tag => (typeof tag === 'string' ? tag : tag?.id))
        .filter(id => typeof id === 'string' && id !== '')
      if (tagIds.length > 0 && created?.id !== undefined) {
        try {
          const applied = await this.setWorkflowTags(alias, String(created.id), tagIds, { signal })
          result.tags = applied.data
        } catch (error) {
          result.tagsError = error instanceof Error ? error.message : String(error)
        }
      }
    }
    if (publish === true && created?.id !== undefined) {
      try {
        await this.setPublished(alias, String(created.id), true, { signal })
        result.active = true
      } catch (error) {
        result.publishError = error instanceof Error ? error.message : String(error)
      }
    }
    return result
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

  /**
   * Stop (cancel) a running execution. n8n answers 409 for an execution that
   * already ended ("Only running or waiting executions can be stopped"), which
   * is a final state rather than a failure: report that state so the caller
   * does not retry a request that cannot succeed.
   */
  async stopExecution(alias, executionId, { signal } = {}) {
    try {
      return await this.request(alias, 'POST', `/executions/${encodeURIComponent(executionId)}/stop`, { signal })
    } catch (error) {
      const alreadyDone = error instanceof N8nError
        && error.status === 409
        && /only running or waiting executions can be stopped/i.test(error.body?.message ?? '')
      if (!alreadyDone) throw error
      const execution = await this.getExecution(alias, executionId, { includeData: false, signal })
      return { ...execution, id: execution?.id ?? executionId }
    }
  }

  /** List tags. */
  async listTags(alias, { limit, cursor, signal } = {}) {
    const body = await this.request(alias, 'GET', '/tags', { query: { limit, cursor }, signal })
    return {
      data: Array.isArray(body.data) ? body.data : [],
      nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
    }
  }

  /** Every tag of an instance, following pagination (bounded so a huge registry cannot stall). */
  async listAllTags(alias, { pageLimit = 250, maxPages = 8, signal } = {}) {
    const tags = []
    let cursor
    for (let page = 0; page < maxPages; page += 1) {
      const body = await this.request(alias, 'GET', '/tags', { query: { limit: pageLimit, cursor }, signal })
      for (const tag of Array.isArray(body?.data) ? body.data : []) tags.push(tag)
      if (typeof body?.nextCursor !== 'string' || body.nextCursor === '') break
      cursor = body.nextCursor
    }
    return tags
  }

  /** Create a tag. */
  async createTag(alias, name, { signal } = {}) {
    return this.request(alias, 'POST', '/tags', { body: { name: validateTagName(name) }, signal })
  }

  /** Rename a tag. */
  async updateTag(alias, tagId, name, { signal } = {}) {
    return this.request(alias, 'PUT', `/tags/${encodeURIComponent(tagId)}`, {
      body: { name: validateTagName(name) },
      signal,
    })
  }

  /** Delete a tag; n8n detaches it from every workflow it was attached to. */
  async deleteTag(alias, tagId, { signal } = {}) {
    const tag = await this.request(alias, 'DELETE', `/tags/${encodeURIComponent(tagId)}`, { signal })
    return {
      deleted: true,
      id: tagId,
      ...(typeof tag?.name === 'string' ? { name: tag.name } : {}),
    }
  }

  /** The tags of one workflow. */
  async getWorkflowTags(alias, workflowId, { signal } = {}) {
    const body = await this.request(alias, 'GET', `/workflows/${encodeURIComponent(workflowId)}/tags`, { signal })
    return { data: Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [] }
  }

  /** Replace the tags of one workflow: the body is an array of `{ id }` objects. */
  async setWorkflowTags(alias, workflowId, tagIds, { signal } = {}) {
    const body = (Array.isArray(tagIds) ? tagIds : []).map(id => ({ id: String(id) }))
    const result = await this.request(alias, 'PUT', `/workflows/${encodeURIComponent(workflowId)}/tags`, {
      body,
      signal,
    })
    return { data: Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [] }
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

  // ------------------------------------------------------------------
  // Variables (instance variables; n8n Cloud Pro/Enterprise, self-hosted
  // Business/Enterprise). Values are strings; `set` below is upsert-by-key.
  // ------------------------------------------------------------------

  /** List instance variables. */
  async listVariables(alias, { limit, cursor, projectId, state, signal } = {}) {
    const body = await this.request(alias, 'GET', '/variables', { query: { limit, cursor, projectId, state }, signal })
    return {
      data: Array.isArray(body.data) ? body.data : [],
      nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
    }
  }

  /** Every variable of an instance, following pagination (bounded, like listAllTags). */
  async listAllVariables(alias, { pageLimit = 250, maxPages = 8, signal } = {}) {
    const variables = []
    let cursor
    for (let page = 0; page < maxPages; page += 1) {
      const body = await this.request(alias, 'GET', '/variables', { query: { limit: pageLimit, cursor }, signal })
      for (const variable of Array.isArray(body?.data) ? body.data : []) variables.push(variable)
      if (typeof body?.nextCursor !== 'string' || body.nextCursor === '') break
      cursor = body.nextCursor
    }
    return variables
  }

  /** Create one variable (POST; n8n answers 201 with an empty body → {}). */
  async createVariable(alias, key, value, { projectId, signal } = {}) {
    return this.request(alias, 'POST', '/variables', {
      body: { key: validateVariableKey(key), value: validateVariableValue(value), ...(projectId !== undefined ? { projectId } : {}) },
      signal,
    })
  }

  /** Replace one variable (PUT needs key AND value; 204 with an empty body). */
  async updateVariable(alias, variableId, key, value, { signal } = {}) {
    await this.request(alias, 'PUT', `/variables/${encodeURIComponent(variableId)}`, {
      body: { key: validateVariableKey(key), value: validateVariableValue(value) },
      signal,
    })
    return { id: String(variableId), key: validateVariableKey(key), value: validateVariableValue(value) }
  }

  /** Delete one variable by id. */
  async deleteVariable(alias, variableId, { signal } = {}) {
    await this.request(alias, 'DELETE', `/variables/${encodeURIComponent(variableId)}`, { signal })
    return { deleted: true, id: String(variableId) }
  }

  /**
   * Set (upsert) one variable by key: the API has no PATCH, and re-POSTing an
   * existing key 409s, so the key is resolved against the full registry first
   * (create when absent, PUT with key+value when present).
   */
  async setVariable(alias, key, value, { projectId, signal } = {}) {
    const normalizedKey = validateVariableKey(key)
    const existing = (await this.listAllVariables(alias, { signal })).find(variable => variable?.key === normalizedKey)
    if (existing?.id !== undefined) {
      return { ...(await this.updateVariable(alias, existing.id, normalizedKey, value, { signal })), created: false }
    }
    await this.createVariable(alias, normalizedKey, value, { projectId, signal })
    // The create response is empty; echo back the effective values.
    return { id: undefined, key: normalizedKey, value: validateVariableValue(value), created: true }
  }

  // ------------------------------------------------------------------
  // Capabilities probe: one limit=1 GET per feature endpoint, classified by
  // HTTP status. Answers "is this instance new/licensed enough for X?" without
  // a round of 404/403 guesswork.
  // ------------------------------------------------------------------

  /** The feature endpoints the probe walks, in order. */
  static PROBE_ENDPOINTS = [
    ['workflows', '/workflows', '工作流'],
    ['executions', '/executions', '执行记录'],
    ['tags', '/tags', '标签'],
    ['credentials', '/credentials', '凭证'],
    ['variables', '/variables', '变量（需 Business/Enterprise 许可）'],
    ['dataTables', '/data-tables', 'Data Table（需 n8n≥2.7）'],
  ]

  /**
   * Probe one instance's public-API surface. A transport-level failure on the
   * first endpoint (connection refused, DNS, timeout) ends the probe early —
   * nothing else would succeed either — and is reported as `reachable:false`.
   */
  async probeInstance(alias, { signal } = {}) {
    const entry = this.store.require(alias)
    const capabilities = {}
    let first = true
    let transportError
    for (const [name, path] of N8nClient.PROBE_ENDPOINTS) {
      try {
        await this.request(alias, 'GET', path, { query: { limit: 1 }, signal })
        capabilities[name] = { available: true }
      } catch (error) {
        if (!(error instanceof N8nError) || error.status === undefined) {
          // Transport failure: worthless to hammer the remaining endpoints.
          if (first) {
            transportError = error instanceof Error ? error.message : String(error)
            break
          }
          capabilities[name] = { available: false, kind: 'unreachable', message: error instanceof Error ? error.message : String(error) }
          continue
        }
        capabilities[name] = {
          available: false,
          status: error.status,
          kind: error.status === 401 ? 'unauthorized'
            : error.status === 403 ? 'forbidden'
              : error.status === 404 ? 'absent'
                : 'error',
          message: error.message,
        }
      } finally {
        first = false
      }
    }
    if (transportError !== undefined) {
      return { alias, baseUrl: entry.baseUrl, reachable: false, errorMessage: transportError, capabilities: {} }
    }
    return { alias, baseUrl: entry.baseUrl, reachable: true, capabilities }
  }

  // ------------------------------------------------------------------
  // Data tables (n8n ≥ 2.7). Filters travel as JSON strings in the query for
  // list/delete and as plain objects in the body for update/upsert — the
  // client keeps that distinction out of the callers' way.
  // ------------------------------------------------------------------

  /** List data tables. */
  async listDataTables(alias, { limit, cursor, sortBy, signal } = {}) {
    const body = await this.request(alias, 'GET', '/data-tables', { query: { limit, cursor, sortBy }, signal })
    return {
      data: Array.isArray(body.data) ? body.data : [],
      nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
    }
  }

  /** Fetch one data table with its column definitions. */
  async getDataTable(alias, dataTableId, { signal } = {}) {
    return this.request(alias, 'GET', `/data-tables/${encodeURIComponent(dataTableId)}`, { signal })
  }

  /** Create a data table (name + column definitions). */
  async createDataTable(alias, { name, columns, projectId, signal } = {}) {
    return this.request(alias, 'POST', '/data-tables', {
      body: {
        name: validateDataTableName(name),
        columns: (Array.isArray(columns) ? columns : []).map(column => validateDataTableColumn(column)),
        ...(projectId !== undefined && projectId !== '' ? { projectId } : {}),
      },
      signal,
    })
  }

  /** Delete a data table and all of its rows. */
  async deleteDataTable(alias, dataTableId, { signal } = {}) {
    await this.request(alias, 'DELETE', `/data-tables/${encodeURIComponent(dataTableId)}`, { signal })
    return { deleted: true, id: String(dataTableId) }
  }

  /** List rows of one data table (filter/search/sort travel in the query string). */
  async listDataTableRows(alias, dataTableId, { limit, cursor, filter, sortBy, search, signal } = {}) {
    const body = await this.request(alias, 'GET', `/data-tables/${encodeURIComponent(dataTableId)}/rows`, {
      query: { limit, cursor, filter: rowFilterQuery(filter), sortBy, search },
      signal,
    })
    return {
      data: Array.isArray(body.data) ? body.data : [],
      nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
    }
  }

  /** Insert rows; `returnType` is count (default) | id | all. */
  async insertDataTableRows(alias, dataTableId, rows, { returnType, signal } = {}) {
    const data = (Array.isArray(rows) ? rows : []).map(row => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('每一行都必须是列名→值的对象')
      return row
    })
    if (data.length === 0) throw new Error('rows 至少要有一行数据')
    return this.request(alias, 'POST', `/data-tables/${encodeURIComponent(dataTableId)}/rows`, {
      body: { data, ...(returnType !== undefined && returnType !== 'count' ? { returnType } : {}) },
      signal,
    })
  }

  /** Update matching rows (body: filter + data). */
  async updateDataTableRows(alias, dataTableId, { filter, data, returnData, dryRun, signal } = {}) {
    return this.request(alias, 'PATCH', `/data-tables/${encodeURIComponent(dataTableId)}/rows/update`, {
      body: {
        filter: validateRowFilter(filter, { required: true }),
        data: requireRowObject(data, 'data'),
        ...(returnData === true ? { returnData: true } : {}),
        ...(dryRun === true ? { dryRun: true } : {}),
      },
      signal,
    })
  }

  /** Upsert: update matching rows, insert when none match (body: filter + data). */
  async upsertDataTableRows(alias, dataTableId, { filter, data, returnData, dryRun, signal } = {}) {
    return this.request(alias, 'POST', `/data-tables/${encodeURIComponent(dataTableId)}/rows/upsert`, {
      body: {
        filter: validateRowFilter(filter, { required: true }),
        data: requireRowObject(data, 'data'),
        ...(returnData === true ? { returnData: true } : {}),
        ...(dryRun === true ? { dryRun: true } : {}),
      },
      signal,
    })
  }

  /** Delete matching rows; the filter is mandatory and travels in the query string. */
  async deleteDataTableRows(alias, dataTableId, { filter, returnData, dryRun, signal } = {}) {
    const filterQuery = rowFilterQuery(filter)
    if (filterQuery === undefined) throw new Error('filter 是必填项——不带条件的删除会波及整表，n8n API 也拒绝空 filter')
    return this.request(alias, 'DELETE', `/data-tables/${encodeURIComponent(dataTableId)}/rows`, {
      query: { filter: filterQuery, ...(returnData === true ? { returnData: 'true' } : {}), ...(dryRun === true ? { dryRun: 'true' } : {}) },
      signal,
    })
  }

  /** Delete every row of a data table; returns {deletedCount}. */
  async clearDataTableRows(alias, dataTableId, { signal } = {}) {
    return this.request(alias, 'DELETE', `/data-tables/${encodeURIComponent(dataTableId)}/rows/clear`, { signal })
  }

  /** Escape hatch: one arbitrary public-API request. */
  async raw(alias, { method, path, query, body, timeoutMs, signal }) {
    return this.request(alias, method ?? 'GET', path, { query, body, timeoutMs, signal })
  }

  /**
   * Call a workflow's Webhook trigger endpoint (the way to run a workflow on
   * demand without an authenticated `run` API). Webhook URLs live outside
   * `/api/v1` and are public by design, so this carries no API key. Non-2xx
   * responses are returned, not thrown: a 404 ("wrong path / workflow not
   * published") is a diagnostic result the caller should render, while
   * transport failures still throw {@link N8nError}.
   */
  async callWebhook(alias, { path, method = 'GET', mode = 'production', query, body, timeoutMs, signal } = {}) {
    const entry = this.store.require(alias)
    // Webhook routes sit beside `/api/v1`, under whatever path prefix the
    // instance is served from (a reverse proxy mounted at /n8n, say), so the
    // prefix has to travel with the request — taking only the origin dropped it.
    const root = new URL(String(entry.baseUrl).replace(/\/+$/, ''))
    const prefix = root.pathname.replace(/\/+$/, '')
    const branch = mode === 'test' ? 'webhook-test' : 'webhook'
    const cleanPath = String(path).replace(/^\/+/, '')
    const url = new URL(`${prefix}/${branch}/${cleanPath}`, root.origin)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item))
      } else {
        url.searchParams.set(key, String(value))
      }
    }
    const verb = String(method).toUpperCase()
    if (body !== undefined && (verb === 'GET' || verb === 'HEAD')) {
      throw new Error(`${verb} 请求不支持 body——请改用 query 参数，或把节点/调用改成 POST`)
    }
    const headers = {
      accept: 'application/json, text/plain;q=0.8, */*;q=0.5',
      // Same reason as `request`: the host's undici wrapper drops automatic
      // decompression, so ask for an uncompressed body up front.
      'accept-encoding': 'identity',
    }
    const init = { method: verb, headers, signal: this.#signal(timeoutMs, signal) }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const started = Date.now()
    let response
    try {
      response = await this.fetchImpl(url, init)
    } catch (error) {
      if (signal?.aborted) throw new Error('请求已取消')
      throw new N8nError(`n8n webhook 调用失败：${describeFetchError(error)}`, { alias, path: url.pathname })
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
    return {
      url: url.toString(),
      method: verb,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type') ?? undefined,
      durationMs: Math.max(1, Date.now() - started),
      body: parsed === undefined ? null : parsed,
    }
  }

  /**
   * Poll one execution until it reaches a terminal status (or the budget runs
   * out). A `waiting` execution is returned immediately with `timedOut: false`
   * — it is parked on an external event and will not finish by itself. With
   * `includeData` the final fetch re-reads the execution with its per-node
   * data so the caller can render the run in one round trip.
   */
  async waitExecution(alias, executionId, { timeoutMs = 60_000, pollMs = 2_000, includeData = true, signal } = {}) {
    const started = Date.now()
    const budget = Math.min(Math.max(timeoutMs, 1_000), 600_000)
    const interval = Math.max(500, pollMs)
    for (;;) {
      const execution = await this.getExecution(alias, executionId, { includeData: false, signal })
      const status = execution?.status
      if (status === undefined || EXECUTION_TERMINAL_STATUSES.has(status) || status === 'waiting') {
        const final = includeData
          ? await this.getExecution(alias, executionId, { includeData: true, signal })
          : execution
        return { execution: final, waitedMs: Date.now() - started, timedOut: false }
      }
      if (Date.now() - started >= budget) {
        return { execution, waitedMs: Date.now() - started, timedOut: true }
      }
      await delay(Math.min(interval, budget - (Date.now() - started)), signal)
    }
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

/**
 * Project a workflow onto a create-request body for cloning. Only the
 * definition travels: identity, activation, tags (read-only in the workflow
 * document; applied through the tags endpoint) and runtime state (staticData,
 * meta, shared) never do. Pinned editor data is kept, since it is part of what
 * a clone is for. A missing name becomes 「<source>（副本）」.
 */
export function toWorkflowClonePayload(workflow, name) {
  const sourceName = typeof workflow?.name === 'string' && workflow.name !== '' ? workflow.name : '未命名工作流'
  const payload = {
    name: typeof name === 'string' && name.trim() !== '' ? name.trim() : `${sourceName}（副本）`,
    nodes: Array.isArray(workflow?.nodes) ? workflow.nodes : [],
    connections: workflow?.connections ?? {},
    settings: workflow?.settings ?? {},
  }
  if (Array.isArray(workflow?.nodeGroups) && workflow.nodeGroups.length > 0) {
    payload.nodeGroups = workflow.nodeGroups
  }
  if (workflow?.pinData !== null && typeof workflow?.pinData === 'object' && Object.keys(workflow.pinData).length > 0) {
    payload.pinData = workflow.pinData
  }
  return payload
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

/**
 * List the Webhook trigger nodes of a workflow: name, request path and HTTP
 * method. Pure so the tool layer can pick a target and tests can drive it.
 * Nodes whose `path` is missing/empty are skipped (they would 404 anyway).
 */
export function extractWebhookPaths(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : []
  const hooks = []
  for (const node of nodes) {
    if (node?.type !== WEBHOOK_NODE_TYPE) continue
    const path = node.parameters?.path
    if (typeof path !== 'string' || path === '') continue
    const method = node.parameters?.httpMethod
    hooks.push({
      ...(typeof node.name === 'string' ? { name: node.name } : {}),
      path,
      method: typeof method === 'string' && method !== '' ? method.toUpperCase() : 'GET',
    })
  }
  return hooks
}