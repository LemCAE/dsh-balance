/**
 * DeepSeek Open Platform balance and session consumption readout.
 *
 * Host half: resolves the harness's own DEEPSEEK_API_KEY credential, queries
 * the official balance endpoint through a bounded node subprocess (the API key
 * travels only over the child's stdin), estimates the current session's spend
 * from durable per-step provider usage (uncached input / cache reads / output)
 * against the official price table (old fixed table until 2026-08-16 23:59
 * Beijing time, then the peak/off-peak table). The page pulls everything on
 * demand over the built-in commands Remote namespace:
 *
 *   client ctx.remote.commands.execute(sessionId, '/dsh-balance refresh')
 *     -> host command handler -> builds payload -> returns JSON text
 *   client ... '/dsh-balance interval <ms>' / '/dsh-balance prices <json>'
 *     -> host updates settings and returns a fresh payload
 *   client timer -> periodic '/dsh-balance refresh' per returned nextRefreshMs
 *     (active interval; paused detection interval after 2 quiet cycles)
 *
 * The model-facing tool `deepseek_balance` returns the same payload shape.
 */

import { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'

// ─── Price table (元 per 1M tokens, from the official pricing page) ─────────

export type RateSet = {
  /** 输入（缓存未命中）每百万 tokens 单价（元）。 */
  input: number
  /** 输入（缓存命中）每百万 tokens 单价（元）。 */
  cacheHit: number
  /** 输出每百万 tokens 单价（元）。 */
  output: number
}

export type ModelPrices = {
  /** 旧价目表（2026-08-17 前生效的固定价格）。 */
  old: RateSet
  /** 新价目表·空闲时段。 */
  offPeak: RateSet
  /** 新价目表·高峰时段。 */
  peak: RateSet
}

export type PriceTable = {
  /** 新旧价目切换时刻（ISO 8601）。2026-08-17 00:00 北京时间 = 2026-08-16T16:00:00Z。 */
  switchover: string
  models: Record<string, ModelPrices>
}

export type BalanceInfo = {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
}

export type BalanceResult =
  | { ok: true; data: { is_available: boolean; balance_infos: BalanceInfo[] } }
  | { ok: false; error: string }

export type ConsumptionInfo = {
  cost: number
  uncachedInput: number
  cacheRead: number
  output: number
  model: string | null
  currency: string
  estimated: boolean
}

const RATE = (input: number, cacheHit: number, output: number): RateSet => ({ input, cacheHit, output })

/** 新旧价目切换点：2026-08-17 00:00 北京时间。 */
export const DEFAULT_SWITCHOVER = '2026-08-16T16:00:00Z'

export const DEFAULT_PRICE_TABLE: PriceTable = {
  switchover: DEFAULT_SWITCHOVER,
  models: {
    'deepseek-v4-flash': {
      old: RATE(1, 0.02, 2),
      offPeak: RATE(1.5, 0.05, 4.5),
      peak: RATE(3, 0.1, 9),
    },
    'deepseek-v4-pro': {
      old: RATE(3, 0.025, 6),
      offPeak: RATE(4.5, 0.15, 13.5),
      peak: RATE(9, 0.3, 27),
    },
    // 未在表中列出的模型按 v4-flash 估算。
    'default': {
      old: RATE(1, 0.02, 2),
      offPeak: RATE(1.5, 0.05, 4.5),
      peak: RATE(3, 0.1, 9),
    },
  },
}

const RateSetSchema = z.object({
  input: z.number().default(0),
  cacheHit: z.number().default(0),
  output: z.number().default(0),
})
const ModelPricesSchema = z.object({
  old: RateSetSchema,
  offPeak: RateSetSchema,
  peak: RateSetSchema,
})
const PriceTableSchema = z.object({
  switchover: z.string().default(DEFAULT_SWITCHOVER),
  models: z.object({
    'deepseek-v4-flash': ModelPricesSchema,
    'deepseek-v4-pro': ModelPricesSchema,
    'default': ModelPricesSchema,
  }),
})
type BalanceSettingsValue = { refreshIntervalMs: number; prices: PriceTable; language: 'auto' | 'zh-CN' | 'en' }

const BalanceSettingsSchema = z.object({
  refreshIntervalMs: z.number().default(30000),
  prices: PriceTableSchema,
  language: z.string().default('auto'),
}) as unknown as z<BalanceSettingsValue>

export const name = 'dsh-balance'
export const inject = ['settings', 'tools', 'credentials', 'subprocess', 'sandboxPolicy', 'commands', 'sessionPersistence']

// ─── Subprocess seam shapes (structural; no host type imports needed) ───────

interface SubprocessSeam {
  resolveExecutable(command: string): Promise<string>
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: { data: string }
      stdout: { mode: 'collect'; maxBytes: number }
      stderr: { mode: 'collect'; maxBytes: number }
    }
    graceMs: number
    signal?: AbortSignal | undefined
  }): {
    done: Promise<{ exitCode: number | null }>
    collected: {
      stdout?: { readFrom(offset: number): { text: string } }
      stderr?: { readFrom(offset: number): { text: string } }
    }
  }
}

