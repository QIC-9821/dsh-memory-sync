import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildSnapshot } from '../lib/archive.mjs'
import { callPeer, createSnapshotServer } from '../lib/peer-http.mjs'

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
  }
}

async function startHub(root, secret, autoApply = false) {
  const stateDir = mkdtempSync(join(tmpdir(), 'memsync-hub-'))
  const snapDir = join(stateDir, 'snapshots')
  const hub = createSnapshotServer({
    dir: snapDir,
    secret,
    machine: 'pc',
    repoRoot: root,
    autoApply,
    keep: 3,
    listenHost: '127.0.0.1',
    listenPort: 0,
    logger: null,
  })
  const addr = await hub.listen()
  return { hub, url: `http://127.0.0.1:${addr.port}`, snapDir }
}

test('hub rejects a wrong secret', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memsync-pc-'))
  await writeTree(root, { 'USER.md': 'pc user' })
  const { hub, url } = await startHub(root, 's3cret')
  try {
    await assert.rejects(() => callPeer(url, '/mem/list', { secret: 'nope' }), /401/)
  } finally {
    await hub.close()
  }
})

test('push then pull exchanges both sides', async () => {
  const pcRoot = mkdtempSync(join(tmpdir(), 'memsync-pc-'))
  await writeTree(pcRoot, { 'USER.md': 'pc user', 'MEMORY.md': 'pc memory' })
  const { hub, url, snapDir } = await startHub(pcRoot, 's3cret', true)
  try {
    const tabletRoot = mkdtempSync(join(tmpdir(), 'memsync-tablet-'))
    await writeTree(tabletRoot, { 'KEY.md': 'tablet key' })

    const snapshot = await buildSnapshot(tabletRoot, { machine: 'tablet' })
    const response = await callPeer(url, '/mem/snapshot', {
      method: 'POST',
      secret: 's3cret',
      body: snapshot.body,
      headers: { 'content-type': 'application/gzip' },
    })
    const stored = await response.json()
    assert.equal(stored.ok, true)
    // autoApply merged the tablet file into the hub tree
    assert.equal(await fs.readFile(join(pcRoot, 'KEY.md'), 'utf8'), 'tablet key')
    assert.ok((await fs.readdir(snapDir)).some((name) => name.endsWith('.json.gz')))

    const latest = await callPeer(url, '/mem/latest', { secret: 's3cret' })
    const doc = JSON.parse((await import('node:zlib')).gunzipSync(Buffer.from(await latest.arrayBuffer())).toString('utf8'))
    assert.equal(doc.machine, 'pc')
    const paths = doc.files.map((file) => file.path).sort()
    assert.deepEqual(paths, ['KEY.md', 'MEMORY.md', 'USER.md'])
  } finally {
    await hub.close()
  }
})

test('latest returns 404 when the hub has no memories yet', async () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'memsync-empty-'))
  const { hub, url } = await startHub(emptyRoot, 's3cret')
  try {
    await assert.rejects(() => callPeer(url, '/mem/latest', { secret: 's3cret' }), /404/)
  } finally {
    await hub.close()
  }
})

test('peer memory records authenticated callers only and serves the hub view', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memsync-pc-'))
  await writeTree(root, { 'USER.md': 'pc user' })
  const stateDir = mkdtempSync(join(tmpdir(), 'memsync-hub-'))
  const seen = []
  const records = { hotspot: { host: '192.168.137.50', at: '2026-11-19T00:00:00.000Z', count: 2 } }
  const peers = {
    record: (host) => seen.push(host),
    list: () => ({ rememberPeer: true, machine: 'pc', listenPort: 18792, records }),
    remove: (mode) => {
      const found = Boolean(records[mode])
      delete records[mode]
      return found
    },
    use: async (mode) => (records[mode]
      ? { ok: true, mode, peerUrl: `http://${records[mode].host}:18792`, host: records[mode].host }
      : { ok: false, error: `no remembered ${mode} address` }),
  }
  const hub = createSnapshotServer({
    dir: join(stateDir, 'snapshots'),
    secret: 's3cret',
    machine: 'pc',
    repoRoot: root,
    listenHost: '127.0.0.1',
    listenPort: 0,
    peers,
    logger: null,
  })
  const addr = await hub.listen()
  const url = `http://127.0.0.1:${addr.port}`
  try {
    // /mem/ping is unauthenticated: it must not be remembered.
    const ping = await callPeer(url, '/mem/ping')
    assert.equal((await ping.json()).ok, true)
    assert.equal(seen.length, 0)

    // An authenticated call is what carries a usable address.
    const list = await callPeer(url, '/mem/list', { secret: 's3cret' })
    assert.equal((await list.json()).ok, true)
    assert.deepEqual(seen, ['127.0.0.1'])

    const view = await callPeer(url, '/mem/peers', { secret: 's3cret' })
    const doc = await view.json()
    assert.equal(doc.ok, true)
    assert.equal(doc.rememberPeer, true)
    assert.equal(doc.records.hotspot.host, '192.168.137.50')

    const used = await callPeer(url, '/mem/peers/use', {
      method: 'POST',
      secret: 's3cret',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'hotspot' }),
    })
    const usedDoc = await used.json()
    assert.equal(usedDoc.ok, true)
    assert.equal(usedDoc.peerUrl, 'http://192.168.137.50:18792')

    const removed = await callPeer(url, '/mem/peers/delete', {
      method: 'POST',
      secret: 's3cret',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'hotspot' }),
    })
    const removedDoc = await removed.json()
    assert.equal(removedDoc.ok, true)
    assert.equal(removedDoc.removed, true)

    await assert.rejects(
      () => callPeer(url, '/mem/peers', { secret: 'nope' }),
      /401/,
    )
  } finally {
    await hub.close()
  }
})
