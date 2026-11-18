# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-11-18

### Added

- Memory janitor in the settings page ("记忆归档与清理"): moves entries older
  than `archiveAfterDays` from `MEMORY.md` / `USER.md` / `KEY.md` into
  `*-archive.md`, then deletes archived entries older than `purgeAfterDays` (or
  beyond `keepArchivedEntries`, keeping the newest by date). Manual preview and
  run buttons go through `POST /memory-sync/api/janitor/run`; no agent tool is
  added, so the prompt and tool table do not grow.
- `janitorEnabled` (`true`), `janitorIntervalHours` (`24`), `archiveAfterDays`
  (`7`), `purgeAfterDays` (`90`), `keepArchivedEntries` (`300`),
  `janitorProtectKeywords`, `janitorScope` (`project`) and `janitorSyncAfter`
  in the desktop settings page and the Android `Config` form.
- Protection keywords skip entries containing them; every write is backed up as
  `<file>.bak-janitor-<timestamp>` first; a dry run only reports what would move.
- After a non-dry run that archived or purged entries, the plugin pushes one
  snapshot (HTTP transport) so a tablet holding older files cannot write the
  removed entries back.
- The janitor state (`lastRunAt`, the last result counts, `nextDueAt`) is
  restored after a plugin reload and exposed in the settings state.

### Changed

- `janitorScope` defaults to `project`, so global `MEMORY.md` / `USER.md` are
  left untouched unless the user selects `all` or `global`.

## [0.4.0] - 2026-11-18

### Added

- Secret lifecycle: `secretFile` (default `<stateDir>/secret`, supports `~` and
  relative paths) and `secretEnv` (default `DSH_MEM_SECRET`). Resolution order is
  explicit `memSecret` > env > file > generated. A 32-byte hex secret is
  generated only when `serve` is on and no other source exists; files are written
  with mode 0600 where the platform supports it.
- Secret fingerprint: `/mem/ping` and the settings state expose a SHA-256
  prefix only. `POST /memory-sync/api/secret/migrate` moves the secret to a new
  file. A config/env source is copied to that file instead of rejected; the
  active source stays config/env until that override is removed.
- Pairing: `POST /mem/pair` (unauthenticated, but requires a 6-digit code),
  one-use codes with a 300-second TTL, per-IP failure counting and a 10-minute
  lock after 5 failures. Paired peers are recorded with name, platform,
  transport, timestamp and secret fingerprint (up to 10).
- Remote access: `remoteMode=off|tailscale|ssh`. Tailscale binds the tailnet
  IPv4 when it is online and reports a `remoteUrl`; SSH mode can keep a reverse
  tunnel (`ssh -N -R`) alive with 5/10/30/60-second backoff. With
  `warpCoexist`, WARP is moved to DNS-only (`doh`) while Tailscale mode is on;
  the previous mode is restored when remote mode leaves Tailscale.
- Settings page cards for remote access and secret/pairing, plus a "delete local
  data" action (`POST /memory-sync/api/cleanup`) with an optional backup purge.
- `purgeOnUninstall` (default `false`, experimental): on dispose, clean local
  data only when the profile no longer lists this plugin.

### Changed

- HTTP protocol is now version 4; `/mem/ping` reports the fingerprint without
  the secret.
- `/mem/*` authentication uses a constant-time comparison.
- The settings state now includes `secret`, `remote` and `pairing` blocks; the
  local API adds `secret/migrate`, `pair/new`, `pair/accept`, `pairings`,
  `pair/clear`, `remote/refresh` and `cleanup`.
- Cleanup stops the server/tunnel/timers first, removes settings, run state,
  logs, locks, pairings and a file/generated secret, and keeps snapshots,
  exports and the memory directory unless `includeBackups=true`.
- `memory_sync` tool schema is unchanged; token behavior from 0.3.1 still
  applies.

### Security

- Secrets are never echoed by the settings API or written to logs; only the
  source and fingerprint are shown.
- The shared secret equals write access. Pairing returns the secret over HTTP,
  so use it only on a LAN, Tailscale, or an SSH tunnel.

## [0.3.1] - 2026-11-18

### Added

- `toolsMode` (`auto` / `always` / `off`, default `auto`) and `toolsScope`
  (`core` / `full`, default `core`) in the desktop settings page and the Android
  `Config` form.
- "工具（省 token）" card: live registration/visibility state, the reason, a
  character/token estimate, and a 10-minute wake button.
- `POST /memory-sync/api/tools/wake` (`{minutes}` 1–120) and a `tools` block in
  `GET /memory-sync/api/state`.
