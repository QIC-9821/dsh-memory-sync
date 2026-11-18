import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  archivePathFor,
  createJanitor,
  parseMemoryText,
  runJanitor,
  serializeMemoryText,
} from '../lib/janitor.mjs'

const NOW = new Date('2026-11-18T00:00:00Z')

async function tempTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'memsync-janitor-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'))
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
  }
  return root
}

const sample = (title) => `[2026-01-01] ${title}\n内容\n\n§\n\n[2026-11-10] 新条目\n新内容\n`

test('parse and serialize keep preamble, entries and undated blocks', () => {
  const text = `# 文件头\n\n[2026-01-01] [summary: 摘要] 旧条目\n正文\n\n§\n\n无日期但保留的块\n\n§\n\n[2026-11-10] 新条目\n`
  const parsed = parseMemoryText(text)
  assert.equal(parsed.preamble, '# 文件头')
  assert.equal(parsed.entries.length, 3)
  assert.equal(parsed.entries[0].date, '2026-01-01')
  assert.equal(parsed.entries[1].date, null)
  assert.equal(parsed.entries[2].date, '2026-11-10')
  const roundtrip = serializeMemoryText(parsed.preamble, parsed.entries)
  assert.match(roundtrip, /# 文件头/)
  assert.match(roundtrip, /无日期但保留的块/)
  assert.equal(parseMemoryText(roundtrip).entries.length, 3)
})

test('dry run reports the plan without touching files', async () => {
  const root = await tempTree({ 'MEMORY.md': sample('很旧的记忆') })
  const before = await fs.readFile(join(root, 'MEMORY.md'), 'utf8')
  const result = runJanitor({
    repoPath: root,
    archiveAfterDays: 30,
    purgeAfterDays: 365,
    now: NOW,
    dryRun: true,
  })
  assert.equal(result.dryRun, true)
  assert.equal(result.archived, 1)
  assert.equal(result.purged, 0)
  assert.equal(await fs.readFile(join(root, 'MEMORY.md'), 'utf8'), before)
  await assert.rejects(fs.stat(join(root, 'MEMORY-archive.md')))
})

test('archives old entries, keeps protected and recent ones, writes a backup', async () => {
  const root = await tempTree({
    'MEMORY.md': `[2026-01-01] 很旧的记忆\n旧内容\n\n§\n\n[2026-11-10] 新记忆\n新内容\n\n§\n\n[2026-01-02] 勿删：重要旧事\n保留我\n`,
  })
  const result = runJanitor({ repoPath: root, archiveAfterDays: 30, purgeAfterDays: 365, now: NOW })
  assert.equal(result.archived, 1)
  assert.equal(result.skipped, 1)
  assert.equal(result.purged, 0)
  const main = await fs.readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.match(main, /新记忆/)
  assert.match(main, /勿删：重要旧事/)
  assert.doesNotMatch(main, /很旧的记忆/)
  const archived = await fs.readFile(join(root, 'MEMORY-archive.md'), 'utf8')
  assert.match(archived, /很旧的记忆/)
  const files = await fs.readdir(root)
  assert.ok(files.some((name) => name.startsWith('MEMORY.md.bak-janitor-')))
})

test('purges old archive entries and enforces the kept-entry limit', async () => {
  const root = await tempTree({
    'MEMORY.md': '[2026-11-10] 新记忆\n',
    'MEMORY-archive.md': [
      '[2024-01-01] 超旧条目',
      '[2026-01-01] 旧条目',
      '[2026-05-01] 中期条目',
      '[2026-08-01] 较新条目',
      '[2026-11-01] 最新条目',
    ].join('\n\n§\n\n') + '\n',
  })
  const byAge = runJanitor({ repoPath: root, archiveAfterDays: 30, purgeAfterDays: 365, now: NOW })
  assert.equal(byAge.purged, 1)
  assert.match(await fs.readFile(join(root, 'MEMORY-archive.md'), 'utf8'), /旧条目/)
  assert.doesNotMatch(await fs.readFile(join(root, 'MEMORY-archive.md'), 'utf8'), /超旧条目/)

  const limited = runJanitor({ repoPath: root, archiveAfterDays: 30, purgeAfterDays: 365, keepArchivedEntries: 2, now: NOW })
  assert.equal(limited.purged, 2)
  const left = await fs.readFile(join(root, 'MEMORY-archive.md'), 'utf8')
  assert.match(left, /最新条目/)
  assert.match(left, /较新条目/)
  assert.doesNotMatch(left, /旧条目/)
})

test('scope can be limited to projects', async () => {
  const root = await tempTree({
    'MEMORY.md': '[2026-01-01] 全局旧条目\n',
    'projects/abc/KEY.md': '[2026-01-01] 项目旧条目\n',
  })
  const globalOnly = runJanitor({ repoPath: root, scope: 'global', archiveAfterDays: 30, purgeAfterDays: 365, now: NOW })
  assert.equal(globalOnly.files, 1)
  assert.equal(globalOnly.archived, 1)
  assert.match(await fs.readFile(join(root, 'projects/abc/KEY.md'), 'utf8'), /项目旧条目/)

  const projectOnly = runJanitor({ repoPath: root, scope: 'project', archiveAfterDays: 30, purgeAfterDays: 365, now: NOW })
  assert.equal(projectOnly.files, 1)
  assert.equal(projectOnly.archived, 1)
  assert.match(await fs.readFile(join(root, 'projects/abc/KEY-archive.md'), 'utf8'), /项目旧条目/)
})

test('createJanitor exposes status and runs with the current config', async () => {
  const root = await tempTree({ 'USER.md': '[2026-01-01] 旧偏好\n' })
  const janitor = createJanitor({
    getConfig: () => ({
      repoPath: root,
      janitorEnabled: true,
      janitorIntervalHours: 24,
      archiveAfterDays: 30,
      purgeAfterDays: 365,
      keepArchivedEntries: 300,
      janitorScope: 'global',
      janitorProtectKeywords: '',
      janitorSyncAfter: false,
    }),
    stateDir: () => join(root, 'state'),
  })
  assert.equal(janitor.status().enabled, true)
  const result = await janitor.run({ now: NOW })
  assert.equal(result.archived, 1)
  assert.ok(archivePathFor(join(root, 'USER.md')).endsWith('USER-archive.md'))
})
