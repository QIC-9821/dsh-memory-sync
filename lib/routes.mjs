import fs from 'node:fs/promises'

import { callPeer } from './peer-http.mjs'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function send(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': body.length, 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`body over ${limit} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  const body = await readBody(req, limit)
  if (!body.length) return {}
  return JSON.parse(body.toString('utf8'))
}

export function isLocalCall(req, origin) {
  const requestOrigin = req.headers.origin
  if (!requestOrigin) return true
  if (origin && requestOrigin === origin) return true
  try {
    const host = req.headers.host
    return new URL(requestOrigin).host === host
  } catch {
    return false
  }
}

export function createRoutes({
  runtime,
  store,
  version = '',
  origin = '',
  tools = null,
  secrets = null,
  pairing = null,
  remote = null,
  janitor = null,
  peers = null,
  cleanup = null,
  onConfigApplied = null,
}) {
  async function state() {
    return {
      ok: true,
      version,
      config: store.redacted(),
      settings: store.info(),
      status: await runtime.status(),
      ...(typeof tools?.status === 'function' ? { tools: tools.status() } : {}),
      ...(typeof secrets?.status === 'function' ? { secret: secrets.status() } : {}),
      ...(typeof remote?.status === 'function' ? { remote: remote.status() } : {}),
      ...(typeof pairing?.status === 'function' ? { pairing: pairing.status() } : {}),
      ...(typeof janitor?.status === 'function' ? { janitor: janitor.status() } : {}),
    }
  }

  async function applyConfig(patch = {}) {
    if (typeof onConfigApplied === 'function') {
      await onConfigApplied(patch)
      return
    }
    await runtime.reconfigure()
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname
    if (!path.startsWith('/memory-sync/api/')) {
      return send(res, 404, { ok: false, error: 'not found' })
    }
    if (!isLocalCall(req, origin)) {
      return send(res, 403, { ok: false, error: 'forbidden' })
    }
    const action = path.slice('/memory-sync/api/'.length)
    try {
      if (action === 'state' && req.method === 'GET') {
        return send(res, 200, await state())
      }
      if (action === 'config' && req.method === 'POST') {
        const body = await readJson(req)
        const patch = body?.patch && typeof body.patch === 'object' ? { ...body.patch } : {}
        if (patch.memSecret === '') delete patch.memSecret
        store.save(patch, { clearSecret: body?.clearSecret === true })
        if (Object.prototype.hasOwnProperty.call(patch, 'peerUrl') && typeof peers?.noteAddress === 'function') {
          const history = peers.noteAddress(store.current().peerUrl)
          if (history) store.save({ peerHistory: history })
        }
        await applyConfig(patch)
        return send(res, 200, await state())
      }
      if (action === 'reset' && req.method === 'POST') {
        store.reset()
        await applyConfig({})
        return send(res, 200, await state())
      }
      if (action === 'secret/migrate' && req.method === 'POST') {
        if (typeof secrets?.migrate !== 'function') {
          return send(res, 409, { ok: false, error: 'secret store unavailable' })
        }
        const body = await readJson(req)
        const target = String(body?.secretFile || '').trim()
        if (!target) {
          return send(res, 400, { ok: false, error: 'secretFile is required' })
        }
        let moved
        try {
          moved = secrets.migrate(target)
        } catch (error) {
          return send(res, 409, { ok: false, error: String(error?.message || error) })
        }
        store.save({ secretFile: target })
        await applyConfig({ secretFile: target })
        return send(res, 200, { ok: true, ...moved, state: await state() })
      }
      if (action === 'pair/new' && req.method === 'POST') {
        if (typeof pairing?.newCode !== 'function') {
          return send(res, 409, { ok: false, error: 'pairing unavailable' })
        }
        const result = pairing.newCode()
        return send(res, 200, {
          ok: true,
          ...result,
          machine: store.current().machine,
          secret: typeof secrets?.status === 'function' ? secrets.status() : null,
        })
      }
      if (action === 'pair/accept' && req.method === 'POST') {
        if (typeof pairing?.check !== 'function') {
          return send(res, 409, { ok: false, error: 'pairing unavailable' })
        }
        const body = await readJson(req)
        const peerUrl = String(body?.url || '').trim().replace(/\/+$/, '')
        const code = String(body?.code || '').trim()
        let parsed = null
        try {
          parsed = new URL(peerUrl)
        } catch {
          parsed = null
        }
        if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
          return send(res, 400, { ok: false, error: 'url must be http(s)' })
        }
        if (!/^\d{6}$/.test(code)) {
          return send(res, 400, { ok: false, error: 'code must be 6 digits' })
        }
        let response
        let doc
        try {
          response = await callPeer(peerUrl, '/mem/pair', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              code,
              name: store.current().machine,
              platform: process.platform,
              fingerprint: typeof secrets?.status === 'function' ? secrets.status().fingerprint : '',
            }),
            timeoutMs: 10000,
          })
          doc = await response.json()
        } catch (error) {
          return send(res, 502, { ok: false, error: String(error?.message || error) })
        }
        if (!doc?.ok || !doc?.secret) {
          return send(res, 502, { ok: false, error: doc?.error || 'peer did not return a secret' })
        }
        store.save({
          memSecret: doc.secret,
          peerUrl,
          peerMachine: String(doc.name || doc.machine || '').trim(),
          peerName: String(doc.name || doc.machine || '').trim(),
          peerPlatform: String(doc.platform || '').trim(),
          peerPairedAt: new Date().toISOString(),
          peerFingerprint: String(doc.fingerprint || '').trim(),
          transport: 'http',
        })
        await applyConfig({ memSecret: doc.secret, peerUrl, transport: 'http' })
        return send(res, 200, { ok: true, paired: { machine: doc.machine, name: doc.name, fingerprint: doc.fingerprint }, state: await state() })
      }
      if (action === 'pairings' && req.method === 'GET') {
        const items = typeof pairing?.list === 'function' ? pairing.list() : []
        return send(res, 200, { ok: true, items })
      }
      if (action === 'pair/clear' && req.method === 'POST') {
        pairing?.clear?.()
        return send(res, 200, { ok: true, state: await state() })
      }
      if (action === 'remote/refresh' && req.method === 'POST') {
        if (typeof remote?.refresh !== 'function') {
          return send(res, 409, { ok: false, error: 'remote unavailable' })
        }
        await remote.refresh(store.current())
        await applyConfig({})
        return send(res, 200, { ok: true, remote: remote.status(), state: await state() })
      }
      if (action === 'cleanup' && req.method === 'POST') {
        const body = await readJson(req)
        if (body?.confirm !== true) {
          return send(res, 400, { ok: false, error: 'confirm:true is required' })
        }
        if (typeof cleanup !== 'function') {
          return send(res, 409, { ok: false, error: 'cleanup unavailable' })
        }
        const current = store.current()
        await runtime.pause()
        remote?.stop?.()
        await remote?.restoreWarp?.()
        secrets?.suspendGeneration?.()
        const result = await cleanup({
          stateDir: current.stateDir,
          secretInfo: typeof secrets?.status === 'function' ? secrets.status() : {},
          includeBackups: body?.includeBackups === true,
          pairing,
        })
        store.reload()
        tools?.refresh?.()
        return send(res, 200, { ok: true, ...result, state: await state() })
      }
      if (action === 'tools/wake' && req.method === 'POST') {
        const body = await readJson(req)
        const raw = body?.minutes
        const minutes = raw === undefined ? 10 : Number(raw)
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
          return send(res, 400, { ok: false, error: 'minutes must be between 1 and 120' })
        }
        if (typeof tools?.wake !== 'function') {
          return send(res, 409, { ok: false, error: 'tool controller unavailable' })
        }
        const result = tools.wake(minutes)
        if (!result?.ok) {
          return send(res, 409, { ok: false, error: String(result?.error || 'wake unavailable') })
        }
        return send(res, 200, { ok: true, ...result, tools: tools.status() })
      }
      if (action === 'janitor/run' && req.method === 'POST') {
        if (typeof janitor?.run !== 'function') {
          return send(res, 409, { ok: false, error: 'janitor unavailable' })
        }
        const body = await readJson(req)
        const result = await janitor.run({ dryRun: body?.dryRun === true })
        return send(res, 200, { ok: true, result, janitor: janitor.status(), state: await state() })
      }
      if (action === 'sync' && req.method === 'POST') {
        const body = await readJson(req)
        const direction = ['both', 'push', 'pull'].includes(body?.direction) ? body.direction : 'both'
        const result = await runtime.run('manual', { direction })
        return send(res, 200, { ok: true, result, status: await runtime.status() })
      }
      if (action === 'test' && req.method === 'POST') {
        return send(res, 200, { ok: true, result: await runtime.test() })
      }
      if (action === 'peers' && req.method === 'GET') {
        const local = typeof peers?.list === 'function' ? peers.list() : { records: {} }
        let remote = null
        if (url.searchParams.get('remote') === '1') {
          const cfg = store.current()
          if (!cfg.peerUrl) {
            remote = { ok: false, error: 'peerUrl is empty' }
          } else {
            try {
              const response = await callPeer(cfg.peerUrl, '/mem/peers', {
                secret: cfg.memSecret,
                timeoutMs: 5000,
              })
              remote = await response.json()
            } catch (error) {
              remote = { ok: false, error: 'peer unreachable', detail: String(error?.message || error) }
            }
          }
        }
        return send(res, 200, { ok: true, local, remote })
      }
      if (action === 'peers/delete' && req.method === 'POST') {
        const body = await readJson(req)
        const mode = String(body?.mode || '')
        if (body?.remote === true) {
          const cfg = store.current()
          if (!cfg.peerUrl) return send(res, 400, { ok: false, error: 'peerUrl is empty' })
          try {
            const response = await callPeer(cfg.peerUrl, '/mem/peers/delete', {
              method: 'POST',
              secret: cfg.memSecret,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ mode }),
              timeoutMs: 5000,
            })
            return send(res, 200, { ok: true, remote: await response.json() })
          } catch (error) {
            return send(res, 502, { ok: false, error: 'peer unreachable', detail: String(error?.message || error) })
          }
        }
        const removed = typeof peers?.remove === 'function' ? peers.remove(mode) : false
        const local = typeof peers?.list === 'function' ? peers.list() : { records: {} }
        return send(res, 200, { ok: true, removed, local })
      }
      if (action === 'peers/use' && req.method === 'POST') {
        const body = await readJson(req)
        const mode = String(body?.mode || '')
        if (body?.remote === true) {
          const cfg = store.current()
          if (!cfg.peerUrl) return send(res, 400, { ok: false, error: 'peerUrl is empty' })
          try {
            const response = await callPeer(cfg.peerUrl, '/mem/peers/use', {
              method: 'POST',
              secret: cfg.memSecret,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ mode }),
              timeoutMs: 10000,
            })
            return send(res, 200, { ok: true, remote: await response.json() })
          } catch (error) {
            return send(res, 502, { ok: false, error: 'peer unreachable', detail: String(error?.message || error) })
          }
        }
        if (typeof peers?.use !== 'function') {
          return send(res, 409, { ok: false, error: 'peer memory is unavailable' })
        }
        const result = await peers.use(mode)
        if (!result?.ok) return send(res, 400, { ok: false, error: String(result?.error || 'use failed') })
        return send(res, 200, { ok: true, result, state: await state() })
      }
      if (action === 'logs' && req.method === 'GET') {
        const lines = Number(url.searchParams.get('lines')) || 80
        return send(res, 200, { ok: true, lines: await runtime.logs(lines) })
      }
      if (action === 'snapshots' && req.method === 'GET') {
        return send(res, 200, { ok: true, ...(await runtime.list()) })
      }
      if (action === 'restore' && req.method === 'POST') {
        const body = await readJson(req)
        const id = String(body?.id || '')
        return send(res, 200, { ok: true, result: await runtime.restore(id) })
      }
      if (action === 'export' && req.method === 'GET') {
        const result = await runtime.exportTo('')
        const body = await fs.readFile(result.path)
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-length': body.length,
          'content-disposition': `attachment; filename="${result.path.split(/[\\\\/]/).pop()}"`,
          'cache-control': 'no-store',
          'x-snapshot-files': String(result.files ?? ''),
        })
        res.end(body)
        return
      }
      if (action === 'import' && req.method === 'POST') {
        const dryRun = url.searchParams.get('dryRun') === '1'
        const maxBytes = Math.min(256 * 1024 * 1024, Math.max(1, Number(store.current().maxSnapshotMB) || 100) * 1024 * 1024)
        const body = await readBody(req, maxBytes)
        const result = await runtime.importFrom(body, { dryRun })
        return send(res, 200, { ok: true, result })
      }
      return send(res, 404, { ok: false, error: `unknown api: ${action}` })
    } catch (error) {
      return send(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  return { handle, state }
}
