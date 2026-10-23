/**
 * Instance store: one JSON file (`$DSH_HOME/dsh-n8n-plugin.json`, defaulting to
 * `~/.dsh/dsh-n8n-plugin.json`) holding every n8n instance the user registered,
 * written atomically (tmp + rename) with owner-only permissions.
 *
 * Each entry carries a user-chosen alias, the instance base URL, and its n8n
 * API key (`X-N8N-API-KEY`). API keys live in this user-owned file in
 * plaintext — the same trust model as `~/.n8n` or an `n8n-api.sh` environment
 * file. The Host never logs a key, and every browser/agent projection masks it.
 *
 * Pure file I/O: no cordis imports, so the store is unit-testable on its own.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** File format version (bumped only on an incompatible shape change). */
const FORMAT_VERSION = 1

/** Alias grammar: letters/digits plus dots, hyphens and underscores. */
const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** Resolve `$DSH_HOME` (environment override wins, `~/.dsh` otherwise). */
export function dshHome(env = process.env, home = homedir()) {
  const raw = env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim()
    if (trimmed === '~') return home
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
    return isAbsolute(trimmed) ? trimmed : resolve(trimmed)
  }
  return join(home, '.dsh')
}

/** Store file location: `$DSH_HOME/dsh-n8n-plugin.json`. */
export function storePath(env = process.env, home = homedir()) {
  return join(dshHome(env, home), 'dsh-n8n-plugin.json')
}

/** Validate an alias; returns a message or undefined when it is usable. */
export function validateAlias(alias) {
  if (typeof alias !== 'string' || alias.trim() === '') return '别名为必填项'
  if (!ALIAS_RE.test(alias.trim())) return '别名必须以字母或数字开头，且只能包含字母、数字、点、连字符或下划线'
  if (alias.trim().length > 64) return '别名最长 64 个字符'
  return undefined
}

/**
 * Normalize an n8n base URL: trim, drop the trailing slash and a redundant
 * `/api/v1` suffix (the REST client appends the versioned path itself).
 * @returns the normalized URL, or a validation message prefixed with `error:`.
 */
export function normalizeBaseUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return 'error:实例地址必填'
  let url
  try {
    url = new URL(text)
  } catch {
    return 'error:实例地址必须是绝对 http(s) 地址，例如 https://n8n.example.com'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'error:实例地址必须以 http:// 或 https:// 开头'
  }
  if (url.username !== '' || url.password !== '') {
    return 'error:实例地址中不能内嵌账号密码——请改用 API Key 字段'
  }
  let pathname = url.pathname.replace(/\/+$/, '')
  pathname = pathname.replace(/\/api\/v1$/i, '')
  const normalized = `${url.origin}${pathname}${url.search}`
  return normalized
}

/** Mask an API key for browser/agent projections: keep the last four characters. */
export function maskApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey === '') return ''
  if (apiKey.length <= 4) return '****'
  return '****' + apiKey.slice(-4)
}

/** Validate a create/update payload; returns a message or undefined. */
export function validateInstancePayload(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return '请求体必须是 JSON 对象'
  const aliasError = validateAlias(payload.alias)
  if (aliasError !== undefined) return aliasError
  if (typeof payload.baseUrl !== 'string' || payload.baseUrl.trim() === '') return '实例地址必填'
  const base = normalizeBaseUrl(payload.baseUrl)
  if (base.startsWith('error:')) return base.slice('error:'.length)
  if (typeof payload.apiKey !== 'string' || payload.apiKey.trim() === '') return 'API Key 必填'
  if (payload.description !== undefined && typeof payload.description !== 'string') return 'description 必须是字符串'
  if (payload.isDefault !== undefined && typeof payload.isDefault !== 'boolean') return 'isDefault 必须是布尔值'
  return undefined
}

/** One stored instance entry (the on-disk shape). */
export class InstanceStore {
  /**
   * @param path - store file path (defaults to the standard location).
   */
  constructor(path) {
    this.path = resolve(path ?? storePath())
    this.cache = undefined
  }

  /** Whether the store file exists on disk. */
  get exists() {
    return existsSync(this.path)
  }

  /** Load every entry (empty list when the file is absent). */
  list() {
    return this.load().instances
  }

  /** Find one entry by alias. */
  find(alias) {
    return this.list().find(entry => entry.alias === alias)
  }

  /** Find one entry by alias or throw a user-facing error. */
  require(alias) {
    if (typeof alias !== 'string' || alias.trim() === '') throw new Error('缺少实例别名')
    const entry = this.find(alias.trim())
    if (entry === undefined) {
      const known = this.list().map(candidate => candidate.alias)
      throw new Error(known.length === 0
        ? `尚未配置任何 n8n 实例——请在 设置 → n8n 实例 中添加（未找到别名 '${alias}'）`
        : `未知实例别名 '${alias}'（已配置：${known.join(', ')}）`)
    }
    return entry
  }

  /** The default instance alias, when one is marked or a single entry exists. */
  defaultAlias() {
    const entries = this.list()
    const marked = entries.find(entry => entry.isDefault === true)
    if (marked !== undefined) return marked.alias
    return entries.length > 0 ? entries[0].alias : undefined
  }

  /** Secret-free projection for the browser and agent surfaces. */
  summarize(entry) {
    return {
      alias: entry.alias,
      baseUrl: entry.baseUrl,
      apiKeyMasked: maskApiKey(entry.apiKey),
      apiKeyConfigured: typeof entry.apiKey === 'string' && entry.apiKey !== '',
      isDefault: entry.isDefault === true,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }
  }

