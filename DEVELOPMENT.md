# dsh-balance 开发文档（DEVELOPMENT）

> 本文档面向维护者与后续会话：说明插件做什么、怎么工作、怎么改、怎么验证，以及本插件开发过程中踩过的全部关键坑。

---

## 1. 概述

`@lemcae/dsh-balance` 是一个 **Host + Web Client 双半组合插件**，作为独立 npm 包发布（`dsh-plugin` 生态），经 `dsh plugin add` 安装：

- **余额**：调用 DeepSeek 官方 `GET https://api.deepseek.com/user/balance`（复用 harness 的 `DEEPSEEK_API_KEY` 凭据）；
- **当前会话消耗估算**：基于本机会话日志中 provider 上报的 token usage（未命中输入 / 缓存命中 / 输出），按官方价目表（旧固定价 → 峰谷价）逐步骤计价；
- **界面**：会话顶栏余额徽章（含按钮下方悬停气泡）、设置 →「DeepSeek 余额」页（余额、刷新间隔、可编辑价目表）；
- **模型工具**：`deepseek_balance`（余额 + 当前会话消耗）。
- **空闲降频**：连续 2 个刷新周期无会话活动 → 自动刷新从设置间隔降为 5 分钟。
- **完全自包含**：不修改宿主仓库任何代码（`api-remotes` 白名单、事件声明均已还原），一个包 + 一个 `dsh.bundle` patch 即可部署。

## 2. 目录与构建

```
dsh-balance/（独立仓库根）
  package.json        # 双半包元数据；dsh.bundle + dsh.client 声明；peer 依赖（^0.1.0-rc.5 线）
  .npmrc              # 锁定官方 registry（用户级 .npmrc 是 npmmirror 镜像，发布/登录必须走官方）
  tsconfig.json       # solution：tsconfig.host.json + tsconfig.client.json
  tsdown.config.ts    # clientBundle preset（shared/）：node 半 + 浏览器 bundle
  cordis.patch.yml    # dsh.bundle.patch：web profile 的 insert 行（loader 自动应用）
  shared/             # clientBundle 预设 + 平台模块表（自主库复制，勿动）
  src/index.ts        # Host 半
  src/client/index.ts # Client 半
  src/client/balance.module.css
  src/css-modules.d.ts
  README.md / README.zh.md / AGENTS.md / DEVELOPMENT.md
```

```powershell
cd D:\Project\dsh-balance
pnpm install                     # 首次：从 npm 拉 peer/dev 依赖
pnpm typecheck                   # tsc -b（lib/types）
pnpm build                       # tsc -b + tsdown（lib/index.js + lib/client.js + lib/invariant.js）
```

Client 半改动 → 重建 + 页面硬刷新即可；Host 半改动 → 重建 + 重启 `dsh web` 进程。

## 3. 通信架构（自包含设计）

**唯一通道：`commands` Remote 命名空间（宿主已内置，无需注册新 Remote）。**

```
Client                                  Host
  ctx.remote.commands.execute(
    sessionId, '/dsh-balance refresh'
  )  ──────────────────────────────────►  commands 服务按 sessionId 解析 agent
                                            → 'dsh-balance' 命令 handler
                                            → buildPayload(sessionId)
                                            → 返回 { kind:'success', text: JSON(payload) }
  ◄──────────────────────────────────  RemoteResult { ok:true, value: CommandExecution }
  解包 value.result.text → JSON.parse → 渲染
```

要点：

- **`inject` 必须声明 `['slots', 'remote', 'remote.commands']`** —— 客户端 ctx 守卫按属性名校验，缺 `remote.commands` 会在运行时抛 `cannot get property "remote.commands" without inject`。
- 生成 Remote 返回 `{ ok, value } | { ok:false, error }` 信封，需解包。
- 自动刷新由**客户端 `setInterval` 自调度**（浏览器原生 timer，非 timer 服务）；间隔取宿主返回的 `nextRefreshMs`（活跃 = 设置间隔，空闲 = 5 分钟）。
- **不要回退到事件桥**：客户端 `ctx.remote.$dispatch` 只做本地扇出（到不了宿主）；Host→Client 事件转发受 `packages/api/remotes/src/remote-events.ts` 白名单控制（曾加过 `dsh-balance/result`、`dsh-balance/config`，后随自包含改造还原）。

## 4. Host 半（src/index.ts）

### 4.1 注入与设置

```ts
export const inject = ['settings', 'tools', 'credentials', 'subprocess', 'sandboxPolicy', 'commands', 'sessionPersistence']
```

settings 命名空间 `dsh-balance`（schemastery 模式）：

```ts
type BalanceSettingsValue = { refreshIntervalMs: number; prices: PriceTable }
// 注册时 base: { refreshIntervalMs: 30000, prices: DEFAULT_PRICE_TABLE }
```

- `refreshIntervalMs`：自动刷新间隔（5000–600000 校验，默认 30000）。
- `prices`：价目表 `{ switchover: ISO, models: { 'deepseek-v4-flash'|'deepseek-v4-pro'|'default': { old, offPeak, peak } } }`。
- 持久化于设置文档，重启不丢；改动经命令 `scope.update` 写入。

