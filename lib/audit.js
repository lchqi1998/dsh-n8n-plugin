/**
 * Append-only audit log for state-changing operations ($DSH_HOME/dsh-n8n-plugin.audit.log).
 *
 * One JSON object per line: who (actor), what (tool/action), where (alias +
 * target), outcome and duration. Secrets never enter this file — targets are
 * ids/names/paths only. Writers must never break the operation they audit, so
 * {@link appendAudit} swallows its own I/O failures after warning.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { dshHome } from './store.js'

/** Rotate the log once it grows past this many bytes, keeping the newest lines. */
const ROTATE_BYTES = 1_048_576

/** How many newest lines survive a rotation. */
const ROTATE_KEEP_LINES = 500

/** Audit file location: `$DSH_HOME/dsh-n8n-plugin.audit.log`. */
export function auditPath(env = process.env, home = homedir()) {
  return join(dshHome(env, home), 'dsh-n8n-plugin.audit.log')
}

/**
 * Append one record. Never throws: an audit failure must not fail the
 * operation being audited (it warns on stderr instead).
 * @param record - plain object; `ts` is added when absent.
 * @param options - `path` override (tests).
 */
export function appendAudit(record, { path } = {}) {
  const file = path ?? auditPath()
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record })
    let stats
    try {
      stats = statSync(file)
    } catch {
      stats = undefined
    }
    if (stats !== undefined && stats.size > ROTATE_BYTES) {
      rotate(file)
    }
    const dir = dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(file, line + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    console.warn('[dsh-n8n-plugin] audit write failed:', error instanceof Error ? error.message : error)
  }
}

/** Keep only the newest {@link ROTATE_KEEP_LINES} lines (best effort). */
function rotate(file) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
    const kept = lines.slice(-ROTATE_KEEP_LINES)
    writeFileSync(file, kept.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    console.warn('[dsh-n8n-plugin] audit rotation failed:', error instanceof Error ? error.message : error)
  }
}

/**
 * Read the newest `limit` records (newest first). Malformed lines are skipped,
 * and a missing file simply yields an empty list.
 * @param options - `limit` (default 50) and `path` override (tests).
 */
export function readAudit({ limit = 50, path } = {}) {
  const file = path ?? auditPath()
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const entries = []
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0 && entries.length < Math.max(1, limit); index -= 1) {
    const line = lines[index].trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object') entries.push(parsed)
    } catch {
      // A torn or foreign line: skip it, keep the rest readable.
    }
  }
  return entries
}
