import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPairingStore } from '../lib/pairing.mjs'

function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pairing-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeClock(start = Date.parse('2026-01-01T00:00:00.000Z')) {
  let value = start
  return {
    now: () => value,
    advance(ms) {
      value += ms
    },
  }
}

function wrongCodeFor(code) {
  return code === '000000' ? '111111' : '000000'
}

test('issues a six digit code and consumes it once', (t) => {
  const dir = makeDir(t)
  const store = createPairingStore({ stateDir: dir })

  const issued = store.newCode()
  assert.equal(issued.ok, true)
  assert.match(issued.code, /^\d{6}$/)
  assert.equal(Number.isNaN(Date.parse(issued.expiresAt)), false)

  const result = store.check(issued.code, {
    ip: '10.0.0.5',
    name: '平板',
    platform: 'android',
    transport: 'lan',
    fingerprint: 'fp-1',
  })
  assert.equal(result.ok, true)
  assert.equal(result.pairing.name, '平板')
  assert.equal(result.pairing.platform, 'android')
  assert.equal(result.pairing.transport, 'lan')
  assert.equal(result.pairing.fingerprint, 'fp-1')
  assert.equal(result.pairing.lastIp, '10.0.0.5')
  assert.equal(Number.isNaN(Date.parse(result.pairing.pairedAt)), false)

  const again = store.check(issued.code, { ip: '10.0.0.5', name: '平板' })
  assert.deepEqual(again, { ok: false, error: 'invalid' })
  assert.equal(store.list().length, 1)
})

test('rejects a wrong code and keeps the pending code', (t) => {
  const dir = makeDir(t)
  const store = createPairingStore({ stateDir: dir })
  const issued = store.newCode()

  assert.deepEqual(store.check(wrongCodeFor(issued.code), { ip: '1.2.3.4' }), {
    ok: false,
    error: 'invalid',
  })
  assert.equal(store.status().pending.expiresAt, issued.expiresAt)
  assert.equal(store.check(issued.code, { ip: '1.2.3.4' }).ok, true)
})

test('expires a pending code using the injected clock', (t) => {
  const dir = makeDir(t)
  const clock = makeClock()
  const store = createPairingStore({ stateDir: dir, now: clock.now, ttlSec: 60 })

  const issued = store.newCode()
  clock.advance(61_000)

  assert.deepEqual(store.check(issued.code, { ip: '1.1.1.1' }), {
    ok: false,
    error: 'expired',
  })
  assert.equal(store.status().pending, null)
  // The expired code was dropped, so the same value is no longer accepted.
  assert.deepEqual(store.check(issued.code, { ip: '1.1.1.1' }), {
    ok: false,
    error: 'invalid',
  })
})

test('locks one IP after maxFailures and unlocks after lockMs', (t) => {
  const dir = makeDir(t)
  const clock = makeClock()
  const store = createPairingStore({
    stateDir: dir,
    now: clock.now,
    maxFailures: 3,
    lockMs: 60_000,
    ttlSec: 3600,
  })

  const issued = store.newCode()
  const wrong = wrongCodeFor(issued.code)

  assert.deepEqual(store.check(wrong, { ip: '9.9.9.9' }), { ok: false, error: 'invalid' })
  assert.deepEqual(store.check(wrong, { ip: '9.9.9.9' }), { ok: false, error: 'invalid' })
  assert.deepEqual(store.check(wrong, { ip: '9.9.9.9' }), { ok: false, error: 'locked' })

  // Even the correct code is refused while the lock is active.
  assert.deepEqual(store.check(issued.code, { ip: '9.9.9.9' }), {
    ok: false,
    error: 'locked',
  })
  assert.equal(store.status().pending.expiresAt, issued.expiresAt)
  assert.notEqual(store.status().lockedUntil, '')
  assert.equal(Number.isNaN(Date.parse(store.status().lockedUntil)), false)

  clock.advance(60_001)
  assert.equal(store.status().lockedUntil, '')
  assert.equal(store.check(issued.code, { ip: '9.9.9.9' }).ok, true)

  // The failure counter was reset when the lock expired.
  const next = store.newCode()
  assert.deepEqual(store.check(wrongCodeFor(next.code), { ip: '9.9.9.9' }), {
    ok: false,
    error: 'invalid',
  })
})

