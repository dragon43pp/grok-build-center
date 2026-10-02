import { useCallback, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CopyX,
  EyeOff,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { getAdapterIcon, getAdapterName } from './adapterIcons'
import { useSessions } from './sessionHistoryData'
import { useStrings } from './i18n'
import { useSessionOpsStore } from '../state/sessionOpsStore'
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

  // ── AI 智能查找 ────────────────────────────────────────────────
  const [aiQuery, setAiQuery] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  /** null = 没跑过；跑过后保留 answer + 命中 keys，chip 可开关过滤。 */
  const [aiResult, setAiResult] = useState<{ answer: string; sessionKeys: string[] } | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiFilterActive, setAiFilterActive] = useState(false)
  // ── 重复分组 ──────────────────────────────────────────────────
  const [dupBusy, setDupBusy] = useState(false)
  const [dupGroups, setDupGroups] = useState<Array<{ keepKey: string; sessions: HistorySession[] }> | null>(null)
  // ── 回收站 ────────────────────────────────────────────────────
  const [trashingKey, setTrashingKey] = useState<string | null>(null)
  const [trashMessage, setTrashMessage] = useState<string | null>(null)

  const hiddenKeys = useSessionOpsStore((state) => state.hiddenKeys)
  const hideKeys = useSessionOpsStore((state) => state.hide)
  const unhideAll = useSessionOpsStore((state) => state.clearHidden)

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

  /** 行 key，与 AI 返回的 sessionKeys、墓碑 store 同构。 */
  const keyOf = useCallback(
    (session: HistorySession): string => `${session.agent}:${session.id}`,
    []
  )

  /** 能否整场移入回收站：真实文件/目录才行（db 与合成路径拒绝）。 */
  const trashable = useCallback((session: HistorySession): boolean => {
    if (session.storage === 'db') return false
    // opencode 这类合成路径（`opencode://<id>`）不是磁盘上的真实位置。
    return !/^[a-z][a-z0-9+.-]*:\/\//i.test(session.path)
  }, [])

  const runAiSearch = useCallback(async (): Promise<void> => {
    const question = aiQuery.trim()
    if (question === '' || aiBusy) return
    setAiBusy(true)
    setAiError(null)
    try {
      const response = await window.assistantApi.search({ query: question })
      if (!response.ok) {
        setAiError(
          response.errorCode === 'not_configured'
            ? t.aiNotConfigured
            : (response.errorMessage ?? t.aiFailed(''))
        )
        setAiResult(null)
        setAiFilterActive(false)
        return
      }
      setAiResult({ answer: response.answer, sessionKeys: response.sessionKeys })
      // 有命中就直接切到「只看命中」；0 命中保持全列表，让答案自己说话。
      setAiFilterActive(response.sessionKeys.length > 0)
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error))
      setAiResult(null)
    } finally {
      setAiBusy(false)
    }
  }, [aiQuery, aiBusy, t])

  /**
   * 重复分组：标题 + cwd 都归一后相同才算（时间相近的自动化会成批刷重复）。
   * 最新一场留下，其余给出隐藏建议。
   */
  const runDedupe = useCallback((): void => {
    if (dupBusy) return
    setDupBusy(true)
    try {
      const norm = (value: string): string => value.trim().toLowerCase().replace(/[\\/]+/g, '/')
      const buckets = new Map<string, HistorySession[]>()
      for (const session of sessions) {
        if (session.subagent || session.archived) continue
        const group = norm(session.title) + '|' + norm(session.cwd)
        const bucket = buckets.get(group)
        if (bucket) bucket.push(session)
        else buckets.set(group, [session])
      }
      const groups = [...buckets.values()]
        .filter((bucket) => bucket.length > 1)
        .map((bucket) => {
          const sorted = [...bucket].sort((a, b) =>
            (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '')
          )
          return { keepKey: keyOf(sorted[0]), sessions: sorted }
        })
        .sort((a, b) => b.sessions.length - a.sessions.length)
      setDupGroups(groups)
    } finally {
      setDupBusy(false)
    }
  }, [dupBusy, sessions, keyOf])

  const keepNewestHideRest = useCallback(
    (group: { keepKey: string; sessions: HistorySession[] }): void => {
      hideKeys(group.sessions.filter((s) => keyOf(s) !== group.keepKey).map(keyOf))
      setDupGroups((current) =>
        current ? current.filter((candidate) => candidate !== group) : null
      )
    },
    [hideKeys, keyOf]
  )

  const trashSession = useCallback(
    (session: HistorySession): void => {
      if (!window.confirm(t.trashConfirm)) return
      const key = keyOf(session)
      setTrashingKey(key)
      setTrashMessage(null)
      void window.sessionsApi
        .trash({ agent: session.agent, id: session.id, path: session.path })
        .then((result) => {
          if (result.ok) {
            hideKeys([key])
            setTrashMessage(t.trashOk)
          } else {
            setTrashMessage(t.trashFailed(result.message ?? ''))
          }
        })
        .finally(() => setTrashingKey(null))
    },
    [hideKeys, keyOf, t]
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const aiKeys = aiFilterActive && aiResult ? new Set(aiResult.sessionKeys) : null
    return sortSessions(
      sessions.filter((session) => {
        if (!showSubagents && (session.subagent || session.archived)) return false
        if (agentFilter && session.agent !== agentFilter) return false
        if (hiddenKeys.includes(keyOf(session))) return false
        if (aiKeys && !aiKeys.has(keyOf(session))) return false
        if (!needle) return true
        return (
          session.title.toLowerCase().includes(needle) ||
          session.cwd.toLowerCase().includes(needle) ||
          session.model.toLowerCase().includes(needle) ||
          session.agent.includes(needle)
        )
      })
    )
  }, [sessions, query, agentFilter, showSubagents, hiddenKeys, keyOf, aiFilterActive, aiResult])

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

        {/* AI 智能查找 + 查重复 */}
        <div className="mt-2 flex items-center gap-2">
          <label className="relative flex min-w-0 flex-1 items-center">
            <Sparkles
              className="pointer-events-none absolute left-2 size-3.5 text-text-faint"
              strokeWidth={1.75}
            />
            <input
              type="text"
              data-testid="session-history-ai-search"
              value={aiQuery}
              onChange={(event) => setAiQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runAiSearch()
              }}
              placeholder={t.aiSearchPlaceholder}
              className="w-full rounded-md border border-border-subtle bg-transparent py-1.5 pr-2 pl-7 text-[11px] text-text-primary outline-none transition-colors placeholder:text-text-faint focus:border-brand/40"
            />
          </label>
          <button
            type="button"
            data-testid="session-history-ai-ask"
            disabled={aiBusy || aiQuery.trim() === ''}
            onClick={() => void runAiSearch()}
            className="cursor-target flex shrink-0 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-60"
          >
            {aiBusy ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <Sparkles className="size-3.5" strokeWidth={1.75} />
            )}
            {aiBusy ? t.aiSearching : t.aiAsk}
          </button>
          <button
            type="button"
            data-testid="session-history-dedupe"
            disabled={dupBusy}
            onClick={runDedupe}
            className="cursor-target flex shrink-0 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-60"
          >
            {dupBusy ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <CopyX className="size-3.5" strokeWidth={1.75} />
            )}
            {dupBusy ? t.dedupeScanning : t.dedupe}
          </button>
        </div>

        {/* AI 答案面板 */}
        {aiError && (
          <p
            data-testid="session-history-ai-error"
            className="mt-2 rounded-md border border-amber-500/30 px-3 py-2 text-[11px] text-amber-500"
          >
            {aiError}
          </p>
        )}
        {aiResult && !aiError && (
          <div
            data-testid="session-history-ai-answer"
            className="mt-2 rounded-md border border-border-subtle bg-surface px-3 py-2"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-[11px] leading-relaxed text-text-secondary">
                <Sparkles className="mr-1 inline size-3 text-brand" strokeWidth={1.75} />
                <span className="font-medium text-text-primary">{t.aiAnswerLabel}：</span>
                {aiResult.answer}
              </p>
              <button
                type="button"
                onClick={() => {
                  setAiResult(null)
                  setAiFilterActive(false)
                }}
                className="shrink-0 text-[10px] text-text-faint transition-colors hover:text-text-secondary"
              >
                {t.aiClearMatches}
              </button>
            </div>
            {aiResult.sessionKeys.length > 0 && (
              <button
                type="button"
                data-testid="session-history-ai-filter"
                aria-pressed={aiFilterActive}
                onClick={() => setAiFilterActive((value) => !value)}
                className={`mt-1.5 cursor-target rounded-full border px-2 py-0.5 font-maple text-[10px] transition-colors ${
                  aiFilterActive
                    ? 'border-brand/40 bg-surface-strong text-text-primary'
                    : 'border-border-faint text-text-muted hover:bg-surface-hover'
                }`}
              >
                {t.aiMatchedCount(aiResult.sessionKeys.length)}
                {aiFilterActive ? ' · ON' : ' · OFF'}
              </button>
            )}
          </div>
        )}

        {/* 重复分组面板 */}
        {dupGroups && (
          <div
            data-testid="session-history-dup-groups"
            className="mt-2 rounded-md border border-border-subtle bg-surface px-3 py-2"
          >
            {dupGroups.length === 0 ? (
              <p className="text-[11px] text-text-secondary">{t.dedupeNone}</p>
            ) : (
              <>
                <p className="font-maple text-[10px] text-text-faint">
                  {t.dupGroupTitle(dupGroups.length, dupGroups.reduce((sum, g) => sum + g.sessions.length, 0))}
                </p>
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {dupGroups.slice(0, 8).map((group) => (
                    <li key={group.keepKey} className="flex items-center gap-2 text-[11px]">
                      <span className="min-w-0 flex-1 truncate text-text-secondary">
                        {group.sessions[0].title}
                        <span className="ml-1.5 text-text-faint">×{group.sessions.length}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => keepNewestHideRest(group)}
                        className="shrink-0 cursor-target rounded border border-border-faint px-1.5 py-0.5 text-[10px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
                      >
                        {t.dupKeepNewest}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
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

        {trashMessage && (
          <p
            data-testid="session-history-trash-message"
            className="m-3 rounded-md border border-border-subtle bg-surface px-3 py-2 text-[11px] text-text-secondary"
          >
            {trashMessage}
          </p>
        )}

        {hiddenKeys.length > 0 && (
          <div className="mx-3 mt-2 flex items-center justify-between rounded-md border border-border-subtle bg-surface px-3 py-1.5">
            <span className="flex items-center gap-1.5 text-[10px] text-text-muted">
              <EyeOff className="size-3" strokeWidth={1.75} />
              {t.hiddenBanner(hiddenKeys.length)}
            </span>
            <button
              type="button"
              onClick={unhideAll}
              className="cursor-target text-[10px] text-text-faint transition-colors hover:text-text-secondary"
            >
              {t.unhideAll}
            </button>
          </div>
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
            <ul>{rows.map((session) => {
              const key = `${session.agent}:${session.id}`
              return (
              <SessionRow
                key={key}
                session={session}
                affordance={resumeAffordance(session)}
                resuming={resumingId === session.id}
                highlighted={Boolean(aiResult?.sessionKeys.includes(key))}
                trashing={trashingKey === key}
                onTrash={trashable(session) ? trashSession : null}
                onResume={handleResume}
              />
              )
            })}</ul>
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
  highlighted,
  trashing,
  onTrash,
  onResume
}: {
  session: HistorySession
  affordance: { option: LaunchableCli | null; blocked: string | null }
  resuming: boolean
  /** AI 查找命中：左侧 2px 珊瑚条 + 标题点亮。 */
  highlighted: boolean
  trashing: boolean
  /** null = 这种存储不能整场删除（db / 合成路径），不出按钮。 */
  onTrash: ((session: HistorySession) => void) | null
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
      className={`group relative cursor-target flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-hover ${
        highlighted ? 'bg-surface' : ''
      }`}
    >
      {highlighted && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand"
        />
      )}
      <span className="flex size-5 shrink-0 items-center justify-center text-text-muted">
        <Icon size={14} className="size-[14px]" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span
            className={`truncate text-[12px] ${
              highlighted ? 'font-semibold text-text-strong' : 'text-text-primary'
            }`}
          >
            {session.title}
          </span>
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

      {/* 移入系统回收站（可还原）。db / 合成路径不出这个按钮。 */}
      {onTrash && (
        <span className="flex w-6 shrink-0 items-center justify-center">
          <button
            type="button"
            data-testid="session-history-trash"
            data-session={session.id}
            title={t.trash}
            aria-label={`${t.trash}: ${session.title}`}
            disabled={trashing}
            onClick={(event) => {
              event.stopPropagation()
              onTrash(session)
            }}
            className="flex size-5 items-center justify-center rounded text-text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-surface-strong hover:text-status-error focus-visible:opacity-100 disabled:cursor-wait"
          >
            {trashing ? (
              <Loader2 className="size-3 animate-spin" strokeWidth={2} />
            ) : (
              <Trash2 className="size-3" strokeWidth={2} />
            )}
          </button>
        </span>
      )}
    </li>
  )
}
