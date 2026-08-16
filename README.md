# dsh-balance

English | [中文](README.zh.md)

![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)

A Host + Web Client composition plugin for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`): queries the DeepSeek Open Platform account balance and estimates the
current session's spend. Installable via `dsh plugin add`.

![1786767329895](image/README/1786767329895.png)

![1786767316204](image/README/1786767316204.png)

![1786899004009](image/README/1786899004009.png)

## Features

- **Balance**: queries the official `GET https://api.deepseek.com/user/balance`
  using the harness's own `DEEPSEEK_API_KEY` credential (the key travels only
  over a bounded node subprocess's stdin — never in command lines, logs, or UI).
- **Session spend estimate**: folds the provider-reported token usage from the
  session log (uncached input / cache-hit input / output) and prices each step
  with the official peak/off-peak table (peak 9:00–12:00 and 14:00–18:00
  Beijing time). **Estimate only — the official bill is authoritative.**
- **Top-bar chip** (session header): `余额 ¥x | 会话 ≈¥y`, click to refresh;
  hover (500 ms) shows a detail tooltip **below the button**, horizontally
  centered and viewport-clamped.
- **Settings page** (设置 → DeepSeek 余额): balance rows, an auto-refresh
  on/off switch, refresh-interval selector (15 s … 5 min or custom),
  UI-language selector (`auto` follows the host UI / 中文 / English),
  and an editable price table (off-peak / peak per model).
  Changes persist in the settings document across restarts.
- **Model tool**: `deepseek_balance` returns balance + the calling session's
  estimated spend.
- **Pause-aware refresh**: after 2 refresh cycles without a new user or
  assistant message the auto-refresh pauses (5-minute detection cadence); it
  resumes when a new conversation appears. Auto-refresh can also be switched
  off manually (Settings switch or `/dsh-balance auto-refresh off`); while
  off, no queries are issued.
- **Self-contained**: no host-repository changes are required to deploy
  (communication rides the built-in `commands` Remote namespace).

## Installation

Standard (bundle install, recommended):

```sh
dsh plugin --profile web add @lemcae/dsh-balance
```

The installer adds the package to the web profile's dependencies and bundle
list; after restarting `dsh web`, the loader applies the in-package
`cordis.patch.yml` automatically. Verify:

- Open any session → the `余额 ¥x | 会话 ≈¥y` chip appears in the header with
  a hover detail tooltip;
- 设置 → DeepSeek 余额 shows the full card (balance, interval, language, price table);
- Ask the model to call the `deepseek_balance` tool.

Manual install (same mechanism, bypassing the installer): edit
`$DSH_HOME/profiles/web/package.json` — add `"@lemcae/dsh-balance": "<latest version>"` (as on npm) to `dependencies` and `"@lemcae/dsh-balance"` to the
`dsh.profile.bundles` array — then run `pnpm install` in that directory and
restart.

Peer dependencies are the official `@deepseek-ai/*` packages (`^0.1.0-rc.5`
line, covering rc.5 and rc.6; `@deepseek-ai/cordis` ^4.0.1) plus `react`,
provided by the host.

## Usage

- **Chip**: shows `余额 ¥x | 会话 ≈¥y`; click to refresh; hover for details
  (breakdown, model, 更新于, refresh cadence / pause note).
- **Settings**: 设置 → DeepSeek 余额 — balance rows, 自动刷新间隔
  (15 s … 5 min or custom), 自动刷新开关, 界面语言 (auto / 中文 / English), price-table editor (保存 persists), peak-hours hint.
- **Command** (also usable from the command palette): `/dsh-balance [refresh | interval <毫秒> | prices <JSON> | language <auto|zh-CN|en> | auto-refresh <on|off>]`.
- **Tool**: `deepseek_balance` (no arguments).

## Configuration

Settings namespace `dsh-balance`:

| Field                 | Default    | Meaning                                                                                                                      |
| --------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `autoRefresh`       | `true`   | Enable/disable the auto-refresh timer (`/dsh-balance auto-refresh on\|off`)                                                 |
| `refreshIntervalMs` | `30000`  | Active auto-refresh interval (5 000–600 000 ms)                                                                             |
| `language`          | `auto`   | Plugin UI language:`auto` (follow host UI), `zh-CN`, or `en`                                                           |
| `prices`            | see source | `{ models: { deepseek-v4-flash, deepseek-v4-pro, default } }`, each model `{ offPeak, peak }` rates in CNY per 1M tokens |

Prices are picked by Beijing hour: `peak` for 9:00–12:00 and 14:00–18:00,
`offPeak` otherwise.

## Known Limitations and Deferred Work

- **Estimate vs. bill**: the spend is computed from the local session log and
  may differ from the official bill (provider-side caching policy, unlogged
  requests, model renames, price changes). Edit the price table in Settings to
  keep it current.
- **Unknown models** are priced with the `default` entry (v4-flash rates).
- **Subagents** have their own session ids and are not included.
- **Compaction**: a compacted session resets event seqs; the incremental fold
  may keep pre-compaction totals (acceptable for an estimate).
- **Session-log noise**: every auto-refresh runs a slash command, appending
  `command/run` + `command/done` events; pause-downshifting reduces this.
- **Pause recovery latency**: while paused, the client probes once per
  `PAUSED_REFRESH_MS` (5 min); a new conversation resumes the active cadence
  at the next probe, so recovery can lag by up to that interval.
- Balance is cached 10 s; the tool and chip may share one API call per cycle.

## Model Experience

### Request context and condition

#### What the model sees

The tool schema `deepseek_balance` (zero parameters) plus its description,
which states it queries the official balance endpoint with the harness
credential and returns the session spend estimate.

#### Token effect

Zero direct tokens; the tool result is data-dependent (payload with balance,
consumption, prices, idle state).

#### KV Cache effect

Prefix-stable: tool name, description, and schema are constant; the result
varies per call, which does not invalidate prefix reuse.
