import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  DEFAULT_SECRET_ENV,
  createSecretStore,
  expandSecretPath,
  fingerprint,
  generateSecret,
  readSecretFile,
  removeSecretFile,
  resolveSecret,
  writeSecretFile,
} from '../lib/secret.mjs'

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-sync-secret-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

test('DEFAULT_SECRET_ENV is the shared env var name', () => {
  assert.equal(DEFAULT_SECRET_ENV, 'DSH_MEM_SECRET')
})

test('fingerprint is a stable sha256 prefix, empty for blanks', () => {
  assert.equal(fingerprint(''), '')
  assert.equal(fingerprint('   '), '')
  assert.equal(fingerprint(undefined), '')
  assert.equal(fingerprint(null), '')

  const expected = createHash('sha256').update('token-value', 'utf8').digest('hex').slice(0, 8)
  assert.match(fingerprint('token-value'), /^[0-9a-f]{8}$/)
  assert.equal(fingerprint('token-value'), expected)
  assert.equal(fingerprint('  token-value  '), expected)
  assert.notEqual(fingerprint('token-value'), fingerprint('other-value'))
})

test('generateSecret returns 64 random hex chars', () => {
  const first = generateSecret()
  const second = generateSecret()
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.match(second, /^[0-9a-f]{64}$/)
  assert.notEqual(first, second)
})

test('expandSecretPath handles empty, relative, absolute, home and directories', async (t) => {
  const root = await tempRoot(t)

  assert.equal(expandSecretPath('', root), join(root, 'secret'))
  assert.equal(expandSecretPath(null, root), join(root, 'secret'))
  assert.equal(expandSecretPath('   ', root), join(root, 'secret'))

  assert.equal(expandSecretPath('nested/token', root), join(root, 'nested', 'token'))
  assert.equal(expandSecretPath('~/token', root), join(homedir(), 'token'))
  assert.equal(expandSecretPath('~', root), join(homedir(), 'secret'))

  const absolute = join(root, 'abs-token')
  assert.equal(expandSecretPath(absolute, root), absolute)

  const directory = join(root, 'dir-token')
  await mkdir(directory)
  assert.equal(expandSecretPath(directory, root), join(directory, 'secret'))
  assert.equal(expandSecretPath(`${join(root, 'missing')}${sep}`, root), join(root, 'missing', 'secret'))

  const plainFile = join(root, 'file-token')
  await writeFile(plainFile, 'x')
  assert.equal(expandSecretPath(plainFile, root), plainFile)
})

test('writeSecretFile creates parents, appends a newline and reads back', async (t) => {
  const root = await tempRoot(t)
  const file = join(root, 'deep', 'nested', 'secret')

  assert.equal(await writeSecretFile(file, 'token-value'), file)
  assert.equal(await readFile(file, 'utf8'), 'token-value\n')
  assert.equal(await readSecretFile(file), 'token-value')

  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
})

test('readSecretFile returns null for missing and blank files', async (t) => {
  const root = await tempRoot(t)
  assert.equal(await readSecretFile(join(root, 'missing')), null)

  const blank = join(root, 'blank')
  await writeFile(blank, '  \n\t\r\n')
  assert.equal(await readSecretFile(blank), null)
})

test('resolveSecret prefers config over env over the secret file', async (t) => {
  const root = await tempRoot(t)
  const file = join(root, 'secret')
  await writeSecretFile(file, 'file-value')

  const fromConfig = await resolveSecret({
    config: { memSecret: 'config-value' },
    env: { DSH_MEM_SECRET: 'env-value' },
    stateDir: root,
  })
  assert.deepEqual(
    { secret: fromConfig.secret, source: fromConfig.source, file: fromConfig.file },
    { secret: 'config-value', source: 'config', file },
  )
  assert.equal(fromConfig.envName, DEFAULT_SECRET_ENV)
  assert.equal(fromConfig.fingerprint, fingerprint('config-value'))

  const fromEnv = await resolveSecret({
    config: {},
    env: { DSH_MEM_SECRET: 'env-value' },
    stateDir: root,
  })
  assert.equal(fromEnv.secret, 'env-value')
  assert.equal(fromEnv.source, 'env')

  const fromFile = await resolveSecret({ config: {}, env: {}, stateDir: root })
  assert.equal(fromFile.secret, 'file-value')
  assert.equal(fromFile.source, 'file')
  assert.equal(fromFile.fingerprint, fingerprint('file-value'))
})

