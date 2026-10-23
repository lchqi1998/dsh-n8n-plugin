/**
 * Agent tools: the model-facing surface over the same instance registry and
 * transport the Settings page uses. A workflow deployed from the GUI is
 * immediately operable by any agent, and vice versa.
 *
 * Instance CRUD is deliberately absent: agents may read the registry (aliases,
 * base URLs, masked keys) but only the user creates or edits an instance in the
 * GUI. This keeps an API key from being dictated through a conversation.
 *
 * This module returns plain tool definitions — the `defineTool()` wrapper from
 * `@deepseek-ai/dsh-tools` is applied in `./tools.js`.
 */

import { N8N_TOOL_NAMES } from './guidance.js'
import { renderExecutions, renderInstances, renderWorkflows, table, text } from './render.js'
import { validateWorkflow } from './workflow-validate.js'

/** The instance list tool. */
export function n8nInstancesTool(store) {
  return {
    name: 'n8n_instances',
    description: 'List configured n8n instances (alias, base URL, masked API key, default flag). The alias names the target instance in every other n8n_* tool. Instances are created and edited by the user in Settings → n8n instances; the agent cannot change them.',
    parameters: {
      query: { type: 'string', description: 'Optional fuzzy match against alias, base URL and description.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          instances: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          defaultAlias: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.instances.length === 0
        ? 'no n8n instance configured — the user adds one in Settings → n8n instances'
        : renderInstances(value.instances) + (value.defaultAlias !== undefined ? `\n\ndefault: ${value.defaultAlias}` : '')),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const instances = store.list()
        .map(entry => store.summarize(entry))
        .filter(instance => query === ''
          || instance.alias.toLowerCase().includes(query)
          || instance.baseUrl.toLowerCase().includes(query)
          || (instance.description ?? '').toLowerCase().includes(query))
      const defaultAlias = store.defaultAlias()
      return defaultAlias === undefined ? { instances } : { instances, defaultAlias }
    },
  }
}

/** The workflow list tool. */
export function n8nWorkflowsTool(client) {
  return {
    name: 'n8n_workflows',
    description: 'List n8n workflows on one instance (id, name, active flag, updated time, tags). Paginate with the returned nextCursor. Use n8n_workflow_get for the full node graph.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Instance alias from n8n_instances.' },
      active: { type: 'boolean', description: 'Filter by active (published) state.' },
      name: { type: 'string', description: 'Exact workflow name filter.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to filter by.' },
      limit: { type: 'integer', description: 'Page size (1-250, default 100).' },
      cursor: { type: 'string', description: 'nextCursor from the previous page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => text(renderWorkflows(value)),
    },
    async execute(args, exec) {
      return client.listWorkflows(args.alias, {
        limit: args.limit,
        cursor: args.cursor,
        active: args.active,
        name: args.name,
        tags: args.tags,
        signal: exec.signal,
      })
    },
  }
}

/** The full-workflow read tool. */
export function n8nWorkflowGetTool(client) {
  return {
    name: 'n8n_workflow_get',
    description: 'Fetch one n8n workflow in full (name, nodes, connections, settings, tags, active state). Read this before updating a workflow so the update keeps every untouched field.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Instance alias from n8n_instances.' },
      id: { type: 'string', required: true, description: 'Workflow id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => text(`workflow ${value.id ?? args.id}: ${value.name ?? '(unnamed)'} [${value.active === true ? 'active' : 'inactive'}]\n` + JSON.stringify(value, null, 2)),
    },
    async execute(args, exec) {
      return client.getWorkflow(args.alias, args.id, { signal: exec.signal })
    },
  }
}

/** The workflow create tool. */
export function n8nWorkflowCreateTool(client) {
  return {
    name: 'n8n_workflow_create',
    description: 'Create an n8n workflow from a workflow JSON (name, nodes, connections, settings). Publish it with publish:true, or leave it inactive and publish later with n8n_workflow_publish. Validate the JSON with n8n_workflow_validate first.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Instance alias from n8n_instances.' },
      workflow: { type: 'json', required: true, description: 'The workflow document: {name, nodes[], connections{}, settings{executionOrder:"v1"}}.' },
      publish: { type: 'boolean', description: 'Publish (activate) immediately after creating (default false).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(`created workflow ${value.id}: ${value.name ?? ''}` + (value.publishError !== undefined ? `\npublish failed: ${value.publishError}` : '')),
    },
    async execute(args, exec) {
      return client.createWorkflow(args.alias, args.workflow, { publish: args.publish === true, signal: exec.signal })
    },
  }
}

