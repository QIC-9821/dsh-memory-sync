import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { readJson, writeJsonAtomic } from './state.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const ENTRY_DATE = /^\[(\d{4}-\d{2}-\d{2})\]/
const SEPARATOR = '§'
const BACKUP_KEEP = 3

const DEFAULT_PROTECT = ['勿删', '待确认', '勿动', '不要归档', '不要删除']

/**
 * Split a memory file into a preamble (anything before the first entry) and
 * dated entries. Entries are separated by a line that contains only `§`.
 * A block without a leading `[YYYY-MM-DD]` date is kept as an entry with
 * `date = null` and is never archived or purged by the janitor.
 */
export function parseMemoryText(text = '') {
  const normalized = String(text).replace(/\r\n/g, '\n')
  const chunks = normalized.split(/\n[ \t]*§[ \t]*\n/)
  const preambleParts = []
  const entries = []
  for (const raw of chunks) {
    const chunk = raw.replace(/^\s+|\s+$/g, '')
    if (!chunk) continue
    const lines = chunk.split('\n')
    const firstDateIndex = lines.findIndex((line) => ENTRY_DATE.test(line.trim()))
    if (firstDateIndex === -1) {
      // Anything before the first dated entry is file-level preamble. Later
      // undated blocks are still kept verbatim, but flagged so they are safe
      // from archiving/purging.
      if (entries.length === 0) preambleParts.push(chunk)
      else entries.push({ date: null, text: chunk })
      continue
    }
    const before = lines.slice(0, firstDateIndex).join('\n').trim()
    if (before) {
      if (entries.length === 0) preambleParts.push(before)
      else entries.push({ date: null, text: before })
    }
    const body = lines.slice(firstDateIndex).join('\n').trim()
    entries.push({ date: ENTRY_DATE.exec(body)[1], text: body })
  }
  return { preamble: preambleParts.join('\n\n'), entries }
}

/** Render a memory file back to the canonical on-disk shape. */
export function serializeMemoryText(preamble, entries) {
  const parts = []
  if (String(preamble || '').trim()) parts.push(String(preamble).trim())
  for (const entry of entries || []) {
    if (entry?.text && String(entry.text).trim()) parts.push(String(entry.text).trim())
  }
  if (!parts.length) return ''
  return `${parts.join(`\n\n${SEPARATOR}\n\n`)}\n`
}

export function archivePathFor(file) {
  const dir = dirname(file)
  const name = basename(file).replace(/\.md$/i, '')
  return join(dir, `${name}-archive.md`)
}

function parseKeywords(value) {
  const list = String(value || '')
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return list.length ? list : DEFAULT_PROTECT
}

function isProtected(entry, keywords) {
  const text = String(entry?.text || '')
  return keywords.some((word) => text.includes(word))
}