test('resolveSecret treats empty strings as unset', async (t) => {
  const root = await tempRoot(t)
  await writeSecretFile(join(root, 'secret'), 'file-value')

  const resolved = await resolveSecret({
    config: { memSecret: '   ' },
    env: { DSH_MEM_SECRET: '' },
    stateDir: root,
  })
  assert.equal(resolved.source, 'file')
  assert.equal(resolved.secret, 'file-value')

  const none = await resolveSecret({ config: { memSecret: '' }, env: {}, stateDir: await tempRoot(t) })
  assert.equal(none.source, 'none')
  assert.equal(none.secret, '')
  assert.equal(none.fingerprint, '')
})

test('resolveSecret honours config.secretEnv and config.secretFile', async (t) => {
  const root = await tempRoot(t)

  const fromCustomEnv = await resolveSecret({
    config: { secretEnv: 'CUSTOM_MEM_SECRET' },
    env: { CUSTOM_MEM_SECRET: 'custom-value', DSH_MEM_SECRET: 'default-value' },
    stateDir: root,
  })
  assert.equal(fromCustomEnv.source, 'env')
  assert.equal(fromCustomEnv.secret, 'custom-value')
  assert.equal(fromCustomEnv.envName, 'CUSTOM_MEM_SECRET')

  const customFile = await resolveSecret({
    config: { secretFile: 'keys/token' },
    env: {},
    stateDir: root,
  })
  assert.equal(customFile.file, join(root, 'keys', 'token'))
  assert.equal(customFile.source, 'none')
})

test('resolveSecret only generates when asked, and writes a readable file', async (t) => {
  const root = await tempRoot(t)
  const file = join(root, 'secret')

  const off = await resolveSecret({ config: {}, env: {}, stateDir: root })
  assert.equal(off.source, 'none')
  assert.equal(await readSecretFile(file), null)

  const on = await resolveSecret({ config: {}, env: {}, stateDir: root, generate: true })
  assert.equal(on.source, 'generated')
  assert.equal(on.secret, await readSecretFile(file))
  assert.equal(on.fingerprint, fingerprint(on.secret))
  assert.equal(on.file, file)
})

test('removeSecretFile reports success and tolerates a missing file', async (t) => {
  const root = await tempRoot(t)
  const file = join(root, 'secret')
  await writeSecretFile(file, 'bye')

  assert.equal(await removeSecretFile(file), true)
  assert.equal(await readSecretFile(file), null)
  assert.equal(await removeSecretFile(file), true)

  const directory = join(root, 'not-a-file')
  await mkdir(directory)
  assert.equal(await removeSecretFile(directory), false)
})

test('store caches by config object reference and invalidate() clears it', async (t) => {
  const root = await tempRoot(t)
  const config = { stateDir: root, memSecret: 'first-value' }
  const store = createSecretStore({ getConfig: () => config, env: {} })

  const first = await store.current()
  assert.equal(first.secret, 'first-value')
  assert.equal(first.source, 'config')

  config.memSecret = 'second-value'
  assert.equal((await store.current()).secret, 'first-value')

  store.invalidate()
  assert.equal((await store.current()).secret, 'second-value')
})

test('store re-resolves when getConfig returns a new object', async (t) => {
  const root = await tempRoot(t)
  let config = { stateDir: root, memSecret: 'first-value' }
  const store = createSecretStore({ getConfig: () => config, env: {} })

  assert.equal((await store.current()).secret, 'first-value')
  config = { stateDir: root, memSecret: 'second-value' }
  assert.equal((await store.current()).secret, 'second-value')
})

test('status reports source metadata and never the secret value', async (t) => {
  const root = await tempRoot(t)
  const secret = 'store-secret-value'
  const store = createSecretStore({
    getConfig: () => ({ stateDir: root, memSecret: secret }),
    env: {},
  })

  const status = await store.status()
  assert.deepEqual(status, {
    configured: true,
    source: 'config',
    file: join(root, 'secret'),
    envName: DEFAULT_SECRET_ENV,
    fingerprint: fingerprint(secret),
  })
  assert.equal('secret' in status, false)
  assert.equal(JSON.stringify(status).includes(secret), false)
})

