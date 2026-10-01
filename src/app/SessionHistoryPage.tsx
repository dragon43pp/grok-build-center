import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, Play, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import { getAdapterIcon, getAdapterName } from './adapterIcons'
import { useSessions } from './sessionHistoryData'
import { useStrings } from './i18n'
import {
  AGENT_IDS,
  formatTokens,
  formatUsd,
  sortSessions,
  type AgentId,
  type AgentScanResult,
  type HistorySession
} from '../../shared/session-history'
import { planResume } from '../../shared/session-resume'
import type { LaunchableCli } from '../../shared/ipc-contract'

interface SessionHistoryPageProps {
  /** 启动扫描的结果，用来把会话的 agent 映射到具体的 CLI 安装。 */
  clis: readonly LaunchableCli[]
  /**
   * 真的去恢复。原目录是否还存在由主进程判断（渲染进程没法 stat），
   * 所以「目录没了」也走这里 —— 调用方会改成让你选目录。
   * 返回非空字符串表示失败原因。
   */
  onResumeSession: (session: HistorySession, option: LaunchableCli) => Promise<string | null>
}

/** `2026-09-30T02:20:22Z` -> `2026-09-30`. Undefined keeps the list in one group. */
function dayOf(session: HistorySession): string {
  const stamp = session.updatedAt ?? session.createdAt
  if (!stamp) return ''
  return stamp.slice(0, 10)
}

function baseName(path: string): string {
  if (!path) return ''
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed
}

