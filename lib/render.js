/**
 * Model-facing text rendering for the n8n tool surface.
 *
 * Every `output.render` hook returns one text content block built here. Keeping
 * the formatters in their own module means they are pure (no registry, no
 * client, no SDK) and therefore testable on their own — `render` also runs on
 * replay, so it must never touch I/O, the clock, or randomness.
 */

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
  if (rows.length === 0) return 'no rows'
  const cells = [headers, ...rows].map(row => row.map(value => String(value ?? '')))
  const widths = headers.map((_, index) => Math.max(...cells.map(row => row[index].length)))
  const line = row => row.map((cell, index) => cell.padEnd(widths[index])).join(' | ').trimEnd()
  return [line(cells[0]), widths.map(width => '-'.repeat(width)).join(' | '), ...cells.slice(1).map(line)].join('\n')
}

/** Append the pagination hint a list page carries. */
function withCursor(body, nextCursor) {
  return nextCursor === null || nextCursor === undefined ? body : `${body}\n\nnext cursor: ${nextCursor}`
}

/** Render the alias list shared by the instance tool and the missing-alias errors. */
export function renderInstances(instances) {
  return table(
    ['alias', 'base url', 'api key', 'default', 'description'],
    instances.map(instance => [
      instance.alias,
      instance.baseUrl,
      instance.apiKeyMasked,
      instance.isDefault ? 'yes' : '-',
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
  if (page.data.length === 0) return 'no workflows'
  return withCursor(table(
    ['id', 'name', 'active', 'updated', 'tags'],
    page.data.map(workflow => [
      workflow.id,
      workflow.name,
      workflow.active ? 'yes' : '-',
      workflow.updatedAt ?? '-',
      tagNames(workflow.tags).join(',') || '-',
    ]),
  ), page.nextCursor)
}

/** Render one execution list page. */
export function renderExecutions(page) {
  if (page.data.length === 0) return 'no executions'
  return withCursor(table(
    ['id', 'workflow', 'status', 'mode', 'started', 'finished'],
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