### 4.2 余额拉取（为什么用子进程）

Host 沙箱无 `fetch`/`require`；`web.fetch` 只带 URL 不能带 `Authorization` 头且本部署未挂载 fetch provider；实测 curl/Invoke-RestMethod 在沙箱子进程内 schannel TLS 失败（`SEC_E_NO_CREDENTIALS`）。因此：

- `subprocess.spawn({ argv: ['node','-e',脚本], cwd, stdio: { stdin:{data:key+'\n'}, stdout/stderr: collect }, graceMs:5000 })`；
- 子进程脚本用 Node 内置 fetch（OpenSSL）请求官方余额端点，stdout 输出 `{status, body}`；
- **密钥只经 stdin 传递**，不进入命令行/日志/输出；
- `fetchBalanceCached`：成功结果缓存 10 秒（同一周期多会话共享一次子进程与网络往返）。

### 4.3 会话消耗估算（增量折叠）

- 数据：`sessionPersistence.readFrom(sessionId, fromSeq)` 只读 `seq ≥ fromSeq` 的新增事件（`sessionQuery` **没有** readFrom；其 `listEvents` 只返回轻量元数据，`readSession` 全量——均不可用于增量）。
- 每会话状态：`{ seq, uncached, cacheRead, output, cost, model, lastStepKey, lastBuckets, lastTime, lastModel, lastActivity }`。
- 折叠规则：
  - `request/header` → 记当前模型（`data.header.config.model`）；
  - `assistant/message` 带 `data.usage`（`TokenUsage`：`inputTokens`=未命中、`cacheReadTokens`=命中、`outputTokens`）→ 按 `(turn,step)` **last-wins**（同一步重复采样先撤旧再计新，与 harness `tokenUsage` 投影同语义）；
  - 每步按其事件时间 + 当时模型计价：`cost += uncached/1e6×input + cacheRead/1e6×cacheHit + output/1e6×output`。
- 计价表：`switchover = '2026-08-16T16:00:00Z'`（= 2026-08-17 00:00 北京时间）前用 `old`；之后按**北京时间**小时判峰谷（9-12、14-18 为高峰），高峰用 `peak`、其余 `offPeak`。默认价目表由用户提供（v4-flash / v4-pro / default 回退）。
- 已知限制：会话被 compaction 重写 seq 后，增量状态可能停在旧值（估算场景可接受，未处理）。

### 4.4 空闲降频

- 活动事件类型：`user/message`、`assistant/message`、`assistant/chunk`、`tool/result`、`tool/call`；折叠时更新 `lastActivity`（最大事件时间）。
- `idle = lastActivity > 0 && now - lastActivity >= 2 * readInterval()`（默认 30s 周期 → 60s 无活动即降频）。
- payload 携带 `idle` 与 `nextRefreshMs`（空闲 = 300000）。

### 4.5 命令与工具

- 命令 `dsh-balance`（`ctx.commands.register`）：`refresh` / `interval <ms>` / `prices <json>`；成功时 `text` 回传完整 payload JSON（客户端解析）。
- 工具 `deepseek_balance`（`ctx.tools.register(defineTool(...))`）：余额 + 调用方会话（`exec.agent.session.id`）消耗，返回同一 payload 形状。

### 4.6 Payload 形状

```jsonc
{
  "ok": true,
  "data": { "is_available": true, "balance_infos": [{ "currency": "CNY", "total_balance": "9.92", "granted_balance": "0", "topped_up_balance": "9.92" }] },
  "sessionId": "…",
  "fetchedAt": "ISO",
  "intervalMs": 30000,
  "prices": { "switchover": "…", "models": { … } },
  "consumption": { "cost": 5.59, "uncachedInput": 3100763, "cacheRead": 90815744, "output": 334476, "model": "deepseek-v4-flash", "currency": "CNY", "estimated": true } | null,
  "idle": false,
  "nextRefreshMs": 30000
}
```

## 5. Client 半（src/client/index.ts）

- `inject: ['slots', 'remote', 'remote.commands']`。
- **顶栏徽章**（`conversation.session.header.utilities`，注册 `id: 'dsh-balance'`）：
  - 从 slot props 取 `sessionId`；`useEffect` 驱动「立即刷新 + `setInterval(nextMs)` 自调度」，`inFlight` 防重入；
  - 点击按钮 = 手动刷新；悬停 500ms（浏览器 `setTimeout`，非 timer 服务）显示气泡；
  - **气泡定位**：按钮正下方（`top = tip.bottom + 10`、`transform: translateY(0)`），水平以按钮中心居中，视口边缘 12px 夹紧。
