/**
 * Model-facing text rendering for the n8n tool surface.
 *
 * Every `output.render` hook returns one text content block built here. Keeping
 * the formatters in their own module means they are pure (no registry, no
 * client, no SDK) and therefore testable on their own — `render` also runs on
 * replay, so it must never touch I/O, the clock, or randomness.
 */
import { matchExecutionErrorPatterns } from './execution-errors.js'

/** One text content block (the only render shape these tools emit). */
export function text(value) {
  return [{ type: 'text', text: value }]
}

/**
 * Render a simple aligned text table.
 * @param headers - column headers.
 * @param rows - cell values, stringified.
 */
export function table(headers, rows) {
  if (rows.length === 0) return '无数据'
  const cells = [headers, ...rows].map(row => row.map(value => String(value ?? '')))
  const widths = headers.map((_, index) => Math.max(...cells.map(row => row[index].length)))
  const line = row => row.map((cell, index) => cell.padEnd(widths[index])).join(' | ').trimEnd()
  return [line(cells[0]), widths.map(width => '-'.repeat(width)).join(' | '), ...cells.slice(1).map(line)].join('\n')
}

/** Append the pagination hint a list page carries. */
function withCursor(body, nextCursor) {
  return nextCursor === null || nextCursor === undefined ? body : `${body}\n\n下一页 cursor: ${nextCursor}`
}

/** Render the alias list shared by the instance tool and the missing-alias errors. */
export function renderInstances(instances) {
  return table(
    ['别名', '实例地址', 'API Key', '默认', '备注'],
    instances.map(instance => [
      instance.alias,
      instance.baseUrl,
      instance.apiKeyMasked,
      instance.isDefault ? '是' : '-',
      instance.description ?? '',
    ]),
  )
}

/**
 * Tag names of a workflow. The n8n API returns tag objects, but a hand-written
 * workflow may carry plain strings, so accept both.
 */
function tagNames(tags) {
  return (tags ?? [])
    .map(tag => (typeof tag === 'string' ? tag : tag?.name))
    .filter(name => typeof name === 'string' && name.length > 0)
}

/** Render one workflow list page. */
export function renderWorkflows(page) {
  if (page.data.length === 0) return '没有工作流'
  return withCursor(table(
    ['ID', '名称', '已发布', '更新时间', '标签'],
    page.data.map(workflow => [
      workflow.id,
      workflow.name,
      workflow.active ? '是' : '-',
      workflow.updatedAt ?? '-',
      tagNames(workflow.tags).join(',') || '-',
    ]),
  ), page.nextCursor)
}

/** Render one tag. */
export function renderTag(tag) {
  return `标签 ${tag?.id ?? '?'}：${tag?.name ?? '（未命名）'}`
}

/** Render the tags of one workflow. */
export function renderTagTable(tags) {
  if (tags.length === 0) return '该工作流没有标签'
  return table(['ID', '名称'], tags.map(tag => [tag.id, tag.name]))
}

/** Render a clone result: the new workflow, its source, copied tags and warnings. */
export function renderClone(value) {
  const lines = [`已克隆工作流 ${value.id}：${value.name ?? '（未命名）'}`]
  if (value.source !== undefined) {
    lines.push(`源工作流：${value.source.id}（${value.source.name ?? '未命名'}）`)
  }
  if (Array.isArray(value.tags) && value.tags.length > 0) {
    lines.push(`已复制标签：${value.tags.map(tag => tag.name ?? tag.id).join('、')}`)
  } else if (typeof value.tagsError === 'string') {
    lines.push(`标签复制失败：${value.tagsError}`)
  }
  lines.push(value.active === true ? '副本已发布' : '副本未发布（可用 n8n_workflow_publish 发布）')
  if (typeof value.publishError === 'string') lines.push(`发布失败：${value.publishError}`)
  for (const warning of Array.isArray(value.warnings) ? value.warnings : []) lines.push(`提示：${warning}`)
  return lines.join('\n')
}

/** Render one execution list page. */
export function renderExecutions(page) {
  if (page.data.length === 0) return '没有执行记录'
  return withCursor(table(
    ['ID', '工作流', '状态', '模式', '开始', '结束'],
    page.data.map(execution => [
      execution.id,
      execution.workflowId,
      execution.status,
      execution.mode ?? '-',
      execution.startedAt ?? '-',
      execution.finished === undefined ? '-' : String(execution.finished),
    ]),
  ), page.nextCursor)
}

