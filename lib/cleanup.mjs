import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Remove the plugin's own state. The memory repository is deliberately never
 * touched: ~/.dsh/memories is the user's data, not plugin bookkeeping.
 */
export async function cleanupData({
  stateDir,
  secretInfo = {},
  includeBackups = false,
  pairing = null,
} = {}) {
  const removed = []
  const failed = []
  const targets = [
    join(stateDir, 'settings.json'),
    join(stateDir, 'last-run.json'),
    join(stateDir, 'sync.log'),
    join(stateDir, 'sync.log.1'),
    join(stateDir, 'pairings.json'),
    join(stateDir, 'warp-previous.json'),
    join(stateDir, 'lock'),
  ]
  if (secretInfo?.source === 'file' || secretInfo?.source === 'generated') {
    if (secretInfo.file) targets.push(secretInfo.file)
  }
  if (includeBackups) {
    targets.push(join(stateDir, 'snapshots'), join(stateDir, 'exports'))
  }

  for (const target of targets) {
    if (!target) continue
    try {
      if (!existsSync(target)) continue
      await rm(target, { recursive: true, force: true })
      removed.push(target)
    } catch (error) {
      failed.push({ path: target, error: String(error?.message || error) })
    }
  }

  try {
    pairing?.clear?.()
  } catch {
    // best effort
  }
  return { ok: failed.length === 0, removed, failed, stateDir }
}

/** Match the package's own dependency in a DSH profile (best effort). */
export function profileStillHasPlugin(profileDir) {
  if (!profileDir) return true
  try {
    const file = join(profileDir, 'package.json')
    if (!existsSync(file)) return false
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    const deps = {
      ...(pkg?.dependencies || {}),
      ...(pkg?.devDependencies || {}),
      ...(pkg?.optionalDependencies || {}),
    }
    if (deps['dsh-memory-sync'] || deps['@local/dsh-memory-sync']) return true
    const bundles = [
      ...(Array.isArray(pkg?.bundles) ? pkg.bundles : []),
      ...(Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []),
    ]
    return bundles.some((item) => String(item).includes('memory-sync'))
  } catch {
    return true
  }
}
