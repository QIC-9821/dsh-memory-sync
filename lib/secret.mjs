import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Env var consulted when config.secretEnv is empty. */
export const DEFAULT_SECRET_ENV = 'DSH_MEM_SECRET'

const SECRET_FILE_NAME = 'secret'

/** Secrets are compared/trimmed the same way everywhere; never log this value. */
function normalizeSecret(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/** Stable, non-reversible tag for a secret: sha256 hex, first 8 chars. */
export function fingerprint(secret) {
  const text = normalizeSecret(secret)
  if (!text) return ''
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)
}

/** 32 random bytes as lowercase hex (64 chars). */
export function generateSecret() {
  return randomBytes(32).toString('hex')
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Expand `~`, `~/x`, `~\x`, absolute and relative paths. */
function expandPath(value, baseDir) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return isAbsolute(text) ? resolve(text) : resolve(baseDir, text)
}

/**
 * Resolve the secret file path.
 *
 * Empty -> `<stateDir>/secret`. A path ending in a separator, or one that
 * already exists as a directory, gets `secret` appended (so the settings UI
 * can point at a folder instead of a file).
 */
export function expandSecretPath(value, stateDir) {
  const baseDir = expandPath(stateDir, process.cwd()) || process.cwd()
  const raw = value === undefined || value === null ? '' : String(value).trim()
  if (!raw) return join(baseDir, SECRET_FILE_NAME)

  const trailingSeparator = /[\\/]$/.test(raw)
  const target = expandPath(raw, baseDir)
  if (trailingSeparator || isDirectory(target)) return join(target, SECRET_FILE_NAME)
  return target
}

/** Read a secret file and trim surrounding whitespace. Missing/blank -> null. */
export function readSecretFile(file) {
  try {
    const text = String(readFileSync(file, 'utf8')).trim()
    return text || null
  } catch {
    return null
  }
}

/** Create the parent directory, write `secret\n`, best-effort chmod 0600. */
export function writeSecretFile(file, secret) {
  const text = String(secret ?? '')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${text}\n`, 'utf8')
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows and some filesystems do not support POSIX modes.
  }
  return file
}

/**
 * Resolve the shared secret.
 *
 * Priority: config.memSecret > env[config.secretEnv || DEFAULT_SECRET_ENV] >
 * the secret file > (generate=true) a freshly generated file > none.
 * The returned object never leaves the caller guessing which file/env was used.
 */
export function resolveSecret({ config = {}, env = process.env, stateDir, generate = false } = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const envName = String(cfg.secretEnv || '').trim() || DEFAULT_SECRET_ENV
  const file = expandSecretPath(cfg.secretFile ?? cfg.secretPath, stateDir)
  const base = { envName, file }

  const fromConfig = normalizeSecret(cfg.memSecret)
  if (fromConfig) {
    return { ...base, secret: fromConfig, source: 'config', fingerprint: fingerprint(fromConfig) }
  }

  const fromEnv = normalizeSecret(env?.[envName])
  if (fromEnv) {
    return { ...base, secret: fromEnv, source: 'env', fingerprint: fingerprint(fromEnv) }
  }

  const fromFile = readSecretFile(file)
  if (fromFile) {
    return { ...base, secret: fromFile, source: 'file', fingerprint: fingerprint(fromFile) }
  }

  if (generate === true) {
    const created = generateSecret()
    writeSecretFile(file, created)
    return { ...base, secret: created, source: 'generated', fingerprint: fingerprint(created) }
  }

  return { ...base, secret: '', source: 'none', fingerprint: '' }
}

/** Best-effort delete. Never throws; returns whether the file is gone. */
export function removeSecretFile(file) {
  try {
    rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

function samePath(left, right) {
  const a = resolve(String(left || ''))
  const b = resolve(String(right || ''))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function stateDirOf(config, env) {
  const configured = expandPath(config?.stateDir, process.cwd())
  if (configured) return configured
  const home = expandPath(env?.DSH_HOME, process.cwd())
  return join(home || join(homedir(), '.dsh'), 'memory-sync')
}

/**
 * A cached view over one config object.
 *
 * getConfig() is called on every read so the caller can hot-reload settings;
 * the parsed result is reused while that call returns the same object
 * reference, and invalidate() drops the cache explicitly.
 *
 * The methods are synchronous on purpose: index.js resolves the runtime config
 * on every tool call and must not await a file read there.
 */
export function createSecretStore({ getConfig, env = process.env, logger } = {}) {
  const readConfig = () => (typeof getConfig === 'function' ? getConfig() : {})
  const log = (level, message) => {
    try {
      logger?.[level]?.(message)
    } catch {
      // A broken logger must never break secret resolution.
    }
  }

  let cachedConfig = null
  let cached = null
  let hasCache = false
  let generationSuspended = false

  function resolveFor(config) {
    if (hasCache && config === cachedConfig) return cached
    const resolved = resolveSecret({
      config,
      env,
      stateDir: stateDirOf(config, env),
      generate: Boolean(config?.serve) && !generationSuspended,
    })
    cachedConfig = config
    cached = resolved
    hasCache = true
    if (resolved.source === 'generated') {
      log('info', `generated a new memSecret at ${resolved.file} (fingerprint ${resolved.fingerprint})`)
    }
    return resolved
  }

  function invalidate() {
    cachedConfig = null
    cached = null
    hasCache = false
  }

  function suspendGeneration() {
    generationSuspended = true
    invalidate()
  }

  function resumeGeneration() {
    generationSuspended = false
    invalidate()
  }

  function current() {
    return resolveFor(readConfig())
  }

  function status() {
    const resolved = current()
    return {
      configured: Boolean(resolved.secret),
      source: resolved.source,
      file: resolved.file,
      envName: resolved.envName,
      fingerprint: resolved.fingerprint,
    }
  }

  /**
   * Move the active secret to targetFile (or create one when none exists).
   *
   * When the value comes from config or env, copy it to the target file and
   * report `copied: true`. The effective source stays config/env until that
   * override is removed, so this lets the user prepare the file without
   * silently changing which source wins after a restart.
   */
  function migrate(targetFile) {
    const config = readConfig()
    const stateDir = stateDirOf(config, env)
    const resolved = resolveFor(config)
    const target = expandSecretPath(targetFile, stateDir)

    if (resolved.source === 'config' || resolved.source === 'env') {
      writeSecretFile(target, resolved.secret)
      const readback = readSecretFile(target)
      const copied = readback === resolved.secret
      if (copied) {
        log('info', `copied memSecret (source ${resolved.source}) to ${target} (fingerprint ${resolved.fingerprint})`)
      }
      return {
        ok: copied,
        file: target,
        secret: resolved.secret,
        source: resolved.source,
        copied: true,
        warning: '当前密钥仍来自 profile 配置或环境变量；已复制到文件，但删除那个来源并重载后才会以文件为准。',
      }
    }

    if (resolved.secret && samePath(resolved.file, target)) {
      return { ok: true, file: target, secret: resolved.secret, source: 'file' }
    }

    const secret = resolved.secret || generateSecret()
    writeSecretFile(target, secret)
    const readback = readSecretFile(target)
    const ok = readback === secret

    if (ok) {
      cachedConfig = config
      cached = {
        secret,
        source: 'file',
        file: target,
        envName: resolved.envName,
        fingerprint: fingerprint(secret),
      }
      hasCache = true
      log('info', `memSecret migrated to ${target} (fingerprint ${cached.fingerprint})`)
    }

    return { ok, file: target, secret, source: 'file' }
  }

  return { current, invalidate, status, migrate, suspendGeneration, resumeGeneration }
}