/** The workflow update tool. */
export function n8nWorkflowUpdateTool(client) {
  return {
    name: 'n8n_workflow_update',
    description: 'Update an existing n8n workflow with a complete workflow document (read it with n8n_workflow_get first, then change only what is needed and send the whole document). Optionally publish or unpublish in the same call.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Instance alias from n8n_instances.' },
      id: { type: 'string', required: true, description: 'Workflow id.' },
      workflow: { type: 'json', required: true, description: 'The complete workflow document.' },
      publish: { type: 'boolean', description: 'After updating: true publishes, false unpublishes, omit to leave the state unchanged.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(`updated workflow ${value.id}: ${value.name ?? ''} [${value.active === true ? 'active' : 'inactive'}]` + (value.publishError !== undefined ? `\npublish change failed: ${value.publishError}` : '')),
    },
    async execute(args, exec) {
      return client.updateWorkflow(args.alias, args.id, args.workflow, {
        publish: args.publish,
        signal: exec.signal,
      })
    },
  }
}

/** The workflow delete tool. */
export function n8nWorkflowDeleteTool(client) {
  return {
    name: 'n8n_workflow_delete',
    description: 'Delete an n8n workflow permanently. Deleting an active workflow stops its triggers — confirm with the user before calling this.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Instance alias from n8n_instances.' },
      id: { type: 'string', required: true, description: 'Workflow id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { deleted: { type: 'boolean', required: true }, id: { type: 'string', required: true } },
      },
      render: (_args, value) => text(`deleted workflow ${value.id}`),
    },
    async execute(args, exec) {
      return client.deleteWorkflow(args.alias, args.id, { signal: exec.signal })
    },
  }
}

/** The publish / unpublish tool. */
export function n8nWorkflowPublishTool(client) {
  return {
    name: 'n8n_workflow_publish',
    description: 'Publish (activate) or unpublish (deactivate) an n8n workflow. Publishing starts its triggers (webhook/schedule) in production — confirm with the user first.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Instance alias from n8n_instances.' },
      id: { type: 'string', required: true, description: 'Workflow id.' },
      publish: { type: 'boolean', required: true, description: 'true publishes (activates); false unpublishes (deactivates).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => text(`workflow ${value.id ?? args.id}: ${args.publish ? 'published' : 'unpublished'} [${value.active === true ? 'active' : 'inactive'}]`),
    },
    async execute(args, exec) {
      return client.setPublished(args.alias, args.id, args.publish, { signal: exec.signal })
    },
  }
}

/** The offline validation tool. */
export function n8nWorkflowValidateTool() {
  return {
    name: 'n8n_workflow_validate',
    description: 'Validate a workflow JSON offline before creating/updating it (unique node ids and names, connections that reference real nodes, webhook response mode, executionOrder). No instance is contacted.',
    parameters: {
      workflow: { type: 'json', required: true, description: 'The workflow document to check.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => text([
        value.valid ? 'valid' : 'invalid',
        ...value.errors.map(error => 'error: ' + error),
        ...value.warnings.map(warning => 'warning: ' + warning),
      ].join('\n')),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return validateWorkflow(args.workflow)
    },
  }
}

/** The executions list tool. */
export function n8nExecutionsTool(client) {
  return {
    name: 'n8n_executions',
    description: 'List n8n executions (id, workflow, status, mode, start/stop time). Filter by workflow id or status to inspect a run history.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Instance alias from n8n_instances.' },
      workflowId: { type: 'string', description: 'Only executions of this workflow.' },
      status: { type: 'string', enum: ['success', 'error', 'waiting', 'canceled', 'crashed', 'new', 'running'], description: 'Only executions with this status.' },
      limit: { type: 'integer', description: 'Page size (1-250, default 100).' },
      cursor: { type: 'string', description: 'nextCursor from the previous page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => text(renderExecutions(value)),
    },
    async execute(args, exec) {
      return client.listExecutions(args.alias, {
        limit: args.limit,
        cursor: args.cursor,
        workflowId: args.workflowId,
        status: args.status,
        signal: exec.signal,
      })
    },
  }
}