interface CredentialsSeam {
  resolve(ref: string): Promise<{ value?: string | undefined } | string | undefined>
}

interface SessionPersistenceSeam {
  /** 读取某会话 seq ≥ fromSeq 的新增事件（增量折叠，避免全量回放）。 */
  readFrom(sessionId: string, fromSeq: number): Promise<{ events: readonly unknown[] }>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 结构校验一次价格表更新（沿用默认表形状 + 数值非负）。 */
function isPriceTable(value: unknown): value is PriceTable {
  if (!isRecord(value) || typeof value.switchover !== 'string') return false
  const models = value.models
  if (!isRecord(models)) return false
  for (const key of ['deepseek-v4-flash', 'deepseek-v4-pro', 'default']) {
    const entry = models[key]
    if (!isRecord(entry)) return false
    for (const phase of ['old', 'offPeak', 'peak'] as const) {
      const rates = entry[phase]
      if (!isRecord(rates)) return false
      for (const field of ['input', 'cacheHit', 'output'] as const) {
        const num = rates[field]
        if (typeof num !== 'number' || !Number.isFinite(num) || num < 0) return false
      }
    }
  }
  return true
}

/** 北京时间小时（无论宿主机时区）。 */
function beijingHour(when: Date): number {
  return new Date(when.getTime() + 8 * 3600 * 1000).getUTCHours()
}

/** 按请求时间选出适用的单价：旧表（切换点前）或新表峰/谷。 */
function priceFor(table: PriceTable, model: string | undefined, when: Date): RateSet {
  const entry = model !== undefined && isRecord(table.models) && isRecord(table.models[model])
    ? table.models[model] as ModelPrices
    : isRecord(table.models) && isRecord(table.models['default'])
      ? table.models['default'] as ModelPrices
      : DEFAULT_PRICE_TABLE.models['default'] as ModelPrices
  if (when.getTime() < new Date(table.switchover).getTime()) return entry.old
  const hour = beijingHour(when)
  const peak = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
  return peak ? entry.peak : entry.offPeak
}

export function apply(ctx: Context): void {
  const ns = settingsNamespace('dsh-balance')
  const scope = ctx.settings.register(ns, BalanceSettingsSchema, {
    base: { refreshIntervalMs: 30000, prices: DEFAULT_PRICE_TABLE, language: 'auto' },
  })

  const readInterval = (): number => {
    const ms = scope.get().refreshIntervalMs
    return typeof ms === 'number' && ms >= 5000 && ms <= 600000 ? ms : 30000
  }

  const readPrices = (): PriceTable => {
    const value = scope.get().prices
    return isPriceTable(value) ? value : DEFAULT_PRICE_TABLE
  }

  /** 插件界面语言：auto 表示跟随宿主主界面语言（由客户端解析）。 */
  const readLanguage = (): 'auto' | 'zh-CN' | 'en' => {
    const value = scope.get().language
    return value === 'zh-CN' || value === 'en' ? value : 'auto'
  }

  // ─── 余额查询：密钥只经 node 子进程 stdin 传递 ─────────────────────────

  const fetchBalance = async (signal: AbortSignal | undefined): Promise<BalanceResult> => {
    const creds = ctx.get('credentials') as CredentialsSeam | undefined
    if (creds === undefined) return { ok: false, error: '凭据服务不可用，无法解析 API Key' }
    let key: string | undefined
    try {
      const resolved = await creds.resolve('DEEPSEEK_API_KEY')
      key = typeof resolved === 'string'
        ? resolved
        : isRecord(resolved) && typeof resolved.value === 'string'
          ? resolved.value
          : undefined
    } catch (error) {
      return { ok: false, error: `解析 DEEPSEEK_API_KEY 失败: ${errorText(error)}` }
    }
    if (key === undefined || key.length === 0) {
      return { ok: false, error: '未配置 DEEPSEEK_API_KEY，请到 设置 → Models 页面配置 API Key 后重试' }
    }

    const sub = ctx.get('subprocess') as SubprocessSeam | undefined
    if (sub === undefined) return { ok: false, error: '子进程服务不可用' }
    let node: string
    try {
      node = await sub.resolveExecutable('node')
    } catch (error) {
      try {
        node = await sub.resolveExecutable('node.exe')
      } catch (error2) {
        return { ok: false, error: `无法解析 node 可执行文件: ${errorText(error2)}` }
      }
    }

    // 子进程脚本：从 stdin 读密钥，调用官方余额端点，stdout 输出 {status, body}。
    const script = "let k='';process.stdin.on('data',d=>{k+=d});process.stdin.on('end',async()=>{try{const r=await fetch('https://api.deepseek.com/user/balance',{headers:{Authorization:'Bearer '+k.trim()},signal:AbortSignal.timeout(15000)});const b=await r.text();process.stdout.write(JSON.stringify({status:r.status,body:b}))}catch(e){process.stdout.write(JSON.stringify({status:0,body:String((e&&e.message)||e)}))}}) "

    let cwd = '.'
    const policy = ctx.get('sandboxPolicy') as { workspaceRoot?: unknown } | undefined
    if (policy !== undefined && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0) {
      cwd = policy.workspaceRoot
    }

    let handle: ReturnType<SubprocessSeam['spawn']>
    try {
      handle = sub.spawn({
        argv: [node, '-e', script],
        cwd,
        stdio: {
          stdin: { data: `${key}\n` },
          stdout: { mode: 'collect', maxBytes: 20000 },
          stderr: { mode: 'collect', maxBytes: 4096 },
        },
        graceMs: 5000,
        signal,
      })
    } catch (error) {
      return { ok: false, error: `启动余额查询子进程失败: ${errorText(error)}` }
    }

    let outcome: { exitCode: number | null }
    try {
      outcome = await handle.done
    } catch (error) {
      return { ok: false, error: `余额查询子进程启动失败: ${errorText(error)}` }
    }
    if (outcome.exitCode !== 0) {
      let detail = ''
      const stderr = handle.collected.stderr
      if (stderr !== undefined) {
        detail = stderr.readFrom(0).text.trim().slice(0, 300)
      }
      return {
        ok: false,
        error: `余额查询子进程异常退出 (code ${String(outcome.exitCode)})${detail.length > 0 ? `: ${detail}` : ''}`,
      }
    }

    let raw: { status?: unknown; body?: unknown }
    try {
      const stdout = handle.collected.stdout
      const text = stdout !== undefined ? stdout.readFrom(0).text : ''
      raw = JSON.parse(text || '{}') as { status?: unknown; body?: unknown }
    } catch (error) {
      return { ok: false, error: `无法解析余额查询结果: ${errorText(error)}` }
    }

    if (raw.status === 200 && typeof raw.body === 'string') {
      try {
        const data = JSON.parse(raw.body) as Record<string, unknown>
        const infos = Array.isArray(data.balance_infos)
          ? data.balance_infos
            .filter(isRecord)
            .map((item) => ({
              currency: String(item.currency ?? ''),
              total_balance: String(item.total_balance ?? ''),
              granted_balance: String(item.granted_balance ?? ''),
              topped_up_balance: String(item.topped_up_balance ?? ''),
            }))
          : []
        return {
          ok: true,
          data: { is_available: data.is_available === true, balance_infos: infos },
        }
      } catch (error) {
        return { ok: false, error: `余额数据解析失败: ${errorText(error)}` }
      }
    }
    if (raw.status === 401 || raw.status === 403) {
      return { ok: false, error: `API Key 无效或已过期 (HTTP ${String(raw.status)})` }
    }
    if (raw.status === 429) {
      return { ok: false, error: '请求过于频繁 (HTTP 429)，请稍后重试' }
    }
    if (raw.status === 0) {
      return { ok: false, error: `无法连接 DeepSeek API: ${String(raw.body ?? '').slice(0, 300)}` }
    }
    return {
      ok: false,
      error: `DeepSeek API 返回异常状态码 ${String(raw.status)}: ${String(raw.body ?? '').slice(0, 500)}`,
    }
  }

  // ─── 会话消耗估算：增量折叠（只读新增事件），按步骤 (turn,step) 归并 ────

  interface ConsumptionState {
    seq: number
    uncached: number
    cacheRead: number
    output: number
    cost: number
    model: string | null
    lastStepKey: string | null
    lastBuckets: { uncached: number; cacheRead: number; output: number } | null
    lastTime: Date
    lastModel: string | null
    /** 最近一次新对话（用户消息或助手回复）的毫秒时间戳。 */
    lastActivity: number
  }

  const consumptionStates = new Map<string, ConsumptionState>()

  /** 视为“新对话”的事件：用户消息与助手回复（含流式增量）；工具/命令等内部事件不计入。 */
  const ACTIVITY_TYPES = new Set(['user/message', 'assistant/message', 'assistant/chunk'])

  /** 暂停自动查询后的探测间隔：低频轮询以便在新对话出现后恢复。 */
  const PAUSED_REFRESH_MS = 300000

  const costOf = (
    buckets: { uncached: number; cacheRead: number; output: number },
    price: RateSet,
  ): number =>
    buckets.uncached / 1e6 * price.input
    + buckets.cacheRead / 1e6 * price.cacheHit
    + buckets.output / 1e6 * price.output

  const estimateConsumption = async (
    sessionId: string,
    table: PriceTable,
  ): Promise<ConsumptionInfo | null> => {
    const store = ctx.get('sessionPersistence') as SessionPersistenceSeam | undefined
    if (store === undefined) return null
    let state = consumptionStates.get(sessionId)
    if (state === undefined) {
      state = {
        seq: 0,
        uncached: 0,
        cacheRead: 0,
        output: 0,
        cost: 0,
        model: null,
        lastStepKey: null,
        lastBuckets: null,
        lastTime: new Date(0),
        lastModel: null,
        lastActivity: 0,
      }
      consumptionStates.set(sessionId, state)
    }
    try {
      // sessionPersistence.readFrom 只读 seq ≥ state.seq 的新增事件；
      // 首次调用即全量（一次），之后为增量。
      const snapshot = await store.readFrom(sessionId, state.seq)
      const events = Array.isArray(snapshot.events) ? snapshot.events : []
      let lastSeq = state.seq
      let currentModel: string | undefined = state.model ?? undefined
      for (const record of events) {
        if (!isRecord(record)) continue
        const seq = record['seq']
        if (typeof seq === 'number' && seq >= lastSeq) lastSeq = seq
        const data = record['data']
        const time = record['time']
        // 新对话追踪：仅统计用户消息与助手回复（含流式增量）；命令/工具等内部事件不计入。
        if (typeof time === 'number' && typeof record['type'] === 'string' && ACTIVITY_TYPES.has(record['type'] as string)) {
          if (time > state.lastActivity) state.lastActivity = time
        }
        if (record['type'] === 'request/header' && isRecord(data)) {
          const header = data['header']
          const config = isRecord(header) ? header['config'] : undefined
          const model = isRecord(config) ? config['model'] : undefined
          if (typeof model === 'string' && model.length > 0) currentModel = model
          continue
        }
        if (record['type'] !== 'assistant/message' || !isRecord(data)) continue
        const usage = data['usage']
        if (!isRecord(usage)) continue
        const inputTokens = usage['inputTokens']
        const outputTokens = usage['outputTokens']
        if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') continue
        const cacheRead = usage['cacheReadTokens']
        const stepKey = `${String(data['turn'])}:${String(data['step'])}`
        const buckets = {
          uncached: inputTokens,
          cacheRead: typeof cacheRead === 'number' ? cacheRead : 0,
          output: outputTokens,
        }
        const when = typeof time === 'number' ? new Date(time) : new Date()
        // 同一步的重复采样（usage chunk 与 assistant/message）：先撤下旧采样再计入新采样。
        const previous = state.lastStepKey === stepKey ? state.lastBuckets : null
        if (previous !== null) {
          state.cost -= costOf(previous, priceFor(table, state.lastModel ?? undefined, state.lastTime))
          state.uncached -= previous.uncached
          state.cacheRead -= previous.cacheRead
          state.output -= previous.output
        }
        state.cost += costOf(buckets, priceFor(table, currentModel, when))
        state.uncached += buckets.uncached
        state.cacheRead += buckets.cacheRead
        state.output += buckets.output
        state.lastStepKey = stepKey
        state.lastBuckets = buckets
        state.lastTime = when
        state.lastModel = currentModel ?? null
      }
      // 仅当本批有新增事件时才推进游标；空读保持原位，避免暂停期间
      // 低频探测把 seq 推过尚未读到的新对话事件，导致恢复检测失败。
      if (events.length > 0) state.seq = lastSeq + 1
      state.model = currentModel ?? null
      return {
        cost: state.cost,
        uncachedInput: state.uncached,
        cacheRead: state.cacheRead,
        output: state.output,
        model: currentModel ?? null,
        currency: 'CNY',
        estimated: true,
      }
    } catch (error) {
      return null
    }
  }

  // 余额 10 秒缓存：同一推送周期内多个会话共享一次子进程与网络往返。
  let balanceCache: { at: number; result: BalanceResult } | undefined
  const fetchBalanceCached = async (signal: AbortSignal | undefined): Promise<BalanceResult> => {
    if (balanceCache !== undefined && Date.now() - balanceCache.at < 10000) return balanceCache.result
    const result = await fetchBalance(signal)
    balanceCache = { at: Date.now(), result }
    return result
  }

  const buildPayload = async (sessionId: string | undefined): Promise<Record<string, unknown>> => {
    const balance = await fetchBalanceCached(undefined)
    const table = readPrices()
    const stateBefore = sessionId !== undefined ? consumptionStates.get(sessionId) : undefined
    const lastActivityBefore = stateBefore?.lastActivity ?? 0
    const consumption = sessionId === undefined || sessionId.length === 0
      ? null
      : await estimateConsumption(sessionId, table)
    const state = sessionId !== undefined ? consumptionStates.get(sessionId) : undefined
    const lastActivity = state?.lastActivity ?? 0
    // 恢复优先：本次检查观察到新对话（lastActivity 变大）立即恢复活跃刷新；
    // 否则连续 2 个刷新周期（2 × 设置的间隔）无新对话即暂停自动查询。
    // 暂停期间仍以 PAUSED_REFRESH_MS 低频探测，直到某次探测发现新对话。
    const observedNewConversation = lastActivity > lastActivityBefore
    const idle = observedNewConversation
      ? false
      : lastActivity > 0 && Date.now() - lastActivity >= 2 * readInterval()
    return {
      ...balance,
      sessionId: sessionId ?? null,
      fetchedAt: new Date().toISOString(),
      intervalMs: readInterval(),
      prices: table,
      consumption,
      idle,
      language: readLanguage(),
        nextRefreshMs: idle ? PAUSED_REFRESH_MS : readInterval(),
    }
  }

  // ─── 命令入口（Client 经 ctx.remote.commands.execute 调用，结果以 JSON 文本回传）─

  ctx.commands.register({
    name: 'dsh-balance',
    description: '查询 DeepSeek 开放平台余额与当前会话消耗；或设置自动刷新间隔与价目表。',
    input: { hint: 'refresh | interval <毫秒> | prices <JSON> | language <auto|zh-CN|en>' },
    recordInput: true,
    handler: async (invocation) => {
      const sessionId = String(invocation.agent.session.id)
      const raw = (invocation.rawInput ?? '').trim()
      if (raw === '' || raw === 'refresh') {
        const payload = await buildPayload(sessionId)
        return { kind: 'success', text: JSON.stringify(payload) }
      }
      const intervalMatch = raw.match(/^interval\s+(\d+)$/)
      if (intervalMatch !== null) {
        const ms = Number(intervalMatch[1])
        if (!(ms >= 5000 && ms <= 600000)) {
          return { kind: 'error', text: '刷新间隔需在 5000 到 600000 毫秒之间' }
        }
        await scope.update({ refreshIntervalMs: ms })
        const payload = await buildPayload(sessionId)
        return { kind: 'success', text: JSON.stringify(payload) }
      }
      const pricesMatch = raw.match(/^prices\s+(\{.*\})$/s)
      if (pricesMatch !== null) {
        let parsed: unknown
        try {
          parsed = JSON.parse(pricesMatch[1]!)
        } catch {
          return { kind: 'error', text: '价目表 JSON 解析失败' }
        }
        if (!isPriceTable(parsed)) {
          return { kind: 'error', text: '价目表结构无效（需含 switchover 与三个模型的 old/offPeak/peak 单价）' }
        }
        await scope.update({ prices: parsed })
        const payload = await buildPayload(sessionId)
        return { kind: 'success', text: JSON.stringify(payload) }
      }
        const languageMatch = raw.match(/^language\s+(auto|zh-CN|en)$/)
        if (languageMatch !== null) {
          await scope.update({ language: languageMatch[1]! as 'auto' | 'zh-CN' | 'en' })
          const payload = await buildPayload(sessionId)
          return { kind: 'success', text: JSON.stringify(payload) }
        }
      return { kind: 'error', text: '用法：dsh-balance [refresh | interval <毫秒> | prices <JSON> | language <auto|zh-CN|en>]' }
    },
  })

  // ─── 模型工具 ──────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'deepseek_balance',
    description: '查询当前用户的 DeepSeek 开放平台账户余额与可用状态（is_available 与各币种总余额/赠送/充值）；'
      + '并给出当前会话的预估消耗金额（基于本机会话日志的输入/缓存命中/输出 token，按官方价目表估算，仅供参考）。'
      + '使用 harness 已配置的 DEEPSEEK_API_KEY 调用官方 GET https://api.deepseek.com/user/balance，无参数。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const agent = (exec as { agent?: { session?: { id?: unknown } } | undefined }).agent
      const sessionId = agent !== undefined && agent.session !== undefined
        && typeof agent.session.id === 'string'
        ? agent.session.id
        : undefined
      const balance = await fetchBalanceCached(exec.signal)
      const table = readPrices()
      const consumption = sessionId === undefined
        ? null
        : await estimateConsumption(sessionId, table)
      const payload: JsonValue = balance.ok === true
        ? {
            ok: true,
            data: balance.data,
            fetchedAt: new Date().toISOString(),
            intervalMs: readInterval(),
              language: readLanguage(),
            prices: table,
            consumption,
          }
        : {
            ok: false,
            error: balance.error,
            fetchedAt: new Date().toISOString(),
            intervalMs: readInterval(),
              language: readLanguage(),
            prices: table,
            consumption,
          }
      return payload
    },
  }))
}
