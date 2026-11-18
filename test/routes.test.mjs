import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRoutes } from '../lib/routes.mjs'
import { createConfigStore } from '../lib/settings.mjs'

function makeServer(options = {}) {
  const env = { DSH_HOME: mkdtempSync(join(tmpdir(), 'memsync-routes-')) }
  const store = createConfigStore({ transport: 'http', peerUrl: 'http://peer:18792', memSecret: 's3cret', machine: 'pc' }, env)
  let reconfigured = 0
  let paused = 0
  let synced = null
  const snapshotFile = join(env.DSH_HOME, 'export.json.gz')
  writeFileSync(snapshotFile, Buffer.from('fake-gzip'))
  const runtime = {
    status: async () => ({ machine: 'pc', rules: { conflict: store.current().conflict } }),
    reconfigure: async () => {
      reconfigured += 1
    },
    pause: async () => {
      paused += 1
    },
    run: async (trigger, options) => {
      synced = { trigger, options }
      return { ok: true, phases: [] }
    },
    test: async () => ({ ok: true }),
    logs: async () => ['line'],
    list: async () => ({ local: [], peer: [] }),
    restore: async () => ({ written: [] }),
    exportTo: async () => ({ path: snapshotFile, files: 1, bytes: 10 }),
    importFrom: async (body, options) => ({ dryRun: Boolean(options?.dryRun), written: [] }),
  }
  let configApplied = 0
  const routes = createRoutes({
    runtime,
    store,
    version: '0.3.0',
    origin: 'http://127.0.0.1:1',
    tools: options.tools || null,
    secrets: options.secrets || null,
    pairing: options.pairing || null,
    remote: options.remote || null,
    cleanup: options.cleanup || null,
    onConfigApplied: options.onConfigApplied || (() => {
      configApplied += 1
    }),
  })
  const server = createServer((req, res) => void routes.handle(req, res))
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        server,
        store,
        get reconfigured() {
          return reconfigured
        },
        get synced() {
          return synced
        },
        get configApplied() {
          return configApplied
        },
        get paused() {
          return paused
        },
      })
    })
  })
}

test('state hides the secret and exposes rules', async () => {
  const ctx = await makeServer()
  try {
    const response = await fetch(`${ctx.url}/memory-sync/api/state`)
    const doc = await response.json()
    assert.equal(doc.ok, true)
    assert.equal(doc.version, '0.3.0')
    assert.equal(doc.config.memSecret, '')
    assert.equal(doc.config.memSecretSet, true)
    assert.equal(doc.status.machine, 'pc')
  } finally {
    await new Promise((resolvePromise) => ctx.server.close(resolvePromise))
  }
})

test('config saves and applies the config callback', async () => {
  const ctx = await makeServer()
  try {
    const response = await fetch(`${ctx.url}/memory-sync/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { conflict: 'local', intervalSendMinutes: 30 } }),
    })
    const doc = await response.json()
    assert.equal(doc.config.conflict, 'local')
    assert.equal(doc.config.intervalSendMinutes, 30)
    assert.equal(ctx.reconfigured, 0)
    assert.equal(ctx.configApplied, 1)
  } finally {
    await new Promise((resolvePromise) => ctx.server.close(resolvePromise))
  }
})

test('foreign origins are rejected', async () => {
  const ctx = await makeServer()
  try {
    const response = await fetch(`${ctx.url}/memory-sync/api/state`, { headers: { origin: 'http://evil.example' } })
    assert.equal(response.status, 403)
  } finally {
    await new Promise((resolvePromise) => ctx.server.close(resolvePromise))
  }
})

test('export sends gzip and import forwards dryRun', async () => {
  const ctx = await makeServer()
  try {
    const exported = await fetch(`${ctx.url}/memory-sync/api/export`)
    assert.equal(exported.headers.get('content-type'), 'application/gzip')
    assert.ok(Number(exported.headers.get('content-length')) > 0)

    const imported = await fetch(`${ctx.url}/memory-sync/api/import?dryRun=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/gzip' },
      body: Buffer.from('fake'),
    })
    const doc = await imported.json()
    assert.equal(doc.result.dryRun, true)
  } finally {
    await new Promise((resolvePromise) => ctx.server.close(resolvePromise))
  }
})

