import assert from 'node:assert/strict'
import test from 'node:test'

import { memorySyncToolSpec, toolSpecSize } from '../lib/tool.mjs'
import { createToolController } from '../lib/tools.mjs'

function makeCtx() {
  const registrations = []
  let claimed = null
  const ctx = {
    tools: {
      register(spec, options) {
        const entry = { spec, options, disposed: false }
        registrations.push(entry)
        return () => {
          entry.disposed = true
        }
      },
    },
    on(event, handler) {
      if (event === 'agent/inbox/claimed') claimed = handler
      return () => {
        claimed = null
      }
    },
  }
  return {
    ctx,
    registrations,
    fire(agent) {
      claimed?.({ agent })
    },
  }
}

function makeRuntime(initial = {}) {
  const state = {
    run: initial.run === undefined ? { ok: true, at: '2026-11-18T00:00:00.000Z' } : initial.run,
    running: Boolean(initial.running),
    wake: '',
  }
  return {
    state,
    async run() {
      return { ok: true, phases: [] }
    },
    async status() {
      return { ok: true }
    },
    lastRun() {
      return state.run
    },
    isRunning() {
      return state.running
    },
    wakeUntil() {
      return state.wake
    },
    wake(minutes) {
      state.wake = '2026-11-18T00:10:00.000Z'
      return { ok: true, minutes, until: state.wake }
    },
  }
}

function makeController(overrides = {}) {
  const harness = makeCtx()
  const runtime = overrides.runtime || makeRuntime()
  const cfg = {
    repoPath: '/srv/memories',
    toolsMode: 'auto',
    toolsScope: 'core',
    ...(overrides.cfg || {}),
  }
  const controller = createToolController({
    ctx: harness.ctx,
    runtime,
    getConfig: () => cfg,
    logger: { warn() {}, info() {} },
  })
  controller.refresh()
  return { ...harness, runtime, cfg, controller }
}

test('core and full tool specs stay inside the token budget', () => {
  const core = memorySyncToolSpec({}, { scope: 'core' })
  const full = memorySyncToolSpec({}, { scope: 'full' })
  assert.deepEqual(core.parameters.properties.action.enum, ['run', 'status'])
  assert.equal(core.parameters.properties.snapshot, undefined)
  assert.ok(full.parameters.properties.action.enum.includes('restore'))
  assert.ok(full.parameters.properties.path)
  assert.ok(toolSpecSize('core') <= 900, `core is ${toolSpecSize('core')} chars`)
  assert.ok(toolSpecSize('full') <= 1400, `full is ${toolSpecSize('full')} chars`)
  assert.equal(toolSpecSize(), toolSpecSize('core'))
  assert.ok(toolSpecSize('full') > toolSpecSize('core'))
})

test('core only advertises run/status and renders compact output', async () => {
  const runtime = {
    toolStatusSummary: () => ({ ok: true, transport: 'git' }),
    async run() {
      throw new Error('core must not run other actions')
    },
  }
  const spec = memorySyncToolSpec(runtime)
  assert.deepEqual(await spec.execute({ action: 'status' }), { ok: true, transport: 'git' })
  assert.deepEqual(await spec.execute({ action: 'restore', snapshot: 'x' }), {
    ok: false,
    error: 'unknown action: restore',
  })
  const rendered = spec.output.render({}, { ok: true, nested: { a: 1 } })
  assert.equal(rendered[0].text, '{"ok":true,"nested":{"a":1}}')
})

test('auto mode registers a conditional tool and hides it while healthy', () => {
  const { registrations, controller, runtime } = makeController()
  assert.equal(registrations.length, 1)
  assert.equal(typeof registrations[0].options?.when, 'function')
  assert.equal(registrations[0].options.when({ agent: {} }), false)
  assert.equal(controller.status().registered, true)
  assert.equal(controller.status().visible, false)
  assert.equal(controller.status().reason, 'healthy')
  assert.equal(controller.status().estimateChars, 0)

  runtime.state.run = { ok: false, at: '2026-11-18T01:00:00.000Z', error: 'boom' }
  assert.equal(controller.status().reason, 'last-failed')
  assert.equal(controller.status().visible, true)
  assert.equal(controller.status().estimateChars, toolSpecSize('core'))
})

test('visibility is frozen for the whole agent turn', () => {
  const { controller, registrations, runtime, fire } = makeController()
  const agent = { id: 'a1' }
  const when = registrations[0].options.when
  assert.equal(when({ agent }), false)
  assert.equal(controller.status().visible, false)

  runtime.state.run = { ok: false, at: '2026-11-18T01:00:00.000Z' }
  fire(agent)
  assert.equal(when({ agent }), true)

  runtime.state.run = { ok: true, at: '2026-11-18T02:00:00.000Z' }
  // Still visible for this turn: step 2 must not lose the tool mid-turn.
  assert.equal(when({ agent }), true)

  fire(agent)
  assert.equal(when({ agent }), false)
})

test('wake keeps the tool visible until the window expires', () => {
  const { controller, runtime } = makeController()
  const agent = { id: 'a2' }
  const result = controller.wake(10)
  assert.equal(result.ok, true)
  assert.equal(controller.status().visible, true)
  assert.equal(controller.status().reason, 'wake')
  assert.ok(controller.status().wakeUntil)

  runtime.state.wake = ''
  const harness = makeController({ runtime })
  assert.equal(harness.controller.status().visible, false)
  // Unconfigured wake is rejected instead of silently doing nothing.
  const unconfigured = makeController({ cfg: { repoPath: '' } })
  assert.equal(unconfigured.controller.wake(10).ok, false)
  assert.equal(unconfigured.registrations.length, 0)
  assert.equal(unconfigured.controller.status().reason, 'no-repo-path')
})

test('always registers an unconditional tool and off registers nothing', () => {
  const always = makeController({ cfg: { toolsMode: 'always' } })
  assert.equal(always.registrations.length, 1)
  assert.equal(always.registrations[0].options, undefined)
  assert.equal(always.controller.status().visible, true)
  assert.equal(always.controller.status().reason, 'always')

  const off = makeController({ cfg: { toolsMode: 'off' } })
  assert.equal(off.registrations.length, 0)
  assert.equal(off.controller.status().registered, false)
  assert.equal(off.controller.status().reason, 'off')
})

test('refresh replaces the registration instead of stacking duplicates', () => {
  const { controller, registrations } = makeController()
  assert.equal(registrations.length, 1)
  controller.refresh()
  assert.equal(registrations.length, 2)
  assert.equal(registrations[0].disposed, true)
  assert.equal(registrations[1].disposed, false)
  controller.dispose()
  assert.equal(registrations[1].disposed, true)
})

test('full scope is reflected in the status estimate', () => {
  const { controller, runtime } = makeController({ cfg: { toolsScope: 'full' } })
  runtime.state.run = { ok: false, at: '2026-11-18T01:00:00.000Z', error: 'boom' }
  const status = controller.status()
  assert.equal(status.scope, 'full')
  assert.equal(status.estimateChars, toolSpecSize('full'))
})
