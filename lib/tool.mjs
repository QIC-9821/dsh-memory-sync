/**
 * Tool spec for the agent. Two scopes keep the per-step tool table small:
 * core = run/status only, full = snapshot and offline operations as well.
 * Only name/description/parameters are sent to the model, so timeoutMs and
 * the output schema cost nothing.
 */

const MAX_CHARS = 1200
const MAX_ERROR_CHARS = 300

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function bounded(value) {
  if (value === undefined || value === null) return value
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= MAX_CHARS) return value
  return {
    ok: typeof value === 'object' ? value.ok : undefined,
    truncated: true,
    preview: text.slice(0, MAX_CHARS),
  }
}

function summarizeSnapshots(doc) {
  if (!doc || typeof doc !== 'object') return doc
  const items = Array.isArray(doc.items) ? doc.items : null
  if (items) {
    return {
      ok: doc.ok,
      count: items.length,
      items: items.slice(0, 10).map((item) => ({
        id: item?.id,
        at: item?.createdAt || item?.at,
        files: item?.files,
        bytes: item?.bytes,
      })),
      truncated: items.length > 10,
      error: doc.error ? truncate(doc.error, MAX_ERROR_CHARS) : undefined,
    }
  }
  const trim = (list) => (Array.isArray(list) ? list : []).slice(0, 8).map((item) => ({
    id: item?.id,
    source: item?.source,
    bytes: item?.bytes,
    at: item?.createdAt || item?.mtimeMs,
  }))
  return {
    ok: doc.ok,
    local: trim(doc.local),
    peer: trim(doc.peer),
    counts: {
      local: Array.isArray(doc.local) ? doc.local.length : 0,
      peer: Array.isArray(doc.peer) ? doc.peer.length : 0,
    },
    error: doc.error ? truncate(doc.error, MAX_ERROR_CHARS) : undefined,
  }
}

function summarizeResult(runtime, value) {
  if (!value || typeof value !== 'object') return value
  if (value.ok === false && value.error) {
    return { ok: false, error: truncate(value.error, MAX_ERROR_CHARS) }
  }
  return bounded(value)
}

export function memorySyncToolSpec(runtime, options = {}) {
  const scope = options.scope === 'full' ? 'full' : 'core'
  const full = scope === 'full'
  const actions = full
    ? ['run', 'status', 'list', 'restore', 'export', 'import']
    : ['run', 'status']

  const properties = {
    action: {
      type: 'string',
      enum: actions,
      description: full
        ? 'run = sync now; status = last run; list = snapshots; restore = roll back; export/import = offline snapshot.'
        : 'run = sync now; status = last run and schedule.',
    },
    direction: {
      type: 'string',
      enum: ['both', 'push', 'pull'],
      description: 'For action="run" in http mode. Default both.',
    },
  }
  if (full) {
    properties.snapshot = {
      type: 'string',
      description: 'Snapshot id for action="restore" (from action="list").',
    }
    properties.path = {
      type: 'string',
      description: 'Snapshot file for action="export" (destination) or "import" (source).',
    }
    properties.dryRun = {
      type: 'boolean',
      description: 'For action="import": preview without writing.',
    }
  }

  return {
    name: 'memory_sync',
    description: full
      ? 'Sync the shared memory directory with the peer. action="run" syncs now (direction optional); "status" reports the last run; "list"/"restore" manage snapshots; "export"/"import" move memory offline.'
      : 'Sync the shared memory directory with the peer. action="run" syncs now (direction optional); action="status" reports the last run and schedule.',
    parameters: {
      type: 'object',
      properties,
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 300000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{
          type: 'text',
          text: typeof value === 'string' ? value : JSON.stringify(value),
        }]
      },
    },
    async execute(args) {
      const action = String(args?.action || 'status')
      const direction = ['both', 'push', 'pull'].includes(args?.direction) ? args.direction : 'both'
      if (action === 'run') {
        const result = await runtime.run('manual', { direction })
        return runtime.summarizeRun ? runtime.summarizeRun(result) : summarizeResult(runtime, result)
      }
      if (action === 'status') {
        if (typeof runtime.toolStatusSummary === 'function') return runtime.toolStatusSummary()
        return summarizeResult(runtime, await runtime.status())
      }
      if (!full) return { ok: false, error: `unknown action: ${action}` }
      if (action === 'list') return summarizeSnapshots(await runtime.list())
      if (action === 'restore') {
        const id = String(args?.snapshot || '')
        if (!id) return { ok: false, error: 'snapshot is required' }
        return summarizeResult(runtime, await runtime.restore(id))
      }
      if (action === 'export') {
        return summarizeResult(runtime, await runtime.exportTo(String(args?.path || '')))
      }
      if (action === 'import') {
        const path = String(args?.path || '')
        if (!path) return { ok: false, error: 'path is required' }
        const result = await runtime.importFrom(path, { dryRun: args?.dryRun === true, path })
        return summarizeResult(runtime, result)
      }
      return { ok: false, error: `unknown action: ${action}` }
    },
  }
}

/** Character count of the part the model actually receives (for the UI estimate). */
export function toolSpecSize(scope = 'core') {
  const spec = memorySyncToolSpec({}, { scope })
  return JSON.stringify({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
  }).length
}