test('store generates only when serve is true', async (t) => {
  const root = await tempRoot(t)
  const logs = []
  const logger = {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    error: (message) => logs.push(message),
  }

  const quietRoot = join(root, 'quiet')
  await mkdir(quietRoot)
  const quietConfig = { stateDir: quietRoot, serve: false }
  const quietStore = createSecretStore({
    getConfig: () => quietConfig,
    env: {},
    logger,
  })
  const quiet = await quietStore.current()
  assert.equal(quiet.source, 'none')
  assert.equal(quiet.secret, '')
  assert.equal(await readSecretFile(join(quietRoot, 'secret')), null)

  const serveRoot = join(root, 'serving')
  await mkdir(serveRoot)
  const serveConfig = { stateDir: serveRoot, serve: true }
  const servingStore = createSecretStore({
    getConfig: () => serveConfig,
    env: {},
    logger,
  })
  const generated = await servingStore.current()
  assert.equal(generated.source, 'generated')
  assert.equal(generated.secret, await readSecretFile(join(serveRoot, 'secret')))
  assert.equal(generated.fingerprint, fingerprint(generated.secret))

  const status = await servingStore.status()
  assert.equal(status.configured, true)
  assert.equal(status.source, 'generated')

  assert.ok(logs.some((line) => line.includes('generated')))
  for (const line of logs) {
    assert.equal(line.includes(generated.secret), false)
  }
})

test('migrate copies the secret to a new file and keeps the old one', async (t) => {
  const root = await tempRoot(t)
  const currentFile = join(root, 'secret')
  await writeSecretFile(currentFile, 'migrate-me')
  const config = { stateDir: root }
  const store = createSecretStore({ getConfig: () => config, env: {} })

  const result = await store.migrate(join('backup', 'secret'))
  assert.deepEqual(
    { ok: result.ok, source: result.source, secret: result.secret, file: result.file },
    { ok: true, source: 'file', secret: 'migrate-me', file: join(root, 'backup', 'secret') },
  )
  assert.equal(await readSecretFile(result.file), 'migrate-me')
  assert.equal(await readSecretFile(currentFile), 'migrate-me')

  const status = await store.status()
  assert.equal(status.configured, true)
  assert.equal(status.source, 'file')
  assert.equal(status.file, result.file)
  assert.equal(status.fingerprint, fingerprint('migrate-me'))
})

test('migrate returns ok without rewriting when the target is the current file', async (t) => {
  const root = await tempRoot(t)
  const file = join(root, 'secret')
  await writeSecretFile(file, 'stay-put')
  const store = createSecretStore({ getConfig: () => ({ stateDir: root }), env: {} })

  const result = await store.migrate(file)
  assert.deepEqual(
    { ok: result.ok, source: result.source, secret: result.secret, file: result.file },
    { ok: true, source: 'file', secret: 'stay-put', file },
  )
  assert.equal(await readFile(file, 'utf8'), 'stay-put\n')
})

test('migrate copies config and env sources to a file without changing the active source', async (t) => {
  const root = await tempRoot(t)

  const configStore = createSecretStore({
    getConfig: () => ({ stateDir: root, memSecret: 'from-config' }),
    env: {},
  })
  const configResult = configStore.migrate(join(root, 'copy'))
  assert.equal(configResult.ok, true)
  assert.equal(configResult.copied, true)
  assert.equal(configResult.source, 'config')
  assert.match(configResult.warning, /profile|配置|环境变量/)
  assert.equal(await readSecretFile(join(root, 'copy')), 'from-config')
  assert.equal(configStore.status().source, 'config')

  const envStore = createSecretStore({
    getConfig: () => ({ stateDir: root }),
    env: { DSH_MEM_SECRET: 'from-env' },
  })
  const envResult = envStore.migrate(join(root, 'copy-2'))
  assert.equal(envResult.ok, true)
  assert.equal(envResult.copied, true)
  assert.equal(envResult.source, 'env')
  assert.equal(await readSecretFile(join(root, 'copy-2')), 'from-env')
  assert.equal(envStore.status().source, 'env')
})

test('migrate generates a secret when none exists', async (t) => {
  const root = await tempRoot(t)
  const store = createSecretStore({
    getConfig: () => ({ stateDir: root, serve: false }),
    env: {},
  })

  const result = await store.migrate('generated/secret')
  assert.equal(result.ok, true)
  assert.equal(result.source, 'file')
  assert.equal(result.file, join(root, 'generated', 'secret'))
  assert.match(result.secret, /^[0-9a-f]{64}$/)
  assert.equal(await readSecretFile(result.file), result.secret)
})

test('suspending generation keeps cleanup from recreating the secret file', async (t) => {
  const root = await tempRoot(t)
  const config = { stateDir: root, serve: true }
  const store = createSecretStore({ getConfig: () => config, env: {} })

  assert.equal(store.current().source, 'generated')
  store.suspendGeneration()
  await removeSecretFile(join(root, 'secret'))
  const suspended = store.current()
  assert.equal(suspended.source, 'none')
  assert.equal(suspended.secret, '')
  assert.equal(await readSecretFile(join(root, 'secret')), null)

  store.invalidate()
  assert.equal(store.current().source, 'none')
  store.resumeGeneration()
  assert.equal(store.current().source, 'generated')
})
