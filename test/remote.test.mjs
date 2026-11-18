import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createRemoteController } from '../lib/remote.mjs'

function makeRun(handler) {
  const calls = []
  const run = (command, args, options) => {
    calls.push({ command, args, options })
    return handler(command, args, options, calls.length)
  }
  run.calls = calls
  return run
}

/** EventEmitter-shaped fake ssh process; nothing is really executed. */
function makeSpawn() {
  const calls = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4100 + calls.length
    child.killed = false
    child.killSignal = ''
    child.kill = (signal) => {
      child.killed = true
      child.killSignal = String(signal || '')
      return true
    }
    calls.push({ command, args, options, child })
    return child
  }
  spawn.calls = calls
  return spawn
}

function makeTimers() {
  const pending = new Map()
  const cleared = []
  let seq = 0
  return {
    pending,
    cleared,
    setTimer(fn, delay) {
      seq += 1
      pending.set(seq, { fn, delay })
      return seq
    },
    clearTimer(id) {
      cleared.push(id)
      pending.delete(id)
    },
    fire(id) {
      const entry = pending.get(id)
      if (!entry) throw new Error(`timer ${id} is not pending`)
      pending.delete(id)
      entry.fn()
    },
  }
}

function makeWarp(overrides = {}) {
  const calls = []
  const status = {
    installed: true,
    supported: true,
    state: 'connected',
    mode: 'warp',
    tunnel: true,
    ...(overrides.status || {}),
  }
  const client = {
    calls,
    async getStatus() {
      calls.push({ action: 'status' })
      return { ...status }
    },
    async ensureCoexist() {
      calls.push({ action: 'ensureCoexist' })
      if (overrides.ensureCoexist) return overrides.ensureCoexist(status)
      return { ...status, changed: false }
    },
    async restoreTunnel(mode) {
      calls.push({ action: 'restoreTunnel', mode })
      if (overrides.restoreTunnel) return overrides.restoreTunnel(mode, status)
      return { ...status, changed: true, previousMode: 'doh' }
    },
  }
  return client
}

function makeController({ run, spawn, timers, clock, warp, stateDir } = {}) {
  const t = timers || makeTimers()
  let time = clock ?? 1000
  const controller = createRemoteController({
    run: run || makeRun(() => '{}'),
    spawn: spawn || makeSpawn(),
    now: () => time,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    warp: warp || makeWarp(),
    stateDir: stateDir || '',
  })
  return {
    controller,
    timers: t,
    setNow: (value) => {
      time = value
    },
  }
}

const TAILSCALE_CFG = Object.freeze({
  remoteMode: 'tailscale',
  listenHost: '0.0.0.0',
  listenPort: 18792,
})

const SSH_CFG = Object.freeze({
  remoteMode: 'ssh',
  tunnelEnabled: true,
  sshHost: 'cloud.example',
  sshUser: 'root',
  sshKeyPath: 'C:/keys/id_ed25519',
  sshPort: 2222,
  listenPort: 18792,
  tunnelRemotePort: 18790,
})

const STATUS_JSON = JSON.stringify({
  BackendState: 'Running',
  Self: {
    Online: true,
    TailscaleIPs: ['100.64.0.9', 'fd7a:115c:a1e0::9'],
    DNSName: 'whale.tailnet.ts.net.',
  },
})

test('refresh reports an online tailscale node', async () => {
  const run = makeRun(() => STATUS_JSON)
  const { controller } = makeController({ run })

  const result = await controller.refresh(TAILSCALE_CFG)

  assert.deepEqual(result, {
    installed: true,
    online: true,
    ipv4: '100.64.0.9',
    dnsName: 'whale.tailnet.ts.net',
    error: '',
  })
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].command, 'tailscale')
  assert.deepEqual(run.calls[0].args, ['status', '--json'])
  assert.equal(run.calls[0].options.timeoutMs, 3000)
})

test('status exposes the tailscale url and effective host', async () => {
  const run = makeRun(() => STATUS_JSON)
  const { controller } = makeController({ run })
  await controller.refresh(TAILSCALE_CFG)

  const snapshot = controller.status()
  assert.equal(snapshot.mode, 'tailscale')
  assert.equal(snapshot.effectiveHost, '100.64.0.9')
  assert.equal(snapshot.remoteUrl, 'http://100.64.0.9:18792')
  assert.equal(snapshot.tailscale.online, true)
  assert.equal(snapshot.tunnel.enabled, false)
  assert.equal(snapshot.tunnel.state, 'stopped')
})

