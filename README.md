# dsh-memory-sync

[![npm version](https://img.shields.io/npm/v/dsh-memory-sync.svg)](https://www.npmjs.com/package/dsh-memory-sync)
[![CI](https://github.com/QIC-9821/dsh-memory-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/QIC-9821/dsh-memory-sync/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

> 在两台机器之间同步 `~/.dsh/memories`：局域网 HTTP 快照、完全离线文件、或 SSH 对端脚本。电脑有设置页，平板有插件设置表单。

English: [README.en.md](README.en.md) · 简短说明书: [MANUAL.md](MANUAL.md)

## 三种通路

| 通路 | 适合 | 要点 |
| --- | --- | --- |
| 双方插件 · 局域网直连 | 两台机器在同一 Wi-Fi / 热点 | 两端装插件、同一个 `memSecret`、互相填 `peerUrl`；不需要外网 |
| 双方插件 · 离线快照 | 完全不在同一网络 | 导出 `.json.gz`，拷到另一端导入；先预览再合并 |
| 单方插件 · SSH | 只有一端装插件 | 本机 SSH 登录对端执行同步脚本；对端只需可写记忆目录 + 裸仓/脚本 |

不在同一网络时，把 `remoteMode` 设为 `tailscale`（绑定 Tailscale 地址）或 `ssh`（SSH 反向隧道）；见下面「远程访问」。

## 安装

```bash
dsh plugin add dsh-memory-sync
```

本机开发用 `link:`：

```json
"dsh-memory-sync": "link:D:/dsh-plugins/dsh-memory-sync"
```

平板装自包含 zip：跑 `scripts/build-tablet.mjs` 生成（esbuild 把 schemastery 打进 `dist/index.js`，产物是 `dsh-memory-sync-<版本>-tablet.zip`；0.6.0 的包按需构建，仓库里不提交 zip）。

## 设置页

### 电脑：设置 → 记忆同步

页面按用途分成五个 Tab：

| Tab | 内容 |
| --- | --- |
| 总览 | 状态（含实时「连接方式」）、测试连接、立即双向同步 / 仅推送 / 仅拉取、工具与 token 开关 |
| 同步方式 | 离线快照（U 盘，排在最上）、双方插件直连、SSH 三段式、日志 |
| 归档与删档 | 记忆归档与清理（janitor）、删除本机数据 |
| 密钥与配对 | 密钥来源 / 指纹 / 密钥文件、迁移、配对码 |
| 扩展 | 记住的地址（本机 + 对端）、自定义同步规则、快照列表与恢复、远程访问 |

- 「保存并应用」常驻底部，改动保存到 `~/.dsh/memory-sync/settings.json`，优先级高于 profile 的 `cordis.patch.yml`；「恢复 profile 配置」清掉本页覆盖。
- 状态卡里的「连接方式」由对端地址实时推断：未连接 / 热点直连 / 局域网直连 / Tailscale 异地 / 自定义地址。
- 「记住来访地址」打开后（纯服务端常用），任何通过密钥校验的对端连上来，本机就把它按方式分类（热点 / 局域网 / Tailscale / 其他）记进 `<stateDir>/peers.json`，每种只留最后 1 个，10 分钟内不重复写。地址在「扩展」页预览、删除，点「用 XX 地址连它」直接把 peerUrl 换成它并重载。配置里存的是 `rememberPeer` 与 `peerHistory`，不调模型、不占 token。
- 「连接方式」卡还会把 `peerHistory` 里每种方式最近 2 个地址显示成快捷按钮。

### 平板：设置 → 扩展 → 已安装插件 → dsh-memory-sync

使用 `Config` schema 自动生成的表单，字段与电脑页一致。保存后写 profile 配置并重载。平板没有「立即同步」按钮，用 `memory_sync` 工具：

```json
{"action":"run","direction":"both"}
```

把平板当纯服务端跑（只收不算）时：`peerUrl` 留空、`intervalSendMinutes: 0`、`runOnStartup: false`、`replyOnReceive: false`、`serve: true`、`listenHost: 0.0.0.0`、`rememberPeer: true`。

### 记住来访地址的 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/mem/peers` | 本机记住的地址（需 `x-mem-secret`） |
| POST | `/mem/peers/delete` | `{mode}` 删掉某一类 |
| POST | `/mem/peers/use` | `{mode}` 把 peerUrl 切到该地址并重载 |

本机设置页走代理：`GET /memory-sync/api/peers?remote=1` 会同时问对端要一份，返回 `{local, remote}`。

## 自定义同步规则

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `runOnStartup` | `true` | 启动时跑一次；热重载不算 |
| `intervalSendMinutes` | `0` | 每 N 分钟发送一次；0=关。HTTP 只推送，SSH 跑三段 |
| `conflict` | `peer` | 接收方决定：`local`=保本机较新内容，`peer`=保对端（覆盖前备份） |
| `replyOnReceive` | `false` | 收到并写入后回发一次合并快照；带 `no-reply` 防循环 |
| `autoApply` | `true` | 自动/定时推送是否落地；手动推送不受限制 |

手动推送带 `x-mem-apply: manual`，对端即使 `autoApply=false` 也会合并；定时/自动推送不带该头。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `repoPath` | `$DSH_HOME/memories` | 记忆目录 |
| `toolsMode` / `toolsScope` | `auto` / `core` | agent 工具怎么注册、注册多少，见下面「工具与 token」 |
| `remote` / `branch` | `cloud` / `main` | SSH/git 地址与分支 |
| `enabled` | `true` | 总开关（不启动/不跑定时；手动仍可用） |
| `startupGraceSec` | `300` | 启动后多少秒内挂载算一次启动 |
| `transport` | `git` | `http` 或 `git` |
| `peerUrl` | 空 | 对端快照地址，如 `http://192.168.137.50:18792` |
| `memSecret` | 空 | 两端一致的共享密钥；最高优先级，设置页不回显 |
| `secretFile` / `secretEnv` | 空 / `DSH_MEM_SECRET` | 密钥文件（空=stateDir/secret）与环境变量名；优先级低于 `memSecret`、高于文件 |
| `peerName` / `peerPlatform` / `peerPairedAt` / `peerFingerprint` | 空 | 配对记录，由配对流程写入 |
| `machine` / `peerMachine` | 主机名 / 空 | 本机/对端名称 |
| `serve` | `true` | 是否开快照服务 |
| `listenHost` / `listenPort` | `0.0.0.0` / `18792` | 快照服务地址与端口 |
| `autoApply` | `true` | 收到自动/定时推送是否立即合并 |
| `keepSnapshots` / `maxSnapshotMB` | `5` / `100` | 快照保留与大小上限 |
| `peerHost` / `peerUser` / `peerPort` | 空 / 空 / `22` | SSH 模式目标 |
| `peerKeyPath` / `peerCommand` / `peerEnvName` | 空 / `/usr/local/bin/dsh-mem-sync` / `cloud` | SSH 模式密钥、对端脚本、环境名 |
| `retryDelaySec` / `healIntervalSec` | `60` / `600` | 失败重试/自愈间隔 |
| `intervalSendMinutes` / `conflict` / `replyOnReceive` | `0` / `peer` / `false` | 上面的自定义规则 |
| `remoteMode` / `warpCoexist` | `off` / `true` | `off`=局域网；`tailscale`=绑定 Tailscale 地址；`ssh`=SSH 反向隧道；WARP 共存=Tailscale 模式期间把 WARP 切到 DoH，离开时恢复原模式 |
| `tunnelEnabled` / `sshHost` / `sshUser` / `sshKeyPath` | `false` / 空 | SSH 反向隧道开关与跳板机 |
| `tunnelRemotePort` / `tunnelLocalPort` | `18792` / `0` | 跳板机监听端口 / 本机目标端口（0=listenPort） |
| `purgeOnUninstall` | `false` | 实验性：卸载且 profile 已无本插件时清本机数据 |
| `rememberPeer` | `false` | 记住谁连过本机（纯服务端常用）；只在该端作为服务端收到鉴权请求时写 `peers.json` |
| `connectionMode` | 空 | 最近一次「用记住的地址连它」选的方式：`off` / `usb` / `hotspot` / `lan` / `tailnet` / `ssh` |
| `peerHistory` | `{}` | 每种连接方式最近 2 个对端地址，由 `peerUrl` 变化自动累加，设置页显示成快捷按钮 |

状态、日志、设置、快照都在 `$DSH_HOME/memory-sync/`：`last-run.json`、`sync.log`、`settings.json`、`secret`、`pairings.json`、`snapshots/`、`exports/`。

## 密钥与配对

- 密钥优先级：`memSecret`（profile/设置页显式值）> `secretEnv` 环境变量 > `secretFile` > 自动生成。自动生成只在 `serve=true` 且前三种都没有时发生，内容为 32 字节 hex。
- `secretFile` 支持绝对路径、`~` 和相对 `stateDir`；填目录会自动接 `/secret`。
- 设置页只显示来源（config/env/file/generated）和 SHA-256 前 8 位指纹，不回显密钥；`/mem/ping` 也只带指纹。
- 「迁移密钥」把当前密钥写到新文件（`POST /memory-sync/api/secret/migrate`）。来源是 config/env 时会把同一密钥复制到文件，并提示“当前仍以配置/环境变量为准”；删除那个来源并重载后才会改用文件。密钥路径本身用底部「保存」按钮即可单独保存。
- 配对：一端点「生成配对码」，另一端填对端地址和 6 位码点「加入」。码 300 秒有效、只能用一次；同一 IP 连错 5 次锁 10 分钟。配对成功后两端使用同一密钥，并记录对端名称/平台/指纹。
- 配对会把密钥经 HTTP 返回给持码方，只应在局域网、Tailscale 或 SSH 隧道里使用。

## 远程访问

- `remoteMode=off`：只监听 `listenHost` / `listenPort`，适合同一 Wi-Fi/热点。
- `remoteMode=tailscale`：检测到 Tailscale 在线时，把监听地址换成 tailnet IPv4，设置页显示 `remoteUrl`；对端填这个地址即可。Tailscale 离线时回退到 `listenHost`。
- `remoteMode=ssh` + `tunnelEnabled=true`：在本机起 `ssh -N -R 127.0.0.1:<tunnelRemotePort>:127.0.0.1:<localPort> user@sshHost`，由跳板机把连接转回来。断线按 5/10/30/60 秒退避重试；端口占用只记录错误，不自动杀进程。适合有一台公网 SSH 机器、但两端不在同一局域网的场景。
- 这两种都不改 `memory_sync` 工具 schema，不影响省 token。

## 工作方式

- 记忆写入照常实时落盘；同步只是在需要时生成快照并合并。
- HTTP 手动同步：push（带 manual 头）→ pull；只推送/只拉取可单独选。
- 定时：HTTP 只 push；对端按 `autoApply` 决定是否合并。SSH：跑本地 push → 对端脚本 → 本地 pull。
- 合并规则：缺失文件补上；相同跳过；`conflict=local` 时本机较新不覆盖，`conflict=peer` 时对端覆盖；每日日志短的不覆盖长的；不删除；覆盖前写 `.bak-snapshot`。
- 回发：只在本轮真的写入且请求未带 `x-mem-no-reply: 1` 时回发一次，回发本身带 no-reply，避免循环。

## 工具与 token

`memory_sync` 有两档，默认只带最常用的两个动作：

- `core`（默认）：`{"action":"run","direction":"both|push|pull"}`、`{"action":"status"}`。
- `full`：额外有 `list`、`restore`、`export`、`import`（含 `snapshot` / `path` / `dryRun`）。

`toolsMode` 决定它什么时候出现在上下文里：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 没配 `repoPath` 不注册；上次同步成功且空闲时隐藏（声明和调用一起消失）；失败/未知、正在同步、或唤醒窗口内重新出现 |
| `always` | 每轮都注册，适合经常手动调工具的机器 |
| `off` | 完全不注册；仍可用设置页和脚本 |

省 token 的三个层次，从省到费：

| 场景 | 每步工具声明 | 备注 |
| --- | --- | --- |
| `auto` + `core`，上次同步成功 | 0 | 最省；工具不出现在声明里 |
| `auto` + `core`，失败/唤醒/同步中 | ≈521 字符（≈145 tokens） | 处理完自动缩回去 |
| `always` + `core` | ≈521 字符（≈145 tokens） | 旧版是 1635 字符（≈450 tokens） |
| `always` + `full` | ≈989 字符（≈275 tokens） | 含快照/离线动作 |
| 调用 `status` 的输出 | ≈110–150 字符 | 旧版 799–1109 字符 |

设置页的「工具（省 token）」卡片会实时显示当前是否注册、为什么可见，以及估算字符/token；需要临时让 agent 用一次时点「唤醒 agent 工具 10 分钟」（对应 `POST /memory-sync/api/tools/wake`，可传 1–120 分钟）。`auto` 下的可见性在**用户回合开始时**冻结，所以不会在一轮对话中途消失，也不会让 prompt 缓存反复失效。

## 设置 API

`/memory-sync/api/state|config|reset|sync|test|logs|snapshots|restore|export|import|tools/wake|secret/migrate|pair/new|pair/accept|pairings|pair/clear|remote/refresh|cleanup`，只允许本机/同源请求；state/config 不回显 `memSecret`（只给来源和指纹）。

## 安全

- 设置 API 只允许本机/同源；密钥与配对码不回显、不写日志。
- 共享密钥等同写权限；快照是明文 gzip，不要放密码。
- 配对接口免鉴权但必须出示 6 位码，且码单次、短有效期、按 IP 限错；仍只建议在可信网络使用。
- 卸载插件默认**不会**删数据；要清本机数据用设置页「删除本机数据」，或打开 `purgeOnUninstall`（实验性）。
- 覆盖前自动备份；不删除记忆文件。
- 安全漏洞请走 [SECURITY.md](SECURITY.md)，不要开公开 issue。

## 开发

```bash
npm test          # node --test test/*.test.mjs
node --check index.js
node --check client.js
```

平板包构建见 `scripts/build-tablet.mjs`（esbuild 打 `dist/index.js`，把 schemastery 打进去；根目录 package.json，无 BOM）。

## 许可

MIT。变更记录见 [CHANGELOG.md](CHANGELOG.md)。
