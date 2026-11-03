/**
 * Execution error pattern library.
 *
 * A failed n8n execution usually exposes a raw node error (an HTTP status, a
 * JS TypeError, an expression resolution failure, …). Behind each such message
 * stands a small, well-known class of root cause, and the fix is almost always
 * the same. This table maps the observable message to that actionable hint, so
 * the execution renderers can offer a next step instead of a raw stack line.
 *
 * Pure module: regexes and strings only, no I/O — the render layer and the
 * tests consume it directly.
 */

/**
 * Ordered pattern table: the first `max` distinct hints win, so put the more
 * specific patterns first. `pattern` is tested against the concatenated error
 * text of a failed execution (node error message + description + workflow
 * error), case-insensitively.
 */
export const EXECUTION_ERROR_PATTERNS = [
  {
    id: 'http-401',
    pattern: /\b401\b|unauthorized|invalid api key|invalid credential/i,
    hint: 'HTTP 401/未授权：凭证缺失或无效——用 n8n_credentials 确认凭证已配置且类型匹配',
  },
  {
    id: 'http-403',
    pattern: /\b403\b|forbidden|permission denied/i,
    hint: 'HTTP 403：对端拒绝了这次访问——凭证有效但角色/许可不足，或资源不可见',
  },
  {
    id: 'http-404',
    pattern: /\b404\b|not found/i,
    hint: 'HTTP 404：URL 或资源不存在；webhook 触发还要求工作流已发布',
  },
  {
    id: 'http-429',
    pattern: /\b429\b|rate limit|too many requests/i,
    hint: 'HTTP 429：被限流——降低轮询频率/并发，或加重试间隔',
  },
  {
    id: 'http-5xx',
    pattern: /\b5\d{2}\b|internal server error|bad gateway|service unavailable/i,
    hint: 'HTTP 5xx：对端服务故障——稍后重试，或检查目标服务的健康状态',
  },
  {
    id: 'conn-refused',
    pattern: /ECONNREFUSED/i,
    hint: '连接被拒绝——目标主机或端口不正确，或服务没有启动',
  },
  {
    id: 'dns',
    pattern: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    hint: 'DNS 解析失败——检查主机名拼写与 DNS 配置',
  },
  {
    id: 'timeout',
    pattern: /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TimeoutError|socket hang up|ECONNRESET/i,
    hint: '连接超时或被重置——检查网络与对端负载；HTTP 节点可调大 timeout',
  },
  {
    id: 'tls',
    pattern: /CERT_HAS_EXPIRED|SELF_SIGNED|certificate/i,
    hint: 'TLS 证书被拒（过期/自签）——换受信任证书，或走内网 HTTP',
  },
  {
    id: 'credential-missing',
    pattern: /cannot find credential|credential (is )?not found|no credential/i,
    hint: '节点引用的凭证不存在——用 n8n_credentials 列出可用凭证并核对节点里的凭证名',
  },
  {
    id: 'js-undefined',
    pattern: /Cannot read propert(y|ies)|undefined is not (a|an)|is not a function/i,
    hint: '运行时读到了 undefined/null 的属性：上游输出为空或字段结构与预期不符；上游 0 行时整条分支会被静默跳过，必要时给节点开 alwaysOutputData',
  },
  {
    id: 'expr-unresolved',
    pattern: /Expression (does not resolve|error)|Referenced node (is )?unexecuted|invalid reference/i,
    hint: '表达式解析失败：引用的字段或节点不存在/尚未执行——用 n8n_execution_get 核对上游输出的真实字段名',
  },
  {
    id: 'empty-branch',
    pattern: /No data( found)?|no items|returned no data|empty (result|output)/i,
    hint: '上游没有数据（0 行）——n8n 默认跳过空分支不报错；需要流程继续时给该节点加 alwaysOutputData:true',
  },
  {
    id: 'structure',
    pattern: /could not be found|unknown node|connection.{0,20}(invalid|missing)|Referenced node doesn't exist/i,
    hint: '工作流结构问题：连线/表达式引用了不存在的节点——先跑 n8n_workflow_validate 校验再发布',
  },
]

/**
 * Match the error text of a failed execution against the pattern table.
 * @param text - concatenated error messages (node errors, descriptions, …).
 * @param options - `max` caps the hint count (default 3) to keep renders short.
 * @returns the distinct, ordered hints (may be empty).
 */
export function matchExecutionErrorPatterns(text, { max = 3 } = {}) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const hints = []
  const seen = new Set()
  for (const entry of EXECUTION_ERROR_PATTERNS) {
    if (!entry.pattern.test(text)) continue
    if (seen.has(entry.hint)) continue
    seen.add(entry.hint)
    hints.push(entry.hint)
    if (hints.length >= max) break
  }
  return hints
}