- Per-user-turn visibility freezing on `agent/inbox/claimed`, so the tool never
  disappears in the middle of a turn and the prompt cache stays stable.

### Changed

- `memory_sync` is now scoped: `core` advertises only `run` / `status` (521
  characters, about 145 tokens); `full` adds the snapshot/offline actions (989
  characters, about 275 tokens). Before this release every session carried
  1635 characters, about 450 tokens, each step.
- In `auto` mode the tool is not registered at all without `repoPath`, and it is
  hidden while the previous sync is healthy (from the prompt *and* dispatch).
  It appears after a failed/unknown run, while a sync is running, or during a
  wake window. `always` behaves like the old unconditional registration; `off`
  registers nothing.
- Tool results are compact JSON with bounded summaries and errors (status is
  about 110–150 characters instead of 799–1109).

## [0.3.0] - 2026-11-08

### Added

- Desktop settings page in the system settings sidebar: test peer, manual
  both/push/pull, transport switch, custom rules, offline export/import, logs,
  snapshot restore.
- Android `Config` schema form (schemastery bundled into the tablet zip) under
  Settings → Extensions → Installed plugins.
- Custom rules: `intervalSendMinutes` (scheduled send), `conflict`
  (`local`/`peer`), `replyOnReceive` (one reply snapshot after applying),
  plus the existing `runOnStartup` / `autoApply`.
- Offline transport: export/import portable `.json.gz` snapshots with dry-run
  preview and backups; new `memory_sync` actions `export` / `import`.
- `/memory-sync/api/*` settings API, local/same-origin only; secrets are never
  echoed. `/mem/ping` reports protocol version 3 and a read-only rules summary.
- Manual pushes send `x-mem-apply: manual` so they merge even when the peer
  keeps `autoApply` off; reply pushes add `x-mem-no-reply: 1` to stop loops.
- `scripts/build-tablet.mjs` + verification: esbuild bundle, root
  `package.json`, no BOM, no web client, `Config` present.

### Changed

- `runHttpSync` takes a direction (`both` / `push` / `pull`); manual pushes can
  bypass the peer's automatic-apply policy.
- Applying snapshots now uses the receiver's `conflict` preference instead of
  the old hard-coded protected list; every overwrite is backed up.
- HTTP status no longer probes git; git inspection only runs in SSH mode.
- `peerPort` is configurable for SSH.

## [0.2.0] - 2026-11-08

### Added

- HTTP snapshot transport for Android tablets: push/pull, snapshot retention,
  restore and a hub server with `x-mem-secret` auth.
- `keepSnapshots` / `maxSnapshotMB` retention limits and `.bak-snapshot`
  backups on overwrite.

## [0.1.2] - 2026-11-06

### Added

- README demo screenshots: what `memory_sync status` returns after a run, and
  what the three-phase startup log looks like.

## [0.1.1] - 2026-11-05

### Changed

- Repository renamed from `QIC-9821/dsh` to `QIC-9821/dsh-memory-sync`, so the
  GitHub repo matches the npm package name. All metadata, badges and install
  links point at the new URL (the old URL redirects).
- `package.json` description is now a single English sentence: it is what npm
  and plugin directories use as the English description, and the Chinese copy
  lives in `locale/zh.json` and the README.

## [0.1.0] - 2026-11-05

First public release.

### Added

- Three-phase startup sync: local pull/commit/push → peer commit over ssh → local
  pull again, so both machines end on the same commit.
- `peer` and `local` modes; `repoPath`, `remote`, `branch`, `peerHost`,
  `peerUser`, `peerKeyPath`, `peerCommand` and timeouts are configurable.
- Startup grace window (`startupGraceSec`, default 300 s) so hot reloads do not
  trigger a sync.
- Retry once after `retryDelaySec` (60 s), then silent self-heal every
  `healIntervalSec` (600 s) until the sync succeeds.
- Optional OS dialog on final failure (`notifyOnFailure`).
- Optional machine snapshot written before each sync and committed with it
  (`statusFile`).
- `memory_sync` tool for agents: `{"action":"run"}` and `{"action":"status"}`.
- Lock file and `last-run.json` / `sync.log` under `$DSH_HOME/memory-sync/`.
- Tests covering dirty-tree commits, rebase over a peer commit, non-repo errors,
  lock exclusivity and staleness, and config normalization.

[0.1.0]: https://github.com/QIC-9821/dsh-memory-sync/releases/tag/v0.1.0

[0.1.1]: https://github.com/QIC-9821/dsh-memory-sync/releases/tag/v0.1.1
