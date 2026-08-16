/**
 * DeepSeek Open Platform balance readout — browser half.
 *
 * Registers two additive surfaces: a compact chip in the session header
 * utility row (balance + estimated current-session spend, tooltip on the LEFT
 * so hovering never covers the button) and a full card in the Settings →
 * DeepSeek 余额 page (breakdown, refresh-interval selector, editable official
 * price table).
 *
 * Transport: the page pulls all data through the existing
 * `ctx.remote.commands.execute` namespace ('/dsh-balance refresh | interval
 * <ms> | prices <json>'). Each response carries nextRefreshMs; after 2
 * consecutive refresh cycles without a new user/assistant message the Host
 * marks the session idle, the page drops to the paused detection cadence, and
 * the next detection call that sees a new conversation restores the active
 * cadence automatically.
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import * as React from 'react'
import styles from './balance.module.css'

export const name = 'dsh-balance'
export const inject = ['slots', 'remote', 'remote.commands']

interface RateSet {
  input: number
  cacheHit: number
  output: number
}

interface ModelPrices {
  offPeak: RateSet
  peak: RateSet
}

interface PriceTable {
  models: Record<string, ModelPrices>
}

interface Consumption {
  cost: number
  uncachedInput: number
  cacheRead: number
  output: number
  model: string | null
  currency: string
  estimated: boolean
}

interface ResultPayload {
  ok?: unknown
  error?: unknown
  data?: { is_available?: unknown; balance_infos?: Array<Record<string, unknown>> }
  sessionId?: unknown
  fetchedAt?: unknown
  intervalMs?: unknown
  prices?: unknown
  consumption?: unknown
  idle?: unknown
  nextRefreshMs?: unknown
    language?: unknown
    autoRefresh?: unknown
}

type ChipView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; result: ResultPayload }


/** 与 Host 侧 PAUSED_REFRESH_MS 保持一致：暂停自动查询后的兜底探测间隔。 */
const PAUSED_REFRESH_MS = 300000
const INTERVAL_OPTIONS = [
  { ms: 15000 },
  { ms: 30000 },
  { ms: 60000 },
  { ms: 120000 },
  { ms: 300000 },
]

const PRICE_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'default'] as const
const PRICE_PHASES = ['offPeak', 'peak'] as const
const PRICE_FIELDS = ['input', 'cacheHit', 'output'] as const


type Lang = 'zh' | 'en'

function resolveLang(language: unknown): Lang {
  if (language === 'zh-CN') return 'zh'
  if (language === 'en') return 'en'
  if (typeof document !== 'undefined') {
    const host = document.documentElement.lang || navigator.language || 'zh-CN'
    return /^zh/i.test(host) ? 'zh' : 'en'
  }
  return 'zh'
}