function cutoffDate(now, days) {
  return new Date(now.getTime() - Math.max(0, days) * DAY_MS).toISOString().slice(0, 10)
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.bak-janitor-${stamp}`
  if (existsSync(file)) writeFileSync(backup, readFileSync(file), 'utf8')
  pruneBackups(file)
  return backup
}

function pruneBackups(file) {
  try {
    const dir = dirname(file)
    const prefix = `${basename(file)}.bak-janitor-`
    const items = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const item of items.slice(BACKUP_KEEP)) {
      rmSync(join(dir, item.name), { force: true })
    }
  } catch {
    // best effort
  }
}

function writeTextAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.janitor.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** Candidate memory files for a scope. Missing files are simply skipped. */
export function collectMemoryFiles(repoPath, scope = 'all') {
  const globalFiles = ['MEMORY.md', 'USER.md', 'KEY.md'].map((name) => join(repoPath, name))
  const projectRoot = join(repoPath, 'projects')
  const projectFiles = []
  if (scope !== 'global') {
    try {
      for (const dir of readdirSync(projectRoot)) {
        const full = join(projectRoot, dir)
        try {
          if (!statSync(full).isDirectory()) continue
        } catch {
          continue
        }
        for (const name of ['MEMORY.md', 'USER.md', 'KEY.md']) {
          projectFiles.push(join(full, name))
        }
      }
    } catch {
      // no projects directory yet
    }
  }
  const candidates = scope === 'project' ? projectFiles : scope === 'global' ? globalFiles : [...globalFiles, ...projectFiles]
  return candidates.filter((file) => existsSync(file))
}

/**
 * One pass over the memory tree.
 *
 *  archive: move entries older than `archiveAfterDays` from a main file into
 *           `<base>-archive.md` (appended, order preserved).
 *  purge:   delete entries in an archive file that are older than
 *           `purgeAfterDays`, or that fall outside the newest
 *           `keepArchivedEntries` entries.
 *
 * Entries containing a protect keyword are never moved or deleted.
 */
export function runJanitor({
  repoPath,
  scope = 'all',
  archiveAfterDays = 30,
  purgeAfterDays = 90,
  keepArchivedEntries = 300,
  protectKeywords = DEFAULT_PROTECT,
  dryRun = false,
  now = new Date(),
} = {}) {
  const startedAt = new Date(now).toISOString()
  const keywords = parseKeywords(protectKeywords)
  const archiveCutoff = cutoffDate(new Date(now), archiveAfterDays)
  const purgeCutoff = cutoffDate(new Date(now), purgeAfterDays)
  const files = collectMemoryFiles(repoPath, scope)
  const details = []
  let archived = 0
  let purged = 0
  let skipped = 0
  const errors = []

  for (const file of files) {
    const record = {
      file,
      archived: 0,
      purged: 0,
      skipped: 0,
      bytesBefore: fileSize(file),
      bytesAfter: fileSize(file),
      backup: '',
      error: '',
    }
    try {
      const mainText = readText(file)
      const main = parseMemoryText(mainText)
      const archiveFile = archivePathFor(file)
      const archive = parseMemoryText(readText(archiveFile))

      const toArchive = []
      const keep = []
      for (const entry of main.entries) {
        if (!entry.date) {
          keep.push(entry)
          continue
        }
        if (entry.date > archiveCutoff) {
          keep.push(entry)
          continue
        }
        if (isProtected(entry, keywords)) {
          record.skipped += 1
          keep.push(entry)
          continue
        }
        toArchive.push(entry)
      }

      // Archive entries = previous content + newly moved entries.
      const all = [...archive.entries, ...toArchive]
      const dated = all.filter((entry) => entry.date)
      const datedAsc = [...dated].sort((a, b) => String(a.date).localeCompare(String(b.date)))
      const keepSet = keepArchivedEntries > 0
        ? new Set(datedAsc.slice(Math.max(0, datedAsc.length - keepArchivedEntries)))
        : null

      const nextArchive = []
      for (const entry of all) {
        if (!entry.date) {
          nextArchive.push(entry)
          continue
        }
        const tooOld = purgeAfterDays > 0 && entry.date <= purgeCutoff
        const overLimit = keepSet ? !keepSet.has(entry) : false
        if (tooOld || overLimit) {
          if (isProtected(entry, keywords)) {
            record.skipped += 1
            nextArchive.push(entry)
          } else {
            record.purged += 1
          }
          continue
        }
        nextArchive.push(entry)
      }

      record.archived = toArchive.length
      const changed = toArchive.length > 0 || record.purged > 0
      if (!changed) {
        details.push(record)
        continue
      }

      if (dryRun) {
        record.bytesAfter = record.bytesBefore
        details.push(record)
        archived += record.archived
        purged += record.purged
        skipped += record.skipped
        continue
      }

      const backup = backupFile(file)
      record.backup = backup
      writeTextAtomic(file, serializeMemoryText(main.preamble, keep))
      writeTextAtomic(archiveFile, serializeMemoryText(archive.preamble || '', nextArchive))
      record.bytesAfter = fileSize(file)
      details.push(record)
      archived += record.archived
      purged += record.purged
      skipped += record.skipped
    } catch (error) {
      record.error = String(error?.message || error)
      errors.push(record.error)
      details.push(record)
    }
  }

  return {
    ok: errors.length === 0,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    repoPath,
    scope,
    archiveAfterDays,
    purgeAfterDays,
    keepArchivedEntries,
    files: files.length,
    archived,
    purged,
    skipped,
    errors,
    details,
  }
}

/** Parse the stored janitor state (last run and its summary). Never throws. */
export async function readJanitorState(stateDir) {
  return (await readJson(join(stateDir, 'janitor-state.json'), {})) || {}
}

/** Persist a compact summary of the last run for the settings page. */
export async function writeJanitorState(stateDir, value = {}) {
  try {
    await writeJsonAtomic(join(stateDir, 'janitor-state.json'), value)
  } catch {
    // state is only a convenience; failing to persist it must not fail a run
  }
}

/**
 * Background runner used by the plugin: checks hourly whether the configured
 * interval elapsed, then performs one pass. Manual runs go through `run()`.
 */
export function createJanitor({ getConfig, logger = null, stateDir = () => '', onCompleted = null }) {
  let timer = null
  let running = false
  let lastResult = null
  let lastRunAt = ''

  // Restore the last run summary after a reload so the settings page keeps
  // showing when the previous pass happened and does not report "never".
  void (async () => {
    const stored = await readJanitorState(stateDir())
    if (!stored?.runAt) return
    lastRunAt = stored.runAt
    if (!lastResult) {
      lastResult = {
        ok: true,
        dryRun: false,
        finishedAt: stored.runAt,
        archived: Number(stored.archived) || 0,
        purged: Number(stored.purged) || 0,
        skipped: Number(stored.skipped) || 0,
        files: Number(stored.files) || 0,
        errors: Array.isArray(stored.errors) ? stored.errors : [],
      }
    }
  })()

  function cfg() {
    return getConfig()
  }

  function status() {
    const current = cfg()
    const intervalHours = Number(current?.janitorIntervalHours) || 0
    const nextDueAt = lastRunAt && intervalHours > 0
      ? new Date(new Date(lastRunAt).getTime() + intervalHours * 3600 * 1000).toISOString()
      : ''
    return {
      enabled: Boolean(current?.janitorEnabled),
      intervalHours,
      archiveAfterDays: Number(current?.archiveAfterDays) || 0,
      purgeAfterDays: Number(current?.purgeAfterDays) || 0,
      keepArchivedEntries: Number(current?.keepArchivedEntries) || 0,
      scope: current?.janitorScope || 'project',
      protectKeywords: current?.janitorProtectKeywords || '',
      syncAfter: Boolean(current?.janitorSyncAfter),
      running,
      lastRunAt,
      lastResult,
      nextDueAt,
    }
  }

  async function run(options = {}) {
    const current = cfg()
    if (running) throw new Error('janitor is already running')
    running = true
    try {
      const result = runJanitor({
        repoPath: current?.repoPath,
        scope: current?.janitorScope || 'project',
        archiveAfterDays: current?.archiveAfterDays == null ? 7 : Number(current.archiveAfterDays),
        purgeAfterDays: current?.purgeAfterDays == null ? 90 : Number(current.purgeAfterDays),
        keepArchivedEntries: current?.keepArchivedEntries == null ? 300 : Number(current.keepArchivedEntries),
        protectKeywords: current?.janitorProtectKeywords || '',
        dryRun: options?.dryRun === true,
        now: options?.now || new Date(),
      })
      lastResult = result
      if (!result.dryRun) {
        lastRunAt = result.finishedAt
        await writeJanitorState(stateDir(), {
          runAt: lastRunAt,
          archived: result.archived,
          purged: result.purged,
          skipped: result.skipped,
          files: result.files,
          errors: result.errors,
        })
        logger?.info?.(
          `janitor: archived ${result.archived}, purged ${result.purged}, skipped ${result.skipped}, files ${result.files}`,
        )
      }
      if (typeof onCompleted === 'function') {
        await Promise.resolve(onCompleted(result)).catch(() => {})
      }
      return result
    } finally {
      running = false
    }
  }

  async function checkDue() {
    const current = cfg()
    if (!current?.janitorEnabled) return
    const intervalHours = Number(current?.janitorIntervalHours) || 0
    if (intervalHours <= 0) return
    const stored = await readJanitorState(stateDir())
    const lastAt = lastRunAt || stored?.runAt || ''
    const due = !lastAt || Date.now() - new Date(lastAt).getTime() >= intervalHours * 3600 * 1000
    if (!due) return
    try {
      await run({ dryRun: false })
    } catch (error) {
      logger?.warn?.(`janitor failed: ${error?.message || error}`)
    }
  }

  function reconfigure() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    const current = cfg()
    if (!current?.janitorEnabled || Number(current?.janitorIntervalHours) <= 0) return
    timer = setInterval(() => {
      void checkDue()
    }, 10 * 60 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    void checkDue()
  }

  function dispose() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { run, status, reconfigure, dispose, checkDue }
}
