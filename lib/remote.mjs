import { execFile, spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createWarpClient } from './warp.mjs'

const TAILSCALE_TIMEOUT_MS = 3000
const STDERR_LIMIT = 2000
const RETRY_DELAYS = Object.freeze([5000, 10000, 30000, 60000])
const PORT_IN_USE_RE = /Address already in use|remote port forwarding failed/i

const EMPTY_TAILSCALE = Object.freeze({
  installed: false,
  online: false,
  ipv4: '',
  dnsName: '',
  error: '',
})

const EMPTY_WARP = Object.freeze({
  installed: false,
  supported: false,
  state: 'unknown',
  mode: '',
  tunnel: false,
  changed: false,
  error: '',
})

function errorText(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  const code = error.code ? `${error.code}: ` : ''
  return `${code}${error.message || String(error)}`
}

function limitText(text, limit = STDERR_LIMIT) {
  const value = String(text || '')
  return value.length > limit ? value.slice(value.length - limit) : value
}

/** The first dotted-quad IPv4 address in a tailscale IP list. */
function firstIpv4(list) {
  if (!Array.isArray(list)) return ''
  for (const raw of list) {
    const value = String(raw || '').trim()
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value
  }
  return ''
}

function cloneTailscale(value) {
  return {
    installed: Boolean(value?.installed),
    online: Boolean(value?.online),
    ipv4: String(value?.ipv4 || ''),
    dnsName: String(value?.dnsName || ''),
    error: String(value?.error || ''),
  }
}

function cloneWarp(value) {
  return {
    installed: Boolean(value?.installed),
    supported: Boolean(value?.supported),
    state: String(value?.state || 'unknown'),
    mode: String(value?.mode || ''),
    tunnel: Boolean(value?.tunnel),
    changed: Boolean(value?.changed),
    error: String(value?.error || ''),
  }
}

/** run() may resolve to a string, a Buffer, or an object with stdout. */
async function stdoutOf(result) {
  const value = await result
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (typeof value === 'object' && value.stdout !== undefined) {
    return Buffer.isBuffer(value.stdout) ? value.stdout.toString('utf8') : String(value.stdout)
  }
  return String(value)
}

function defaultRun(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: options.timeoutMs || TAILSCALE_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(typeof stdout === 'string' ? stdout : String(stdout || ''))
      },
    )
  })
}

function sshArgs(cfg, localPort, remotePort) {
  const args = ['-N', '-T']
  const keyPath = String(cfg?.sshKeyPath || '').trim()
  if (keyPath) args.push('-i', keyPath)
  args.push(
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
  )
  const sshPort = Number(cfg?.sshPort)
  if (Number.isFinite(sshPort) && sshPort > 0) args.push('-p', String(sshPort))
  args.push(`${String(cfg.sshUser).trim()}@${String(cfg.sshHost).trim()}`)
  return args
}

/**
 * Tailscale discovery plus an optional SSH reverse tunnel. Every external
 * command goes through the injected `run` / `spawn`, so tests never touch the
 * network or start real processes. No method throws.
 */