/** Human label per execution status (matches n8n's status vocabulary). */
const EXECUTION_STATUS_LABELS = {
  success: '✓ 成功',
  error: '✗ 失败',
  running: '▶ 运行中',
  new: '• 新建',
  waiting: '⏸ 等待中',
  canceled: '⊘ 已取消',
  crashed: '💥 崩溃',
}

/** One execution status (or task status) as a short human label. */
export function executionStatusLabel(status) {
  if (typeof status === 'string' && EXECUTION_STATUS_LABELS[status] !== undefined) {
    return EXECUTION_STATUS_LABELS[status]
  }
  return status === undefined || status === null || status === '' ? '未知' : String(status)
}

/** Milliseconds as a compact human duration. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
}

/** Stringify and clip any value to `max` characters, with a truncation marker. */
export function clip(value, max = 600) {
  if (value === undefined || value === null) return ''
  let content
  if (typeof value === 'string') content = value
  else {
    try {
      content = JSON.stringify(value)
    } catch {
      content = String(value)
    }
  }
  if (content.length > max) return content.slice(0, max) + `…（截断，共 ${content.length} 字符）`
  return content
}

/** Pull the most useful message out of an n8n node/workflow error object. */
function errorText(error) {
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message !== '') return error.message
  return clip(error, 200)
}

/** Wall-clock duration of an execution, or the sum of its node times, or null. */
function executionDuration(execution) {
  const started = Date.parse(execution?.startedAt ?? '')
  const stopped = Date.parse(execution?.stoppedAt ?? '')
  if (Number.isFinite(started) && Number.isFinite(stopped)) return Math.max(0, stopped - started)
  const runData = execution?.data?.resultData?.runData
  if (runData !== null && typeof runData === 'object') {
    let total = 0
    for (const tasks of Object.values(runData)) {
      const task = Array.isArray(tasks) ? tasks[tasks.length - 1] : undefined
      if (typeof task?.executionTime === 'number') total += task.executionTime
    }
    return total > 0 ? total : null
  }
  return null
}

/** The output of the last executed node that produced one, clipped. */
function lastNodeOutput(runData, names) {
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const tasks = Array.isArray(runData[names[index]]) ? runData[names[index]] : []
    for (let taskIndex = tasks.length - 1; taskIndex >= 0; taskIndex -= 1) {
      const outputs = tasks[taskIndex]?.outputData
      if (Array.isArray(outputs) && outputs.length > 0) {
        const first = outputs[0]
        return clip(first?.json !== undefined ? first.json : first, 600)
      }
    }
  }
  return null
}

/**
 * Render one execution in a structured, token-frugal view: a header line with
 * status and duration, one line per executed node (time, status, error
 * summary) and the last node's output. Degrades safely when the execution was
 * fetched without data.
 */
