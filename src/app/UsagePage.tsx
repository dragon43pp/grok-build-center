import { useMemo, useState } from 'react'
import { Loader2, RefreshCw, Tags } from 'lucide-react'
import { getAdapterIcon, getAdapterName } from './adapterIcons'
import { refreshPricingAndRescan, useSessions } from './sessionHistoryData'
import { useStrings } from './i18n'
import {
  addUsage,
  emptyUsage,
  formatTokens,
  formatUsd,
  type AgentId,
  type CostSource,
  type HistorySession,
  type TokenUsage
} from '../../shared/session-history'

interface Bucket {
  sessions: number
  subagents: number
  /** Tokens spent in sub-agent sessions, so their share can be stated. */
  subagentTokens: number
  usage: TokenUsage
  /** 各成本来源下的金额与会话数，分开记，免得把估算混进账单。 */
  bySource: Record<CostSource, { sessions: number; usd: number }>
}

function newBucket(): Bucket {
  return {
    sessions: 0,
    subagents: 0,
    subagentTokens: 0,
    usage: emptyUsage(),
    bySource: {
      recorded: { sessions: 0, usd: 0 },
      catalog: { sessions: 0, usd: 0 },
      unpriced: { sessions: 0, usd: 0 },
      none: { sessions: 0, usd: 0 }
    }
  }
}

function add(bucket: Bucket, session: HistorySession): void {
  if (session.subagent) {
    bucket.subagents++
    bucket.subagentTokens += session.usage.total
  } else {
    bucket.sessions++
  }
  bucket.usage = addUsage(bucket.usage, session.usage)
  const slot = bucket.bySource[session.costSource]
  slot.sessions++
  slot.usd += session.costUsd
}

/** 按 key 归并成一组桶，所有分组视图共用。 */
function group(
  sessions: readonly HistorySession[],
  key: (session: HistorySession) => string
): [string, Bucket][] {
  const buckets = new Map<string, Bucket>()
  for (const session of sessions) {
    const name = key(session)
    const bucket = buckets.get(name)
    if (bucket) add(bucket, session)
    else {
      const fresh = newBucket()
      add(fresh, session)
      buckets.set(name, fresh)
    }
  }
  // 按 token 降序：谁在烧钱谁排前面。
  return [...buckets.entries()].sort((a, b) => b[1].usage.total - a[1].usage.total)
}

/** 五段堆叠条：把 token 构成画出来，比五个数字直观。 */
function TokenBar({ usage }: { usage: TokenUsage }) {
  const parts = [
    { key: 'input', value: usage.input, className: 'bg-brand' },
    { key: 'output', value: usage.output, className: 'bg-brand/70' },
    { key: 'cacheRead', value: usage.cacheRead, className: 'bg-brand/35' },
    { key: 'cacheWrite', value: usage.cacheWrite, className: 'bg-brand/20' },
    { key: 'reasoning', value: usage.reasoning, className: 'bg-text-faint/40' }
  ].filter((part) => part.value > 0)
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  if (!total) return <div className="h-1.5 w-full rounded-full bg-surface-strong" />
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-strong">
      {parts.map((part) => (
        <span
          key={part.key}
          className={part.className}
          style={{ width: `${(part.value / total) * 100}%` }}
        />
      ))}
    </div>
  )
}

/**
 * 成本列的三种状态，和会话列表用同一套规矩：
 * 实记账单点亮品牌色（真账单），价目表估算保持安静（估算别穿成账单的样子），
 * 两者都没有就明写一个破折号 —— 不能把「算不出来」画成 $0。
 */
function CostCell({ bucket }: { bucket: Bucket }) {
  const recorded = bucket.bySource.recorded
  if (recorded.usd > 0) {
    return (
      <span className="w-20 shrink-0 text-right font-maple text-[10px] text-brand">
        {formatUsd(recorded.usd)}
      </span>
    )
  }
  const catalog = bucket.bySource.catalog
  return (
    <span
      className={`w-20 shrink-0 text-right font-maple text-[10px] ${
        catalog.usd > 0 ? 'text-text-secondary' : 'text-text-faint'
      }`}
    >
      {catalog.usd > 0 ? formatUsd(catalog.usd) : '—'}
    </span>
  )
}

