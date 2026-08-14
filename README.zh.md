# dsh-balance（DeepSeek 余额查询）

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) | 中文

DeepSeek 开放平台余额与当前会话消耗估算——[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的
常驻组合插件（Host + Web Client 双半），可通过 `dsh plugin add` 安装。

## 功能

- **余额查询**：调用官方 `GET https://api.deepseek.com/user/balance`，复用 harness 自身的
  `DEEPSEEK_API_KEY` 凭据（与 Models 页同一把）。密钥只经有界 node 子进程的 stdin 传递，
  不进入命令行、日志或任何输出。
- **当前会话消耗估算**：从会话日志折叠 provider 上报的 token 用量（未命中输入 / 缓存命中 / 输出），
  按官方价目表逐步骤计价（2026-08-16 23:59 北京时间前为旧固定价；之后按峰谷价，
  高峰 9-12 / 14-18 北京时间）。**仅为估算，以官方账单为准。**
- **顶栏徽章**（会话头部）：`余额 ¥x | 会话 ≈¥y`，点击刷新；悬停 500ms 显示明细气泡
  （**按钮正下方**、水平居中、视口边缘自动夹紧）。
- **设置页**（设置 → DeepSeek 余额）：余额、自动刷新间隔下拉、可编辑价目表
  （旧价 / 空闲 / 高峰 × 模型）。改动持久化于设置文档。
- **模型工具**：`deepseek_balance`——余额 + 调用方会话的预估消耗。
- **空闲降频**：连续 2 个刷新周期无会话活动后，自动刷新降为 5 分钟，有活动即恢复。
- **完全自包含**：部署无需修改宿主仓库任何代码（通信走内置 `commands` Remote 命名空间）。

## 安装

```sh
dsh plugin --profile web add @lemcae/dsh-balance
```

重启 `dsh web`（host 模块就绪后刷新页面即可），打开任意会话：顶栏出现余额徽章，
设置 → DeepSeek 余额 显示完整卡片。

手动安装（同一机制，不经过市场）：在 web profile patch（`$DSH_HOME/profiles/web/cordis.patch.yml`）加行：

```yaml
- insert:
    - id: dsh-balance
      name: '@lemcae/dsh-balance'
```

Peer 依赖为官方 `@deepseek-ai/*` 包（^0.1.0-rc.6 线，`@deepseek-ai/cordis` ^4.0.1）与 `react`。

## 使用

- **徽章**：显示 `余额 ¥x | 会话 ≈¥y`；点击刷新；悬停查看明细（构成、模型、更新于、刷新节奏/空闲提示）。
- **设置页**：余额行、「自动刷新间隔」（15 秒 … 5 分钟）、价目表编辑（「保存」持久化）、切换时刻提示。
- **命令**（命令面板也可用）：`/dsh-balance [refresh | interval <毫秒> | prices <JSON>]`。
- **工具**：`deepseek_balance`（无参数）。

## 配置

settings 命名空间 `dsh-balance`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `refreshIntervalMs` | `30000` | 活跃时自动刷新间隔（5000–600000 毫秒） |
| `prices` | 见源码 | `{ switchover, models: { deepseek-v4-flash, deepseek-v4-pro, default } }`，每模型 `{ old, offPeak, peak }`，单位：元 / 百万 tokens |

`switchover` 默认 `2026-08-16T16:00:00Z`（北京时间 2026-08-17 00:00）；此前用 `old` 价，
之后按北京时间的峰谷价。

## Known Limitations and Deferred Work

- **估算与账单的差异**：消耗基于本机会话日志计算，可能与官方账单不一致（平台侧缓存策略、
  未记录请求、模型改名、价格变动等）。可在设置页更新价目表。
- **未知模型**按 `default`（v4-flash）计价。
- **子代理**（subagent）有独立 sessionId，不纳入本会话估算。
- **压缩（compaction）**：会话压缩会重写事件 seq，增量折叠可能停留在压缩前的合计（估算场景可接受）。
- **日志噪声**：每次自动刷新都会执行一次斜杠命令，向会话日志追加 `command/run` 与 `command/done`
  两条事件；空闲降频可大幅减少。
- 余额缓存 10 秒；同一周期内工具与界面共享一次 API 调用。

## Model Experience

### Request context and condition

#### What the model sees

工具 `deepseek_balance` 的 schema（零参数）与描述：声明使用 harness 凭据查询官方余额端点，
并返回当前会话的消耗估算。

#### Token effect

无固定 token 开销；结果为数据相关载荷（余额、消耗、价目表、空闲状态）。

#### KV Cache effect

前缀稳定：工具名、描述与 schema 恒定，结果随调用变化，不影响前缀复用。

## 开发

- `pnpm install` 后 `pnpm build`（tsc -b + tsdown）；仅查类型用 `pnpm typecheck`。
- 只改 Client 半：重建 + 页面硬刷新即可；改 Host 半：重建 + 重启 `dsh web` 进程。
- 架构、数据流、验证步骤与故障排查表见 `DEVELOPMENT.md`；`AGENTS.md` 记录了其他会话
  在本仓库工作时必须遵守的关键约束。

## 发布

推送 `vX.Y.Z` tag 即发布开关：[发布 workflow](.github/workflows/release.yml) 校验 tag 与
`package.json` 版本一致、typecheck、构建、发布 `@lemcae/dsh-balance` 到 npm（`latest` dist-tag）
并创建 GitHub Release。

发布采用 **npm Trusted Publishing（OIDC）**——无需在 GitHub secrets 中长期存放 npm token。
一次性配置：注册 npm 用户 `lemcae`；在本机先手动发布一次 `0.1.0`（`npm login` 后
`pnpm publish --access public --no-git-checks`）；然后在 npm 包设置页把
`LemCAE/dsh-balance`（workflow `release.yml`）添加为可信发布者。

请为本仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 以便社区发现，
并向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
提交一行条目。
