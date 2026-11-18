import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createPairingStore } from '../lib/pairing.mjs'
import { createSnapshotServer } from '../lib/peer-http.mjs'

async function startHub() {
  const stateDir = mkdtempSync(join(tmpdir(), 'memsync-pair-'))
  const pairing = createPairingStore({ stateDir })
  const hub = createSnapshotServer({
    dir: join(stateDir, 'snapshots'),
    secret: 'host-secret',
    fingerprint: 'abcd1234',
    machine: 'pc',
    listenHost: '127.0.0.1',
    listenPort: 0,
    pairing,
  })
  const addr = await hub.listen()
  return { hub, pairing, url: `http://127.0.0.1:${addr.port}` }
}

test('ping exposes the fingerprint but not the secret', async () => {
  const { hub, url } = await startHub()
  try {
    const response = await fetch(`${url}/mem/ping`)
    const doc = await response.json()
    assert.equal(doc.version, 4)
    assert.equal(doc.fingerprint, 'abcd1234')
    assert.equal('secret' in doc, false)
  } finally {
    await hub.close()
  }
})

test('pairing code is single use and returns the shared secret', async () => {
  const { hub, pairing, url } = await startHub()
  try {
    const { code } = pairing.newCode()
    const first = await fetch(`${url}/mem/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'tablet', platform: 'android', fingerprint: 'peer-fp' }),
    })
    assert.equal(first.status, 200)
    const doc = await first.json()
    assert.equal(doc.ok, true)
    assert.equal(doc.secret, 'host-secret')
    assert.equal(doc.fingerprint, 'abcd1234')

    const second = await fetch(`${url}/mem/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'again' }),
    })
    assert.equal(second.status, 400)
    assert.equal((await second.json()).error, 'invalid')
    assert.equal(pairing.list().length, 1)
    assert.equal(pairing.list()[0].name, 'tablet')
  } finally {
    await hub.close()
  }
})

test('pairing endpoint rejects a wrong code and locks after repeated failures', async () => {
  const { hub, pairing, url } = await startHub()
  try {
    const { code } = pairing.newCode()
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(`${url}/mem/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: wrong }),
      })
      const doc = await response.json()
      assert.equal(doc.ok, false)
    }
    const locked = await fetch(`${url}/mem/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    assert.equal(locked.status, 429)
  } finally {
    await hub.close()
  }
})