function Tile({
  label,
  value,
  hint,
  accent = false
}: {
  label: string
  value: string
  hint?: string
  accent?: boolean
}) {
  return (
    <div className="rounded-lg border border-border-subtle px-3 py-2">
      <div className="font-maple text-[10px] tracking-wide text-text-faint uppercase">
        {label}
      </div>
      <div
        className={`mt-1 font-maple text-[18px] leading-none ${
          accent ? 'text-brand' : 'text-text-primary'
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 font-maple text-[10px] text-text-faint">{hint}</div>}
    </div>
  )
}

export default function UsagePage() {
  const strings = useStrings()
  const t = strings.usageStats
  const history = strings.sessionHistory
  const { result, scanning, error, scan } = useSessions()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const sessions = useMemo(() => result?.sessions ?? [], [result])

  const total = useMemo(() => {
    const bucket = newBucket()
    for (const session of sessions) add(bucket, session)
    return bucket
  }, [sessions])

  // 子代理会话默认在历史列表里是藏起来的，但它们是真花钱的调用，
  // 所以统计页照算，并且单独把份额标出来。
  const agents = useMemo(() => {
    const buckets = new Map<AgentId, Bucket>()
    for (const session of sessions) {
      const bucket = buckets.get(session.agent)
      if (bucket) add(bucket, session)
      else {
        const fresh = newBucket()
        add(fresh, session)
        buckets.set(session.agent, fresh)
      }
    }
    // 按 token 降序：谁在烧钱谁排前面。
    return [...buckets.entries()].sort((a, b) => b[1].usage.total - a[1].usage.total)
  }, [sessions])

  const models = useMemo(() => group(sessions, (session) => session.model || '—').slice(0, 12), [
    sessions
  ])

  const components: {
    key:
      | 'tokensInput'
      | 'tokensOutput'
      | 'tokensCacheRead'
      | 'tokensCacheWrite'
      | 'tokensReasoning'
    value: number
    className: string
  }[] = [
    { key: 'tokensInput', value: total.usage.input, className: 'bg-brand' },
    { key: 'tokensOutput', value: total.usage.output, className: 'bg-brand/70' },
    { key: 'tokensCacheRead', value: total.usage.cacheRead, className: 'bg-brand/35' },
    { key: 'tokensCacheWrite', value: total.usage.cacheWrite, className: 'bg-brand/20' },
    { key: 'tokensReasoning', value: total.usage.reasoning, className: 'bg-text-faint/40' }
  ]

  return (
    <section
      data-testid="usage-page"
      className="sidebar-scroll flex h-full min-h-0 flex-col overflow-y-auto font-pingfang"
    >
      <header className="shrink-0 border-b border-border-subtle px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[15px] leading-tight text-text-primary">{t.title}</h1>
            <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-text-muted">
              {t.subtitle}
            </p>
          </div>
          <button
            type="button"
            data-testid="usage-rescan"
            disabled={scanning}
            onClick={scan}
            className="cursor-target flex shrink-0 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-60"
          >
            {scanning ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <RefreshCw className="size-3.5" strokeWidth={1.75} />
            )}
            {scanning ? history.rescanning : history.rescan}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 px-5 py-4">
        {error && (
          <p className="rounded-md border border-amber-500/30 px-3 py-2 text-[11px] text-amber-500">
            {error}
          </p>
        )}

        {!error && sessions.length === 0 && !scanning && (
          <p className="py-16 text-center text-[12px] text-text-faint">{t.empty}</p>
        )}

        {sessions.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile
                label={t.sessionsCount}
                value={String(total.sessions + total.subagents)}
                hint={
                  total.subagents
                    ? t.subagentShare(formatTokens(total.subagentTokens))
                    : undefined
                }
              />
              <Tile label={history.totalTokens} value={formatTokens(total.usage.total)} />
              <Tile
                label={history.costRecorded}
                value={formatUsd(total.bySource.recorded.usd)}
                hint={`${total.bySource.recorded.sessions} ${t.sessionsCount}`}
                accent
              />
              <Tile
                label={history.costEstimated}
                value={formatUsd(total.bySource.catalog.usd)}
                hint={
                  total.bySource.unpriced.sessions
                    ? `${total.bySource.unpriced.sessions} ${history.costUnpriced}`
                    : undefined
                }
              />
            </div>

            <section>
              <TokenBar usage={total.usage} />
              <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-5">
                {components.map((component) => (
                  <li key={component.key} className="flex items-center gap-2">
                    <span className={`size-2 shrink-0 rounded-sm ${component.className}`} />
                    <span className="text-[10px] text-text-muted">{t[component.key]}</span>
                    <span className="ml-auto font-maple text-[10px] text-text-secondary">
                      {formatTokens(component.value)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className="mb-1.5 font-maple text-[11px] text-text-faint">{t.agents}</h2>
              <ul className="flex flex-col">
                {agents.map(([agent, bucket]) => {
                  const Icon = getAdapterIcon(agent)
                  const share = total.usage.total
                    ? (bucket.usage.total / total.usage.total) * 100
                    : 0
                  return (
                    <li
                      key={agent}
                      data-testid="usage-agent-row"
                      data-agent={agent}
                      className="flex items-center gap-3 border-b border-border-faint py-2 last:border-b-0"
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center text-text-muted">
                        <Icon size={14} className="size-[14px]" />
                      </span>
                      <span className="w-28 shrink-0 truncate text-[12px] text-text-primary">
                        {getAdapterName(agent)}
                      </span>
                      <span className="hidden w-24 shrink-0 sm:block">
                        <TokenBar usage={bucket.usage} />
                      </span>
                      <span className="w-14 shrink-0 text-right font-maple text-[10px] text-text-faint">
                        {bucket.sessions + bucket.subagents}
                      </span>
                      <span className="w-16 shrink-0 text-right font-maple text-[10px] text-text-secondary">
                        {formatTokens(bucket.usage.total)}
                      </span>
                      <span className="w-12 shrink-0 text-right font-maple text-[10px] text-text-faint">
                        {share.toFixed(1)}%
                      </span>
                      <CostCell bucket={bucket} />
                    </li>
                  )
                })}
              </ul>
            </section>

            <section>
              <h2 className="mb-1.5 font-maple text-[11px] text-text-faint">{t.models}</h2>
              <ul className="flex flex-col">
                {models.map(([model, bucket]) => (
                  <li
                    key={model}
                    data-testid="usage-model-row"
                    className="flex items-center gap-3 border-b border-border-faint py-1.5 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-maple text-[11px] text-text-primary">
                      {model}
                    </span>
                    <span className="w-14 shrink-0 text-right font-maple text-[10px] text-text-faint">
                      {bucket.sessions + bucket.subagents}
                    </span>
                    <span className="w-16 shrink-0 text-right font-maple text-[10px] text-text-secondary">
                      {formatTokens(bucket.usage.total)}
                    </span>
                    <CostCell bucket={bucket} />
                  </li>
                ))}
              </ul>
            </section>

            <p className="max-w-3xl pb-2 text-[10px] leading-relaxed text-text-faint">
              {t.pricingNote}
              {result?.pricing && (
                <>
                  {' '}
                  <span className="text-text-muted">
                    {t.pricingCatalog(
                      result.pricing.models,
                      result.pricing.generatedOn,
                      result.pricing.refreshed
                    )}
                  </span>
                </>
              )}{' '}
              <button
                type="button"
                data-testid="usage-refresh-pricing"
                disabled={refreshing}
                onClick={() => {
                  setRefreshing(true)
                  setRefreshError(null)
                  void refreshPricingAndRescan()
                    .then((reason) => setRefreshError(reason ? t.pricingRefreshFailed(reason) : null))
                    .finally(() => setRefreshing(false))
                }}
                className="cursor-target inline-flex items-center gap-1 rounded border border-border-subtle px-1.5 py-0.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-60"
              >
                {refreshing ? (
                  <Loader2 className="size-2.5 animate-spin" strokeWidth={2} />
                ) : (
                  <Tags className="size-2.5" strokeWidth={2} />
                )}
                {refreshing ? t.refreshingPricing : t.refreshPricing}
              </button>
              {refreshError && <span className="text-amber-500"> {refreshError}</span>}
            </p>
          </>
        )}
      </div>
    </section>
  )
}
