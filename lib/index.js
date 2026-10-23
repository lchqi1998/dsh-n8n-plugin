/**
 * dsh-n8n-plugin — host half.
 *
 * Mounts the n8n instance registry (a user-owned JSON file under $DSH_HOME),
 * the /api/dsh-n8n-plugin route family the Settings page talks to, the n8n_* agent
 * tools, and a system-prompt section. The browser half (./client) renders the
 * Settings → n8n instances page and uses the same routes, so GUI and agent
 * always see the same aliases.
 *
 * Everything this module owns is registered through `ctx`, so every surface is
 * an effect the framework tears down with the fiber. Failures are *not*
 * swallowed: a broken registration should mark this fiber FAILED and show up in
 * the loader log, which is the documented diagnosis path — the host keeps
 * running the other plugins either way.
 */

import z from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import { N8nClient } from './n8n.js'
import { makeRoutes } from './routes.js'
import { InstanceStore } from './store.js'
import { makeTools } from './tools.js'
import { N8N_GUIDANCE, visibleToolText } from './guidance.js'
import { mountOnce } from './mount-once.js'

/** Stable cordis plugin name. */
export const name = 'n8n'

/** Services required before the n8n surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Prompt-section order: inside the plugin tool-guidance band. */
const SECTION_ORDER = 160

/**
 * Absolute path of the bundled workflow guide, so the announcement can point
 * the model at a file it can read on demand (the prompt itself stays short).
 */
const KNOWLEDGE_PATH = (() => {
  try {
    return fileURLToPath(new URL('../knowledge/workflow-guide.md', import.meta.url))
  } catch {
    return undefined
  }
})()

/** The guidance body, extended with the on-disk reference path when resolvable. */
const GUIDANCE_TEXT = KNOWLEDGE_PATH === undefined
  ? N8N_GUIDANCE
  : `${N8N_GUIDANCE}\n工作流 JSON 的详细规范与常见模式模板见本机文件：${KNOWLEDGE_PATH}（需要时用 read 工具读取）。`

/**
 * Plugin config. Both fields are `volatile()`: a settings edit reaches the
 * running instance without a remount (the loader commits the value into the
 * field's reference and announces `loader/volatile-update` on this fiber).
 * Defaults live here and nowhere else — the loader resolves them.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  announceToAgent: z.boolean().default(true).volatile(),
})

/** Schema defaults, for the hand-built contexts a test or an older host passes in. */
const DEFAULT_ENABLED = true
const DEFAULT_ANNOUNCE = true

/** Read one resolved config field, following the live reference the schema produces. */
function readConfigField(field, fallback) {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined ? fallback : value
  }
  return field
}

/** The fiber logger when the host exposes one, the console otherwise. */
function loggerOf(ctx) {
  try {
    const logger = ctx.logger?.('n8n')
    if (logger !== undefined && logger !== null) return logger
  } catch {
    // A context without a logger still gets its message through console.
  }
  return console
}

/** Mount the store, routes, tools, and announcement. */
export const apply = mountOnce('dsh-n8n-plugin', applyImpl)

/**
 * Register (or drop) every surface to match the resolved config.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
function applyImpl(ctx, config) {
  const store = new InstanceStore()
  const client = new N8nClient(store)
  const routes = makeRoutes({ store, client })
  const tools = makeTools({ store, client })

  const resolve = () => ({
    enabled: readConfigField(config?.enabled, DEFAULT_ENABLED),
    announceToAgent: readConfigField(config?.announceToAgent, DEFAULT_ANNOUNCE),
  })

  let disposeSection
  let disposeRoutes
  let disposeTools

  const clear = () => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
  }

  const sync = () => {
    clear()
    const value = resolve()
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-n8n-plugin',
        order: SECTION_ORDER,
        text: visibleToolText(ctx.tools, GUIDANCE_TEXT),
      })
    }
    disposeRoutes = ctx.effect(() => {
      const disposers = routes.map(route => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers.splice(0)) dispose()
      }
    }, 'dsh-n8n-plugin: routes')
    disposeTools = ctx.effect(() => {
      const disposers = tools.map(tool => ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers.splice(0)) dispose()
      }
    }, 'dsh-n8n-plugin: tools')
  }

  // A volatile settings edit is committed into this instance's config
  // references and announced on this fiber; re-derive the surfaces. This runs
  // from an event listener rather than from apply, so a throw here would not be
  // able to mark the fiber FAILED — it is reported instead.
  ctx.on('loader/volatile-update', () => {
    try {
      sync()
    } catch (error) {
      loggerOf(ctx).warn('[n8n] re-deriving surfaces after a volatile config update failed', error)
    }
  })

  sync()
}