/** The execution read tool (includes run data by default). */
export function n8nExecutionGetTool(client) {
  return {
    name: 'n8n_execution_get',
    description: 'Fetch one n8n execution with its data (per-node input/output) by default. Use n8n_executions first to find the id.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Instance alias from n8n_instances.' },
      id: { type: 'string', required: true, description: 'Execution id.' },
      includeData: { type: 'boolean', description: 'Include the execution data payload (default true).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => text(JSON.stringify(value, null, 2)),
    },
    async execute(args, exec) {
      return client.getExecution(args.alias, args.id, { includeData: args.includeData !== false, signal: exec.signal })
    },
  }
}

/** The tags list tool. */
export function n8nTagsTool(client) {
  return {
    name: 'n8n_tags',
    description: 'List the tags defined on an n8n instance. Tag ids are what a workflow update uses inside its tags array.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Instance alias from n8n_instances.' },
      limit: { type: 'integer', description: 'Page size (1-250, default 100).' },
      cursor: { type: 'string', description: 'nextCursor from the previous page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => text(table(
        ['id', 'name'],
        value.data.map(tag => [tag.id, tag.name]),
      )),
    },
    async execute(args, exec) {
      return client.listTags(args.alias, { limit: args.limit, cursor: args.cursor, signal: exec.signal })
    },
  }
}

/** The credentials list tool. */
export function n8nCredentialsTool(client) {
  return {
    name: 'n8n_credentials',
    description: 'List credential names and types configured on an n8n instance (ids only — the API never returns secret values). Check this before wiring a node that needs a credential.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Instance alias from n8n_instances.' },
      limit: { type: 'integer', description: 'Page size (1-250, default 100).' },
      cursor: { type: 'string', description: 'nextCursor from the previous page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => text(table(
        ['id', 'name', 'type'],
        value.data.map(credential => [credential.id, credential.name, credential.type]),
      )),
    },
    async execute(args, exec) {
      return client.listCredentials(args.alias, { limit: args.limit, cursor: args.cursor, signal: exec.signal })
    },
  }
}

/** The raw-request escape hatch. */
export function n8nApiTool(client) {
  return {
    name: 'n8n_api',
    description: 'Send one arbitrary n8n public API v1 request (path relative to /api/v1, e.g. "/workflows", "/workflows/{id}", "/executions"). Use this for endpoints the named tools do not cover, such as node types or instance metadata.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Instance alias from n8n_instances.' },
      method: { type: 'string', required: true, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method.' },
      path: { type: 'string', required: true, description: 'Path under /api/v1, starting with "/".' },
      query: { type: 'json', description: 'Query parameters as an object.' },
      body: { type: 'json', description: 'JSON request body (for POST/PUT/PATCH).' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 30000).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => text(JSON.stringify(value, null, 2)),
    },
    async execute(args, exec) {
      if (!args.path.startsWith('/')) throw new Error('path must start with "/"')
      return client.raw(args.alias, {
        method: args.method,
        path: args.path,
        query: args.query,
        body: args.body,
        timeoutMs: args.timeoutMs,
        signal: exec.signal,
      })
    },
  }
}

/**
 * Every tool this plugin registers, in list order, as plain definitions.
 * @param deps - the instance store and the n8n client.
 */
export function toolSpecs({ store, client }) {
  return [
    n8nInstancesTool(store),
    n8nWorkflowsTool(client),
    n8nWorkflowGetTool(client),
    n8nWorkflowCreateTool(client),
    n8nWorkflowUpdateTool(client),
    n8nWorkflowDeleteTool(client),
    n8nWorkflowPublishTool(client),
    n8nWorkflowValidateTool(),
    n8nExecutionsTool(client),
    n8nExecutionGetTool(client),
    n8nTagsTool(client),
    n8nCredentialsTool(client),
    n8nApiTool(client),
  ]
}

export { N8N_TOOL_NAMES }