import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createConfigStore, redactConfig } from './lib/settings.mjs'
import { createRoutes } from './lib/routes.mjs'
import { createLogger, ensureDir, rotateLog } from './lib/state.mjs'
import { createSyncRuntime } from './lib/sync.mjs'
import { createToolController } from './lib/tools.mjs'
import { createSecretStore } from './lib/secret.mjs'
import { createPairingStore } from './lib/pairing.mjs'
import { createRemoteController } from './lib/remote.mjs'
import { cleanupData, profileStillHasPlugin } from './lib/cleanup.mjs'

export const name = 'dsh-memory-sync'

const VERSION = (() => {
  for (const rel of ['./package.json', '../package.json']) {
    try {
      const value = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')).version
      if (value) return value
    } catch {
      // try the next layout (dist/index.js uses ../package.json)
    }
  }
  return ''
})()

const SHORT_MANUAL = `记忆同步：PC 与平板各装一份本插件，填同一个 memSecret，一端填另一端地址即可互传。
1) 两端都开 serve、互相填 peerUrl，任意一端都能手动发起同步。
2) 启动自同步：每次启动跑一次；定时发送：每 N 分钟推一次，0=关。
3) 冲突时保留：local=保本机较新内容，peer=保对端（覆盖前自动备份）。
4) 收到后回发：适合两端都想尽快拿到合并结果，只回发一次，不会循环。
5) 手动同步不受 autoApply 限制；定时/自动推送受对端 autoApply 控制。
6) 完全离线时导出 .json.gz，拷到另一端导入；导入前会先预览。`

/**
 * Config is optional on hosts without @deepseek-ai/schemastery. The tablet zip
 * bundles schemastery into dist/index.js so this schema still materializes the
 * native plugin settings form on Android.
 */
let z = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  z = mod?.default ?? mod ?? null
} catch {
  z = null
}

const field = (schema) => (typeof schema?.extra === 'function' ? schema.extra('volatile', true) : schema)

