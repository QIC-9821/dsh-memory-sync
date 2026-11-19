window.__ModuleLoader__.load({
  id: 'dsh-memory-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/memory-sync/api/'

    const CARD = {
      border: '1px solid var(--dsh-border, rgba(127,127,127,.28))',
      borderRadius: 12,
      padding: '14px 16px',
      marginBottom: 14,
      background: 'var(--dsh-surface, transparent)',
    }
    const LABEL = { fontSize: 12.5, opacity: 0.7, marginBottom: 4 }
    const INPUT = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 9px',
      borderRadius: 8,
      border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
    }
    const BUTTON = {
      padding: '7px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit',
    }
    const PRIMARY = { ...BUTTON, background: 'var(--dsh-accent, #3b82f6)', borderColor: 'var(--dsh-accent, #3b82f6)', color: '#fff' }
    const MUTED = { fontSize: 12.5, opacity: 0.65 }
    const ROW = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontSize: 13 }
    const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }

    async function api(path, options) {
      const response = await fetch(API + path, options)
      const text = await response.text()
      let value
      try {
        value = JSON.parse(text)
      } catch {
        value = { error: text || `HTTP ${response.status}` }
      }
      if (!response.ok || value?.ok === false) {
        throw new Error(value?.error || value?.result?.error || `HTTP ${response.status}`)
      }
      return value
    }

    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
    }

    function Card(props) {
      return h('div', { style: CARD }, [
        h('div', { key: 'title', style: { fontSize: 13.5, fontWeight: 600, marginBottom: 10 } }, props.title),
        ...(Array.isArray(props.children) ? props.children : [props.children]),
      ])
    }

    function Field(props) {
      return h('div', { style: { marginTop: props.first ? 0 : 10 } }, [
        props.label ? h('div', { key: 'label', style: LABEL }, props.label) : null,
        props.children,
        props.help ? h('div', { key: 'help', style: MUTED }, props.help) : null,
      ])
    }

    function Text(props) {
      return h('input', {
        style: INPUT,
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: props.placeholder || '',
        type: props.type || 'text',
        onChange: (event) => props.onChange(event.target.value),
      })
    }

    function Select(props) {
      return h(
        'select',
        {
          style: INPUT,
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          onChange: (event) => props.onChange(event.target.value),
        },
        props.options.map(([value, label]) => h('option', { key: value, value }, label)),
      )
    }

    function Toggle(props) {
      return h(
        'label',
        {
          style: {
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            padding: '6px 0',
            borderBottom: '1px dashed var(--dsh-border, rgba(127,127,127,.25))',
            cursor: 'pointer',
          },
        },
        [
          h('input', {
            key: 'box',
            type: 'checkbox',
            checked: Boolean(props.checked),
            onChange: (event) => props.onChange(event.target.checked),
            style: { marginTop: 2 },
          }),
          h('span', { key: 'text' }, [
            h('b', { key: 'name' }, props.label),
            props.dirty ? h('span', { key: 'dirty', style: { marginLeft: 6, fontSize: 11, color: 'var(--dsh-accent, #3b82f6)' } }, '未保存') : null,
            props.desc ? h('div', { key: 'desc', style: MUTED }, props.desc) : null,
          ]),
        ],
      )
    }

    function bytes(value) {
      const n = Number(value) || 0
      if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
      if (n > 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${n} B`
    }

    function clock(value) {
      if (!value) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }

    const TOOL_REASON_LABELS = {
      off: '已关闭',
      always: '始终注册',
      'no-repo-path': '未配置记忆目录',
      wake: '唤醒窗口内',
      running: '正在同步',
      'no-last-run': '还没同步过',
      'last-failed': '上次同步失败',
      healthy: '上次同步成功',
      'register-failed': '注册失败',
    }

    const SECRET_SOURCE_LABELS = {
      config: '配置文件 memSecret',
      env: '环境变量',
      file: '密钥文件',
      generated: '自动生成（文件）',
      none: '未设置',
    }

    const REMOTE_MODE_LABELS = {
      off: '关闭（局域网直连）',
      tailscale: 'Tailscale（异地）',
      ssh: 'SSH 反向隧道',
    }

    function phaseLine(phase) {
      const bits = [phase.name, phase.ok ? 'ok' : 'FAILED']
      if (phase.ms !== undefined) bits.push(`${phase.ms}ms`)
      if (phase.files !== undefined) bits.push(`${phase.files} files`)
      if (phase.bytes !== undefined) bits.push(bytes(phase.bytes))
      if (phase.from) bits.push(`from ${phase.from}`)
      if (phase.written) bits.push(`wrote ${Array.isArray(phase.written) ? phase.written.length : phase.written}`)
      if (phase.applied && phase.applied.written) bits.push(`peer applied ${phase.applied.written.length}`)
      if (phase.error) bits.push(phase.error)
      return bits.join(' · ')
    }

    function SettingsPage() {
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState({})
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [result, setResult] = useState(null)
      const [test, setTest] = useState(null)
      const [logs, setLogs] = useState([])
      const [snapshots, setSnapshots] = useState(null)
      const [preview, setPreview] = useState(null)
      const [pendingImport, setPendingImport] = useState(null)
      const [clearSecret, setClearSecret] = useState(false)
      const [pairCode, setPairCode] = useState(null)
      const [pairUrl, setPairUrl] = useState('')
      const [pairInput, setPairInput] = useState('')
      const [includeBackups, setIncludeBackups] = useState(false)
      const [tab, setTab] = useState('overview')
      const [peersView, setPeersView] = useState(null)
      const [peersError, setPeersError] = useState('')
      const [peerBusy, setPeerBusy] = useState('')

      const load = useCallback(async () => {
        try {
          const next = await api('state')
          setData(next)
          setError('')
        } catch (err) {
          setError(String(err?.message || err))
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 8000)
        return () => clearInterval(timer)
      }, [load])

      const loadPeers = useCallback(async () => {
        try {
          const next = await api('peers?remote=1')
          setPeersView(next)
          setPeersError('')
        } catch (err) {
          setPeersError(String(err?.message || err))
        }
      }, [])

      // The address book is read on demand: asking the peer costs a network
      // round trip, so it must not ride the eight-second status poll.
      useEffect(() => {
        if (tab === 'ext') void loadPeers()
      }, [tab, loadPeers])

      async function peerAction(kind, mode, remote) {
        setPeerBusy(`${kind}-${mode}-${remote ? 'r' : 'l'}`)
        setError('')
        setNote('')
        try {
          await post(`peers/${kind}`, { mode, remote })
          await loadPeers()
          setNote(kind === 'use'
            ? `已把对端地址切到记住的 ${mode} 地址。`
            : `已删除记住的 ${mode} 地址。`)
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setPeerBusy('')
        }
      }

      const config = data?.config || {}
      const status = data?.status || {}
      const rules = status.rules || {}
      const dirty = Object.keys(draft)
      const value = (key) => (draft[key] !== undefined ? draft[key] : config[key])
      const set = (key, next) => setDraft((current) => ({ ...current, [key]: next }))
      const dirtyOf = (key) => draft[key] !== undefined

      const toolInfo = data?.tools || {}
      const toolMode = value('toolsMode') || toolInfo.mode || 'auto'
      const toolScope = value('toolsScope') || toolInfo.scope || 'core'
      const toolReason = TOOL_REASON_LABELS[toolInfo.reason] || toolInfo.reason || ''
      const secretInfo = data?.secret || {}
      const remoteInfo = data?.remote || {}
      const pairingInfo = data?.pairing || {}
      const janitorInfo = data?.janitor || {}

      async function run(label, fn) {
        setBusy(label)
        setError('')
        setNote('')
        try {
          await fn()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
        }
      }

      async function save() {
        const patch = { ...draft }
        if (patch.memSecret === '') delete patch.memSecret
        const toolChanged = 'toolsMode' in patch || 'toolsScope' in patch
        await run('save', async () => {
          const next = await post('config', { patch, clearSecret })
          setData(next)
          setDraft({})
          setClearSecret(false)
          setNote(toolChanged
            ? '已保存，工具注册表已更新（下一轮对话生效）。'
            : '已保存到 settings.json，并立即生效。')
        })
      }

      async function reset() {
        if (!window.confirm('删除本页保存的覆盖项，回到 profile 里的配置？')) return
        await run('reset', async () => {
          const next = await post('reset')
          setData(next)
          setDraft({})
          setClearSecret(false)
          setNote('已恢复 profile 配置。')
        })
      }

      async function sync(direction) {
        await run(`sync-${direction}`, async () => {
          const next = await post('sync', { direction })
          setResult(next.result)
          setData((current) => ({ ...current, status: next.status }))
        })
      }

      async function wakeTools() {
        await run('wake', async () => {
          const next = await post('tools/wake', { minutes: 10 })
          setData((current) => ({ ...current, tools: next.tools || current?.tools }))
          setNote(`已唤醒 memory_sync 工具，10 分钟内后续对话可见（${next.until ? clock(next.until) : ''}）。`)
        })
      }

      async function migrateSecret() {
        const target = String(value('secretFile') || '').trim()
        if (!target) {
          setNote('先填写新的密钥文件路径，再点迁移。')
          return
        }
        await run('migrate-secret', async () => {
          const next = await post('secret/migrate', { secretFile: target })
          setData(next.state)
          setNote(next.warning || `密钥已迁移到 ${next.file || target}；旧值未删除，确认无误后可手动清理。`)
        })
      }

      async function newPairCode() {
        await run('pair-new', async () => {
          const next = await post('pair/new')
          setPairCode(next)
          setNote(`配对码 ${next.code}，${clock(next.expiresAt)} 前有效，只能使用一次。`)
        })
      }

      async function acceptPair() {
        await run('pair-accept', async () => {
          const next = await post('pair/accept', { url: pairUrl, code: pairInput })
          setData(next.state)
          setPairCode(null)
          setPairInput('')
          setNote(`已配对：${next.paired?.name || next.paired?.machine || '对端'} · 指纹 ${next.paired?.fingerprint || '-'}`)
        })
      }

      async function refreshRemote() {
        await run('remote-refresh', async () => {
          const next = await post('remote/refresh')
          setData(next.state)
          setNote(next.remote?.tunnel?.state ? `远程状态：${next.remote.tunnel.state}` : '远程状态已刷新。')
        })
      }

      async function cleanupLocal() {
        if (!window.confirm('删除本机插件数据（设置、密钥、日志、配对记录）？记忆目录不会被删除。')) return
        await run('cleanup', async () => {
          const next = await post('cleanup', { confirm: true, includeBackups })
          setData(next.state)
          setDraft({})
          setNote(`已删除 ${next.removed?.length || 0} 项本机数据${next.failed?.length ? `，${next.failed.length} 项失败` : ''}。重启插件后恢复默认。`)
        })
      }

      async function testPeer() {
        await run('test', async () => {
          const next = await post('test')
          setTest(next.result)
        })
      }

      async function loadLogs() {
        await run('logs', async () => {
          const next = await api('logs?lines=80')
          setLogs(next.lines || [])
        })
      }

      async function loadSnapshots() {
        await run('snapshots', async () => {
          setSnapshots(await api('snapshots'))
        })
      }

      async function restore(id) {
        if (!window.confirm(`恢复快照 ${id}？当前文件会先备份。`)) return
        await run('restore', async () => {
          const next = await post('restore', { id })
          setNote(`已恢复 ${id}：写入 ${next.result?.written?.length ?? 0} 个文件`)
          await load()
        })
      }

      async function exportSnapshot() {
        await run('export', async () => {
          const response = await fetch(API + 'export')
          if (!response.ok) throw new Error(`导出失败：HTTP ${response.status}`)
          const blob = await response.blob()
          const name = `memory-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = name
          document.body.appendChild(link)
          link.click()
          link.remove()
          setTimeout(() => URL.revokeObjectURL(url), 30000)
          setNote(`已导出 ${name}（${bytes(blob.size)}）`)
        })
      }

      function pickImport(file) {
        if (!file) return
        setPendingImport(file)
        setPreview(null)
        void run('import-preview', async () => {
          const buffer = await file.arrayBuffer()
          const response = await fetch(API + 'import?dryRun=1', {
            method: 'POST',
            headers: { 'content-type': 'application/gzip' },
            body: buffer,
          })
          const value = await response.json()
          if (!response.ok || value?.ok === false) throw new Error(value?.error || `HTTP ${response.status}`)
          setPreview(value.result)
        })
      }

      async function confirmImport() {
        if (!pendingImport) return
        await run('import', async () => {
          const buffer = await pendingImport.arrayBuffer()
          const response = await fetch(API + 'import', {
            method: 'POST',
            headers: { 'content-type': 'application/gzip' },
            body: buffer,
          })
          const value = await response.json()
          if (!response.ok || value?.ok === false) throw new Error(value?.error || `HTTP ${response.status}`)
          setNote(`导入完成：写入 ${value.result?.written?.length ?? 0} 个文件，备份 ${value.result?.backups?.length ?? 0} 个`)
          setPreview(null)
          setPendingImport(null)
          await load()
        })
      }

      async function runJanitorJob(dryRun) {
        await run(dryRun ? 'janitor-preview' : 'janitor-run', async () => {
          const next = await post('janitor/run', { dryRun })
          const info = next.janitor || {}
          setData((current) => ({ ...current, janitor: info }))
          const report = next.result || {}
          setNote(
            `${report.dryRun ? '预览' : '整理完成'}：扫描 ${report.files || 0} 个文件，归档 ${report.archived || 0} 条、删除 ${report.purged || 0} 条、跳过 ${report.skipped || 0} 条${report.errors?.length ? `，${report.errors.length} 个错误` : ''}。`,
          )
        })
      }

      if (!data) {
        return h('div', { style: { padding: 20 } }, error ? `读取失败：${error}` : '读取记忆同步状态…')
      }

      const role = value('transport') === 'git'
        ? 'ssh'
        : value('serve')
          ? value('peerUrl')
            ? 'both'
            : 'server'
          : 'client'

      const setRole = (next) => {
        if (next === 'client') {
          set('serve', false)
        } else if (next === 'server') {
          set('serve', true)
          set('peerUrl', '')
        } else {
          set('serve', true)
        }
      }

      const interval = Number(value('intervalSendMinutes') || 0)

      const connectionLabel = (() => {
        const url = String(status.peerUrl || '')
        if (!url) return '未连接'
        let host = ''
        try {
          host = new URL(url).hostname.toLowerCase()
        } catch {
          return '自定义地址'
        }
        if (host.endsWith('.ts.net')) return 'Tailscale 异地'
        if (/^192\.168\.(137|43)\./.test(host) || /^172\.20\.10\./.test(host)) return '热点直连'
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return '局域网直连'
        return '自定义地址'
      })()

      const MODE_LABELS = { hotspot: '热点', lan: '局域网', tailnet: 'Tailscale', other: '其他' }

      const peerGroup = (title, view, remote) => {
        const records = view?.records || {}
        const modes = ['hotspot', 'lan', 'tailnet', 'other']
        return h('div', { key: `peer-${title}`, style: { marginTop: 12 } }, [
          h('div', { key: 'h', style: { fontWeight: 600, fontSize: 13, marginBottom: 4 } }, `${title}${view?.machine ? ` · ${view.machine}` : ''}`),
          ...modes.map((mode) => {
            const record = records[mode]
            const busyKey = `delete-${mode}-${remote ? 'r' : 'l'}`
            return h('div', { key: mode, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12.5 } }, [
              h('span', { key: 'k', style: { width: 76, opacity: 0.7 } }, MODE_LABELS[mode]),
              h('span', { key: 'v', style: { flex: 1, wordBreak: 'break-all' } }, record ? record.host : '—'),
              record
                ? h('button', {
                    key: 'd',
                    style: { ...BUTTON, padding: '2px 8px', fontSize: 11.5 },
                    disabled: Boolean(peerBusy),
                    onClick: () => void peerAction('delete', mode, remote),
                  }, peerBusy === busyKey ? '删除中…' : '删除')
                : null,
            ])
          }),
          remote
            ? h('div', { key: 'use', style: { marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' } }, [
                ...modes
                  .filter((mode) => records[mode])
                  .map((mode) => h('button', {
                    key: mode,
                    style: { ...BUTTON, padding: '3px 10px', fontSize: 12 },
                    disabled: Boolean(peerBusy),
                    onClick: () => void peerAction('use', mode, true),
                  }, `用 ${MODE_LABELS[mode]} 地址连它`)),
              ])
            : null,
        ])
      }

      const tabButton = (id, label) => h('button', {
        key: `tab-${id}`,
        style: {
          ...BUTTON,
          padding: '5px 12px',
          border: `1px solid ${tab === id ? 'var(--dsh-accent, #3b82f6)' : 'transparent'}`,
          background: tab === id ? 'rgba(59,130,246,.12)' : 'transparent',
          color: 'inherit',
        },
        onClick: () => setTab(id),
      }, label)

      const nodes = [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 } }, [
          h('h2', { key: 'title', style: { margin: 0, fontSize: 18 } }, '记忆同步'),
          h('span', { key: 'ver', style: MUTED }, `v${data.version || '?'} · ${status.machine || '?'}`),
        ]),

        error ? h('div', { key: 'err', style: { padding: '9px 12px', marginBottom: 12, borderRadius: 8, background: 'rgba(239,68,68,.12)', color: '#ef4444', fontSize: 13 } }, error) : null,
        note ? h('div', { key: 'note', style: { padding: '9px 12px', marginBottom: 12, borderRadius: 8, background: 'rgba(34,197,94,.12)', color: '#16a34a', fontSize: 13 } }, note) : null,

        h('div', {
          key: 'tabs',
          style: {
            display: 'flex',
            gap: 6,
            marginBottom: 14,
            paddingBottom: 8,
            borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,.2))',
            flexWrap: 'wrap',
          },
        }, [
          tabButton('overview', '总览'),
          tabButton('sync', '同步方式'),
          tabButton('archive', '归档与删档'),
          tabButton('secret', '密钥与配对'),
          tabButton('ext', '扩展'),
        ]),

        h(Card, { key: 'status', title: '状态' }, [
          h('div', { key: 'rows' }, [
            h('div', { key: 'a', style: ROW }, [h('span', { key: 'k' }, '传输'), h('b', { key: 'v' }, value('transport') === 'http' ? 'HTTP 快照' : 'SSH 三段式')]),
            h('div', { key: 'conn', style: ROW }, [h('span', { key: 'k' }, '连接方式'), h('b', { key: 'v' }, connectionLabel)]),
            h('div', { key: 'b', style: ROW }, [h('span', { key: 'k' }, '角色'), h('b', { key: 'v' }, { client: '客户端', server: '服务端', both: '双向节点', ssh: 'SSH' }[role] || role)]),
            h('div', { key: 'c', style: ROW }, [h('span', { key: 'k' }, '对端'), h('span', { key: 'v' }, status.peerUrl || status.peerHost || '未配置')]),
            h('div', { key: 'd', style: ROW }, [h('span', { key: 'k' }, '快照服务'), h('span', { key: 'v' }, status.server?.error ? `错误：${status.server.error}` : status.server ? `${status.server.host}:${status.server.port}` : '未启动')]),
            h('div', { key: 'e', style: ROW }, [h('span', { key: 'k' }, '上次同步'), h('span', { key: 'v' }, status.lastRun ? `${clock(status.lastRun.at)} · ${status.lastRun.ok ? 'ok' : '失败'}` : '还没跑过')]),
            h('div', { key: 'f', style: ROW }, [h('span', { key: 'k' }, '定时发送'), h('span', { key: 'v' }, interval > 0 ? `每 ${interval} 分钟 · 下次 ${clock(status.schedule?.nextAt)}` : '关闭')]),
          ]),
          h('div', { key: 'buttons', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } }, [
            h('button', { key: 'test', style: BUTTON, disabled: Boolean(busy), onClick: () => void testPeer() }, busy === 'test' ? '测试中…' : '测试连接'),
            h('button', { key: 'sync', style: PRIMARY, disabled: Boolean(busy), onClick: () => void sync('both') }, busy === 'sync-both' ? '同步中…' : '立即双向同步'),
            h('button', { key: 'push', style: BUTTON, disabled: Boolean(busy), onClick: () => void sync('push') }, '仅推送'),
            h('button', { key: 'pull', style: BUTTON, disabled: Boolean(busy), onClick: () => void sync('pull') }, '仅拉取'),
            h('button', { key: 'reload', style: BUTTON, disabled: Boolean(busy), onClick: () => void load() }, '刷新'),
          ]),
          test ? h('div', { key: 'testout', style: { ...MUTED, marginTop: 8, whiteSpace: 'pre-wrap' } }, JSON.stringify(test, null, 2)) : null,
          result ? h('div', { key: 'run', style: { marginTop: 10, padding: 10, borderRadius: 8, background: 'rgba(127,127,127,.08)', fontSize: 12.5 } }, [
            h('div', { key: 'h', style: { fontWeight: 600, marginBottom: 4 } }, `本次结果 · ${result.trigger || 'manual'} · ${result.ok ? 'ok' : '失败'}`),
            ...(result.phases || []).map((phase, index) => h('div', { key: index }, phaseLine(phase))),
            result.error ? h('div', { key: 'e', style: { color: '#ef4444' } }, result.error) : null,
          ]) : null,
        ]),

        h(Card, { key: 'remember', title: '记住来访地址' }, [
          h(Toggle, {
            key: 'on',
            label: '当纯服务端时，记住谁连过我',
            desc: '打开后，PC 每次连上来都会把它的地址记在本机，每种方式只留最后 1 个；要修电脑时从这里挑一个地址回连，不用再问 IP。关掉就只是普通服务端，什么都不记。',
            checked: Boolean(value('rememberPeer')),
            onChange: (v) => set('rememberPeer', v),
            dirty: dirtyOf('rememberPeer'),
          }),
          h('div', { key: 'hint', style: { ...MUTED, marginTop: 6 } },
            Boolean(value('rememberPeer'))
              ? '开着：看看「扩展」里记住了哪些地址，保存后生效。'
              : '关着：本机不记录任何来访地址。'),
        ]),

        h(Card, { key: 'tools', title: '工具（省 token）' }, [
          h(Field, {
            key: 'mode',
            first: true,
            label: 'memory_sync 什么时候注册',
            help: 'agent 每轮都要读工具表。不用时让工具从表里消失，比删注册表更省：模型根本看不到它。',
          }, h(Select, {
            value: toolMode,
            options: [
              ['auto', '自动：需要时才出现（推荐，最省）'],
              ['always', '总是注册：每轮都占工具位'],
              ['off', '关闭：完全不注册'],
            ],
            onChange: (next) => set('toolsMode', next),
          })),
          h(Toggle, {
            key: 'scope',
            label: '注册完整操作（快照 / 离线）',
            desc: '不勾=只给 run/status，工具表最短；勾上才给 list/restore/export/import。',
            checked: toolScope === 'full',
            onChange: (next) => set('toolsScope', next ? 'full' : 'core'),
            dirty: dirtyOf('toolsScope'),
          }),
          h('div', { key: 'now', style: { ...MUTED, marginTop: 8 } }, [
            h('div', { key: 'line1' }, `当前：${toolInfo.registered ? '已注册' : '未注册'} · ${toolInfo.visible ? '下一轮可见' : '下一轮隐藏'}${toolReason ? ` · ${toolReason}` : ''}`),
            h('div', { key: 'line2' }, `工具表约 ${toolInfo.estimateChars || 0} 字符 ≈ ${toolInfo.estimateTokens || 0} tokens · 当前范围 ${toolInfo.scope || toolScope}`),
            toolInfo.wakeUntil ? h('div', { key: 'line3' }, `唤醒至 ${clock(toolInfo.wakeUntil)}`) : null,
          ]),
          h('div', { key: 'buttons', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } }, [
            h('button', {
              key: 'wake',
              style: BUTTON,
              disabled: Boolean(busy) || toolMode !== 'auto' || !value('repoPath'),
              onClick: () => void wakeTools(),
            }, busy === 'wake' ? '唤醒中…' : '唤醒 agent 工具 10 分钟'),
            h('span', { key: 'hint', style: MUTED }, toolMode === 'auto'
              ? '健康时整条工具从工具表消失；上次失败、正在同步或唤醒窗口内会重新出现。'
              : toolMode === 'off' ? '完全不注册，agent 无法主动同步。' : '每轮都注册，token 占用最高。'),
          ]),
        ]),

        h(Card, { key: 'transport', title: '传输方式' }, [
          h(Field, { key: 't', first: true, label: '怎么连对端' }, h(Select, {
            value: value('transport'),
            options: [
              ['http', '双方插件 · 局域网直连（推荐）'],
              ['git', '单方插件 · SSH + 对端脚本'],
            ],
            onChange: (next) => set('transport', next),
          })),
          h(Field, { key: 'role', label: '本机角色', help: '两端都开 serve 并互相填 peerUrl，就是「双向节点」，任意一端都能发起。' }, h(Select, {
            value: role === 'ssh' ? 'client' : role,
            options: [
              ['client', '客户端：连对端，不开服务'],
              ['server', '服务端：等对端来连'],
              ['both', '双向节点：既服务又连对端'],
            ],
            onChange: setRole,
          })),
        ]),

        h(Card, { key: 'remote', title: '远程访问（异地）' }, [
          h(Field, { key: 'mode', first: true, label: '怎么让对端找到本机', help: 'Tailscale 适合平板/家里 NAS；SSH 反向隧道需要一台有公网 IP 的跳板机。' }, h(Select, {
            value: value('remoteMode'),
            options: Object.entries(REMOTE_MODE_LABELS),
            onChange: (v) => set('remoteMode', v),
          })),
          value('remoteMode') === 'tailscale' ? h('div', { key: 'ts', style: { marginTop: 8 } }, [
            h('div', { key: 'rows', style: { fontSize: 13 } }, [
              h('div', { key: 'a', style: ROW }, [h('span', { key: 'k' }, 'Tailscale'), h('span', { key: 'v' }, remoteInfo.tailscale?.installed ? (remoteInfo.tailscale.online ? '在线' : '离线') : '未安装')]),
              h('div', { key: 'b', style: ROW }, [h('span', { key: 'k' }, '地址'), h('span', { key: 'v' }, remoteInfo.tailscale?.ipv4 || remoteInfo.effectiveHost || '—')]),
              h('div', { key: 'c', style: ROW }, [h('span', { key: 'k' }, '远程 URL'), h('span', { key: 'v' }, remoteInfo.remoteUrl || '—')]),
              h('div', { key: 'd', style: ROW }, [h('span', { key: 'k' }, 'WARP'), h('span', { key: 'v' }, remoteInfo.warp?.installed
                ? `${remoteInfo.warp.mode || '未知模式'}${remoteInfo.warp.changed ? ` · 已切到 DoH（原 ${remoteInfo.warp.previousMode || 'tunnel'}）` : ''}`
                : '未安装')]),
            ]),
            h(Toggle, { key: 'warp', label: '与 WARP 共存', desc: '把 WARP 切到 DoH，避免抢 Tailscale 路由。', checked: Boolean(value('warpCoexist')), onChange: (v) => set('warpCoexist', v), dirty: dirtyOf('warpCoexist') }),
          ]) : null,
          value('remoteMode') === 'ssh' ? h('div', { key: 'ssh', style: { marginTop: 8 } }, [
            h(Toggle, { key: 'tunnel', label: '启动 SSH 反向隧道', desc: '在跳板机上监听 tunnelRemotePort，把连接送回本机快照服务。', checked: Boolean(value('tunnelEnabled')), onChange: (v) => set('tunnelEnabled', v), dirty: dirtyOf('tunnelEnabled') }),
            h('div', { key: 'grid', style: GRID }, [
              h(Field, { key: 'host', label: '跳板机地址' }, h(Text, { value: value('sshHost'), placeholder: '114.55.146.70', onChange: (v) => set('sshHost', v) })),
              h(Field, { key: 'user', label: '跳板机用户' }, h(Text, { value: value('sshUser'), placeholder: 'root', onChange: (v) => set('sshUser', v) })),
              h(Field, { key: 'key', label: '私钥路径' }, h(Text, { value: value('sshKeyPath'), placeholder: 'C:/Users/.../.ssh/id_ed25519', onChange: (v) => set('sshKeyPath', v) })),
              h(Field, { key: 'rport', label: '跳板机监听端口' }, h(Text, { value: value('tunnelRemotePort'), type: 'number', onChange: (v) => set('tunnelRemotePort', v) })),
              h(Field, { key: 'lport', label: '本机目标端口（0=listenPort）' }, h(Text, { value: value('tunnelLocalPort'), type: 'number', onChange: (v) => set('tunnelLocalPort', v) })),
            ]),
            h('div', { key: 'state', style: { ...MUTED, marginTop: 8 } }, `隧道状态：${remoteInfo.tunnel?.state || 'stopped'}${remoteInfo.tunnel?.error ? ` · ${remoteInfo.tunnel.error}` : ''}`),
          ]) : null,
          h('div', { key: 'actions', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } }, [
            h('button', { key: 'refresh', style: BUTTON, disabled: Boolean(busy), onClick: () => void refreshRemote() }, busy === 'remote-refresh' ? '刷新中…' : '刷新远程状态'),
          ]),
          h('div', { key: 'tip', style: { ...MUTED, marginTop: 8 } }, 'Tailscale 在线时会自动把监听地址换成 tailnet IPv4；离线时回退到 listenHost。SSH 隧道只解决“跳板机 → 本机”一个方向。'),
        ]),

        value('transport') === 'http'
          ? h(Card, { key: 'http', title: '双方插件直连' }, [
              h('div', { key: 'grid', style: GRID }, [
                h(Field, { key: 'peerUrl', first: true, label: '对端地址' }, h(Text, { value: value('peerUrl'), placeholder: 'http://192.168.137.50:18792', onChange: (v) => set('peerUrl', v) })),
                h(Field, { key: 'secret', label: '共享密钥' }, h(Text, {
                  value: value('memSecret'),
                  type: 'password',
                  placeholder: config.memSecretSet ? '已设置（留空不改）' : '两端填同一个',
                  onChange: (v) => {
                    setClearSecret(false)
                    set('memSecret', v)
                  },
                })),
                h(Field, { key: 'machine', label: '本机名称' }, h(Text, { value: value('machine'), placeholder: 'pc / tablet', onChange: (v) => set('machine', v) })),
                h(Field, { key: 'peerMachine', label: '对端名称' }, h(Text, { value: value('peerMachine'), placeholder: 'tablet', onChange: (v) => set('peerMachine', v) })),
                h(Field, { key: 'host', label: '监听地址' }, h(Text, { value: value('listenHost'), placeholder: '0.0.0.0', onChange: (v) => set('listenHost', v) })),
                h(Field, { key: 'port', label: '监听端口' }, h(Text, { value: value('listenPort'), type: 'number', onChange: (v) => set('listenPort', v) })),
              ]),
              h('div', { key: 'flags', style: { marginTop: 8 } }, [
                h(Toggle, { key: 'serve', label: '开快照服务', desc: '关掉后本机只连别人，不能让别人连进来。', checked: Boolean(value('serve')), onChange: (v) => set('serve', v), dirty: dirtyOf('serve') }),
                h(Toggle, { key: 'auto', label: '收到自动/定时推送就合并', desc: '手动推送不受这个开关限制。', checked: Boolean(value('autoApply')), onChange: (v) => set('autoApply', v), dirty: dirtyOf('autoApply') }),
              ]),
              h('div', { key: 'tip', style: { ...MUTED, marginTop: 8 } }, 'PC 防火墙要放行这个端口；两端不在同一网络时改用下面的离线快照。'),
            ])
          : null,

        h(Card, { key: 'secret', title: '密钥与配对' }, [
          h('div', { key: 'rows', style: { fontSize: 13 } }, [
            h('div', { key: 'a', style: ROW }, [h('span', { key: 'k' }, '密钥来源'), h('span', { key: 'v' }, SECRET_SOURCE_LABELS[secretInfo.source] || secretInfo.source || '未设置')]),
            h('div', { key: 'b', style: ROW }, [h('span', { key: 'k' }, '指纹'), h('span', { key: 'v' }, secretInfo.fingerprint || '—')]),
            h('div', { key: 'c', style: ROW }, [h('span', { key: 'k' }, '密钥文件'), h('span', { key: 'v', style: { wordBreak: 'break-all', textAlign: 'right' } }, secretInfo.file || '—')]),
          ]),
          h(Field, { key: 'file', label: '新密钥文件路径', help: '留空=stateDir/secret；支持绝对路径、~ 或相对 stateDir。填目录会自动变成目录/secret。' }, h(Text, { value: value('secretFile'), placeholder: 'C:/Users/QIC/.dsh/memory-sync/secret', onChange: (v) => set('secretFile', v) })),
          h('div', { key: 'migrate', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } }, [
            h('button', { key: 'm', style: BUTTON, disabled: Boolean(busy), onClick: () => void migrateSecret() }, busy === 'migrate-secret' ? '迁移中…' : '把当前密钥迁移到该路径'),
          ]),
          h('div', { key: 'pairhead', style: { fontWeight: 600, marginTop: 14 } }, '配对码'),
          h('div', { key: 'pairhint', style: MUTED }, '一台生成 6 位码，另一台填地址和码加入；码 5 分钟内有效、只能使用一次。配对会互换共享密钥。'),
          h('div', { key: 'pairrow', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } }, [
            h('button', { key: 'new', style: PRIMARY, disabled: Boolean(busy), onClick: () => void newPairCode() }, busy === 'pair-new' ? '生成中…' : '生成配对码'),
            pairCode ? h('span', { key: 'show', style: { alignSelf: 'center', fontWeight: 700, letterSpacing: 2 } }, `${pairCode.code} · ${clock(pairCode.expiresAt)} 前`) : null,
          ]),
          h('div', { key: 'pairgrid', style: { ...GRID, marginTop: 8 } }, [
            h(Field, { key: 'url', label: '对端地址（加入方填）' }, h(Text, { value: pairUrl, placeholder: 'http://100.x.x.x:18792', onChange: setPairUrl })),
            h(Field, { key: 'code', label: '配对码（加入方填）' }, h(Text, { value: pairInput, placeholder: '6 位数字', onChange: setPairInput })),
          ]),
          h('div', { key: 'accept', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } }, [
            h('button', { key: 'go', style: BUTTON, disabled: Boolean(busy) || !pairUrl || !pairInput, onClick: () => void acceptPair() }, busy === 'pair-accept' ? '配对中…' : '加入配对'),
            h('span', { key: 'count', style: MUTED }, `已记录配对：${pairingInfo.pairings || 0} 台${pairingInfo.lockedUntil ? ` · 锁定至 ${clock(pairingInfo.lockedUntil)}` : ''}`),
          ]),
          h('div', { key: 'tip', style: { ...MUTED, marginTop: 8 } }, '密钥优先级：配置值 > 环境变量 > 密钥文件 > 自动生成。配对码走 HTTP，建议只在局域网 / Tailscale / SSH 隧道内使用。'),
        ]),

        h(Card, { key: 'manual', title: '使用说明' }, [
          h('div', { key: 'list', style: { fontSize: 13, lineHeight: 1.75 } }, [
            h('div', { key: 1 }, '1. 两端都装本插件，填同一个共享密钥；一端填另一端地址，点「测试连接」。'),
            h('div', { key: 2 }, '2. 两端都开服务并互相填地址，任意一端都能手动发起；只开一端也行。'),
            h('div', { key: 3 }, '3. 启动自同步：每次 DSH 启动跑一次；定时发送：每 N 分钟推一次，0=关闭。'),
            h('div', { key: 4 }, '4. 冲突时保留：本机=不覆盖本机较新的内容；对端=用对端覆盖，覆盖前自动备份。'),
            h('div', { key: 5 }, '5. 收到后回发：两端都想尽快拿到合并结果时打开；只回发一次，不会循环。'),
            h('div', { key: 6 }, '6. 完全离线：一端导出 .json.gz，拷到另一端导入；导入前会先预览。'),
            h('div', { key: 7 }, '7. 单方插件：只有本机装插件时，用 SSH 地址/用户/密钥让对端执行同步脚本。'),
            h('div', { key: 8, style: MUTED }, '快捷键：先测连接 → 再双向同步 → 看下方日志。'),
          ]),
        ]),

        h(Card, { key: 'rules', title: '自定义同步规则' }, [
          h(Toggle, { key: 'startup', label: '启动时自同步', desc: 'DSH 启动后自动跑一次；热重载不算启动。', checked: Boolean(value('runOnStartup')), onChange: (v) => set('runOnStartup', v), dirty: dirtyOf('runOnStartup') }),
          h(Toggle, {
            key: 'interval',
            label: '定时发送快照',
            desc: 'HTTP 模式只推送；SSH 模式跑一次三段。0=关闭。',
            checked: interval > 0,
            onChange: (v) => set('intervalSendMinutes', v ? (interval > 0 ? interval : 30) : 0),
            dirty: dirtyOf('intervalSendMinutes'),
          }),
          interval > 0 ? h(Field, { key: 'intervalv', label: '间隔（分钟）' }, h(Text, { value: value('intervalSendMinutes'), type: 'number', onChange: (v) => set('intervalSendMinutes', v) })) : null,
          h(Field, { key: 'conflict', label: '冲突时保留' }, h(Select, {
            value: value('conflict'),
            options: [
              ['local', '本机为准（不覆盖本机较新内容）'],
              ['peer', '对端为准（用对端覆盖，先备份）'],
            ],
            onChange: (v) => set('conflict', v),
          })),
          h(Toggle, { key: 'reply', label: '收到对端同步后回发快照', desc: '只在本次真的写入文件时回发一次，并带 no-reply 防循环。', checked: Boolean(value('replyOnReceive')), onChange: (v) => set('replyOnReceive', v), dirty: dirtyOf('replyOnReceive') }),
          h('div', { key: 'rulesnow', style: { ...MUTED, marginTop: 6 } }, `当前生效：启动=${rules.runOnStartup ? '开' : '关'} · 定时=${rules.intervalSendMinutes || 0} 分钟 · 冲突=${rules.conflict || 'peer'} · 回发=${rules.replyOnReceive ? '开' : '关'}`),
        ]),

        h(Card, { key: 'janitor', title: '记忆归档与清理' }, [
          h('div', { key: 'desc', style: { ...MUTED, lineHeight: 1.6 } }, '把旧条目从主记忆移到 *-archive.md，归档再按天数/条数清理。归档和删除都可逆：写入前会自动备份成 *.bak-janitor-*。'),
          h(Toggle, { key: 'enabled', label: '定期自动整理', desc: '关闭时只能手动点下面的按钮。', checked: Boolean(value('janitorEnabled')), onChange: (v) => set('janitorEnabled', v), dirty: dirtyOf('janitorEnabled') }),
          h(Toggle, { key: 'syncAfter', label: '整理后自动推送快照', desc: '避免平板带着旧条目同步回来把已删内容写回。', checked: Boolean(value('janitorSyncAfter')), onChange: (v) => set('janitorSyncAfter', v), dirty: dirtyOf('janitorSyncAfter') }),
          h('div', { key: 'numbers', style: GRID }, [
            h(Field, { key: 'archive', first: true, label: '主记忆超过多少天归档' }, h(Text, { value: value('archiveAfterDays'), type: 'number', onChange: (v) => set('archiveAfterDays', v) })),
            h(Field, { key: 'purge', label: '归档超过多少天删除' }, h(Text, { value: value('purgeAfterDays'), type: 'number', onChange: (v) => set('purgeAfterDays', v) })),
            h(Field, { key: 'keep', label: '归档最多保留条数（0=不限）' }, h(Text, { value: value('keepArchivedEntries'), type: 'number', onChange: (v) => set('keepArchivedEntries', v) })),
            h(Field, { key: 'interval', label: '自动整理间隔（小时）' }, h(Text, { value: value('janitorIntervalHours'), type: 'number', onChange: (v) => set('janitorIntervalHours', v) })),
          ]),
          h('div', { key: 'options', style: GRID }, [
            h(Field, { key: 'scope', label: '整理范围' }, h(Select, {
              value: value('janitorScope') || 'all',
              options: [['all', '全局 + 全部项目'], ['project', '只看项目'], ['global', '只看全局']],
              onChange: (v) => set('janitorScope', v),
            })),
            h(Field, { key: 'protect', label: '保护关键词（逗号分隔）' }, h(Text, { value: value('janitorProtectKeywords'), onChange: (v) => set('janitorProtectKeywords', v) })),
          ]),
          h('div', { key: 'janitorstate', style: { ...MUTED, marginTop: 8 } }, [
            h('div', { key: 'a' }, `上次整理：${janitorInfo.lastRunAt ? clock(janitorInfo.lastRunAt) : '还没跑过'}${janitorInfo.nextDueAt ? ` · 下次 ${clock(janitorInfo.nextDueAt)}` : ''}`),
            janitorInfo.lastResult
              ? h('div', { key: 'b' }, `上次结果：归档 ${janitorInfo.lastResult.archived || 0} 条、删除 ${janitorInfo.lastResult.purged || 0} 条、跳过 ${janitorInfo.lastResult.skipped || 0} 条`)
              : null,
          ]),
          h('div', { key: 'actions', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } }, [
            h('button', { key: 'preview', style: BUTTON, disabled: Boolean(busy), onClick: () => void runJanitorJob(true) }, busy === 'janitor-preview' ? '预览中…' : '预览会怎么整理'),
            h('button', { key: 'run', style: PRIMARY, disabled: Boolean(busy), onClick: () => void runJanitorJob(false) }, busy === 'janitor-run' ? '整理中…' : '现在整理'),
          ]),
          h('div', { key: 'tip', style: { ...MUTED, marginTop: 8 } }, '先点下方「保存设置」让参数生效，再点整理。手动整理只走设置页接口，不新增 agent 工具。'),
        ]),

        h(Card, { key: 'offline', title: '离线快照（完全不用网络）' }, [
          h('div', { key: 'row', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
            h('button', { key: 'export', style: BUTTON, disabled: Boolean(busy), onClick: () => void exportSnapshot() }, busy === 'export' ? '导出中…' : '导出快照'),
            h('label', { key: 'import', style: { ...BUTTON, display: 'inline-block' } }, [
              '导入快照…',
              h('input', {
                key: 'file',
                type: 'file',
                accept: '.gz,.json.gz,application/gzip',
                style: { display: 'none' },
                onChange: (event) => pickImport(event.target.files?.[0]),
              }),
            ]),
          ]),
          preview ? h('div', { key: 'preview', style: { marginTop: 10, fontSize: 12.5 } }, [
            h('div', { key: 'h', style: { fontWeight: 600 } }, `预览：${preview.machine || '?'} · ${preview.fileCount ?? '?'} 个文件`),
            h('div', { key: 'w' }, `将写入 ${preview.written?.length || 0} 个，跳过 ${preview.skipped?.length || 0} 个`),
            h('div', { key: 'buttons', style: { display: 'flex', gap: 8, marginTop: 8 } }, [
              h('button', { key: 'ok', style: PRIMARY, disabled: Boolean(busy), onClick: () => void confirmImport() }, '确认导入'),
              h('button', { key: 'cancel', style: BUTTON, onClick: () => { setPreview(null); setPendingImport(null) } }, '取消'),
            ]),
          ]) : null,
          h('div', { key: 'tip', style: { ...MUTED, marginTop: 8 } }, '平板没有这个页面：把文件拷过去，对平板 agent 说「导入记忆快照 <路径>」，或 call memory_sync {"action":"import","path":"..."}。'),
        ]),

        value('transport') === 'git'
          ? h(Card, { key: 'ssh', title: '单方插件（SSH + 对端脚本）' }, [
              h('div', { key: 'grid', style: GRID }, [
                h(Field, { key: 'host', first: true, label: '对端地址' }, h(Text, { value: value('peerHost'), onChange: (v) => set('peerHost', v) })),
                h(Field, { key: 'user', label: '对端用户' }, h(Text, { value: value('peerUser'), onChange: (v) => set('peerUser', v) })),
                h(Field, { key: 'port', label: '端口' }, h(Text, { value: value('peerPort'), type: 'number', onChange: (v) => set('peerPort', v) })),
                h(Field, { key: 'key', label: '私钥路径' }, h(Text, { value: value('peerKeyPath'), placeholder: 'C:/Users/.../.ssh/id_ed25519', onChange: (v) => set('peerKeyPath', v) })),
                h(Field, { key: 'cmd', label: '对端同步脚本' }, h(Text, { value: value('peerCommand'), onChange: (v) => set('peerCommand', v) })),
                h(Field, { key: 'env', label: '对端环境名' }, h(Text, { value: value('peerEnvName'), onChange: (v) => set('peerEnvName', v) })),
              ]),
              h('div', { key: 'tip', style: { ...MUTED, marginTop: 8 } }, '对端不需要装本插件；需要可写的记忆目录、git 裸仓，以及能执行的同步脚本。'),
            ])
          : null,

        h(Card, { key: 'peers', title: '记住的地址' }, [
          h('div', { key: 'hint', style: MUTED }, '本机在「记住来访地址」打开时会记下每个连过它的地址；对端那份要连得上才能读到。每种方式只留最后 1 个，可以在下面删除，或者让对端改用其中某个地址。'),
          peerGroup('本机记录', peersView?.local, false),
          peersView?.remote === null
            ? h('div', { key: 'nopeer', style: { ...MUTED, marginTop: 12 } }, '对端未配置地址，读不到它的记录。')
            : peerGroup('对端记录', peersView?.remote, true),
          peersError ? h('div', { key: 'err', style: { marginTop: 10, color: '#ef4444', fontSize: 12.5 } }, peersError) : null,
          h('div', { key: 'row', style: { marginTop: 10 } }, [
            h('button', { key: 'r', style: BUTTON, disabled: Boolean(peerBusy), onClick: () => void loadPeers() }, peerBusy ? '读取中…' : '刷新地址簿'),
          ]),
        ]),

        h(Card, { key: 'logs', title: '日志' }, [
          h('div', { key: 'row', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
            h('button', { key: 'l', style: BUTTON, disabled: Boolean(busy), onClick: () => void loadLogs() }, busy === 'logs' ? '读取中…' : '刷新日志'),
            h('button', { key: 's', style: BUTTON, disabled: Boolean(busy), onClick: () => void loadSnapshots() }, busy === 'snapshots' ? '读取中…' : '看快照'),
          ]),
          logs.length ? h('pre', { key: 'pre', style: { marginTop: 10, whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 260, overflow: 'auto', background: 'rgba(127,127,127,.08)', padding: 10, borderRadius: 8 } }, logs.join('\n')) : null,
          snapshots ? h('div', { key: 'snaps', style: { marginTop: 10, fontSize: 12.5 } }, [
            h('div', { key: 'h', style: { fontWeight: 600 } }, `快照：本地 ${snapshots.local?.length || 0} 份，对端 ${snapshots.peer?.length || 0} 份`),
            ...(snapshots.local || []).slice(0, 8).map((item) => h('div', { key: item.id, style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, [
              h('span', { key: 'id', style: { opacity: 0.8 } }, `${item.id} · ${bytes(item.bytes)}`),
              h('button', { key: 'r', style: { ...BUTTON, padding: '2px 8px', fontSize: 11.5 }, onClick: () => void restore(item.id) }, '恢复'),
            ])),
          ]) : null,
        ]),

        h(Card, { key: 'advanced', title: '高级' }, [
          h('div', { key: 'grid', style: GRID }, [
            h(Field, { key: 'repo', first: true, label: '记忆目录' }, h(Text, { value: value('repoPath'), onChange: (v) => set('repoPath', v) })),
            h(Field, { key: 'startupGrace', label: '启动宽限（秒）' }, h(Text, { value: value('startupGraceSec'), type: 'number', onChange: (v) => set('startupGraceSec', v) })),
            h(Field, { key: 'retry', label: '失败重试（秒）' }, h(Text, { value: value('retryDelaySec'), type: 'number', onChange: (v) => set('retryDelaySec', v) })),
            h(Field, { key: 'heal', label: '自愈间隔（秒）' }, h(Text, { value: value('healIntervalSec'), type: 'number', onChange: (v) => set('healIntervalSec', v) })),
            h(Field, { key: 'keep', label: '保留快照份数' }, h(Text, { value: value('keepSnapshots'), type: 'number', onChange: (v) => set('keepSnapshots', v) })),
            h(Field, { key: 'max', label: '快照上限（MB）' }, h(Text, { value: value('maxSnapshotMB'), type: 'number', onChange: (v) => set('maxSnapshotMB', v) })),
            h(Field, { key: 'status', label: '状态文件' }, h(Text, { value: value('statusFile'), onChange: (v) => set('statusFile', v) })),
            h(Field, { key: 'localTimeout', label: '本机超时（ms）' }, h(Text, { value: value('localTimeoutMs'), type: 'number', onChange: (v) => set('localTimeoutMs', v) })),
            h(Field, { key: 'peerTimeout', label: '对端超时（ms）' }, h(Text, { value: value('peerTimeoutMs'), type: 'number', onChange: (v) => set('peerTimeoutMs', v) })),
          ]),
          h('div', { key: 'flags', style: { marginTop: 8 } }, [
            h(Toggle, { key: 'enabled', label: '总开关', desc: '关掉后不启动/不跑定时；手动同步仍可用。', checked: Boolean(value('enabled')), onChange: (v) => set('enabled', v), dirty: dirtyOf('enabled') }),
            h(Toggle, { key: 'notify', label: '失败弹窗', desc: '同步失败时弹系统窗口提醒。', checked: Boolean(value('notifyOnFailure')), onChange: (v) => set('notifyOnFailure', v), dirty: dirtyOf('notifyOnFailure') }),
            h(Toggle, { key: 'purge', label: '卸载时删除本机数据（实验性）', desc: 'DSH 没有公开卸载钩子，只有在 profile 里已经找不到本插件时才会尝试清理。', checked: Boolean(value('purgeOnUninstall')), onChange: (v) => set('purgeOnUninstall', v), dirty: dirtyOf('purgeOnUninstall') }),
          ]),
          h('div', { key: 'cleanup', style: { marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--dsh-border, rgba(127,127,127,.25))' } }, [
            h('div', { key: 'h', style: { fontWeight: 600 } }, '删除本机数据'),
            h('div', { key: 'd', style: MUTED }, '删除设置、密钥文件、日志、上次运行记录、配对记录和锁；默认保留快照/导出和记忆目录。'),
            h(Toggle, { key: 'backups', label: '连快照和导出一起删', desc: '勾选后 snapshots/ 与 exports/ 也会删除；记忆目录永远不删。', checked: includeBackups, onChange: setIncludeBackups }),
            h('button', { key: 'go', style: BUTTON, disabled: Boolean(busy), onClick: () => void cleanupLocal() }, busy === 'cleanup' ? '删除中…' : '删除本机插件数据'),
          ]),
        ]),

        h('div', { key: 'save', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } }, [
          h('button', { key: 'save', style: PRIMARY, disabled: Boolean(busy) || (dirty.length === 0 && !clearSecret), onClick: () => void save() }, busy === 'save' ? '保存中…' : '保存设置'),
          h('button', { key: 'reset', style: BUTTON, disabled: Boolean(busy), onClick: () => void reset() }, '恢复 profile 配置'),
          h('span', { key: 'hint', style: MUTED }, dirty.length === 0 && !clearSecret ? `已保存 · ${clock(data.settings?.updatedAt)} · ${data.settings?.path || ''}` : `${dirty.length} 项待保存${clearSecret ? '（将清除密钥）' : ''}`),
          h('button', { key: 'clear', style: BUTTON, disabled: Boolean(busy), onClick: () => { setClearSecret(true); setNote('保存后会清除共享密钥；也可以直接填写新密钥。') } }, '清除密钥'),
        ]),
      ]

      const TAB_OF_KEY = {
        status: 'overview',
        remember: 'overview',
        tools: 'overview',
        manual: 'overview',
        transport: 'sync',
        remote: 'sync',
        http: 'sync',
        ssh: 'sync',
        offline: 'sync',
        secret: 'secret',
        janitor: 'archive',
        rules: 'archive',
        peers: 'ext',
        logs: 'ext',
        advanced: 'ext',
      }
      const TAB_ORDER = { offline: 0 }
      const visible = nodes
        .filter((node) => {
          const where = TAB_OF_KEY[node?.key]
          return !where || where === tab
        })
        .map((node, index) => ({ node, index }))
        // The USB snapshot card is the first thing under 同步方式: it works with
        // no network at all, so it should not sit below the online methods.
        .sort((a, b) => (TAB_ORDER[a.node?.key] ?? 10) - (TAB_ORDER[b.node?.key] ?? 10) || a.index - b.index)
        .map((entry) => entry.node)
      return h('div', { style: { maxWidth: 860, margin: '0 auto', padding: '4px 0 24px' } }, visible)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'memory-sync', order: 17, label: () => '记忆同步' },
            SettingsPage,
          ),
        )
      },
    }
  },
})