export function renderExecutionDetail(execution) {
  const lines = []
  const status = executionStatusLabel(execution?.status)
  lines.push(`执行 ${execution?.id ?? '?'} · 工作流 ${execution?.workflowId ?? '?'} [${status}]` + (execution?.mode !== undefined ? ` · 模式 ${execution.mode}` : ''))
  const duration = executionDuration(execution)
  if (duration !== null) {
    lines.push(`开始 ${execution?.startedAt ?? '-'} → 结束 ${execution?.stoppedAt ?? '-'} · 用时 ${formatDuration(duration)}`)
  } else if (execution?.startedAt !== undefined) {
    lines.push(`开始 ${execution.startedAt}`)
  }
  const result = execution?.data?.resultData
  const runData = result?.runData
  if (runData === null || runData === undefined || typeof runData !== 'object') {
    if (result?.error !== undefined) lines.push(`工作流错误：${errorText(result.error)}`)
    return lines.join('\n')
  }
  const names = Object.keys(runData)
  const cap = 50
  lines.push('')
  lines.push(`节点执行（${names.length}）：`)
  const failureTexts = []
  for (const name of names.slice(0, cap)) {
    const tasks = Array.isArray(runData[name]) ? runData[name] : []
    const task = tasks[tasks.length - 1] ?? {}
    const taskStatus = task.error !== undefined || task.status === 'error' ? '✗ 失败' : executionStatusLabel(task.status ?? 'success')
    const ms = typeof task.executionTime === 'number' ? ` · ${formatDuration(task.executionTime)}` : ''
    lines.push(`- ${name} ${taskStatus}${ms}`)
    if (task.error !== undefined) {
      const message = errorText(task.error)
      if (message !== '') {
        lines.push(`  错误：${message}`)
        failureTexts.push(message)
      }
      const description = typeof task.error?.description === 'string' ? task.error.description.split('\n')[0] : ''
      if (description !== '') {
        lines.push(`  描述：${description}`)
        failureTexts.push(description)
      }
    }
  }
  if (names.length > cap) lines.push(`…还有 ${names.length - cap} 个节点未显示`)
  if (result?.error !== undefined) {
    const workflowError = errorText(result.error)
    lines.push(`工作流错误：${workflowError}`)
    failureTexts.push(workflowError)
  }
  // Root-cause hints for failed executions, matched against the raw error
  // lines collected above (kept short: at most three).
  if (failureTexts.length > 0) {
    const hints = matchExecutionErrorPatterns(failureTexts.join('\n'))
    if (hints.length > 0) {
      lines.push('')
      lines.push('错误模式提示：')
      for (const hint of hints) lines.push(`- ${hint}`)
    }
  }
  const output = lastNodeOutput(runData, names)
  if (output !== null && output !== '') lines.push('', `末节点输出：${output}`)
  return lines.join('\n')
}

/** Render one on-demand webhook trigger plus its follow-up execution. */
export function renderWebhookCall(value) {
  const lines = []
  const workflow = value?.workflow
  if (workflow !== undefined) {
    lines.push(`工作流 ${workflow.id}「${workflow.name ?? ''}」[${workflow.active === true ? '已发布' : '未发布'}]`)
  }
  const webhook = value?.webhook
  if (webhook !== undefined) lines.push(`Webhook ${webhook.method} ${webhook.url}（${webhook.mode}）`)
  const response = value?.response
  if (response !== undefined) {
    lines.push(`HTTP ${response.status} · ${formatDuration(response.durationMs)}`)
    if (response.body !== null && response.body !== undefined && response.body !== '') {
      lines.push(`响应：${clip(response.body, 400)}`)
    }
  }
  for (const warning of value?.warnings ?? []) lines.push(`警告：${warning}`)
  if (value?.execution !== undefined) {
    lines.push('', renderExecutionDetail(value.execution))
    if (value?.wait !== undefined) {
      lines.push(value.wait.timedOut
        ? `（等待 ${formatDuration(value.wait.waitedMs)} 后超时，执行仍在进行——稍后可用 n8n_execution_get 再查）`
        : `（等待 ${formatDuration(value.wait.waitedMs)} 后结束）`)
    }
  }
  return lines.join('\n')
}

/** Render one wait-for-execution result (the header plus the wait outcome). */
export function renderWaitResult(value) {
  const lines = [renderExecutionDetail(value?.execution)]
  lines.push(value?.timedOut === true
    ? `（等待 ${formatDuration(value?.waitedMs)} 后超时，执行仍未结束——稍后可用 n8n_execution_get 再查）`
    : `（等待 ${formatDuration(value?.waitedMs ?? 0)} 后返回）`)
  return lines.join('\n')
}

/** Render the outcome of a stop request: canceled, still running, or already over. */
export function renderExecutionCancel(value) {
  const id = value?.id ?? '?'
  const status = executionStatusLabel(value?.status)
  if (value?.status === 'canceled') return `已取消执行 ${id}（状态：${status}）`
  if (value?.status === 'running' || value?.status === 'new' || value?.status === 'waiting') {
    return `已向执行 ${id} 发出停止请求，当前仍为「${status}」——停止不是瞬时的，稍后用 n8n_execution_get 复查`
  }
  return `执行 ${id} 已经结束（状态：${status}），无需取消`
}