const COPY: Record<Lang, Record<string, string>> = {
  zh: {
    settingsTitle: 'DeepSeek 开放平台余额',
    available: '可用',
    unavailable: '不可用',
    noSession: '打开会话后自动显示余额',
    loading: '查询中…',
    noBalance: '暂无余额数据',
    granted: '赠送',
    toppedUp: '充值',
    updatedAt: '更新于',
    refresh: '刷新',
    autoRefreshInterval: '自动刷新间隔',
    language: '界面语言',
    languageAuto: '跟随主界面',
    languageZh: '中文',
    languageEn: 'English',
    priceTable: '价格表（元 / 百万 tokens）',
    save: '保存',
    offPeakPrice: '空闲时段',
    peakPrice: '高峰时段',
    inputLabel: '输入(未命中)',
    cacheHitLabel: '缓存命中',
    outputLabel: '输出',
    defaultModelLabel: '默认（未列出的模型按此计价）',
    peakHoursHint: '高峰时段 9-12、14-18（北京时间），其余时段按「空闲」价。估算仅供参考，以官方账单为准。',
    pausedTip: '已暂停自动查询：连续 2 个周期无新对话，出现新对话后自动恢复',
    activeRefresh: '自动刷新每',
    seconds: '秒',
    clickRefresh: '点击刷新',
    estimateNote: '按官方价目表估算，仅供参考',
    retry: '点击重试',
    balance: '余额',
    sessionApprox: '会话 ≈',
    balanceDash: '余额 —',
    balanceLoading: '余额 …',
    unknownCurrency: '未知币种',
    sessionNoData: '会话消耗：暂无会话数据',
    modelUnknown: '未知模型',
    modelDefault: '默认（未列出的模型按此计价）',
      autoRefresh: '自动刷新',
      autoRefreshOn: '开启',
      autoRefreshOff: '关闭',
      autoRefreshDisabledTip: '自动刷新已关闭',
      customInterval: '自定义间隔（毫秒，5000–600000）',
      customIntervalApply: '应用',
      customOption: '自定义…',
  },
  en: {
    settingsTitle: 'DeepSeek Balance',
    available: 'Available',
    unavailable: 'Unavailable',
    noSession: 'Open a session to show balance',
    loading: 'Loading…',
    noBalance: 'No balance data',
    granted: 'granted',
    toppedUp: 'topped up',
    updatedAt: 'Updated',
    refresh: 'Refresh',
    autoRefreshInterval: 'Auto-refresh interval',
    language: 'Language',
    languageAuto: 'Follow host UI',
    languageZh: '中文',
    languageEn: 'English',
    priceTable: 'Price table (CNY / 1M tokens)',
    save: 'Save',
    offPeakPrice: 'Off-peak',
    peakPrice: 'Peak',
    inputLabel: 'Input (uncached)',
    cacheHitLabel: 'Cache hit',
    outputLabel: 'Output',
    defaultModelLabel: 'Default (unknown models use this)',
    peakHoursHint: 'Peak hours 9-12, 14-18 (Beijing time); other hours use off-peak. Estimate only — the official bill is authoritative.',
    pausedTip: 'Auto-refresh paused: no new conversation for 2 cycles; resumes when a new message appears',
    activeRefresh: 'Auto-refresh every',
    seconds: 's',
    clickRefresh: 'Click to refresh',
    estimateNote: 'Estimated from the official price table, for reference only',
    retry: 'Click to retry',
    balance: 'Balance',
    sessionApprox: 'Session ≈',
    balanceDash: 'Balance —',
    balanceLoading: 'Balance …',
    unknownCurrency: 'Unknown currency',
    sessionNoData: 'Session spend: no session data',
    modelUnknown: 'Unknown model',
    modelDefault: 'Default (unknown models use this)',
      autoRefresh: 'Auto-refresh',
      autoRefreshOn: 'On',
      autoRefreshOff: 'Off',
      autoRefreshDisabledTip: 'Auto-refresh off',
      customInterval: 'Custom interval (ms, 5000–600000)',
      customIntervalApply: 'Apply',
      customOption: 'Custom…',
  },
}

function t(lang: Lang, key: keyof typeof COPY.zh): string {
  return COPY[lang][key] ?? COPY.zh[key] ?? String(key)
}

function intervalLabel(lang: Lang, ms: number): string {
  return lang === 'zh' ? `${ms / 1000} 秒` : `${ms / 1000} s`
}

function fieldLabel(lang: Lang, field: string): string {
  const key = field === 'input' ? 'inputLabel' : field === 'cacheHit' ? 'cacheHitLabel' : 'outputLabel'
  return t(lang, key)
}
const FIELD_LABEL: Record<string, string> = { input: '输入(未命中)', cacheHit: '缓存命中', output: '输出' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function symbolOf(currency: unknown): string {
  const map: Record<string, string> = { CNY: '¥', USD: '$', EUR: '€', HKD: 'HK$', JPY: '¥' }
  const key = String(currency ?? '')
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key]! : `${key} `
}

function formatCost(cost: number): string {
 return cost >= 0.005 ? `¥${cost.toFixed(2)}` : '<¥0.01'
}

function formatExact(cost: number): string {
  return `¥${cost.toFixed(4)}`
}

function formatTime(iso: unknown): string {
  if (typeof iso !== 'string') return ''
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}

function formatNum(value: number): string {
  return value.toLocaleString('zh-CN')
}