export const Config = z
  ? z
      .object({
        repoPath: field(z.string().default('').description('记忆目录；平板默认 dsh-home/memories')),
        remote: field(z.string().default('cloud').description('git remote 名；HTTP 模式不用')),
        branch: field(z.string().default('main').description('git 分支；HTTP 模式不用')),
        enabled: field(z.boolean().default(true).description('总开关；关闭后不启动定时/启动同步')),
        runOnStartup: field(z.boolean().default(true).description('启动时自同步一次')),
        startupGraceSec: field(z.natural().default(300).description('启动后多少秒内挂载算一次启动，超过视为热重载')),
        mode: field(z.string().default('peer').description('peer=有对端；local=只同步本机')),
        peerHost: field(z.string().default('').description('SSH 模式：对端地址')),
        peerUser: field(z.string().default('').description('SSH 模式：对端用户')),
        peerPort: field(z.natural().default(22).description('SSH 模式：端口')),
        peerKeyPath: field(z.string().default('').description('SSH 模式：私钥路径')),
        peerCommand: field(z.string().default('/usr/local/bin/dsh-mem-sync').description('SSH 模式：对端执行的同步脚本')),
        peerEnvName: field(z.string().default('cloud').description('SSH 模式：对端 DSH_SYNC_NAME')),
        retryDelaySec: field(z.natural().default(60).description('启动失败后第一次重试间隔（秒），0=关')),
        healIntervalSec: field(z.natural().default(600).description('失败后自愈重试间隔（秒），0=关')),
        notifyOnFailure: field(z.boolean().default(true).description('失败时弹系统窗口')),
        commitPrefix: field(z.string().default('sync').description('自动提交信息前缀')),
        gitPath: field(z.string().default('git').description('git 可执行文件')),
        localTimeoutMs: field(z.natural().default(120000).description('本机步骤超时（毫秒）')),
        peerTimeoutMs: field(z.natural().default(120000).description('对端步骤超时（毫秒）')),
        statusFile: field(z.string().default('').description('同步前写一份机器快照到该文件；空=不写')),
        transport: field(z.string().default('git').description('http=双方插件直连；git=单方插件 SSH 三段式')),
        peerUrl: field(z.string().default('').description('对端快照地址，例如 http://192.168.137.50:18792')),
        peerMachine: field(z.string().default('').description('对端名称，用于筛选对端快照')),
        machine: field(z.string().default('').description('本机名称；留空自动取主机名')),
        memSecret: field(z.string().default('').description('两端一致的共享密钥；设置页不回显，留空=不改')),
        secretFile: field(z.string().default('').description('密钥文件路径；留空=stateDir/secret。支持绝对路径、~ 或相对 stateDir')),
        secretEnv: field(z.string().default('DSH_MEM_SECRET').description('密钥环境变量名；优先级低于 memSecret、高于密钥文件')),
        peerName: field(z.string().default('').description('配对记录：对端名称')),
        peerPlatform: field(z.string().default('').description('配对记录：对端平台')),
        peerPairedAt: field(z.string().default('').description('配对记录：配对时间')),
        peerFingerprint: field(z.string().default('').description('配对记录：对端密钥指纹')),
        serve: field(z.boolean().default(true).description('本机是否开快照服务，让对端能连进来')),
        listenHost: field(z.string().default('0.0.0.0').description('快照服务监听地址；局域网填 0.0.0.0')),
        listenPort: field(z.natural().default(18792).description('快照服务端口，两端要能互访')),
        autoApply: field(z.boolean().default(true).description('收到自动/定时推送的快照时是否立即合并；手动推送不受此限制')),
        keepSnapshots: field(z.natural().default(5).description('本机保留几份快照')),
        maxSnapshotMB: field(z.natural().default(100).description('快照总大小上限（MB）')),
        intervalSendMinutes: field(z.natural().default(0).description('每 N 分钟发送一次快照；0=关闭。HTTP 只推送，SSH 跑三段')),
        conflict: field(z.string().default('peer').description('冲突时保留：local=保本机较新内容，peer=保对端（覆盖前备份）')),
        replyOnReceive: field(z.boolean().default(false).description('收到对端同步且真的写入后，回发一次合并快照')),
        toolsMode: field(z.string().default('auto').description('agent 工具注册：auto=只在需要时出现；always=每轮都注册；off=不注册（省 token）')),
        toolsScope: field(z.string().default('core').description('工具动作：core=run/status；full=含快照/离线操作（省 token）')),
        remoteMode: field(z.string().default('off').description('远程访问：off=局域网；tailscale=绑定 Tailscale 地址；ssh=SSH 反向隧道')),
        warpCoexist: field(z.boolean().default(true).description('用 Tailscale 时让 WARP 切到 DoH，避免抢路由')),
        tunnelEnabled: field(z.boolean().default(false).description('SSH 模式：是否启动反向隧道')),
        sshHost: field(z.string().default('').description('SSH 隧道：跳板机地址')),
        sshUser: field(z.string().default('').description('SSH 隧道：跳板机用户')),
        sshKeyPath: field(z.string().default('').description('SSH 隧道：私钥路径')),
        tunnelRemotePort: field(z.natural().default(18792).description('SSH 隧道：跳板机上监听的端口')),
        tunnelLocalPort: field(z.natural().default(0).description('SSH 隧道：本机目标端口；0=用 listenPort')),
        purgeOnUninstall: field(z.boolean().default(false).description('卸载时尝试删除本机数据（实验性；DSH 没有公开卸载钩子）')),
      })
      .description(SHORT_MANUAL)
  : undefined

export const inject = ['tools']

function pickLogger(logger) {
  if (typeof logger?.info === 'function') return logger
  return {
    info: (...args) => console.log('[memory-sync]', ...args),
    warn: (...args) => console.warn('[memory-sync]', ...args),
    error: (...args) => console.error('[memory-sync]', ...args),
  }
}