/** Render an instances probe: one row per feature endpoint with its verdict. */
export function renderProbe(probe) {
  if (probe.reachable === false) {
    return `实例 ${probe.alias}（${probe.baseUrl}）不可达：${probe.errorMessage}`
  }
  const KIND_LABELS = {
    unauthorized: '✗ 401 鉴权失败',
    forbidden: '✗ 403 许可不足',
    absent: '✗ 404 端点不存在（版本过旧）',
    error: '✗ 请求失败',
    unreachable: '✗ 请求失败',
  }
  const labels = {
    workflows: '工作流',
    executions: '执行记录',
    tags: '标签',
    credentials: '凭证',
    variables: '变量',
    dataTables: 'Data Table',
  }
  const rows = Object.entries(probe.capabilities ?? {}).map(([name, capability]) => [
    `${labels[name] ?? name}`,
    capability.available === true ? '✓ 可用' : KIND_LABELS[capability.kind] ?? '✗ 不可用',
    capability.available === true ? '' : capability.message ?? '',
  ])
  return `实例 ${probe.alias}（${probe.baseUrl}）能力探测：\n` + table(['能力', '状态', '详情'], rows)
}

/** Render one variables list page. */
export function renderVariables(page) {
  if (page.data.length === 0) return '没有变量'
  return withCursor(table(
    ['Key', 'Value', 'ID'],
    page.data.map(variable => [variable.key, clip(String(variable.value ?? ''), 80), variable.id]),
  ), page.nextCursor)
}

/** Render the result of a variable set (created vs updated). */
export function renderVariableSet(value) {
  const action = value.created === true ? '已创建' : '已更新'
  return `变量 ${value.key} ${action}（值：${clip(String(value.value ?? ''), 200)}）`
}

/** Render one data table with its columns. */
export function renderDataTable(dataTable) {
  const lines = [`数据表 ${dataTable.id}「${dataTable.name}」`]
  if (dataTable.sizeBytes !== undefined) lines.push(`大小：${dataTable.sizeBytes} 字节`)
  const columns = Array.isArray(dataTable.columns) ? dataTable.columns : []
  lines.push(`列（${columns.length}）：`)
  for (const column of columns) lines.push(`- ${column.name} · ${column.type}${column.index !== undefined ? ` · #${column.index}` : ''}`)
  return lines.join('\n')
}

/** Render one data-tables list page. */
export function renderDataTables(page) {
  if (page.data.length === 0) return '没有数据表'
  return withCursor(table(
    ['名称', 'ID', '列数', '大小'],
    page.data.map(dataTable => [
      dataTable.name,
      dataTable.id,
      Array.isArray(dataTable.columns) ? String(dataTable.columns.length) : '',
      dataTable.sizeBytes !== undefined ? String(dataTable.sizeBytes) : '',
    ]),
  ), page.nextCursor)
}

/** Render one rows list page: system columns first, then the table's own columns. */
export function renderDataTableRowsPage(page) {
  if (page.data.length === 0) return '没有行（0 行命中）'
  const systemColumns = ['id', 'createdAt', 'updatedAt']
  const columns = [...systemColumns, ...collectRowColumns(page.data).filter(name => !systemColumns.includes(name))]
  const rows = page.data.map(row => columns.map(column => clip(stringifyRowCell(row?.[column]), 60)))
  return withCursor(table(columns, rows), page.nextCursor)
}

/** Render the result of a rows mutation (insert/update/upsert/delete/clear). */
export function renderRowsMutation(value) {
  if (value === true) return '操作成功'
  if (value === false) return '操作未生效（0 行命中）'
  if (Array.isArray(value)) return table(['id'], value.map(row => [row?.id ?? '']))
  if (value !== null && typeof value === 'object') {
    if (value.success === true && value.insertedRows !== undefined) return `已插入 ${value.insertedRows} 行`
    if (value.deletedCount !== undefined) return `已删除 ${value.deletedCount} 行`
    return JSON.stringify(value)
  }
  return String(value)
}

/** Column names seen across a rows page (deduped, first-seen order). */
function collectRowColumns(rows) {
  const names = []
  const seen = new Set()
  for (const row of rows) {
    for (const key of Object.keys(row ?? {})) {
      if (!seen.has(key)) {
        seen.add(key)
        names.push(key)
      }
    }
  }
  return names
}

/** Stringify one row cell for the table renderer. */
function stringifyRowCell(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