test('sync forwards direction', async () => {
  const ctx = await makeServer()
  try {
    const response = await fetch(`${ctx.url}/memory-sync/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ direction: 'pull' }),
    })
    const doc = await response.json()
    assert.equal(doc.result.ok, true)
    assert.equal(ctx.synced.options.direction, 'pull')
  } finally {
    await new Promise((resolvePromise) => ctx.server.close(resolvePromise))
  }
})

test('state exposes tool status and wake validates minutes', async () => {
  const wakes = []
  const tools = {
    status: () => ({
      mode: 'auto',
      scope: 'core',
      registered: true,
      visible: false,
      reason: 'healthy',
      estimateChars: 600,
      estimateTokens: 167,
      wakeUntil: '',
    }),
    wake: (minutes) => {
      wakes.push(minutes)
      return { ok: true, minutes, until: '2026-11-18T00:10:00.000Z' }
    },
  }
  const ctx = await makeServer({ tools })
  try {
    const state = await (await fetch(`${ctx.url}/memory-sync/api/state`)).json()
    assert.equal(state.tools.reason, 'healthy')

    const response = await fetch(`${ctx.url}/memory-sync/api/tools/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minutes: 5 }),
    })
    const doc = await response.json()
    assert.equal(response.status, 200)
    assert.equal(doc.ok, true)
    assert.deepEqual(wakes, [5])
    assert.equal(doc.tools.mode, 'auto')

    for (const minutes of [0, 121, 'nope']) {
      const bad = await fetch(`${ctx.url}/memory-sync/api/tools/wake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minutes }),
      })
      assert.equal(bad.status, 400, `minutes=${minutes}`)
    }
  } finally {
    await new Promise((resolvePromise) => ctx.server.close(resolvePromise))
  }
})

test('wake returns 409 when auto visibility is unavailable', async () => {
  const tools = {
    status: () => ({ mode: 'off' }),
    wake: () => ({ ok: false, error: 'wake only applies when toolsMode is auto' }),
  }
  const ctx = await makeServer({ tools })
  try {
    const response = await fetch(`${ctx.url}/memory-sync/api/tools/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minutes: 10 }),
    })
    assert.equal(response.status, 409)
    const doc = await response.json()
    assert.equal(doc.ok, false)
  } finally {
    await new Promise((resolvePromise) => ctx.server.close(resolvePromise))
  }
})

test('secret migration saves the new path and applies config', async () => {
  const calls = []
  const secrets = {
    status: () => ({ source: 'file', fingerprint: 'abcd1234', file: '/old/secret' }),
    migrate: (target) => {
      calls.push(target)
      return { ok: true, file: target, source: 'file', secret: 'hidden' }
    },
  }
  const ctx = await makeServer({ secrets })
  try {
    const response = await fetch(`${ctx.url}/memory-sync/api/secret/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secretFile: 'keys/new-secret' }),
    })
    const doc = await response.json()
    assert.equal(response.status, 200)
    assert.equal(doc.ok, true)
    assert.equal(doc.file, 'keys/new-secret')
    assert.deepEqual(calls, ['keys/new-secret'])
    assert.equal(ctx.store.current().secretFile, 'keys/new-secret')
    assert.equal(ctx.configApplied, 1)
  } finally {
    await new Promise((resolvePromise) => ctx.server.close(resolvePromise))
  }
})

test('pairing endpoints generate a code and expose no secret', async () => {
  const pairing = {
    newCode: () => ({ ok: true, code: '123456', expiresAt: '2026-11-18T00:05:00.000Z' }),
    status: () => ({ pairings: 0, pending: null, lockedUntil: '' }),
    list: () => [],
    clear: () => ({ ok: true }),
  }
  const secrets = { status: () => ({ source: 'file', fingerprint: 'abcd1234', file: '/secret' }) }
  const ctx = await makeServer({ pairing, secrets })
  try {
    const response = await fetch(`${ctx.url}/memory-sync/api/pair/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const doc = await response.json()
    assert.equal(response.status, 200)
    assert.equal(doc.code, '123456')
    assert.equal(JSON.stringify(doc).includes('host-secret'), false)
    assert.equal(doc.secret.fingerprint, 'abcd1234')

    const state = await (await fetch(`${ctx.url}/memory-sync/api/state`)).json()
    assert.equal(state.pairing.pairings, 0)
    assert.equal(state.secret.fingerprint, 'abcd1234')
  } finally {
    await new Promise((resolvePromise) => ctx.server.close(resolvePromise))
  }
})

test('cleanup pauses the runtime and reports removed files', async () => {
  const cleaned = []
  const cleanup = async (args) => {
    cleaned.push(args)
    return { ok: true, removed: ['settings.json'], failed: [] }
  }
  const ctx = await makeServer({ cleanup })
  try {
    const response = await fetch(`${ctx.url}/memory-sync/api/cleanup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, includeBackups: true }),
    })
    const doc = await response.json()
    assert.equal(response.status, 200)
    assert.equal(doc.ok, true)
    assert.equal(doc.removed.length, 1)
    assert.equal(ctx.paused, 1)
    assert.equal(cleaned[0].includeBackups, true)
    assert.equal(typeof cleaned[0].stateDir, 'string')
  } finally {
    await new Promise((resolvePromise) => ctx.server.close(resolvePromise))
  }
})