function isPriceTable(value: unknown): value is PriceTable {
  if (!isRecord(value) || !isRecord(value.models)) return false
  for (const key of PRICE_MODELS) {
    const entry = value.models[key]
    if (!isRecord(entry)) return false
    for (const phase of PRICE_PHASES) {
      const rates = entry[phase]
      if (!isRecord(rates)) return false
      for (const field of PRICE_FIELDS) {
        if (typeof rates[field] !== 'number') return false
      }
    }
  }
  return true
}

export function apply(ctx: ClientContext): void {
  // 用户驱动的动作经现成的 commands 命名空间送达宿主（免去自定义 Remote 注册）。
  // 命令成功时以 JSON 文本回传数据，这里解析为结果载荷。
  const runCommand = async (sessionId: string | undefined, line: string): Promise<ResultPayload | null> => {
      const sid = sessionId ?? ''
    try {
      // 生成的 Remote 命名空间返回 { ok, value } 信封。
      const execution = await ctx.remote.commands.execute(sid as SessionId, line)
      const value = isRecord(execution) && execution.ok === true ? execution.value : undefined
      const text = value !== undefined && isRecord(value) && isRecord(value.result)
        ? value.result.text
        : undefined
      if (typeof text !== 'string' || text.length === 0) return null
      try {
        return JSON.parse(text) as ResultPayload
      } catch {
        return null
      }
    } catch {
      return null
    }
  }

  // ─── 顶栏徽章：余额 + 会话消耗，Tooltip 在按钮下方 ─────────────────────

  const BalanceChip = (props: { sessionId?: string }) => {
    const sessionId = props.sessionId ?? ''
    const [view, setView] = React.useState<ChipView>({ kind: 'loading' })
    const [intervalMs, setIntervalMs] = React.useState(30000)
    const [nextMs, setNextMs] = React.useState(30000)
    const [tip, setTip] = React.useState<{ left: number; right: number; top: number; bottom: number } | null>(null)
      const [lang, setLang] = React.useState<Lang>(resolveLang(undefined))
      const [autoRefresh, setAutoRefresh] = React.useState(true)
      const autoRefreshRef = React.useRef(true)
      const L = (key: keyof typeof COPY.zh) => t(lang, key)
    const anchorRef = React.useRef<HTMLButtonElement | null>(null)
    const bubbleRef = React.useRef<HTMLSpanElement | null>(null)
    const tipTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

    // 命令驱动：刷新 + 自调度。intervalMs 是设置值（用于展示），nextRefreshMs
    // 是下次刷新的实际间隔（活跃=intervalMs，暂停后=5 分钟低频探测以恢复）。
    React.useEffect(() => {
      let disposed = false
      let inFlight = false
      const tick = async () => {
        if (inFlight || disposed) return
          if (!autoRefreshRef.current) return
        inFlight = true
        try {
          const payload = await runCommand(sessionId, '/dsh-balance refresh')
          if (disposed || payload === null) return
          if (typeof payload.intervalMs === 'number' && payload.intervalMs !== intervalMs) {
            setIntervalMs(payload.intervalMs)
          }
          if (typeof payload.nextRefreshMs === 'number' && payload.nextRefreshMs !== nextMs) {
            setNextMs(payload.nextRefreshMs)
          }
            if (typeof payload.language === 'string') setLang(resolveLang(payload.language))
            setAutoRefresh(payload.autoRefresh !== false)
              autoRefreshRef.current = payload.autoRefresh !== false
          setView({ kind: 'data', result: payload })
        } finally {
          inFlight = false
        }
      }
      void tick()
        
      const timer = setInterval(() => { void tick() }, nextMs)
      return () => { disposed = true; clearInterval(timer) }
    }, [sessionId, intervalMs, nextMs])

      // 暂停期间用户与页面交互时立即探测：发送新消息必然伴随点击/键盘事件，
      // 这样无需等待最长为 PAUSED_REFRESH_MS 的下一次低频轮询即可恢复活跃刷新。
      React.useEffect(() => {
        if (true) return
        let disposed = false
        let inFlight = false
        const probe = async () => {
          if (inFlight || disposed) return
          inFlight = true
          try {
            const payload = await runCommand(sessionId, '/dsh-balance refresh')
            if (disposed || payload === null) return
            if (typeof payload.intervalMs === 'number' && payload.intervalMs !== intervalMs) {
              setIntervalMs(payload.intervalMs)
            }
            if (typeof payload.nextRefreshMs === 'number' && payload.nextRefreshMs !== nextMs) {
              setNextMs(payload.nextRefreshMs)
            }
            if (typeof payload.language === 'string') setLang(resolveLang(payload.language))
            if (typeof payload.language === 'string') setLang(resolveLang(payload.language))
            setView({ kind: 'data', result: payload })
          } finally {
            inFlight = false
          }
        }
        const onInteract = () => { void probe() }
        window.addEventListener('click', onInteract)
        window.addEventListener('keydown', onInteract)
        return () => {
          disposed = true
          window.removeEventListener('click', onInteract)
          window.removeEventListener('keydown', onInteract)
        }
      }, [sessionId, intervalMs, nextMs])

    const positionTip = () => {
      const el = anchorRef.current
      if (el === null) return
      const r = el.getBoundingClientRect()
      setTip({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })
    }
    const showTip = () => {
      if (tipTimerRef.current !== null) { clearTimeout(tipTimerRef.current); tipTimerRef.current = null }
      tipTimerRef.current = setTimeout(() => { tipTimerRef.current = null; positionTip() }, 500)
    }
    const focusTip = () => {
      if (tipTimerRef.current !== null) { clearTimeout(tipTimerRef.current); tipTimerRef.current = null }
      positionTip()
    }
    const hideTip = () => {
      if (tipTimerRef.current !== null) { clearTimeout(tipTimerRef.current); tipTimerRef.current = null }
      setTip(null)
    }
    React.useEffect(() => {
      if (tip === null) return
      const el = bubbleRef.current
      if (el === null) return
      const rect = el.getBoundingClientRect()
      const margin = 12
      // 正下方居中；视口放不下时贴边夹紧（不超出页面）。
      let left = (tip.left + tip.right) / 2 - rect.width / 2
      if (left < margin) left = margin
      if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - margin - rect.width
      if (left < margin) left = margin
      el.style.left = `${left}px`
    }, [tip])

    const tipLabel = (): string => {
      if (view.kind === 'data' && view.result.ok === true) {
        const result = view.result
        const lines: string[] = []
        const infos = Array.isArray(result.data?.balance_infos) ? result.data.balance_infos : []
        if (infos.length > 0) {
          for (const info of infos) {
            lines.push(`${String(info.currency ?? '')} ${lang === 'zh' ? '总额' : 'Balance'} ${String(info.total_balance ?? '0')}`
              + `（${lang === 'zh' ? '赠送' : 'granted'} ${String(info.granted_balance ?? '0')} / ${lang === 'zh' ? '充值' : 'topped up'} ${String(info.topped_up_balance ?? '0')}）`)
          }
        } else {
          lines.push(L('noBalance'))
        }
        const consumption = result.consumption as Consumption | null | undefined
        if (consumption !== undefined && consumption !== null && typeof consumption.cost === 'number') {
          lines.push(`${lang === 'zh' ? '会话消耗' : 'Session spend'} ≈ ${formatExact(consumption.cost)}（${consumption.model ?? (lang === 'zh' ? '未知模型' : 'Unknown model')}）`)
          lines.push(`${lang === 'zh' ? '输入未命中' : 'Input (uncached)'} ${formatNum(consumption.uncachedInput)} / ${lang === 'zh' ? '缓存命中' : 'Cache hit'} ${formatNum(consumption.cacheRead)}`
            + ` / ${lang === 'zh' ? '输出' : 'Output'} ${formatNum(consumption.output)} tokens`)
        } else if (consumption === null) {
          lines.push(L('sessionNoData'))
        }
        lines.push(`${L('updatedAt')} ${formatTime(result.fetchedAt)} · ${!autoRefresh
          ? L('autoRefreshDisabledTip')
            : result.idle === true
              ? L('pausedTip')
          : `${L('activeRefresh')} ${Math.round(intervalMs / 1000)} ${L('seconds')}`} · ${L('clickRefresh')}`)
        lines.push(L('estimateNote'))
        return lines.join('\n')
      }
      if (view.kind === 'error') return `${view.message}\n${L('retry')}`
      return L('loading')
    }

    let label = L('balanceLoading')
    let cls = styles.util
    if (view.kind === 'data') {
      const result = view.result
      if (result.ok === true) {
        const infos = Array.isArray(result.data?.balance_infos) ? result.data.balance_infos : []
        if (infos.length > 0) {
          const info = infos[0]!
          const total = String(info.total_balance ?? '0')
          const consumption = result.consumption as Consumption | null | undefined
          label = consumption !== undefined && consumption !== null && typeof consumption.cost === 'number'
            ? `${L('balance')} ${symbolOf(info.currency)}${total} | ${L('sessionApprox')}${formatCost(consumption.cost)}`
            : `${L('balance')} ${symbolOf(info.currency)}${total}`
          cls = result.data?.is_available === true
            ? `${styles.util} ${styles.utilOk}`
            : `${styles.util} ${styles.utilBad}`
        } else {
          label = L('balanceDash')
          cls = `${styles.util} ${styles.utilBad}`
        }
      } else {
        label = L('balanceDash')
        cls = `${styles.util} ${styles.utilErr}`
      }
    } else if (view.kind === 'error') {
      label = L('balanceDash')
      cls = `${styles.util} ${styles.utilErr}`
    }

    // 气泡放在按钮下沿 +10px（不遮挡按钮，也不与按钮内容重叠）。
    const y = tip === null ? 0 : tip.bottom + 10
    const manualRefresh = () => {
      void runCommand(sessionId, '/dsh-balance refresh').then((payload) => {
        if (payload === null) return
        if (typeof payload.intervalMs === 'number' && payload.intervalMs !== intervalMs) {
          setIntervalMs(payload.intervalMs)
        }
        if (typeof payload.nextRefreshMs === 'number' && payload.nextRefreshMs !== nextMs) {
          setNextMs(payload.nextRefreshMs)
        }
        setView({ kind: 'data', result: payload })
      })
    }
    return React.createElement('span', { style: { display: 'inline-flex' } },
      React.createElement('button', {
        ref: anchorRef,
        className: cls,
        onClick: manualRefresh,
        type: 'button',
        onMouseEnter: showTip,
        onMouseLeave: hideTip,
        onFocus: focusTip,
        onBlur: hideTip,
      }, label),
      tip !== null && React.createElement('span', {
        ref: bubbleRef,
        className: styles.tip,
        role: 'tooltip',
        style: { left: '-9999px', top: `${y}px`, transform: 'translateY(0)' },
      }, tipLabel()),
    )
  }

  // ─── 设置页卡片：余额 + 会话消耗明细 + 间隔 + 价格表编辑 ────────────────

  const BalanceCard = (props: { settings?: boolean; sessionId?: string }) => {
    const withSettings = props.settings === true
    const sessionId = props.sessionId
    const [view, setView] = React.useState<ChipView>({ kind: 'loading' })
    const [intervalMs, setIntervalMs] = React.useState(30000)
    const [nextMs, setNextMs] = React.useState(30000)
    const [prices, setPrices] = React.useState<PriceTable | null>(null)
      const [lang, setLang] = React.useState<Lang>(resolveLang(undefined))
      const L = (key: keyof typeof COPY.zh) => t(lang, key)
      const [autoRefresh, setAutoRefresh] = React.useState(true)
      const autoRefreshRef = React.useRef(true)
      const [customInterval, setCustomInterval] = React.useState('')

    // 命令驱动 + 自调度（与顶栏徽章同模式）；commands.execute 需要真实会话 ID。
    const applyPayload = (payload: ResultPayload): void => {
      if (typeof payload.intervalMs === 'number') setIntervalMs(payload.intervalMs)
      if (typeof payload.nextRefreshMs === 'number' && payload.nextRefreshMs !== nextMs) {
        setNextMs(payload.nextRefreshMs)
      }
      const nextPrices = payload.prices
          setAutoRefresh(payload.autoRefresh !== false)
          autoRefreshRef.current = payload.autoRefresh !== false
      if (isPriceTable(nextPrices)) setPrices(prev => (prev ?? nextPrices) as PriceTable | null)
        if (typeof payload.language === 'string') setLang(resolveLang(payload.language))
      setView({ kind: 'data', result: payload })
    }
    React.useEffect(() => {
      if (sessionId === undefined) return
      let disposed = false
      let inFlight = false
      const tick = async () => {
        if (inFlight || disposed) return
          if (!autoRefreshRef.current) return
        inFlight = true
        try {
          const payload = await runCommand(sessionId, '/dsh-balance refresh')
          if (disposed || payload === null) return
          applyPayload(payload)
        } finally {
          inFlight = false
        }
      }
      void tick()
      const timer = setInterval(() => { void tick() }, nextMs)
      return () => { disposed = true; clearInterval(timer) }
    }, [sessionId, intervalMs, nextMs])

      // 暂停期间用户与页面交互时立即探测：发送新消息必然伴随点击/键盘事件，
      // 这样无需等待最长为 PAUSED_REFRESH_MS 的下一次低频轮询即可恢复活跃刷新。
      React.useEffect(() => {
        if (sessionId === undefined) return
        if (true) return
        let disposed = false
        let inFlight = false
        const probe = async () => {
          if (inFlight || disposed) return
          inFlight = true
          try {
            const payload = await runCommand(sessionId, '/dsh-balance refresh')
            if (disposed || payload === null) return
            applyPayload(payload)
          } finally {
            inFlight = false
          }
        }
        const onInteract = () => { void probe() }
        window.addEventListener('click', onInteract)
        window.addEventListener('keydown', onInteract)
        return () => {
          disposed = true
          window.removeEventListener('click', onInteract)
          window.removeEventListener('keydown', onInteract)
        }
      }, [sessionId, intervalMs, nextMs])

    const applyInterval = (ms: number) => {
      if (sessionId === undefined) return
      void runCommand(sessionId, `/dsh-balance interval ${ms}`).then((payload) => {
        if (payload !== null) applyPayload(payload)
      })
    }
      const applyAutoRefresh = (enabled: boolean) => {
        if (sessionId === undefined) return
        void runCommand(sessionId, `/dsh-balance auto-refresh ${enabled ? 'on' : 'off'}`).then((payload) => {
          if (payload !== null) applyPayload(payload)
        })
      }
    const applyPrices = () => {
      if (sessionId === undefined || prices === null) return
      void runCommand(sessionId, `/dsh-balance prices ${JSON.stringify(prices)}`).then((payload) => {
        if (payload !== null) applyPayload(payload)
      })
    }
      const applyLanguage = (value: string) => {
        if (sessionId === undefined) return
        void runCommand(sessionId, `/dsh-balance language ${value}`).then((payload) => {
          if (payload !== null) applyPayload(payload)
        })
      }
    const setPrice = (model: string, phase: string, field: string, value: number) => {
      setPrices((prev): PriceTable | null => {
        if (prev === null) return prev
        const modelEntry = isRecord(prev.models[model]) ? prev.models[model] as ModelPrices : prev.models['default'] as ModelPrices
        const rates = modelEntry[phase as keyof ModelPrices] as RateSet
        return {
          ...prev,
          models: {
            ...prev.models,
            [model]: {
              ...modelEntry,
              [phase]: { ...rates, [field]: value },
            },
          },
        }
      })
    }

    const renderBody = () => {
      if (sessionId === undefined) {
        return React.createElement('div', { className: styles.muted }, L('noSession'))
      }
      if (view.kind === 'loading') {
        return React.createElement('div', { className: styles.muted }, L('loading'))
      }
      if (view.kind === 'error') {
        return React.createElement('div', { className: styles.err }, view.message)
      }
      const result = view.result
        const languageValue = typeof result.language === 'string' ? result.language : 'auto'
      if (result.ok !== true) {
        const message = typeof result.error === 'string' ? result.error : (lang === 'zh' ? '查询失败' : 'Query failed')
        return React.createElement('div', { className: styles.err }, message)
      }
      const elements: React.ReactNode[] = []
      const infos = Array.isArray(result.data?.balance_infos) ? result.data.balance_infos : []
      if (infos.length === 0) {
        elements.push(React.createElement('div', { className: styles.muted, key: 'empty' }, L('noBalance')))
      } else {
        for (const info of infos) {
          elements.push(React.createElement('div', { className: styles.row, key: String(info.currency ?? '') },
            React.createElement('span', null, String(info.currency ?? L('unknownCurrency'))),
            React.createElement('span', null,
              React.createElement('span', { className: styles.total }, String(info.total_balance ?? '0')),
              React.createElement('span', { className: styles.muted }, `（${L('granted')} ${String(info.granted_balance ?? '0')} / ${L('toppedUp')} ${String(info.topped_up_balance ?? '0')}）`),
            ),
          ))
        }
      }
      const time = formatTime(result.fetchedAt)
      elements.push(React.createElement('div', { className: styles.foot, key: 'foot' },
        React.createElement('span', { className: styles.muted }, `${L('updatedAt')} ${time}`),
        React.createElement('button', {
          className: styles.btn,
          onClick: () => {
            if (sessionId === undefined) return
            void runCommand(sessionId, '/dsh-balance refresh').then((payload) => {
              if (payload !== null) applyPayload(payload)
            })
          },
          type: 'button',
        }, L('refresh')),
      ))
      if (withSettings) {
          elements.push(React.createElement('div', { className: styles.setrow, key: 'auto-refresh' },
            React.createElement('span', null, L('autoRefresh')),
            React.createElement('select', {
              className: styles.select,
              value: autoRefresh ? 'on' : 'off',
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { applyAutoRefresh(event.target.value === 'on') },
            },
              React.createElement('option', { value: 'on' }, L('autoRefreshOn')),
              React.createElement('option', { value: 'off' }, L('autoRefreshOff')),
            ),
          ))
        elements.push(React.createElement('div', { className: styles.setrow, key: 'interval' },
          React.createElement('span', null, L('autoRefreshInterval')),
          React.createElement('select', {
            className: styles.select,
            value: INTERVAL_OPTIONS.some(option => option.ms === intervalMs) ? String(intervalMs) : 'custom',
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                const value = event.target.value
                if (value === 'custom') {
                  setCustomInterval(String(intervalMs))
                } else {
                  applyInterval(Number(value))
                }
              },
          }, INTERVAL_OPTIONS.map(option =>
            React.createElement('option', { key: String(option.ms), value: String(option.ms) }, intervalLabel(lang, option.ms))),
              React.createElement('option', { value: 'custom' }, L('customOption')),
            ),
          ))
          elements.push(React.createElement('div', { className: styles.setrow, key: 'custom-interval' },
            React.createElement('span', null, L('customInterval')),
            React.createElement('input', {
              className: styles.priceInput,
              type: 'number',
              step: '1000',
              min: '5000',
              max: '600000',
              value: customInterval,
              placeholder: '5000–600000',
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setCustomInterval(event.target.value) },
            }),
            React.createElement('button', {
              className: styles.btn,
              type: 'button',
              onClick: () => {
                const ms = Number(customInterval)
                if (Number.isFinite(ms) && ms >= 5000 && ms <= 600000) applyInterval(ms)
              },
            }, L('customIntervalApply')),
          ))
          elements.push(React.createElement('div', { className: styles.setrow, key: 'language' },
            React.createElement('span', null, L('language')),
            React.createElement('select', {
              className: styles.select,
              value: languageValue,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { applyLanguage(event.target.value) },
            },
              React.createElement('option', { value: 'auto' }, L('languageAuto')),
              React.createElement('option', { value: 'zh-CN' }, L('languageZh')),
              React.createElement('option', { value: 'en' }, L('languageEn')),
            ),
          ))
      }
      if (withSettings && prices !== null) {
        elements.push(React.createElement('div', { className: styles.pricerow, key: 'price-head' },
          React.createElement('span', null, L('priceTable')),
          React.createElement('button', { className: styles.btn, onClick: applyPrices, type: 'button' }, L('save')),
        ))
        const grid: React.ReactNode[] = [
          React.createElement('div', { key: 'ph0' }, ''),
          React.createElement('div', { className: styles.muted, key: 'ph1' }, L('offPeakPrice')),
          React.createElement('div', { className: styles.muted, key: 'ph2' }, L('peakPrice')),
        ]
        for (const model of PRICE_MODELS) {
          const entry = prices.models[model]
          if (entry === undefined) continue
          grid.push(React.createElement('div', { className: styles.priceModel, key: `${model}-name` },
            model === 'default' ? L('defaultModelLabel') : model))
          for (const field of PRICE_FIELDS) {
            grid.push(React.createElement('div', { className: styles.muted, key: `${model}-${field}` }, fieldLabel(lang, field)))
            for (const phase of PRICE_PHASES) {
              const rates = entry[phase]
              if (rates === undefined) continue
              grid.push(React.createElement('div', { className: styles.priceCell, key: `${model}-${field}-${phase}` },
                React.createElement('input', {
                  className: styles.priceInput,
                  type: 'number',
                  step: '0.001',
                  min: '0',
                  value: String(rates[field as keyof RateSet] ?? 0),
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                    const value = Number(event.target.value)
                    if (Number.isFinite(value) && value >= 0) setPrice(model, phase, field, value)
                  },
                })))
            }
          }
        }
        elements.push(React.createElement('div', { className: styles.priceGrid, key: 'price-grid' }, grid))
        elements.push(React.createElement('div', { className: styles.muted, key: 'peak-hours' },
          L('peakHoursHint')))
      }
      return React.createElement('div', null, ...elements)
    }

    return React.createElement('div', { className: styles.card },
      React.createElement('div', { className: styles.head },
        React.createElement('span', null, L('settingsTitle')),
        view.kind === 'data' && view.result.ok === true
          ? (view.result.data?.is_available === true
              ? React.createElement('span', { className: `${styles.badge} ${styles.ok}` }, L('available'))
              : React.createElement('span', { className: `${styles.badge} ${styles.bad}` }, L('unavailable')))
          : null,
      ),
      renderBody(),
    )
  }

  // ─── 隐藏主聊天页的 dsh-balance 命令行（刷新不再污染会话记录）──────────
  // 自动/手动刷新都经 commands.execute 执行，宿主为每次执行向会话日志追加
  // command/run + command/done 事件，主聊天页据此渲染一行命令卡片（标题
  // dsh-balance + 完整 payload JSON）。这里注册 keyed commandview 渲染器，
  // 把该命令的行替换成一个空标记元素，再用 CSS 把整个 flow item 设为
  // display:none——页面不再产生记录行，也不残留空行高/flex 间隙。事件仍会
  // 写入日志（host 侧 recordInput: false 后 command/run 不带 args），只是
  // 不再污染页面。
  // 副作用：用户在输入框手动敲 /dsh-balance … 产生的行同样被隐藏（结果仍
  // 可见于顶栏徽章、设置卡片与工具返回）。
  const COMMAND_HIDE_STAMP = 'data-dsh-balance-command-row'
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register(
    { name: 'conversation.chat.commandview', key: 'dsh-balance' },
    () => {
      const stamp: Record<string, string> = { [COMMAND_HIDE_STAMP]: 'true' }
      return React.createElement('div', stamp)
    },
  ))
  if (typeof document !== 'undefined'
    && document.querySelector('style[data-plugin-css="dsh-balance/command-hide"]') === null) {
    const tag = document.createElement('style')
    tag.dataset.pluginCss = 'dsh-balance/command-hide'
    tag.textContent = `[data-chat-flow-kind="command"]:has([${COMMAND_HIDE_STAMP}]){display:none}`
    document.head.appendChild(tag)
  }

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: 'dsh-balance', order: 10, label: 'DeepSeek 余额' },
    (props) => React.createElement(BalanceChip, { sessionId: props.sessionId }),
  ))
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'dsh-balance', order: 30, label: 'DeepSeek 余额' },
    (props) => {
      // 命令需要真实会话 ID：从设置页标准 props 的 useSessions 取当前会话。
      const currentId = props.useSessions((state) => state.current)
      const cardProps: { settings: boolean; sessionId?: string } = typeof currentId === 'string'
        ? { settings: true, sessionId: currentId }
        : { settings: true }
      return React.createElement(BalanceCard, cardProps)
    },
  ))
}
