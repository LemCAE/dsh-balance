# dsh-balance（DeepSeek 余额查询插件）

## 这是什么

`@lemcae/dsh-balance`：查询 DeepSeek 开放平台余额 + 估算当前会话消耗的组合插件（Host + Web Client 双半）。
独立 npm 包（`dsh-plugin` 生态），经 `dsh plugin --profile web add @lemcae/dsh-balance` 安装；包内 `cordis.patch.yml` 即 `dsh.bundle.patch`。

## 本目录文件

| 文件 | 说明 |
| --- | --- |
| `src/index.ts` | Host 半：settings 注册（含 `language`）、余额拉取、会话消耗增量折叠、`dsh-balance` 命令、`deepseek_balance` 工具 |
| `src/client/index.ts` | Client 半：顶栏徽章、设置页卡片（含界面语言）、Tooltip、命令驱动刷新、中英文案字典 |
| `src/client/balance.module.css` | 界面样式（CSS Module） |
| `cordis.patch.yml` | dsh.bundle patch：web profile 的 `insert` 行 |
| `shared/` | clientBundle 预设 + 平台模块表（自主库复制，勿动） |
| `tsdown.config.ts` / `tsconfig.json` / `package.json` | 构建与包元数据（host/client 双 program） |
| `DEVELOPMENT.md` | 详细开发文档（架构、数据流、构建、排查） |

## 构建与生效

```powershell
cd D:\Project\dsh-balance
pnpm install            # 首次：从 npm 拉 peer/dev 依赖
pnpm typecheck          # tsc -b（lib/types）
pnpm build              # tsc -b + tsdown（lib/index.js + lib/client.js + lib/invariant.js）
```

- 只改 Client 半（`src/client/**`）：重建 bundle 后浏览器硬刷新（Ctrl+F5）即可，无需重启进程。
- 改 Host 半（`src/index.ts`）：重建后重启 `dsh web` 进程（重启会中断当前会话的回合，属预期）。

## 关键约束（踩过的坑，勿回退）

1. **通信自包含**：Client→Host 走 `ctx.remote.commands.execute`（`inject` 必须声明 `'remote.commands'`），结果经命令 `text` 回传 JSON。**不要**改回 `$dispatch`/`ctx.emit` 事件桥（客户端 `$dispatch` 只本地扇出；Host→Client 需改 `api-remotes` 白名单——已还原，勿再加回）。
2. **注入即属性访问**：客户端 ctx 守卫要求属性级 inject（`remote.commands` 必须显式声明），否则运行时报 `cannot get property ... without inject`。
3. **增量读取**：消耗折叠用 `sessionPersistence.readFrom(id, fromSeq)`（`sessionQuery` 没有 readFrom，只有轻量 `listEvents` 与全量 `readSession`）。
4. **命令需要真实会话 ID**：`commands.execute('', ...)` 无效（解析不到 agent）——设置页卡片经 `useSessions(state => state.current)` 取当前会话。
5. **patch 插入方言**：profile patch 加新行必须用 `- insert:\n    - id: ...` 形式；裸 `- id:` 是按 id 覆盖，新 id 会报 `entry not found` 被跳过（包内 `cordis.patch.yml` 即此形式）。
6. **模块解析**：`dsh plugin add` 把包装入 `$DSH_HOME/profiles/web/node_modules` 并登记
   `dsh.profile.bundles`；loader 启动时自动应用包内 `cordis.patch.yml`（`dsh.bundle.patch`）。
   手动安装 = 编辑 `profiles/web/package.json`（dependencies + bundles）后 `pnpm install`。
   旧式 `profiles/node_modules` junction 仅用于早期部署，勿回退。
7. `exactOptionalPropertyTypes` 开启：不要显式传 `prop: undefined`。
8. 生成 Remote 返回 `{ ok, value }` 信封，需解包后再取 `result.text`。
9. **发布用官方 registry**：项目级 `.npmrc` 锁定 `registry=https://registry.npmjs.org/`（用户级是 npmmirror 镜像，登录/发布会打到镜像账号体系）；workflow 的 publish 步骤也显式带 `--registry`。
10. **provenance 与 repository.url**：`--provenance` 时 sigstore 要求 `repository.url` 与 OIDC 仓库标识字符串精确匹配——必须是 `https://github.com/LemCAE/dsh-balance`（无 `git+`、无 `.git`、保留大小写），否则 CI 报 `E422 Error verifying sigstore provenance bundle`。
11. **peer 范围**：`^0.1.0-rc.5`（同时覆盖 rc.5 与 rc.6 宿主），不写 `workspace:`；host 半 `tsconfig.host.json` 必须 `types: ["node"]`（`AbortSignal` 来自 @types/node 全局）。
12. **暂停恢复只认会话日志**：暂停后恢复由 Host 端低频探测会话日志中的 `user/message`、`assistant/message`、`assistant/chunk` 事件驱动；**不要**再用全局 `click`/`keydown` 监听触发探测（普通键鼠不是「新对话」，会造成暂停后高频查询）。
13. **空读不推进游标**：`estimateConsumption` 中仅 `events.length > 0` 时才 `state.seq = lastSeq + 1`；空读保持原位，否则暂停期间低频探测会把 `seq` 推过尚未读到的新对话事件，导致恢复失败。

## 当前状态与待办（2026-08-15）

- **已发布**：npm 0.1.0（手动首发）/ 0.1.2 / 0.1.3 / 0.1.4（CI + provenance）；GitHub Release v0.1.2、v0.1.3、v0.1.4；Trusted Publishing 已配置（无 NPM_TOKEN）
- **已安装并验证**：本机 web profile 经 `dsh plugin add` 登记 bundle；重启 `dsh web` 后运行态验证通过（余额、会话消耗、顶栏徽章/设置卡片可见）
- **0.1.4 已发布**（CI + provenance，workflow run 成功）：暂停自动查询（只认 user/assistant 事件、空读不推进 seq、恢复判定改为观察增量）；设置页界面语言切换（`auto` 跟随主界面 / `zh-CN` / `en`，命令 `language <auto|zh-CN|en>`）；客户端中英文案；tarball 补 `image/`（README 截图）
- **待办**：提交 awesome-dsh-plugin 收录（README.md + README.zh.md 同步）并补 README 徽章

## 验证清单

- `pnpm typecheck && pnpm build`；`pnpm pack --dry-run` 检查 tarball（lib + src + cordis.patch.yml + README）
- 发布：推 `vX.Y.Z` tag → workflow 校验版本、构建、`pnpm publish --tag latest --provenance`、GitHub Release（**Trusted Publishing/OIDC，无需 NPM_TOKEN**；仓库 `repository.url` 必须精确等于 `https://github.com/LemCAE/dsh-balance` 才能通过 sigstore 校验）
- 生态：仓库已打 `dsh-plugin` topic；awesome-dsh-plugin 收录待功能稳定后再提交（README.md + README.zh.md 同步）
- 运行态：顶栏徽章（余额 | 会话 ≈x）、悬停气泡（按钮下方居中）、设置 → DeepSeek 余额（含界面语言切换，auto 跟随主界面）；`Tool.listTools` 含 `deepseek_balance`，调用返回余额 + 消耗 + `nextRefreshMs` + `language`；暂停后普通键鼠不触发查询，发送新消息后在下一次低频探测时恢复

详见 `DEVELOPMENT.md`。
