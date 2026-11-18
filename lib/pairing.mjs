import { randomInt, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

const CODE_LENGTH = 6
const DEFAULT_FILE = 'pairings.json'
const DEFAULT_TTL_SEC = 300
const DEFAULT_MAX_PAIRINGS = 10
const DEFAULT_MAX_FAILURES = 5
const DEFAULT_LOCK_MS = 10 * 60 * 1000

function positiveInt(value, fallback) {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function asText(value) {
  if (typeof value === 'string') return value
  return value == null ? '' : String(value)
}

function iso(ms) {
  return new Date(ms).toISOString()
}

/** Constant-time compare for codes; different lengths are never equal. */
function codesEqual(left, right) {
  const a = Buffer.from(asText(left), 'utf8')
  const b = Buffer.from(asText(right), 'utf8')
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function normalizePairing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    name: asText(raw.name),
    platform: asText(raw.platform),
    transport: asText(raw.transport) || 'http',
    fingerprint: asText(raw.fingerprint),
    pairedAt: asText(raw.pairedAt),
    lastIp: asText(raw.lastIp),
  }
}

function pairedTime(pairing) {
  const time = Date.parse(pairing?.pairedAt)
  return Number.isFinite(time) ? time : 0
}

/**
 * One-shot pairing store for dsh-memory-sync 0.4.0.
 *
 * - Exactly one pending code exists at a time; issuing a new one invalidates
 *   the old code immediately.
 * - `check()` is single use: a correct code is consumed and the pairing is
 *   recorded + persisted. Wrong codes are counted per IP; reaching
 *   `maxFailures` locks that IP for `lockMs`. A locked IP is refused even with
 *   the correct code. Other IPs are unaffected.
 * - Only the pairing history is persisted (default `<stateDir>/pairings.json`);
 *   the pending code and the per-IP failure counters live in memory.
 * - All methods are synchronous so a caller can persist before answering.
 */
export function createPairingStore({
  stateDir,
  file,
  logger,
  now = () => Date.now(),
  ttlSec = DEFAULT_TTL_SEC,
  maxPairings = DEFAULT_MAX_PAIRINGS,
  maxFailures = DEFAULT_MAX_FAILURES,
  lockMs = DEFAULT_LOCK_MS,
} = {}) {
  if (!stateDir) throw new TypeError('createPairingStore: stateDir is required')

  const clock = typeof now === 'function' ? now : () => Date.now()
  const ttlMs = positiveInt(ttlSec, DEFAULT_TTL_SEC) * 1000
  const pairingLimit = positiveInt(maxPairings, DEFAULT_MAX_PAIRINGS)
  const failureLimit = positiveInt(maxFailures, DEFAULT_MAX_FAILURES)
  const lockDurationMs = Math.max(0, Math.floor(Number(lockMs) || 0))
  const stateFile =
    typeof file === 'string' && file.length > 0
      ? isAbsolute(file)
        ? file
        : join(stateDir, file)
      : join(stateDir, DEFAULT_FILE)

  const emit = (level, message) => {
    try {
      logger?.[level]?.(message)
    } catch {
      // A logger must never break pairing.
    }
  }

  function loadPairings() {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
      const items = Array.isArray(raw) ? raw : Array.isArray(raw?.pairings) ? raw.pairings : []
      return items
        .map(normalizePairing)
        .filter(Boolean)
        .sort((a, b) => pairedTime(b) - pairedTime(a))
        .slice(0, pairingLimit)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        emit('warn', `pairing file unreadable (${error?.code || error?.name || 'error'}); starting empty`)
      }
      return []
    }
  }

  let pending = null
  let pairings = loadPairings()
  const failures = new Map()

  function failureState(ip) {
    let state = failures.get(ip)
    if (!state) {
      state = { count: 0, lockedUntil: 0 }
      failures.set(ip, state)
    }
    return state
  }

  function persist() {
    const dir = dirname(stateFile)
    const tmp = join(dir, `.${process.pid}.${clock()}.pairings.tmp`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(tmp, JSON.stringify({ version: 1, pairings }, null, 2), 'utf8')
      renameSync(tmp, stateFile)
      return true
    } catch (error) {
      emit('warn', `pairing file not saved (${error?.code || error?.name || 'error'})`)
      try {
        rmSync(tmp, { force: true })
      } catch {
        // Best effort: a leftover temp file is harmless.
      }
      return false
    }
  }

  function recordPairing(input, at, ip) {
    const entry = {
      name: asText(input.name),
      platform: asText(input.platform),
      transport: asText(input.transport) || 'http',
      fingerprint: asText(input.fingerprint),
      pairedAt: iso(at),
      lastIp: asText(ip),
    }
    // A non-empty fingerprint identifies a device; only a name is remembered
    // otherwise, so re-pairing refreshes rather than duplicates the record.
    const index = entry.fingerprint
      ? pairings.findIndex((item) => item.fingerprint === entry.fingerprint)
      : pairings.findIndex((item) => item.name === entry.name)
    if (index >= 0) pairings.splice(index, 1)
    pairings.unshift(entry)
    if (pairings.length > pairingLimit) pairings = pairings.slice(0, pairingLimit)
    return { ...entry }
  }

  function newCode() {
    const at = clock()
    const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
    pending = { code, expiresAt: at + ttlMs }
    emit('info', `pairing code issued expiresAt=${iso(pending.expiresAt)}`)
    return { ok: true, code, expiresAt: iso(pending.expiresAt) }
  }

  function check(
    code,
    { ip = '', name = '', platform = '', transport = 'http', fingerprint = '' } = {},
  ) {
    const at = clock()
    const ipKey = asText(ip)

    if (!pending) {
      emit('warn', `pairing rejected ip=${ipKey} reason=invalid`)
      return { ok: false, error: 'invalid' }
    }
    if (pending.expiresAt <= at) {
      pending = null
      emit('warn', `pairing rejected ip=${ipKey} reason=expired`)
      return { ok: false, error: 'expired' }
    }

    const attempt = failureState(ipKey)
    if (attempt.lockedUntil > at) {
      emit('warn', `pairing rejected ip=${ipKey} reason=locked until=${iso(attempt.lockedUntil)}`)
      return { ok: false, error: 'locked' }
    }
    if (attempt.lockedUntil) {
      attempt.lockedUntil = 0
      attempt.count = 0
    }

    if (!codesEqual(code, pending.code)) {
      attempt.count += 1
      if (attempt.count >= failureLimit) {
        attempt.lockedUntil = at + lockDurationMs
        emit('warn', `pairing locked ip=${ipKey} until=${iso(attempt.lockedUntil)}`)
        return { ok: false, error: 'locked' }
      }
      emit('warn', `pairing rejected ip=${ipKey} reason=invalid`)
      return { ok: false, error: 'invalid' }
    }

    pending = null
    attempt.count = 0
    attempt.lockedUntil = 0
    const pairing = recordPairing({ name, platform, transport, fingerprint }, at, ipKey)
    persist()
    emit('info', `pairing accepted ip=${ipKey} name=${pairing.name} platform=${pairing.platform}`)
    return { ok: true, pairing }
  }

  function list() {
    return pairings.map((pairing) => ({ ...pairing }))
  }

  function status() {
    const at = clock()
    if (pending && pending.expiresAt <= at) pending = null
    let lockedUntil = 0
    for (const state of failures.values()) {
      if (state.lockedUntil > at && state.lockedUntil > lockedUntil) lockedUntil = state.lockedUntil
    }
    return {
      pending: pending ? { expiresAt: iso(pending.expiresAt) } : null,
      pairings: pairings.length,
      lockedUntil: lockedUntil ? iso(lockedUntil) : '',
    }
  }

  function clear() {
    pending = null
    pairings = []
    failures.clear()
    try {
      rmSync(stateFile, { force: true })
    } catch (error) {
      emit('warn', `pairing file not removed (${error?.code || error?.name || 'error'})`)
    }
    emit('info', 'pairing store cleared')
    return { ok: true }
  }

  return { newCode, check, list, status, clear }
}
