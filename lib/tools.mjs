import { memorySyncToolSpec, toolSpecSize } from './tool.mjs'

/**
 * Owns the memory_sync tool registration.
 *
 * toolsMode:
 *   auto   register a conditional tool; it is only advertised while a sync is
 *          useful (wake window, a run in progress, an unknown/failed last run).
 *   always register an unconditional tool (v0.3 behaviour).
 *   off    register nothing.
 *
 * toolsScope trims the action surface: core = run/status, full = snapshots and
 * offline operations too. `when` only reads memory; it never touches git/disk.
 */
export function createToolController({ ctx, runtime, getConfig, logger }) {
  const log = (level, message) => logger?.[level]?.(message)
  let frozenByAgent = new WeakMap()
  const frozenById = new Map()
  let disposer = null
  let subscription = null
  let lastError = ''

  function modeOf(cfg) {
    const mode = cfg?.toolsMode
    return mode === 'always' || mode === 'off' ? mode : 'auto'
  }

  function scopeOf(cfg) {
    return cfg?.toolsScope === 'full' ? 'full' : 'core'
  }

  function lastFailed(run) {
    return !run || run.ok !== true
  }

  function visibleNow(cfg = getConfig()) {
    if (modeOf(cfg) !== 'auto') return true
    if (!cfg?.repoPath) return false
    if (typeof runtime.wakeUntil === 'function' && runtime.wakeUntil()) return true
    if (typeof runtime.isRunning === 'function' && runtime.isRunning()) return true
    const run = typeof runtime.lastRun === 'function' ? runtime.lastRun() : null
    return lastFailed(run)
  }

  function reasonOf(cfg = getConfig()) {
    const mode = modeOf(cfg)
    if (mode === 'off') return 'off'
    if (mode === 'always') return 'always'
    if (!cfg?.repoPath) return 'no-repo-path'
    if (typeof runtime.wakeUntil === 'function' && runtime.wakeUntil()) return 'wake'
    if (typeof runtime.isRunning === 'function' && runtime.isRunning()) return 'running'
    const run = typeof runtime.lastRun === 'function' ? runtime.lastRun() : null
    if (!run) return 'no-last-run'
    return run.ok === true ? 'healthy' : 'last-failed'
  }

  /** Freeze the visibility for the whole user turn; pre-step runs too late. */
  function freeze(agent) {
    if (!agent) return
    const value = visibleNow()
    frozenByAgent.set(agent, value)
    if (agent.id !== undefined && agent.id !== null) {
      frozenById.set(String(agent.id), value)
      if (frozenById.size > 64) frozenById.clear()
    }
  }

  function visibleFor(agent) {
    if (agent && frozenByAgent.has(agent)) return frozenByAgent.get(agent)
    if (agent && agent.id !== undefined && frozenById.has(String(agent.id))) {
      return frozenById.get(String(agent.id))
    }
    return visibleNow()
  }

  function when(context) {
    try {
      return visibleFor(context?.agent)
    } catch (error) {
      lastError = String(error?.message || error)
      return false
    }
  }

  function unregister() {
    try {
      disposer?.()
    } catch (error) {
      log('warn', `memory-sync tool dispose failed: ${String(error?.message || error)}`)
    }
    disposer = null
  }

  function register() {
    const cfg = getConfig()
    const mode = modeOf(cfg)
    const scope = scopeOf(cfg)
    if (mode === 'off') return
    if (mode === 'auto' && !cfg?.repoPath) return
    const spec = memorySyncToolSpec(runtime, { scope })
    const options = mode === 'auto' ? { when } : undefined
    disposer = options ? ctx.tools.register(spec, options) : ctx.tools.register(spec)
  }

  function refresh() {
    unregister()
    frozenByAgent = new WeakMap()
    frozenById.clear()
    lastError = ''
    try {
      register()
    } catch (error) {
      lastError = String(error?.message || error)
      log('warn', `memory-sync tool registration failed: ${lastError}`)
    }
  }

  function status() {
    const cfg = getConfig()
    const mode = modeOf(cfg)
    const scope = scopeOf(cfg)
    const visible = mode === 'always' ? true : mode === 'off' ? false : visibleNow(cfg)
    const chars = visible ? toolSpecSize(scope) : 0
    return {
      mode,
      scope,
      registered: Boolean(disposer),
      visible,
      reason: lastError ? 'register-failed' : reasonOf(cfg),
      estimateChars: chars,
      estimateTokens: Math.round(chars / 3.6),
      wakeUntil: typeof runtime.wakeUntil === 'function' ? runtime.wakeUntil() : '',
      ...(lastError ? { error: lastError } : {}),
    }
  }

  function wake(minutes = 10) {
    const cfg = getConfig()
    if (modeOf(cfg) !== 'auto') {
      return { ok: false, error: 'wake only applies when toolsMode is auto' }
    }
    if (!cfg?.repoPath) return { ok: false, error: 'repoPath is not configured' }
    if (typeof runtime.wake !== 'function') return { ok: false, error: 'runtime does not support wake' }
    return runtime.wake(minutes)
  }

  function dispose() {
    unregister()
    try {
      subscription?.()
    } catch {
      // already detached
    }
    subscription = null
    frozenById.clear()
  }

  try {
    if (typeof ctx.on === 'function') {
      subscription = ctx.on('agent/inbox/claimed', (payload) => freeze(payload?.agent))
    }
  } catch (error) {
    log('warn', `memory-sync turn listener unavailable: ${String(error?.message || error)}`)
  }

  return { refresh, status, wake, dispose }
}