export function createRemoteController({
  logger,
  run = defaultRun,
  spawn = nodeSpawn,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  warp = null,
  stateDir = '',
  platform = process.platform,
} = {}) {
  const log = (level, message) => {
    try {
      logger?.[level]?.(message)
    } catch {
      // a broken logger must never break the controller
    }
  }

  let tailscale = { ...EMPTY_TAILSCALE }
  let warpState = { ...EMPTY_WARP }
  const warpPreviousFile = stateDir ? join(stateDir, 'warp-previous.json') : ''
  let previousWarpMode = readPreviousWarp()
  let lastCfg = null
  let generation = 0
  let retryTimer = null
  const warpClient = warp || createWarpClient({ platform })

  function readPreviousWarp() {
    if (!warpPreviousFile) return ''
    try {
      const parsed = JSON.parse(readFileSync(warpPreviousFile, 'utf8'))
      return String(parsed?.mode || '')
    } catch {
      return ''
    }
  }

  function savePreviousWarp(mode) {
    previousWarpMode = String(mode || '')
    if (!warpPreviousFile) return
    try {
      if (!previousWarpMode) {
        rmSync(warpPreviousFile, { force: true })
        return
      }
      mkdirSync(dirname(warpPreviousFile), { recursive: true })
      writeFileSync(warpPreviousFile, `${JSON.stringify({ mode: previousWarpMode })}\n`, 'utf8')
    } catch (error) {
      log('warn', `warp previous mode could not be saved: ${errorText(error)}`)
    }
  }

  async function restoreWarpIfNeeded() {
    if (!previousWarpMode) return
    try {
      const result = await warpClient.restoreTunnel(previousWarpMode)
      warpState = cloneWarp({ ...result, changed: Boolean(result?.changed) })
      if (result?.changed) log('info', `warp restored to ${previousWarpMode}`)
      savePreviousWarp('')
    } catch (error) {
      warpState = cloneWarp({ ...warpState, installed: true, error: errorText(error) })
      log('warn', `warp restore failed: ${errorText(error)}`)
    }
  }

  async function syncWarp(cfg) {
    try {
      if (cfg?.remoteMode === 'tailscale' && cfg?.warpCoexist) {
        const result = await warpClient.ensureCoexist()
        const previous = String(result?.previousMode || '')
        if (result?.changed && previous) savePreviousWarp(previous)
        warpState = cloneWarp(result)
        if (result?.changed) log('info', `warp switched to DNS-only mode (was ${previous || 'tunnel'})`)
        return
      }
      if (previousWarpMode) {
        await restoreWarpIfNeeded()
        return
      }
      warpState = cloneWarp(await warpClient.getStatus())
    } catch (error) {
      warpState = cloneWarp({ ...warpState, installed: true, supported: true, error: errorText(error) })
      log('warn', `warp check failed: ${errorText(error)}`)
    }
  }

  const tun = {
    state: 'stopped',
    pid: 0,
    error: '',
    remotePort: 0,
    localPort: 0,
    attempts: 0,
    nextRetryAt: 0,
    stderr: '',
    child: null,
  }

  function clearRetryTimer() {
    if (retryTimer !== null) {
      try {
        clearTimer(retryTimer)
      } catch {
        // ignore
      }
      retryTimer = null
    }
  }

  async function probe() {
    let raw
    try {
      raw = await stdoutOf(run('tailscale', ['status', '--json'], { timeoutMs: TAILSCALE_TIMEOUT_MS }))
    } catch (error) {
      const text = errorText(error)
      log('warn', `tailscale status failed: ${text}`)
      return { installed: false, online: false, ipv4: '', dnsName: '', error: text }
    }

    let parsed = null
    try {
      parsed = JSON.parse(String(raw || '').trim() || '{}')
    } catch {
      const text = 'tailscale status returned invalid JSON'
      log('warn', text)
      return { installed: false, online: false, ipv4: '', dnsName: '', error: text }
    }

    const self = parsed?.Self && typeof parsed.Self === 'object' ? parsed.Self : {}
    const backend = String(parsed?.BackendState || '')
    const online = backend === 'Running' && self.Online !== false
    let ipv4 = firstIpv4(self.TailscaleIPs)

    if (!ipv4) {
      try {
        const text = await stdoutOf(run('tailscale', ['ip', '-4'], { timeoutMs: TAILSCALE_TIMEOUT_MS }))
        ipv4 = firstIpv4(String(text || '').split(/\r?\n/))
      } catch (error) {
        log('warn', `tailscale ip -4 failed: ${errorText(error)}`)
      }
    }

    const result = {
      installed: true,
      online,
      ipv4,
      dnsName: String(self.DNSName || '').trim().replace(/\.$/, ''),
      error: '',
    }
    log('info', `tailscale: online=${online} ipv4=${ipv4 || '-'}`)
    return result
  }

  async function refresh(cfg = {}) {
    lastCfg = cfg
    if (cfg?.remoteMode !== 'tailscale') {
      await restoreWarpIfNeeded()
      return cloneTailscale(tailscale)
    }
    try {
      tailscale = await probe()
    } catch (error) {
      tailscale = { ...EMPTY_TAILSCALE, error: errorText(error) }
      log('warn', `tailscale probe failed: ${tailscale.error}`)
    }
    await syncWarp(cfg)
    return cloneTailscale(tailscale)
  }

  /** Pure: derives the listen host from the last probe, never mutates cfg. */
  function effectiveConfig(cfg = {}) {
    if (cfg?.remoteMode === 'tailscale' && tailscale.online && tailscale.ipv4) {
      return { ...cfg, listenHost: tailscale.ipv4 }
    }
    return cfg
  }

  function scheduleRetry(cfg, localPort) {
    const index = Math.min(Math.max(tun.attempts - 1, 0), RETRY_DELAYS.length - 1)
    const delay = RETRY_DELAYS[index]
    tun.state = 'retrying'
    tun.pid = 0
    tun.nextRetryAt = now() + delay
    clearRetryTimer()
    const gen = generation
    retryTimer = setTimer(() => {
      retryTimer = null
      if (gen !== generation || tun.state !== 'retrying') return
      startTunnel(cfg, localPort)
    }, delay)
    log('warn', `ssh tunnel retry in ${delay}ms (attempt ${tun.attempts})`)
  }

  function handleExit(gen, code, signal, cfg, localPort, forcedError) {
    if (gen !== generation) return
    tun.child = null
    tun.pid = 0
    const tail = tun.stderr.trim()
    const exitText = `ssh exited (code ${code === null || code === undefined ? 'null' : code}${signal ? `, signal ${signal}` : ''})`
    if (forcedError || !tun.error) {
      tun.error = limitText(`${exitText}${tail ? `: ${tail}` : ''}`)
    }
    if (PORT_IN_USE_RE.test(tun.error)) {
      log('warn', 'ssh tunnel remote port forwarding failed; check the remote port')
    }
    tun.attempts += 1
    log('warn', `ssh tunnel exited: ${tun.error}`)
    scheduleRetry(cfg, localPort)
  }

  function startTunnel(cfg, localPort) {
    clearRetryTimer()
    const remotePort = Number(cfg?.tunnelRemotePort) > 0
      ? Number(cfg.tunnelRemotePort)
      : Number(cfg?.listenPort) > 0
        ? Number(cfg.listenPort)
        : 0
    tun.localPort = Number(localPort) || 0
    tun.remotePort = remotePort
    tun.state = 'starting'
    tun.pid = 0

    const args = sshArgs(cfg, tun.localPort, remotePort)
    const gen = (generation += 1)
    let child
    try {
      child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      tun.error = limitText(`ssh spawn failed: ${errorText(error)}`)
      log('warn', tun.error)
      tun.attempts += 1
      scheduleRetry(cfg, localPort)
      return
    }
    if (!child || typeof child.on !== 'function') {
      tun.error = 'ssh spawn returned no process'
      log('warn', tun.error)
      tun.attempts += 1
      scheduleRetry(cfg, localPort)
      return
    }

    tun.child = child
    tun.pid = Number(child.pid) || 0
    tun.state = 'running'
    tun.stderr = ''
    log('info', `ssh tunnel started pid=${tun.pid} ${args.join(' ')}`)

    let settled = false
    const fail = (error) => {
      if (settled || gen !== generation) return
      settled = true
      handleExit(gen, null, null, cfg, localPort, `ssh error: ${errorText(error)}`)
    }

    if (child.stderr?.on) {
      child.stderr.on('data', (chunk) => {
        if (gen !== generation) return
        tun.stderr = limitText(tun.stderr + String(chunk ?? ''))
      })
    }
    child.on('error', fail)
    child.on('exit', (code, signal) => {
      if (settled || gen !== generation) return
      settled = true
      handleExit(gen, code, signal, cfg, localPort, '')
    })
  }

  function stopTunnel() {
    generation += 1
    clearRetryTimer()
    const child = tun.child
    tun.child = null
    if (child && typeof child.kill === 'function') {
      try {
        child.kill('SIGTERM')
      } catch (error) {
        log('warn', `ssh kill failed: ${errorText(error)}`)
      }
    }
    tun.state = 'stopped'
    tun.pid = 0
    tun.error = ''
    tun.attempts = 0
    tun.nextRetryAt = 0
    tun.stderr = ''
  }

  async function reconfigure(cfg = {}, options = {}) {
    lastCfg = cfg
    try {
      await refresh(cfg)
    } catch (error) {
      log('warn', `remote refresh failed: ${errorText(error)}`)
    }

    try {
      const localPort = Number(options?.localPort ?? cfg?.listenPort)
      const wanted = Boolean(
        cfg?.remoteMode === 'ssh'
          && cfg?.tunnelEnabled
          && String(cfg?.sshHost || '').trim()
          && String(cfg?.sshUser || '').trim()
          && Number.isFinite(localPort)
          && localPort > 0,
      )
      if (!wanted) {
        stopTunnel()
        return status()
      }
      stopTunnel()
      startTunnel(cfg, localPort)
    } catch (error) {
      tun.state = 'error'
      tun.error = limitText(errorText(error))
      log('warn', `remote reconfigure failed: ${tun.error}`)
    }
    return status()
  }

  function status() {
    const cfg = lastCfg || {}
    const ts = cloneTailscale(tailscale)
    const effective = effectiveConfig(cfg)
    const onlineTailscale = Boolean(cfg.remoteMode === 'tailscale' && ts.online && ts.ipv4)
    const listenPort = Number(cfg.listenPort) || 0
    return {
      mode: String(cfg.remoteMode || 'off'),
      tailscale: ts,
      warp: { ...cloneWarp(warpState), coexist: Boolean(cfg.warpCoexist), previousMode: previousWarpMode },
      effectiveHost: String(effective?.listenHost || ''),
      remoteUrl: onlineTailscale ? `http://${ts.ipv4}:${listenPort}` : '',
      tunnel: {
        enabled: Boolean(cfg.remoteMode === 'ssh' && cfg.tunnelEnabled),
        state: tun.state,
        pid: tun.pid,
        error: tun.error,
        remotePort: tun.remotePort,
        localPort: tun.localPort,
        attempts: tun.attempts,
        nextRetryAt: tun.nextRetryAt,
      },
    }
  }

  function dispose() {
    stopTunnel()
    void restoreWarpIfNeeded()
  }

  async function restoreWarp() {
    await restoreWarpIfNeeded()
  }

  return {
    refresh,
    effectiveConfig,
    reconfigure,
    status,
    stop: stopTunnel,
    restoreWarp,
    dispose,
  }
}