export async function apply(ctx, config = {}) {
  const store = createConfigStore(config, process.env)
  const cfg = store.current()
  await ensureDir(cfg.stateDir).catch(() => {})
  await rotateLog(join(cfg.stateDir, 'sync.log')).catch(() => {})

  const logger = pickLogger(createLogger({ dir: cfg.stateDir, tag: 'memory-sync' }))
  const secrets = createSecretStore({
    getConfig: () => store.current(),
    env: process.env,
    logger,
  })
  const pairing = createPairingStore({ stateDir: cfg.stateDir, logger })
  const remote = createRemoteController({ logger, stateDir: store.current().stateDir })

  const getRuntimeConfig = () => {
    const base = store.current()
    const secret = secrets.current()
    return remote.effectiveConfig({
      ...base,
      memSecret: secret.secret,
      memSecretFingerprint: secret.fingerprint,
    })
  }

  const runtime = createSyncRuntime({
    getConfig: getRuntimeConfig,
    logger,
    pairing,
  })
  const tools = createToolController({
    ctx,
    runtime,
    getConfig: getRuntimeConfig,
    logger,
  })

  async function applyConfig() {
    secrets.resumeGeneration?.()
    secrets.invalidate()
    const applied = await runtime.reconfigure()
    const effective = getRuntimeConfig()
    const localPort = applied?.server?.port || effective.tunnelLocalPort || effective.listenPort
    await remote.reconfigure(effective, { localPort })
    tools.refresh()
    return applied
  }

  const disposers = []
  const mountRoutes = (hostCtx) => {
    const webServer = hostCtx?.webServer ?? hostCtx?.get?.('webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    try {
      const origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : ''
      const routes = createRoutes({
        runtime,
        store,
        version: VERSION,
        origin,
        tools,
        secrets,
        pairing,
        remote,
        cleanup: cleanupData,
        onConfigApplied: applyConfig,
      })
      disposers.push(webServer.register({ kind: 'prefix', path: '/memory-sync', handler: routes.handle }))
      logger.info('settings api mounted at /memory-sync/api')
    } catch (error) {
      logger.warn(`web route registration failed: ${error?.message || error}`)
    }
  }

  // On a cold boot a bundle row can be instantiated before the web server
  // exists (the server rides a later row); acquire it lazily.
  if (typeof ctx?.inject === 'function') {
    disposers.push(ctx.inject(['webServer'], (hostCtx) => mountRoutes(hostCtx)))
  } else {
    mountRoutes(ctx)
  }

  await remote.refresh(store.current()).catch(() => {})
  await applyConfig().catch(() => {})
  runtime.scheduleStartup()
  const effective = getRuntimeConfig()
  logger.info(
    `ready: repo=${effective.repoPath} transport=${effective.transport} mode=${effective.mode} ` +
      `conflict=${effective.conflict} interval=${effective.intervalSendMinutes}m ` +
      `secret=${secrets.status().source}/${secrets.status().fingerprint || '-'} ` +
      `remote=${effective.remoteMode} tools=${effective.toolsMode}/${effective.toolsScope} ` +
      `settings=${store.file()}`,
  )

  const dispose = async () => {
    remote.dispose()
    tools.dispose()
    runtime.dispose()
    try {
      const current = store.current()
      if (current.purgeOnUninstall && !profileStillHasPlugin(process.env.DSH_PROFILE_DIR)) {
        await cleanupData({
          stateDir: current.stateDir,
          secretInfo: secrets.status(),
          includeBackups: false,
          pairing,
        })
      }
    } catch (error) {
      logger.warn(`uninstall cleanup failed: ${error?.message || error}`)
    }
    for (const disposer of disposers.reverse()) {
      try {
        disposer?.()
      } catch {
        // ignore teardown errors
      }
    }
  }

  ctx.effect?.(() => () => dispose(), 'dsh-memory-sync: teardown')
  return dispose
}

export { redactConfig }
