/**
 * Small HTTP helpers for the /api/dsh-n8n-plugin route family: one bounded JSON body
 * reader, one JSON writer, and the loopback trust fence.
 *
 * The fence mirrors what the dsh-web plugin family uses: the socket address
 * must be loopback, the Host header must name a loopback authority, a request
 * carrying a forwarding header is refused (a proxy stood in between), and the
 * browser same-origin markers must agree. Instance CRUD hands out API keys, so
 * these endpoints must never be reachable from the LAN.
 */

/** Default JSON body cap: 256 KiB (an n8n workflow JSON fits comfortably). */
export const DEFAULT_JSON_BODY_MAX_BYTES = 256 * 1024

/** One JSON response with no-store caching: API keys must never be cached. */
export function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(payload)
}

/**
 * Read a request body as JSON.
 * @param req - node HTTP request.
 * @param maxBytes - byte cap (default 256 KiB); an oversized body destroys the request.
 * @returns the parsed value, or undefined for an empty, oversized, or invalid body.
 */
export async function readJsonBody(req, maxBytes = DEFAULT_JSON_BODY_MAX_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      req.destroy()
      return undefined
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Whether a value is a JSON object (not null, not an array). */
export function isJsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** IPv4 127/8 predicate. */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address is loopback (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** Whether a reverse proxy stood between the client and this host. */
export function isProxiedRequest(req) {
  return req.headers['cf-connecting-ip'] !== undefined
    || req.headers['x-forwarded-for'] !== undefined
}

/**
 * Request-level trust fence for the instance-management endpoints.
 * @param req - node HTTP request.
 * @returns true only for a direct loopback browser request.
 */
export function isLoopbackRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  if (isProxiedRequest(req)) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** First value of a URL query parameter. */
export function queryParam(url, name) {
  const value = url.searchParams.get(name)
  return value === null || value === '' ? undefined : value
}