  /** Create one instance. Throws on invalid payload or alias collision. */
  create(payload) {
    const error = validateInstancePayload(payload)
    if (error !== undefined) throw new Error(error)
    const alias = payload.alias.trim()
    const file = this.load()
    if (file.instances.some(entry => entry.alias === alias)) throw new Error(`别名 '${alias}' 已存在`)
    const now = Date.now()
    const entry = {
      alias,
      baseUrl: normalizeBaseUrl(payload.baseUrl),
      apiKey: payload.apiKey.trim(),
      isDefault: false,
      ...(payload.description !== undefined && payload.description.trim() !== ''
        ? { description: payload.description.trim() }
        : {}),
      createdAt: now,
      updatedAt: now,
    }
    file.instances.push(entry)
    this.applyDefault(file, entry, payload.isDefault === true, true)
    this.save(file)
    return entry
  }

  /**
   * Update the fields present in `patch`; unknown aliases throw. A `patch.alias`
   * renames the entry (uniqueness checked); a blank/absent `patch.apiKey` keeps
   * the stored key.
   */
  update(alias, patch) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('请求体必须是 JSON 对象')
    const file = this.load()
    const entry = file.instances.find(candidate => candidate.alias === alias)
    if (entry === undefined) throw new Error(`别名 '${alias}' 不存在`)

    if (patch.alias !== undefined) {
      const aliasError = validateAlias(patch.alias)
      if (aliasError !== undefined) throw new Error(aliasError)
      const next = patch.alias.trim()
      if (next !== alias) {
        if (file.instances.some(candidate => candidate.alias === next)) throw new Error(`别名 '${next}' 已存在`)
        entry.alias = next
      }
    }
    if (patch.baseUrl !== undefined) {
      if (typeof patch.baseUrl !== 'string' || patch.baseUrl.trim() === '') throw new Error('实例地址必填')
      const base = normalizeBaseUrl(patch.baseUrl)
      if (base.startsWith('error:')) throw new Error(base.slice('error:'.length))
      entry.baseUrl = base
    }
    if (patch.apiKey !== undefined) {
      if (typeof patch.apiKey !== 'string') throw new Error('API Key 必须是字符串')
      // Blank keeps the stored key: the browser never receives it back, so an
      // untouched form field must not erase it.
      if (patch.apiKey.trim() !== '') entry.apiKey = patch.apiKey.trim()
    }
    if (patch.description !== undefined) {
      if (typeof patch.description !== 'string') throw new Error('description 必须是字符串')
      const description = patch.description.trim()
      if (description === '') delete entry.description
      else entry.description = description
    }
    if (patch.isDefault !== undefined) {
      if (typeof patch.isDefault !== 'boolean') throw new Error('isDefault 必须是布尔值')
      this.applyDefault(file, entry, patch.isDefault, false)
    }
    entry.updatedAt = Date.now()
    this.save(file)
    return entry
  }

  /** Remove one instance. The default flag moves to the first remaining entry. */
  delete(alias) {
    const file = this.load()
    const index = file.instances.findIndex(candidate => candidate.alias === alias)
    if (index < 0) throw new Error(`别名 '${alias}' 不存在`)
    const [removed] = file.instances.splice(index, 1)
    if (removed.isDefault === true && file.instances.length > 0) {
      file.instances[0].isDefault = true
      file.instances[0].updatedAt = Date.now()
    }
    this.save(file)
  }

  /** Clear the default flag elsewhere and set it on `entry` (or make it the only default). */
  applyDefault(file, entry, makeDefault, creating) {
    const noDefault = !file.instances.some(candidate => candidate.isDefault === true)
    if (makeDefault || (creating && noDefault) || (creating && file.instances.length === 1)) {
      for (const candidate of file.instances) {
        if (candidate !== entry && candidate.isDefault === true) {
          candidate.isDefault = false
          candidate.updatedAt = Date.now()
        }
      }
      entry.isDefault = true
    }
  }

  /** Parse the store, caching by file identity. Corrupt files are set aside, never overwritten silently. */
  load() {
    let stats
    try {
      stats = statSync(this.path)
    } catch {
      this.cache = undefined
      return { version: FORMAT_VERSION, instances: [] }
    }
    if (this.cache !== undefined && this.cache.mtimeMs === stats.mtimeMs && this.cache.size === stats.size) {
      return this.cache.file
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.instances)) {
        throw new Error('store file shape invalid')
      }
      parsed.instances = parsed.instances.filter(instance => isStoredEntry(instance))
      this.cache = { mtimeMs: stats.mtimeMs, size: stats.size, file: parsed }
      return parsed
    } catch {
      this.cache = undefined
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
      } catch {
        // Best effort: the user keeps the broken file and the plugin starts empty.
      }
      return { version: FORMAT_VERSION, instances: [] }
    }
  }

  /** Atomically replace the store file (owner-only permissions). */
  save(file) {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify({ version: FORMAT_VERSION, instances: file.instances }, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(tmp, this.path)
    this.cache = undefined
  }
}

/** Whether a parsed entry has the minimum usable shape. */
function isStoredEntry(entry) {
  return typeof entry === 'object' && entry !== null
    && typeof entry.alias === 'string' && entry.alias !== ''
    && typeof entry.baseUrl === 'string' && entry.baseUrl !== ''
    && typeof entry.apiKey === 'string'
}