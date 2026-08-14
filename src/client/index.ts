/**
 * DeepSeek Open Platform balance readout — browser half.
 *
 * Registers two additive surfaces: a compact chip in the session header
 * utility row (balance + estimated current-session spend, tooltip on the LEFT
 * so hovering never covers the button) and a full card in the Settings →
 * DeepSeek 余额 page (breakdown, refresh-interval selector, editable official
 * price table).
 *
 * Transport: the Host pushes 'dsh-balance/result' and 'dsh-balance/config'
 * over the allowlisted remote event bridge on its own timer; the page only
 * subscribes and issues rare user-driven actions through the existing
 * `ctx.remote.commands.execute` namespace ('/dsh-balance refresh | interval
 * <ms> | prices <json>').
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
  old: RateSet
  offPeak: RateSet
  peak: RateSet
}

interface PriceTable {
  switchover: string
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
}

type ChipView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; result: ResultPayload }

const INTERVAL_OPTIONS = [
  { ms: 15000, label: '15 秒' },
  { ms: 30000, label: '30 秒' },
  { ms: 60000, label: '60 秒' },
  { ms: 120000, label: '2 分钟' },
  { ms: 300000, label: '5 分钟' },
]

const PRICE_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'default'] as const
const PRICE_PHASES = ['old', 'offPeak', 'peak'] as const
const PRICE_FIELDS = ['input', 'cacheHit', 'output'] as const

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
  if (!isRecord(value) || typeof value.switchover !== 'string') return false
  if (!isRecord(value.models)) return false
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
  const runCommand = async (sessionId: string, line: string): Promise<ResultPayload | null> => {
    try {
      // 生成的 Remote 命名空间返回 { ok, value } 信封。
      const execution = await ctx.remote.commands.execute(sessionId as SessionId, line)
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
    const anchorRef = React.useRef<HTMLButtonElement | null>(null)
    const bubbleRef = React.useRef<HTMLSpanElement | null>(null)
    const tipTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

    // 命令驱动：刷新 + 自调度。intervalMs 是设置值（用于展示），nextRefreshMs
    // 是下次刷新的实际间隔（活跃=intervalMs，空闲=5 分钟降频）。
    React.useEffect(() => {
      let disposed = false
      let inFlight = false
      const tick = async () => {
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
          setView({ kind: 'data', result: payload })
        } finally {
          inFlight = false
        }
      }
      void tick()
      const timer = setInterval(() => { void tick() }, nextMs)
      return () => { disposed = true; clearInterval(timer) }
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
            lines.push(`${String(info.currency ?? '')} 总额 ${String(info.total_balance ?? '0')}`
              + `（赠送 ${String(info.granted_balance ?? '0')} / 充值 ${String(info.topped_up_balance ?? '0')}）`)
          }
        } else {
          lines.push('暂无余额数据')
        }
        const consumption = result.consumption as Consumption | null | undefined
        if (consumption !== undefined && consumption !== null && typeof consumption.cost === 'number') {
          lines.push(`会话消耗 ≈ ${formatExact(consumption.cost)}（${consumption.model ?? '未知模型'}）`)
          lines.push(`输入未命中 ${formatNum(consumption.uncachedInput)} / 缓存命中 ${formatNum(consumption.cacheRead)}`
            + ` / 输出 ${formatNum(consumption.output)} tokens`)
        } else if (consumption === null) {
          lines.push('会话消耗：暂无会话数据')
        }
        lines.push(`更新于 ${formatTime(result.fetchedAt)} · ${result.idle === true
          ? '空闲中：自动刷新已降频至 5 分钟'
          : `自动刷新每 ${Math.round(intervalMs / 1000)} 秒`} · 点击刷新`)
        lines.push('按官方价目表估算，仅供参考')
        return lines.join('\n')
      }
      if (view.kind === 'error') return `${view.message}\n点击重试`
      return '查询中…'
    }

    let label = '余额 …'
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
            ? `余额 ${symbolOf(info.currency)}${total} | 会话 ≈${formatCost(consumption.cost)}`
            : `余额 ${symbolOf(info.currency)}${total}`
          cls = result.data?.is_available === true
            ? `${styles.util} ${styles.utilOk}`
            : `${styles.util} ${styles.utilBad}`
        } else {
          label = '余额 —'
          cls = `${styles.util} ${styles.utilBad}`
        }
      } else {
        label = '余额 —'
        cls = `${styles.util} ${styles.utilErr}`
      }
    } else if (view.kind === 'error') {
      label = '余额 —'
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

    // 命令驱动 + 自调度（与顶栏徽章同模式）；commands.execute 需要真实会话 ID。
    const applyPayload = (payload: ResultPayload): void => {
      if (typeof payload.intervalMs === 'number') setIntervalMs(payload.intervalMs)
      if (typeof payload.nextRefreshMs === 'number' && payload.nextRefreshMs !== nextMs) {
        setNextMs(payload.nextRefreshMs)
      }
      const nextPrices = payload.prices
      if (isPriceTable(nextPrices)) setPrices(prev => (prev ?? nextPrices) as PriceTable | null)
      setView({ kind: 'data', result: payload })
    }
    React.useEffect(() => {
      if (sessionId === undefined) return
      let disposed = false
      let inFlight = false
      const tick = async () => {
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
      void tick()
      const timer = setInterval(() => { void tick() }, nextMs)
      return () => { disposed = true; clearInterval(timer) }
    }, [sessionId, intervalMs, nextMs])

    const applyInterval = (ms: number) => {
      if (sessionId === undefined) return
      void runCommand(sessionId, `/dsh-balance interval ${ms}`).then((payload) => {
        if (payload !== null) applyPayload(payload)
      })
    }
    const applyPrices = () => {
      if (sessionId === undefined || prices === null) return
      void runCommand(sessionId, `/dsh-balance prices ${JSON.stringify(prices)}`).then((payload) => {
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
        return React.createElement('div', { className: styles.muted }, '打开会话后自动显示余额')
      }
      if (view.kind === 'loading') {
        return React.createElement('div', { className: styles.muted }, '查询中…')
      }
      if (view.kind === 'error') {
        return React.createElement('div', { className: styles.err }, view.message)
      }
      const result = view.result
      if (result.ok !== true) {
        const message = typeof result.error === 'string' ? result.error : '查询失败'
        return React.createElement('div', { className: styles.err }, message)
      }
      const elements: React.ReactNode[] = []
      const infos = Array.isArray(result.data?.balance_infos) ? result.data.balance_infos : []
      if (infos.length === 0) {
        elements.push(React.createElement('div', { className: styles.muted, key: 'empty' }, '暂无余额数据'))
      } else {
        for (const info of infos) {
          elements.push(React.createElement('div', { className: styles.row, key: String(info.currency ?? '') },
            React.createElement('span', null, String(info.currency ?? '未知币种')),
            React.createElement('span', null,
              React.createElement('span', { className: styles.total }, String(info.total_balance ?? '0')),
              React.createElement('span', { className: styles.muted }, `（赠送 ${String(info.granted_balance ?? '0')} / 充值 ${String(info.topped_up_balance ?? '0')}）`),
            ),
          ))
        }
      }
      const time = formatTime(result.fetchedAt)
      elements.push(React.createElement('div', { className: styles.foot, key: 'foot' },
        React.createElement('span', { className: styles.muted }, `更新于 ${time}`),
        React.createElement('button', {
          className: styles.btn,
          onClick: () => {
            if (sessionId === undefined) return
            void runCommand(sessionId, '/dsh-balance refresh').then((payload) => {
              if (payload !== null) applyPayload(payload)
            })
          },
          type: 'button',
        }, '刷新'),
      ))
      if (withSettings) {
        elements.push(React.createElement('div', { className: styles.setrow, key: 'interval' },
          React.createElement('span', null, '自动刷新间隔'),
          React.createElement('select', {
            className: styles.select,
            value: String(intervalMs),
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { applyInterval(Number(event.target.value)) },
          }, INTERVAL_OPTIONS.map(option =>
            React.createElement('option', { key: String(option.ms), value: String(option.ms) }, option.label))),
        ))
      }
      if (withSettings && prices !== null) {
        elements.push(React.createElement('div', { className: styles.pricerow, key: 'price-head' },
          React.createElement('span', null, '价格表（元 / 百万 tokens）'),
          React.createElement('button', { className: styles.btn, onClick: applyPrices, type: 'button' }, '保存'),
        ))
        const grid: React.ReactNode[] = [
          React.createElement('div', { key: 'ph0' }, ''),
          React.createElement('div', { className: styles.muted, key: 'ph1' }, '旧价'),
          React.createElement('div', { className: styles.muted, key: 'ph2' }, '空闲时段'),
          React.createElement('div', { className: styles.muted, key: 'ph3' }, '高峰时段'),
        ]
        for (const model of PRICE_MODELS) {
          const entry = prices.models[model]
          if (entry === undefined) continue
          grid.push(React.createElement('div', { className: styles.priceModel, key: `${model}-name` },
            model === 'default' ? '默认（未列出的模型按此计价）' : model))
          for (const field of PRICE_FIELDS) {
            grid.push(React.createElement('div', { className: styles.muted, key: `${model}-${field}` }, FIELD_LABEL[field] ?? field))
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
        elements.push(React.createElement('div', { className: styles.muted, key: 'switchover' },
          `08-17 00:00（北京时间）起使用「空闲/高峰」价；高峰时段 9-12、14-18。估算仅供参考，以官方账单为准。`))
      }
      return React.createElement('div', null, ...elements)
    }

    return React.createElement('div', { className: styles.card },
      React.createElement('div', { className: styles.head },
        React.createElement('span', null, 'DeepSeek 开放平台余额'),
        view.kind === 'data' && view.result.ok === true
          ? (view.result.data?.is_available === true
              ? React.createElement('span', { className: `${styles.badge} ${styles.ok}` }, '可用')
              : React.createElement('span', { className: `${styles.badge} ${styles.bad}` }, '不可用'))
          : null,
      ),
      renderBody(),
    )
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