test('effectiveConfig only rewrites the host for an online tailscale node', async () => {
  const online = makeController({ run: makeRun(() => STATUS_JSON) })
  const cfg = { ...TAILSCALE_CFG }
  await online.controller.refresh(cfg)
  const effective = online.controller.effectiveConfig(cfg)

  assert.equal(effective.listenHost, '100.64.0.9')
  assert.notEqual(effective, cfg)
  assert.equal(cfg.listenHost, '0.0.0.0')

  const offlineJson = JSON.stringify({
    BackendState: 'Stopped',
    Self: { Online: false, TailscaleIPs: ['100.64.0.9'], DNSName: 'whale.tailnet.ts.net.' },
  })
  const offline = makeController({ run: makeRun(() => offlineJson) })
  await offline.controller.refresh(cfg)
  assert.equal(offline.controller.effectiveConfig(cfg).listenHost, '0.0.0.0')
  assert.equal(offline.controller.status().remoteUrl, '')
  assert.equal(offline.controller.status().tailscale.installed, true)
  assert.equal(offline.controller.status().tailscale.online, false)

  const ssh = makeController({ run: makeRun(() => STATUS_JSON) })
  const sshCfg = { ...SSH_CFG, listenHost: '127.0.0.1' }
  const sshEffective = ssh.controller.effectiveConfig(sshCfg)
  assert.equal(sshEffective, sshCfg)
  assert.equal(sshEffective.listenHost, '127.0.0.1')
})

test('refresh leaves tailscale offline when the backend is not running', async () => {
  const run = makeRun(() => JSON.stringify({
    BackendState: 'NeedsLogin',
    Self: { Online: true, TailscaleIPs: ['100.64.0.9'] },
  }))
  const { controller } = makeController({ run })

  const result = await controller.refresh(TAILSCALE_CFG)
  assert.equal(result.installed, true)
  assert.equal(result.online, false)
  assert.equal(result.ipv4, '100.64.0.9')
})

test('refresh falls back to tailscale ip -4 when status omits an IPv4', async () => {
  const run = makeRun((command, args) => {
    if (args[0] === 'status') {
      return JSON.stringify({
        BackendState: 'Running',
        Self: { Online: true, TailscaleIPs: ['fd7a:115c:a1e0::9'], DNSName: 'whale.tailnet.ts.net.' },
      })
    }
    return '100.90.1.5\nfd7a:115c:a1e0::9\n'
  })
  const { controller } = makeController({ run })

  const result = await controller.refresh(TAILSCALE_CFG)

  assert.equal(result.ipv4, '100.90.1.5')
  assert.equal(result.online, true)
  assert.equal(run.calls.length, 2)
  assert.deepEqual(run.calls[1].args, ['ip', '-4'])
})

test('refresh marks tailscale missing when the command fails', async () => {
  const run = makeRun(() => {
    const error = new Error('spawn tailscale ENOENT')
    error.code = 'ENOENT'
    throw error
  })
  const { controller } = makeController({ run })

  const result = await controller.refresh(TAILSCALE_CFG)

  assert.equal(result.installed, false)
  assert.equal(result.online, false)
  assert.equal(result.ipv4, '')
  assert.match(result.error, /ENOENT/)
  assert.equal(controller.effectiveConfig(TAILSCALE_CFG).listenHost, '0.0.0.0')
  assert.equal(controller.status().remoteUrl, '')
})

test('refresh does not throw on invalid JSON', async () => {
  const { controller } = makeController({ run: makeRun(() => 'not json at all') })
  const result = await controller.refresh(TAILSCALE_CFG)
  assert.equal(result.installed, false)
  assert.match(result.error, /invalid JSON/)
})

test('refresh reads stdout from an object result', async () => {
  const { controller } = makeController({ run: makeRun(() => ({ stdout: STATUS_JSON })) })
  const result = await controller.refresh(TAILSCALE_CFG)
  assert.equal(result.ipv4, '100.64.0.9')
})

test('refresh skips detection outside tailscale mode', async () => {
  const run = makeRun(() => STATUS_JSON)
  const { controller } = makeController({ run })

  await controller.refresh({ ...SSH_CFG })

  assert.equal(run.calls.length, 0)
  assert.equal(controller.status().tailscale.installed, false)
})

test('reconfigure never spawns outside ssh mode', async () => {
  const run = makeRun(() => STATUS_JSON)
  const spawn = makeSpawn()
  const { controller } = makeController({ run, spawn })

  await controller.reconfigure({ ...TAILSCALE_CFG, tunnelEnabled: true })

  assert.equal(spawn.calls.length, 0)
  const snapshot = controller.status()
  assert.equal(snapshot.effectiveHost, '100.64.0.9')
  assert.equal(snapshot.tunnel.enabled, false)
  assert.equal(snapshot.tunnel.state, 'stopped')
})