export default function SessionHistoryPage({ clis, onResumeSession }: SessionHistoryPageProps) {
  const strings = useStrings()
  const t = strings.sessionHistory
  const { result, scanning, error, scan } = useSessions()
  const [query, setQuery] = useState('')
  const [agentFilter, setAgentFilter] = useState<AgentId | null>(null)
  const [showSubagents, setShowSubagents] = useState(false)
  /** 正在启动的那一场，用来把按钮换成转圈。 */
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)

  /**
   * 会话 → 能不能恢复、为什么不能。三类条件各查各的：
   * 会话本身（纯函数 planResume）、CLI 装没装（启动扫描）、有没有安装项。
   * 理由要拼成人话塞进 title，否则用户只能看到一个不明所以的灰按钮。
   */
  const resumeAffordance = useCallback(
    (session: HistorySession): { option: LaunchableCli | null; blocked: string | null } => {
      const plan = planResume(session)
      if (!plan.ok) {
        const blocked =
          plan.blocker === 'subagent'
            ? t.resumeBlockedSubagent
            : plan.blocker === 'no-session-id'
              ? t.resumeBlockedNoId
              : t.resumeBlockedUnverified
        return { option: null, blocked }
      }
      const option = clis.find((candidate) => candidate.definition.id === plan.cliId) ?? null
      if (!option || option.installations.length === 0) {
        return { option: null, blocked: t.resumeBlockedCliMissing(getAdapterName(session.agent)) }
      }
      return { option, blocked: null }
    },
    [clis, t]
  )

  const handleResume = useCallback(
    (session: HistorySession, option: LaunchableCli): void => {
      setResumingId(session.id)
      setResumeError(null)
      void onResumeSession(session, option)
        .then((failure) => {
          if (failure) setResumeError(t.resumeFailed(failure))
        })
        .finally(() => setResumingId(null))
    },
    [onResumeSession, t]
  )

  const sessions = useMemo(() => result?.sessions ?? [], [result])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sortSessions(
      sessions.filter((session) => {
        if (!showSubagents && (session.subagent || session.archived)) return false
        if (agentFilter && session.agent !== agentFilter) return false
        if (!needle) return true
        return (
          session.title.toLowerCase().includes(needle) ||
          session.cwd.toLowerCase().includes(needle) ||
          session.model.toLowerCase().includes(needle) ||
          session.agent.includes(needle)
        )
      })
    )
  }, [sessions, query, agentFilter, showSubagents])

  // 按天分组：会话历史里「哪天做的」比「第几条」有用得多。
  const groups = useMemo(() => {
    const byDay = new Map<string, HistorySession[]>()
    for (const session of filtered) {
      const day = dayOf(session)
      const bucket = byDay.get(day)
      if (bucket) bucket.push(session)
      else byDay.set(day, [session])
    }
    return [...byDay.entries()]
  }, [filtered])

  const agentResult = useCallback(
    (agent: AgentId): AgentScanResult | null =>
      result?.results.find((entry) => entry.agent === agent) ?? null,
    [result]
  )

  const totalTokens = filtered.reduce((sum, session) => sum + session.usage.total, 0)
  const totalCost = filtered.reduce((sum, session) => sum + session.costUsd, 0)
  const costSource = strings.sessionHistory.costRecorded

  return (
    <section
      data-testid="session-history-page"
      className="flex h-full min-h-0 flex-col font-pingfang"
    >
      <header className="shrink-0 border-b border-border-subtle px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[15px] leading-tight text-text-primary">{t.title}</h1>
            <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-text-muted">
              {t.subtitle}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="text-right">
              <div className="font-maple text-[11px] text-text-secondary">
                {formatTokens(totalTokens)} · {formatUsd(totalCost)}
              </div>
              <div className="font-maple text-[10px] text-text-faint">
                {result ? t.scannedIn(result.tookMs) : ''}
              </div>
            </div>
            <button
              type="button"
              data-testid="session-history-rescan"
              disabled={scanning}
              onClick={() => void scan()}
              className="cursor-target flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-60"
            >
              {scanning ? (
                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
              ) : (
                <RefreshCw className="size-3.5" strokeWidth={1.75} />
              )}
              {scanning ? t.rescanning : t.rescan}
            </button>
          </div>
        </div>

        {/* agent 状态条：哪家装了、哪家没有、哪家读挂了，一眼看到 */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {AGENT_IDS.map((agent) => {
            const entry = agentResult(agent)
            const Icon = getAdapterIcon(agent)
            const failed = Boolean(entry?.error)
            const count = entry?.sessions.length ?? 0
            const active = agentFilter === agent
            const hint = entry?.error
              ? `${t.failed}: ${entry.error}`
              : entry?.notInstalled
                ? t.notInstalled
                : count > 0
                  ? `${count}`
                  : t.emptyStore
            return (
              <button
                key={agent}
                type="button"
                data-testid={`session-history-agent-${agent}`}
                title={`${getAdapterName(agent)} · ${hint}`}
                aria-pressed={active}
                // 读挂了的和没装的都点不动：过滤出 0 条没有意义。
                disabled={failed || entry?.notInstalled}
                onClick={() => setAgentFilter(active ? null : agent)}
                className={`cursor-target flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] transition-colors ${
                  active
                    ? 'border-brand/40 bg-surface-strong text-text-primary'
                    : 'border-border-faint text-text-muted hover:bg-surface-hover'
                } ${failed || entry?.notInstalled ? 'cursor-not-allowed opacity-45' : ''}`}
              >
                {failed ? (
                  <TriangleAlert className="size-3 text-amber-500" strokeWidth={2} />
                ) : entry?.notInstalled ? (
                  <AlertTriangle className="size-3 text-text-faint" strokeWidth={2} />
                ) : (
                  <Icon size={11} className="size-[11px]" />
                )}
                <span className="font-maple">{getAdapterName(agent)}</span>
                <span className="font-maple text-text-faint">{hint}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <label className="relative flex min-w-0 flex-1 items-center">
            <Search
              className="pointer-events-none absolute left-2 size-3.5 text-text-faint"
              strokeWidth={1.75}
            />
            <input
              type="search"
              data-testid="session-history-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t.searchPlaceholder}
              className="w-full rounded-md border border-border-subtle bg-transparent py-1.5 pr-2 pl-7 text-[11px] text-text-primary outline-none transition-colors placeholder:text-text-faint focus:border-brand/40"
            />
          </label>
          <label className="flex shrink-0 cursor-target items-center gap-1.5 text-[10px] text-text-muted select-none">
            <input
              type="checkbox"
              data-testid="session-history-subagents"
              checked={showSubagents}
              onChange={(event) => setShowSubagents(event.target.checked)}
              className="size-3 accent-[var(--gbc-brand,#FF6B4A)]"
            />
            {t.showSubagents}
          </label>
        </div>
      </header>

      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {resumeError && (
          <p
            data-testid="session-history-resume-error"
            className="m-3 rounded-md border border-amber-500/30 px-3 py-2 text-[11px] text-amber-500"
          >
            {resumeError}
          </p>
        )}

        {error && (
          <p
            data-testid="session-history-error"
            className="m-3 rounded-md border border-amber-500/30 px-3 py-2 text-[11px] text-amber-500"
          >
            {error}
          </p>
        )}

        {!error && !scanning && filtered.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <p className="text-[12px] text-text-secondary">{t.empty}</p>
            <p className="text-[10px] text-text-faint">{t.emptyHint}</p>
          </div>
        )}

        {groups.map(([day, rows]) => (
          <div key={day} className="mb-2">
            <div className="sticky top-0 z-10 bg-app px-2 py-1 font-maple text-[10px] text-text-faint">
              {day || '—'}
            </div>
            <ul>{rows.map((session) => (
              <SessionRow
                key={`${session.agent}:${session.id}`}
                session={session}
                affordance={resumeAffordance(session)}
                resuming={resumingId === session.id}
                onResume={handleResume}
              />
            ))}</ul>
          </div>
        ))}
      </div>

      <footer className="shrink-0 border-t border-border-faint px-5 py-1.5 font-maple text-[10px] text-text-faint">
        {strings.sessionHistory.totalTokens}: {formatTokens(totalTokens)} ·{' '}
        {strings.sessionHistory.totalCost}: {formatUsd(totalCost)} ({costSource})
      </footer>
    </section>
  )
}

function SessionRow({
  session,
  affordance,
  resuming,
  onResume
}: {
  session: HistorySession
  affordance: { option: LaunchableCli | null; blocked: string | null }
  resuming: boolean
  onResume: (session: HistorySession, option: LaunchableCli) => void
}) {
  const strings = useStrings()
  const t = strings.sessionHistory
  const Icon = getAdapterIcon(session.agent)
  const costLabel =
    session.costSource === 'recorded'
      ? t.costRecorded
      : session.costSource === 'catalog'
        ? t.costEstimated
        : session.costSource === 'unpriced'
          ? t.costUnpriced
          : t.costNone

  const option = affordance.option
  const canResume = Boolean(option) && !resuming
  const actionLabel = resuming
    ? t.resuming
    : (affordance.blocked ?? `${t.resume} · ${t.resumeHint}`)

  return (
    <li
      data-testid="session-history-row"
      data-agent={session.agent}
      data-subagent={session.subagent ? 'true' : 'false'}
      data-resumable={option ? 'true' : 'false'}
      // 行里只显示 cwd 的**基名**（`baseName(session.cwd)`），完整路径在 DOM 里
      // 根本没露面。而「恢复时预填的是不是这条会话自己的老目录」恰好只能靠完整
      // 路径判死 —— 比基名会漏（同名目录就算过）。所以这里把原值挂出来，
      // 供步骤 07 做精确断言。
      data-cwd={session.cwd}
      title={`${session.path}\n${costLabel}`}
      // 双击整行 = 点「继续」；不能恢复的行不做任何反应，免得误触后
      // 看起来像卡住了。
      onDoubleClick={() => {
        if (option) onResume(session, option)
      }}
      className="group cursor-target flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-hover"
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-text-muted">
        <Icon size={14} className="size-[14px]" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12px] text-text-primary">{session.title}</span>
          {session.subagent && (
            <span className="shrink-0 rounded bg-surface-strong px-1 font-maple text-[9px] text-text-muted">
              SUB
            </span>
          )}
          {session.origin === 'ide' && (
            <span className="shrink-0 rounded bg-surface-strong px-1 font-maple text-[9px] text-text-muted">
              {t.originIde}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-2 font-maple text-[10px] text-text-faint">
          <span className="truncate">{baseName(session.cwd) || '—'}</span>
          <span className="truncate">{session.model || '—'}</span>
        </span>
      </span>

      <span className="w-14 shrink-0 text-right font-maple text-[10px] text-text-faint">
        {session.messageCount}
      </span>
      <span className="w-16 shrink-0 text-right font-maple text-[10px] text-text-secondary">
        {formatTokens(session.usage.total)}
      </span>
      <span
        title={costLabel}
        // 只有 CLI 自己记的账单才是真数，值得用品牌色点亮；估出来的保持安静。
        className={`w-20 shrink-0 text-right font-maple text-[10px] ${
          session.costSource === 'recorded'
            ? 'text-brand'
            : session.costSource === 'catalog'
              ? 'text-text-secondary'
              : 'text-text-faint'
        }`}
      >
        {session.costSource === 'recorded' || session.costSource === 'catalog'
          ? formatUsd(session.costUsd)
          : '—'}
      </span>

      {/* 固定占一列宽，不靠 hover 才撑开：否则鼠标扫过整页时整行会左右抖。
          平时透明，hover / 键盘聚焦时才显形。 */}
      <span className="flex w-6 shrink-0 items-center justify-center">
        <button
          type="button"
          data-testid="session-history-resume"
          data-session={session.id}
          title={actionLabel}
          aria-label={actionLabel}
          disabled={!canResume}
          onClick={(event) => {
            event.stopPropagation()
            if (option) onResume(session, option)
          }}
          className={`flex size-5 items-center justify-center rounded transition-opacity ${
            canResume
              ? 'text-brand opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-brand/10 focus-visible:opacity-100'
              : 'cursor-not-allowed text-text-disabled opacity-0 group-hover:opacity-40'
          }`}
        >
          {resuming ? (
            <Loader2 className="size-3 animate-spin" strokeWidth={2} />
          ) : (
            <Play className="size-3" strokeWidth={2} />
          )}
        </button>
      </span>
    </li>
  )
}
