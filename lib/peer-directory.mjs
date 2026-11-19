import {
  addPeerHistory,
  classifyUrl,
  deletePeerRecord,
  hostForUrl,
  readPeerRecords,
  rememberPeerRecord,
} from './peer-memory.mjs'

/**
 * The node-side face of the address memory: recording, listing, and the
 * "use this remembered address" action that turns a server back into a client.
 *
 * `applyPatch` writes the config through the same path the settings UI uses,
 * so a remembered address behaves exactly like one typed by hand.
 */
export function createPeerDirectory({ getConfig, applyPatch, logger }) {
  const log = (level, message) => logger?.[level]?.(message)

  function config() {
    return getConfig?.() || {}
  }

  return {
    /** Is the remember switch on? */
    enabled() {
      return Boolean(config().rememberPeer)
    },

    /** Record the address an authenticated request came from. */
    record(rawHost) {
      const cfg = config()
      if (!cfg.rememberPeer) return null
      try {
        const record = rememberPeerRecord(cfg.stateDir, rawHost)
        if (record) log('info', `remembered peer ${record.host}`)
        return record
      } catch (error) {
        log('warn', `remembering peer failed: ${error?.message || error}`)
        return null
      }
    },

    /** Address chips for the current peerUrl (call after saving one). */
    noteAddress(peerUrl) {
      const cfg = config()
      const url = String(peerUrl || '').trim()
      if (!url) return cfg.peerHistory || {}
      let host = ''
      try {
        host = new URL(url.includes('://') ? url : `http://${url}`).hostname
      } catch {
        return cfg.peerHistory || {}
      }
      if (!classifyUrl(url)) return cfg.peerHistory || {}
      return addPeerHistory(cfg.peerHistory, host)
    },

    list() {
      const cfg = config()
      return {
        rememberPeer: Boolean(cfg.rememberPeer),
        machine: cfg.machine || '',
        listenPort: cfg.listenPort,
        records: readPeerRecords(cfg.stateDir),
      }
    },

    remove(mode) {
      const cfg = config()
      return deletePeerRecord(cfg.stateDir, mode)
    },

    /** Point this node at a remembered peer (http transport). */
    async use(mode) {
      const cfg = config()
      const records = readPeerRecords(cfg.stateDir)
      const record = records[mode]
      if (!record) return { ok: false, error: `no remembered ${mode} address` }
      const peerUrl = `http://${hostForUrl(record.host)}:${cfg.listenPort}`
      await applyPatch({
        peerUrl,
        transport: 'http',
        connectionMode: mode,
        remoteMode: mode === 'tailnet' ? 'tailscale' : 'off',
        intervalSendMinutes: 30,
        replyOnReceive: true,
      })
      log('info', `switched to remembered ${mode} peer ${peerUrl}`)
      return { ok: true, mode, peerUrl, host: record.host }
    },
  }
}