test('keeps failure counters per IP', (t) => {
  const dir = makeDir(t)
  const store = createPairingStore({ stateDir: dir, maxFailures: 3, lockMs: 60_000 })
  const issued = store.newCode()
  const wrong = wrongCodeFor(issued.code)

  assert.deepEqual(store.check(wrong, { ip: '10.0.0.1' }), { ok: false, error: 'invalid' })
  assert.deepEqual(store.check(wrong, { ip: '10.0.0.2' }), { ok: false, error: 'invalid' })
  assert.deepEqual(store.check(wrong, { ip: '10.0.0.1' }), { ok: false, error: 'invalid' })
  assert.deepEqual(store.check(wrong, { ip: '10.0.0.1' }), { ok: false, error: 'locked' })
  // The other IP is still at one failure and can pair.
  assert.equal(store.check(issued.code, { ip: '10.0.0.2' }).ok, true)
})

test('replaces the previous code when a new one is issued', (t) => {
  const dir = makeDir(t)
  const store = createPairingStore({ stateDir: dir })

  const first = store.newCode()
  const second = store.newCode()
  assert.equal(store.status().pending.expiresAt, second.expiresAt)

  if (first.code !== second.code) {
    assert.deepEqual(store.check(first.code, { ip: '10.1.1.1' }), {
      ok: false,
      error: 'invalid',
    })
  }
  assert.equal(store.check(second.code, { ip: '10.1.1.1' }).ok, true)
})

test('keeps at most ten pairings and evicts the oldest', (t) => {
  const dir = makeDir(t)
  const clock = makeClock()
  const store = createPairingStore({ stateDir: dir, now: clock.now })

  for (let index = 0; index < 12; index += 1) {
    clock.advance(1000)
    const issued = store.newCode()
    const result = store.check(issued.code, {
      ip: `10.0.0.${index}`,
      name: `dev-${index}`,
      fingerprint: `fp-${index}`,
    })
    assert.equal(result.ok, true)
  }

  const list = store.list()
  assert.equal(list.length, 10)
  assert.equal(list[0].name, 'dev-11')
  assert.equal(list.at(-1).name, 'dev-2')
  assert.equal(
    list.some((pairing) => pairing.name === 'dev-0' || pairing.name === 'dev-1'),
    false,
  )

  // The cap also applies when the history is read back from disk.
  const reloaded = createPairingStore({ stateDir: dir })
  assert.equal(reloaded.list().length, 10)
  assert.equal(reloaded.list()[0].name, 'dev-11')
})

test('deduplicates by fingerprint, or by name when there is none', (t) => {
  const dir = makeDir(t)
  const clock = makeClock()
  const store = createPairingStore({ stateDir: dir, now: clock.now })

  const pair = (name, fingerprint) => {
    clock.advance(1000)
    const issued = store.newCode()
    return store.check(issued.code, { ip: '10.2.0.1', name, fingerprint })
  }

  assert.equal(pair('平板', 'fp-same').ok, true)
  assert.equal(pair('平板改名', 'fp-same').ok, true)
  let list = store.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '平板改名')

  assert.equal(pair('电视', '').ok, true)
  assert.equal(pair('电视', '').ok, true)
  list = store.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].name, '电视')
  assert.equal(list[0].fingerprint, '')
})

