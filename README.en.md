# dsh-memory-sync

Sync `~/.dsh/memories` between two machines: LAN HTTP snapshots, fully offline snapshot files, or an SSH peer chain. Desktop gets a settings page; Android gets a native plugin settings form.

## Transports

| Transport | Use when | Notes |
| --- | --- | --- |
| Both plugins · LAN | same Wi-Fi / hotspot | same `memSecret`; fill each other's `peerUrl`; no internet needed |
| Both plugins · offline | never on the same network | export `.json.gz`, copy over, preview then import |
| One plugin · SSH | only this machine has the plugin | SSH to the peer and run its sync script; peer needs a writable memory dir + bare repo/script |

When the two machines are not on one network, set `remoteMode` to `tailscale` or `ssh`; see "Remote access" below.

## Install

```bash
dsh plugin add dsh-memory-sync
```

Local development: `"dsh-memory-sync": "link:D:/dsh-plugins/dsh-memory-sync"`.

Android: the current built zip is `dist/dsh-memory-sync-0.3.0-tablet.zip` (root `package.json`, no BOM, schemastery bundled into `dist/index.js`). The 0.4.0 code has not been re-packed yet; run `scripts/build-tablet.mjs` when needed.

## Settings

- Desktop: Settings → Memory Sync — test, sync both/push/pull, the token-saving tool card (`toolsMode` / `toolsScope`), secrets and pairing, remote access, rules, offline snapshots, logs, restore.
- Android: Settings → Extensions → Installed plugins → dsh-memory-sync — schema form with the same fields; use the `memory_sync` tool for manual runs.

Overrides live in `~/.dsh/memory-sync/settings.json` and take precedence over the profile's `cordis.patch.yml`.

## Custom rules

| Key | Default | Meaning |
| --- | --- | --- |
| `runOnStartup` | true | sync once on startup |
| `intervalSendMinutes` | 0 | send every N minutes; 0=off (HTTP push; SSH chain) |
| `conflict` | peer | `local` keeps a newer local copy; `peer` lets the remote win (backup first) |
| `replyOnReceive` | false | after applying files, send one merged snapshot back (no-reply guard) |
| `autoApply` | true | apply automatic/scheduled pushes; manual pushes bypass it |

## Config

See the Chinese README for the full table. State lives in `$DSH_HOME/memory-sync/`.

Key entries for this release: `secretFile` (default `<stateDir>/secret`; `~` and relative paths work), `secretEnv` (default `DSH_MEM_SECRET`), `remoteMode` (`off` / `tailscale` / `ssh`), `warpCoexist`, `tunnelEnabled`, `sshHost` / `sshUser` / `sshKeyPath`, `tunnelRemotePort` / `tunnelLocalPort`, `purgeOnUninstall`.

## Secrets and pairing

- Resolution: explicit `memSecret` > `secretEnv` > `secretFile` > generated. A 32-byte hex secret is generated only when `serve` is on and no other source exists.
- The settings page shows the source and a SHA-256 prefix, never the secret. `/mem/ping` exposes the fingerprint only.
- Migration (`POST /memory-sync/api/secret/migrate`) writes the secret to a new file. A config/env source is copied to that file with a warning; the source stays config/env until that override is removed. The path alone can be saved with the normal Save button.
- Pairing: one side issues a 6-digit code (300-second TTL, single use, 5 failures per IP lock for 10 minutes), the other side submits the peer URL and code. Both sides then share one secret and record name/platform/fingerprint.
- Pairing returns the secret over HTTP to whoever holds the code; use it only on a LAN, Tailscale or an SSH tunnel.

## Remote access

- `off`: listen on `listenHost` / `listenPort`; suitable for one Wi-Fi/hotspot.
- `tailscale`: when Tailscale is online, bind the tailnet IPv4 and show `remoteUrl`; fall back to `listenHost` when offline.
- `ssh` + `tunnelEnabled`: keep an `ssh -N -R 127.0.0.1:<tunnelRemotePort>:127.0.0.1:<localPort> user@sshHost` tunnel alive with 5/10/30/60-second backoff. Port conflicts are reported, not killed automatically.
- `warpCoexist` (Tailscale mode): if WARP is running a full tunnel, switch it to DNS-only (`doh`) so it does not steal Tailscale's route; the previous mode is restored when remote mode leaves Tailscale.
- Neither mode changes the `memory_sync` tool schema or the token cost.

## Tools and token cost

`memory_sync` comes in two scopes:

- `core` (default): `run` (`direction=both|push|pull`) and `status`.
- `full`: adds `list`, `restore`, `export`, `import` (`snapshot`, `path`, `dryRun`).

`toolsMode` decides when it is advertised:

- `auto` (default): not registered without `repoPath`; hidden while the last sync is healthy and nothing is running; shown after a failed/unknown run, during a sync, or inside a wake window.
- `always`: registered every turn.
- `off`: never registered (the settings page and API still work).

| Situation | Tool schema per step | Note |
| --- | --- | --- |
| `auto` + `core`, healthy | 0 | the cheapest; absent from the declaration |
| `auto` + `core`, failed/wake/running | ~521 chars (~145 tokens) | shrinks back after the issue clears |
| `always` + `core` | ~521 chars (~145 tokens) | it used to be 1635 chars (~450 tokens) |
| `always` + `full` | ~989 chars (~275 tokens) | includes snapshot/offline actions |
| `status` output | ~110–150 chars | it used to be 799–1109 chars |

The settings card shows the live registration state, reason, and estimate, plus a 10-minute wake button (`POST /memory-sync/api/tools/wake`, 1–120 minutes). In `auto` mode visibility is frozen at the start of the user's turn, so it never vanishes mid-turn or churns the prompt cache.

## Security

Local/same-origin settings API; secrets and pairing codes are never echoed or logged. The shared secret equals write access; snapshots are plain gzip. Pairing is unauthenticated by design but requires a short-lived, single-use code with a per-IP failure lock. Overwrites are backed up as `*.bak-snapshot`; memory files are never deleted. Uninstalling the plugin leaves local data in place; use "delete local data" or `purgeOnUninstall` to remove it.

## License

MIT.