test('reconfigure builds the expected ssh arguments', async () => {
  const spawn = makeSpawn()
  const { controller } = makeController({ spawn })

  await controller.reconfigure(SSH_CFG)

  assert.equal(spawn.calls.length, 1)
  const call = spawn.calls[0]
  assert.equal(call.command, 'ssh')
  assert.deepEqual(call.args, [
    '-N', '-T',
    '-i', 'C:/keys/id_ed25519',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-R', '127.0.0.1:18790:127.0.0.1:18792',
    '-p', '2222',
    'root@cloud.example',
  ])
  assert.deepEqual(call.options, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const snapshot = controller.status()
  assert.equal(snapshot.tunnel.enabled, true)
  assert.equal(snapshot.tunnel.state, 'running')
  assert.equal(snapshot.tunnel.pid, 4100)
  assert.equal(snapshot.tunnel.remotePort, 18790)
  assert.equal(snapshot.tunnel.localPort, 18792)
})

test('reconfigure omits optional ssh arguments and honours localPort', async () => {
  const spawn = makeSpawn()
  const { controller } = makeController({ spawn })

  await controller.reconfigure(
    {
      remoteMode: 'ssh',
      tunnelEnabled: true,
      sshHost: 'cloud.example',
      sshUser: 'dsh',
      listenPort: 18792,
    },
    { localPort: 19000 },
  )

  const args = spawn.calls[0].args
  assert.equal(args.includes('-i'), false)
  assert.equal(args.includes('-p'), false)
  assert.deepEqual(args.slice(-3), ['-R', '127.0.0.1:18792:127.0.0.1:19000', 'dsh@cloud.example'])
})

test('reconfigure replaces the running tunnel and clears its retry timer', async () => {
  const spawn = makeSpawn()
  const { controller, timers } = makeController({ spawn })

  await controller.reconfigure(SSH_CFG)
  await controller.reconfigure(SSH_CFG)

  assert.equal(spawn.calls[0].child.killed, true)
  assert.equal(spawn.calls.length, 2)

  spawn.calls[1].child.emit('exit', 255, null)
  assert.equal(timers.pending.size, 1)
  const pendingId = [...timers.pending.keys()][0]

  await controller.reconfigure(SSH_CFG)

  assert.ok(timers.cleared.includes(pendingId))
  assert.equal(timers.pending.size, 0)
  assert.equal(spawn.calls.length, 3)
  assert.equal(controller.status().tunnel.state, 'running')
})

test('ssh exit retries with the 5s/10s/30s/60s backoff', async () => {
  const spawn = makeSpawn()
  const { controller, timers } = makeController({ spawn })
  await controller.reconfigure(SSH_CFG)

  const expected = [5000, 10000, 30000, 60000, 60000]
  for (let i = 0; i < expected.length; i += 1) {
    const child = spawn.calls[i].child
    child.emit('exit', 255, null)

    const snapshot = controller.status()
    assert.equal(snapshot.tunnel.state, 'retrying')
    assert.equal(snapshot.tunnel.attempts, i + 1)
    assert.equal(snapshot.tunnel.pid, 0)
    assert.equal(timers.pending.size, 1)

    const [id, timer] = [...timers.pending.entries()][0]
    assert.equal(timer.delay, expected[i])
    assert.equal(snapshot.tunnel.nextRetryAt, 1000 + expected[i])

    timers.fire(id)
    assert.equal(spawn.calls.length, i + 2)
    assert.equal(controller.status().tunnel.state, 'running')
  }

  assert.equal(spawn.calls.length, 6)
})

test('stop kills the process, clears the timer and ignores the late exit', async () => {
  const spawn = makeSpawn()
  const { controller, timers } = makeController({ spawn })
  await controller.reconfigure(SSH_CFG)
  const child = spawn.calls[0].child

  controller.stop()

  assert.equal(child.killed, true)
  assert.equal(child.killSignal, 'SIGTERM')
  const snapshot = controller.status()
  assert.equal(snapshot.tunnel.state, 'stopped')
  assert.equal(snapshot.tunnel.pid, 0)
  assert.equal(snapshot.tunnel.attempts, 0)
  assert.equal(timers.pending.size, 0)

  child.emit('exit', 255, null)
  assert.equal(timers.pending.size, 0)
  assert.equal(spawn.calls.length, 1)
  assert.equal(controller.status().tunnel.state, 'stopped')
})

test('stop cancels a pending retry timer', async () => {
  const spawn = makeSpawn()
  const { controller, timers } = makeController({ spawn })
  await controller.reconfigure(SSH_CFG)
  spawn.calls[0].child.emit('exit', 1, null)
  assert.equal(timers.pending.size, 1)

  controller.stop()

  assert.equal(timers.pending.size, 0)
  assert.equal(controller.status().tunnel.state, 'stopped')
})

test('dispose behaves like stop', async () => {
  const spawn = makeSpawn()
  const { controller } = makeController({ spawn })
  await controller.reconfigure(SSH_CFG)

  controller.dispose()

  assert.equal(spawn.calls[0].child.killed, true)
  assert.equal(controller.status().tunnel.state, 'stopped')
})

test('reconfigure stops the tunnel when the ssh config becomes incomplete', async () => {
  const spawn = makeSpawn()
  const { controller } = makeController({ spawn })
  await controller.reconfigure(SSH_CFG)

  await controller.reconfigure({ ...SSH_CFG, sshUser: '' })

  assert.equal(spawn.calls[0].child.killed, true)
  assert.equal(spawn.calls.length, 1)
  assert.equal(controller.status().tunnel.state, 'stopped')
})

test('port forwarding errors are recorded without running fuser', async () => {
  const spawn = makeSpawn()
  const { controller } = makeController({ spawn })
  await controller.reconfigure(SSH_CFG)

  spawn.calls[0].child.stderr.emit('data', 'Warning: remote port forwarding failed for listen port 18790')
  spawn.calls[0].child.stderr.emit('data', '\nbind: Address already in use')
  spawn.calls[0].child.emit('exit', 255, null)

  const snapshot = controller.status()
  assert.equal(snapshot.tunnel.state, 'retrying')
  assert.match(snapshot.tunnel.error, /remote port forwarding failed/)
  assert.match(snapshot.tunnel.error, /Address already in use/)
  assert.equal(spawn.calls.length, 1)
  assert.ok(spawn.calls.every((call) => call.command === 'ssh'))
})

test('stderr keeps at most 2000 characters', async () => {
  const spawn = makeSpawn()
  const { controller } = makeController({ spawn })
  await controller.reconfigure(SSH_CFG)

  spawn.calls[0].child.stderr.emit('data', 'x'.repeat(5000))
  spawn.calls[0].child.emit('exit', 255, null)

  const error = controller.status().tunnel.error
  assert.ok(error.length <= 2000, `error length ${error.length}`)
  assert.ok(error.endsWith('x'))
})

test('tailscale mode moves WARP to DNS-only and remembers the old mode', async () => {
  const warp = makeWarp({
    ensureCoexist: (status) => ({ ...status, mode: 'doh', tunnel: false, changed: true, previousMode: status.mode }),
  })
  const { controller } = makeController({ warp })
  await controller.reconfigure({ ...TAILSCALE_CFG, warpCoexist: true })

  const snapshot = controller.status()
  assert.equal(warp.calls.some((call) => call.action === 'ensureCoexist'), true)
  assert.equal(snapshot.warp.mode, 'doh')
  assert.equal(snapshot.warp.changed, true)
  assert.equal(snapshot.warp.previousMode, 'warp')
})

test('leaving tailscale mode restores the remembered WARP mode', async () => {
  const warp = makeWarp({
    ensureCoexist: (status) => ({ ...status, mode: 'doh', tunnel: false, changed: true, previousMode: 'warp' }),
    restoreTunnel: (mode) => ({ installed: true, supported: true, state: 'connected', mode, tunnel: true, changed: true }),
  })
  const { controller } = makeController({ warp })
  await controller.reconfigure({ ...TAILSCALE_CFG, warpCoexist: true })
  await controller.reconfigure({ ...TAILSCALE_CFG, remoteMode: 'off' })

  assert.deepEqual(warp.calls.filter((call) => call.action === 'restoreTunnel').map((call) => call.mode), ['warp'])
  assert.equal(controller.status().warp.mode, 'warp')
  assert.equal(controller.status().warp.previousMode, '')
})

test('reconfigure survives a throwing run and a throwing spawn', async () => {
  const run = makeRun(() => {
    throw new Error('tailscale exploded')
  })
  const first = makeController({ run })
  const tailscaleSnapshot = await first.controller.reconfigure(TAILSCALE_CFG)
  assert.equal(tailscaleSnapshot.tailscale.installed, false)
  assert.match(tailscaleSnapshot.tailscale.error, /exploded/)

  const spawn = () => {
    throw new Error('spawn exploded')
  }
  const second = makeController({ spawn })
  const snapshot = await second.controller.reconfigure(SSH_CFG)
  assert.equal(snapshot.tunnel.state, 'retrying')
  assert.equal(snapshot.tunnel.attempts, 1)
  assert.match(snapshot.tunnel.error, /spawn exploded/)
  assert.equal(second.timers.pending.size, 1)
})