test('persists pairings but not the pending code', (t) => {
  const dir = makeDir(t)
  const first = createPairingStore({ stateDir: dir })
  const issued = first.newCode()
  const result = first.check(issued.code, {
    ip: '10.3.0.1',
    name: '平板',
    platform: 'android',
    transport: 'http',
    fingerprint: 'fp-persist',
  })
  assert.equal(result.ok, true)

  const second = createPairingStore({ stateDir: dir })
  const list = second.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '平板')
  assert.equal(list[0].fingerprint, 'fp-persist')
  assert.equal(list[0].lastIp, '10.3.0.1')
  assert.equal(second.status().pairings, 1)
  // The pending code exists only in memory.
  assert.equal(second.status().pending, null)
  assert.deepEqual(second.check(issued.code, { ip: '10.3.0.1' }), {
    ok: false,
    error: 'invalid',
  })

  const raw = readFileSync(join(dir, 'pairings.json'), 'utf8')
  assert.equal(raw.includes(issued.code), false)
  assert.equal(JSON.parse(raw).pairings.length, 1)
})

test('uses a custom file name and creates a missing state directory', (t) => {
  const base = makeDir(t)
  const dir = join(base, 'nested', 'state')
  const store = createPairingStore({ stateDir: dir, file: 'devices.json' })

  const issued = store.newCode()
  assert.equal(store.check(issued.code, { ip: '10.4.0.1', name: 'dev' }).ok, true)

  assert.equal(existsSync(join(dir, 'devices.json')), true)
  assert.equal(existsSync(join(dir, 'pairings.json')), false)
  assert.equal(createPairingStore({ stateDir: dir, file: 'devices.json' }).list().length, 1)
})

test('starts empty when the persisted file is unreadable', (t) => {
  const dir = makeDir(t)
  writeFileSync(join(dir, 'pairings.json'), '{not json', 'utf8')

  const store = createPairingStore({ stateDir: dir })
  assert.deepEqual(store.list(), [])
  assert.deepEqual(store.status(), { pending: null, pairings: 0, lockedUntil: '' })
})

test('clear removes pairings, the pending code and the file', (t) => {
  const dir = makeDir(t)
  const store = createPairingStore({ stateDir: dir })
  const issued = store.newCode()
  assert.equal(store.check(issued.code, { ip: '10.5.0.1', name: '平板' }).ok, true)

  const file = join(dir, 'pairings.json')
  assert.equal(existsSync(file), true)

  assert.deepEqual(store.clear(), { ok: true })
  assert.equal(existsSync(file), false)
  assert.deepEqual(store.list(), [])
  assert.deepEqual(store.status(), { pending: null, pairings: 0, lockedUntil: '' })
  assert.deepEqual(store.clear(), { ok: true })
  assert.equal(store.newCode().ok, true)
})

test('status exposes expiry and lock windows but never the code', (t) => {
  const dir = makeDir(t)
  const clock = makeClock()
  const store = createPairingStore({
    stateDir: dir,
    now: clock.now,
    maxFailures: 1,
    lockMs: 30_000,
  })

  const issued = store.newCode()
  let status = store.status()
  assert.deepEqual(Object.keys(status).sort(), ['lockedUntil', 'pairings', 'pending'])
  assert.equal(status.pending.expiresAt, issued.expiresAt)
  assert.equal(status.lockedUntil, '')

  store.check(wrongCodeFor(issued.code), { ip: '10.6.0.1' })
  status = store.status()
  assert.notEqual(status.lockedUntil, '')
  assert.equal(JSON.stringify(status).includes(issued.code), false)
})

test('logs events without ever logging a code', (t) => {
  const dir = makeDir(t)
  const lines = []
  const logger = {
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  }
  const clock = makeClock()
  const store = createPairingStore({ stateDir: dir, now: clock.now, logger })

  const issued = store.newCode()
  clock.advance(1000)
  const wrong = wrongCodeFor(issued.code)
  store.check(wrong, { ip: '10.7.0.1' })
  store.check(issued.code, { ip: '10.7.0.1' })

  const log = lines.join('\n')
  assert.equal(lines.length >= 3, true)
  assert.match(log, /pairing code issued/)
  assert.match(log, /pairing rejected/)
  assert.match(log, /pairing accepted/)
  assert.equal(log.includes(issued.code), false)
  assert.equal(log.includes(wrong), false)
})
