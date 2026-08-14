# dsh-balance

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DeepSeek Open Platform balance and current-session spend estimate — a permanent
Host + Web Client composition plugin for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`), installable via `dsh plugin add`.

## Features

- **Balance**: queries the official `GET https://api.deepseek.com/user/balance`
  using the harness's own `DEEPSEEK_API_KEY` credential (the key travels only
  over a bounded node subprocess's stdin — never in command lines, logs, or UI).
- **Session spend estimate**: folds the provider-reported token usage from the
  session log (uncached input / cache-hit input / output) and prices each step
  with the official table (old fixed prices until 2026-08-16 23:59 Beijing
  time, then peak/off-peak pricing with peak 9:00–12:00 and 14:00–18:00
  Beijing time). **Estimate only — the official bill is authoritative.**
- **Top-bar chip** (session header): `余额 ¥x | 会话 ≈¥y`, click to refresh;
  hover (500 ms) shows a detail tooltip **below the button**, horizontally
  centered and viewport-clamped.
- **Settings page** (设置 → DeepSeek 余额): balance, refresh-interval selector,
  and an editable price table (old / off-peak / peak per model). Changes
  persist in the settings document.
- **Model tool**: `deepseek_balance` returns balance + the calling session's
  estimated spend.
- **Idle-aware refresh**: after 2 refresh cycles without session activity the
  auto-refresh drops to 5 minutes; it resumes on activity.
- **Self-contained**: no host-repository changes are required to deploy
  (communication rides the built-in `commands` Remote namespace).

## Installation

```sh
dsh plugin --profile web add @lemcae/dsh-balance
```

Restart `dsh web` (or refresh the page once the host module is up), then open
a session: the balance chip appears in the session header, and 设置 →
DeepSeek 余额 shows the full card.

Manual install (same mechanism, no market involved): add the bundle row to the
web profile patch (`$DSH_HOME/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-balance
      name: '@lemcae/dsh-balance'
```

Peer dependencies are the official `@deepseek-ai/*` packages (^0.1.0-rc.6
line, `@deepseek-ai/cordis` ^4.0.1) plus `react`.

## Usage

- **Chip**: shows `余额 ¥x | 会话 ≈¥y`; click to refresh; hover for details
  (breakdown, model, 更新于, refresh cadence / idle note).
- **Settings**: 设置 → DeepSeek 余额 — balance rows, 自动刷新间隔
  (15 s … 5 min), price-table editor (保存 persists), switchover hint.
- **Command** (also usable from the command palette): `/dsh-balance
  [refresh | interval <毫秒> | prices <JSON>]`.
- **Tool**: `deepseek_balance` (no arguments).

## Configuration

Settings namespace `dsh-balance`:

| Field | Default | Meaning |
| --- | --- | --- |
| `refreshIntervalMs` | `30000` | Active auto-refresh interval (5 000–600 000 ms) |
| `prices` | see source | `{ switchover, models: { deepseek-v4-flash, deepseek-v4-pro, default } }`, each model `{ old, offPeak, peak }` rates in CNY per 1M tokens |

`switchover` default `2026-08-16T16:00:00Z` (2026-08-17 00:00 Beijing); before
it the `old` rates apply, after it peak/off-peak by Beijing hour.

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
  `command/run` + `command/done` events; idle-downshifting reduces this.
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

## Development

- `pnpm install` then `pnpm build` (tsc -b + tsdown); `pnpm typecheck` for
  types only.
- Client-half changes: rebuild + hard-refresh the page. Host-half changes:
  rebuild + restart the `dsh web` process.
- See `DEVELOPMENT.md` for architecture, data flow, verify steps, and the
  troubleshooting table. `AGENTS.md` carries the key constraints for other
  sessions working in this repository.

## Release

Pushing a `vX.Y.Z` tag is the release switch: the [release workflow](.github/workflows/release.yml)
verifies the tag matches `package.json` version, typechecks, builds, publishes
`@lemcae/dsh-balance` to npm (`latest` dist-tag), and creates the GitHub
Release.

Publishing uses **npm Trusted Publishing** (OIDC) — no long-lived npm token in
GitHub secrets. One-time setup: register the npm user `lemcae`, publish
`0.1.0` once from a local machine (`npm login` then `pnpm publish --access
public --no-git-checks`), then allow `LemCAE/dsh-balance` (workflow
`release.yml`) as a trusted publisher on the package's npm settings page.

Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to this
repository so the community can discover it, and submit a one-line entry to
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