- **设置页卡片**（`settings.section`，`id: 'dsh-balance'`）：
  - 渲染器经标准 props `useSessions(state => state.current)` 取当前会话 ID（命令需要真实 ID，`''` 无效）；无会话时显示提示；
  - 余额行 + 刷新间隔下拉 + 价目表网格（4 列：行标签/旧价/空闲/高峰，模型分块子标题）；
  - 价格编辑为草稿态，点「保存」走 `prices` 命令持久化。
- `runCommand`：`commands.execute` → 解 `{ok,value}` 信封 → `value.result.text` JSON.parse；失败返回 null（静默降级）。
- 无 `$on`/事件订阅；无 `styles.insert`（CSS Module）。

## 6. 部署接线（安装方式）

1. **标准方式：`dsh plugin` 安装**（从 npm 拉包）：
   ```sh
   dsh plugin --profile web add @lemcae/dsh-balance
   ```
   安装器把包加入 `$DSH_HOME/profiles/web/package.json` 的 `dependencies` 与
   `dsh.profile.bundles` 列表（包实体落在 `profiles/web/node_modules/@lemcae/dsh-balance`）；
   **重启 `dsh web` 后 loader 自动应用包内 `cordis.patch.yml`**（`dsh.bundle.patch` 机制），
   无需手写 profile patch 行。
2. **手动安装**（同一机制，绕过安装器）：编辑 `$DSH_HOME/profiles/web/package.json`——
   `dependencies` 加 `"@lemcae/dsh-balance": "^0.1.3"`，`dsh.profile.bundles` 数组加
   `"@lemcae/dsh-balance"`——然后在该目录 `pnpm install` 并重启。
3. **升级**：`pnpm dsh plugin --profile web update @lemcae/dsh-balance`（或改依赖范围后重装）。
4. **重启**：重启 `dsh web` 进程。patch 行/新包本身可热重载，但**包代码改动**（host 模块）
   需重启进程；client bundle 刷新页面即生效。

## 7. 验证清单

```powershell
cd D:\Project\dsh-balance
pnpm typecheck && pnpm build                  # 构建门禁
pnpm pack --dry-run                           # 检查 tarball 内容（lib + src + cordis.patch.yml + README）
# 安装后（dsh web 重启）：
# 页面：顶栏徽章、悬停气泡（按钮下方）、设置页卡片、间隔/价格编辑生效且刷新后保留
```
- 本会话 `Tool.listTools` 应含 `deepseek_balance`；调用返回余额 + 消耗 + `nextRefreshMs`。
- 安装检查：`$DSH_HOME/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles`
  含 `@lemcae/dsh-balance`；`profiles/web/node_modules/@lemcae/dsh-balance` 存在。

## 8. 故障排查速查表（本插件历史问题）

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| 徽章/卡片一直「查询中」 | 客户端 `$dispatch` 只本地扇出；或事件未在白名单 | 改为 `commands.execute` 通道（现状） |
| `cannot get property "remote.commands" without inject` | client `inject` 缺 `'remote.commands'` | 补注入声明 |
| 消耗恒 0 / 未知模型 | `sessionQuery` 无 `readFrom`（调用即抛错被 catch）；或串会话结果 | 用 `sessionPersistence.readFrom` + payload 带 `sessionId` |
| 设置页无结果 | `commands.execute('', …)` 解析不到 agent | 用 `useSessions` 取当前会话 ID |
| 工具返回 `consumption: null` | `exec.agent.session.id` 取不到时降级为 null（会话恢复瞬间） | 属预期降级 |
| patch 行不生效 | 裸 `- id:` 是覆盖语义 | 用 `- insert:` |
| 包解析不到 | 模块链接缺失（手动安装路径） | 用 `dsh plugin add` 或建 junction |
| 气泡不显示 | 曾用 client timer 服务（不可靠） | 改浏览器 `setTimeout` |
| 构建报 `exactOptionalPropertyTypes` | 显式传 `prop: undefined` | 条件构造 props |

## 9. 发布要点

- **发布开关 = 推送 `vX.Y.Z` tag**：`.github/workflows/release.yml` 校验 tag == `package.json` 版本（`scripts/verify-version.mjs`）→ typecheck → build → `pnpm publish --access public --tag latest` → `gh release create`。**认证走 npm Trusted Publishing（OIDC，`id-token: write`）**，无需 NPM_TOKEN secret；一次性前置：npm 注册用户 `lemcae` → 本机手动首发 `0.1.0`（`npm login` + `pnpm publish`）→ npm 包设置页把 `LemCAE/dsh-balance`（workflow `release.yml`）添加为可信发布者。
- peer 依赖由消费者（dsh 宿主）自行提供（`@deepseek-ai/*` 系列 + `react`）；peer 范围写真实版本（`^0.1.0-rc.5`，兼容 rc.5 与 rc.6 宿主），不写 `workspace:`。
- 生态收录：仓库打 `dsh-plugin` topic；向 awesome-dsh-plugin 提交一行条目（README.md + README.zh.md 同步），其站点每日生成 plugins.json 供 dsh-market 白名单使用。
- 已知代价：每次自动刷新都会写入 `command/run` + `command/done` 两条会话日志事件（空闲降频后大幅减少）。
