/**
 * Host single-instance guard for this plugin package.
 *
 * The profile can end up naming this plugin twice (an aggregate bundle row and
 * a standalone row, an HMR reload that mounts the new entry before the old one
 * is torn down). A second mount would re-register the same webserver routes and
 * tool names, and the registry rejects duplicates — the duplicate row would
 * fail the boot instead of being a harmless no-op.
 *
 * The registry rides a global symbol so two module instances of the same
 * package still share one verdict. A refused mount is queued and replayed when
 * the holder releases the name, provided its own fiber is still alive.
 */

const MOUNTED = Symbol.for('dsh-n8n-plugin.mounted')
const WAITERS = Symbol.for('dsh-n8n-plugin.mounted.waiters')

function mountedSet() {
  const registry = globalThis
  if (registry[MOUNTED] instanceof Set) return registry[MOUNTED]
  const created = new Set()
  registry[MOUNTED] = created
  return created
}

function mountWaiters() {
  const registry = globalThis
  return (registry[WAITERS] ??= new Map())
}

/**
 * Wrap a cordis plugin apply so the package runs at most once per process.
 * @param packageName - stable package identity.
 * @param fn - the original plugin apply.
 */
export function mountOnce(packageName, fn) {
  const mount = (...args) => {
    const mounted = mountedSet()
    const ctx = args[0]
    if (mounted.has(packageName)) {
      const waiters = mountWaiters()
      const queue = waiters.get(packageName) ?? []
      let alive = true
      const pending = { run: () => { if (alive) mount(...args) } }
      try {
        ctx?.effect?.(() => () => {
          alive = false
          const index = queue.indexOf(pending)
          if (index >= 0) queue.splice(index, 1)
        })
      } catch {
        alive = false
      }
      queue.push(pending)
      waiters.set(packageName, queue)
      return
    }
    mounted.add(packageName)
    try {
      ctx?.effect?.(() => () => {
        mounted.delete(packageName)
        const waiters = mountWaiters()
        const queue = waiters.get(packageName)
        if (queue === undefined) return
        waiters.delete(packageName)
        for (const waiter of queue.splice(0)) queueMicrotask(() => waiter.run())
      })
    } catch {
      // A context without effects still gets the mount; it just holds the name.
    }
    return fn(...args)
  }
  return mount
}