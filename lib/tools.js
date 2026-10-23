/**
 * The SDK boundary for the n8n tool surface.
 *
 * The definitions themselves live in `./tool-specs.js` as plain objects. This
 * module is the one place that imports `@deepseek-ai/dsh-tools` and wraps them
 * with `defineTool()`, which compiles the `parameters` DSL, validates returned
 * values against `output.schema`, and binds `output.render`. Keeping that
 * wrapper thin is what allows the definitions to be unit-tested in a checkout
 * where the runtime SDK is not installed (it is provided by the DSH host).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolSpecs } from './tool-specs.js'
import { N8N_TOOL_NAMES } from './guidance.js'

/**
 * Every tool this plugin registers, in list order, ready for the registry.
 * @param deps - the instance store and the n8n client.
 */
export function makeTools(deps) {
  return toolSpecs(deps).map(spec => defineTool(spec))
}

export { N8N_TOOL_NAMES, toolSpecs }