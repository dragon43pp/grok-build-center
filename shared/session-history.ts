/**
 * Session-history contract — shared by the main process and the renderer.
 *
 * GBC's existing adapters (electron/agents/adapters/*) observe a *live* CLI
 * through its hook file, so they can tell you a session is working or blocked.
 * They cannot tell you what ran last week. This module is the other half: it
 * describes the transcripts each CLI leaves on disk, so the app can list,
 * search, total up and export past work.
 *
 * It lives in `shared/` rather than under `electron/sessions/` because the
 * renderer needs the same types to call the IPC surface, and because the
 * aggregation helpers below must not have two implementations — a token total
 * that the list and the statistics page disagree about is worse than no total.
 *
 * Reading is done in the main process (`electron/sessions/`), which is the only
 * side allowed to touch the filesystem. Everything in this file is pure, so it
 * is safe to import from either process.
 */

/** The CLIs whose history we can read. */
export type AgentId =
  | 'grok'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'kimi'
  | 'pi'
  | 'antigravity'
  | 'workbuddy'

export const AGENT_IDS: readonly AgentId[] = [
  'grok',
  'claude',
  'codex',
  'opencode',
  'kimi',
  'pi',
  'antigravity',
  'workbuddy'
]

/**
 * How a session is stored. Deleting or restoring one needs to know whether the
 * unit is a file, a whole directory, or a row in a SQLite database.
 */
export type StorageKind = 'dir' | 'file' | 'db'

/**
 * Token usage for one session, normalised across agents.
 *
 * Agents disagree about nesting, not just naming, and the difference is not
 * guessable from the field names — Grok's `inputTokens` and Codex's
 * `input_tokens` look almost identical and mean different things:
 *
 *   Grok   inputTokens excludes cachedReadTokens     (siblings; established
 *                                                    from Grok's recorded bill)
 *   Codex  input_tokens includes cached_input_tokens (nested; OpenAI's shape)
 *
 * So each reader has to know which agent it is reading and subtract
 * accordingly. Summing the raw fields is the easiest way to be off by 4×; every
 * reader documents its own case and the evidence behind it.
 *
 * The check that a reader got it right is `withTotal`: for the nesting agents,
 * the five components must add back up to the agent's own total. That is why we
 * compute the total ourselves instead of trusting the field.
 */
export interface TokenUsage {
  /** Input tokens billed at the full input rate (cache reads excluded). */
  input: number
  output: number
  /** Cache reads, billed at the provider's cache-read rate (usually ~10-25%). */
  cacheRead: number
  /** Cache writes/creation, billed at or above the input rate. */
  cacheWrite: number
  /** Reasoning/thinking tokens; some providers bill these at the output rate. */
  reasoning: number
  /** input + output + cacheRead + cacheWrite + reasoning. */
  total: number
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }
}

export function withTotal(u: Omit<TokenUsage, 'total'>): TokenUsage {
  return { ...u, total: u.input + u.output + u.cacheRead + u.cacheWrite + u.reasoning }
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return withTotal({
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning
  })
}

export function hasUsage(u: TokenUsage): boolean {
  return u.total > 0
}

/**
 * Where a session's dollar figure came from. Keeping this explicit matters:
 * Grok writes its own cost into usage.json, opencode records a per-message
 * cost, and everything else has to be priced from a catalogue. Presenting a
 * catalogue estimate as a real bill would be wrong.
 */
export type CostSource =
  /** The agent recorded what it actually cost. Trustworthy. */
  | 'recorded'
  /** Priced from the model catalogue. An estimate. */
  | 'catalog'
  /** Usage exists but the model is not in the catalogue. */
  | 'unpriced'
  /** No usage at all (Antigravity records none). */
  | 'none'

export interface HistorySession {
  agent: AgentId
  /** Agent-native session id (UUID, `ses_…`, …). */
  id: string
  title: string
  /** Project working directory, '' when the agent does not record one. */
  cwd: string
  /** ISO 8601, or null when unknown. */
  createdAt: string | null
  updatedAt: string | null
  /** Displayed message count; 0 when the agent does not count them. */
  messageCount: number
  /** Model id as recorded by the agent (raw, not normalised). */
  model: string
  usage: TokenUsage
  /** Dollars. 0 when costSource is 'unpriced' or 'none'. */
  costUsd: number
  costSource: CostSource
  storage: StorageKind
  /**
   * Absolute path to the session unit: a directory for Grok/Kimi/Antigravity,
   * a JSONL file for Claude/Codex/Pi, a synthetic `opencode://<id>` for
   * opencode (which has no per-session file).
   */
  path: string
  /** True when the agent's own UI considers this archived. */
  archived: boolean
  /**
   * Sub-agent session (spawned by another session, not started by the user).
   * Hidden from the session list but still counted in usage totals, because
   * these are real API calls that cost real money.
   */
  subagent: boolean
  /**
   * Which of an agent's several stores the session came from, when it has more
   * than one. Antigravity is the only such agent today: its CLI keeps history
   * under `~/.gemini/antigravity-cli` and the IDE keeps its own under
   * `~/.gemini/antigravity`, and only a CLI session can be resumed from a
   * terminal. Undefined for every other agent, which have a single store.
   */
  origin?: 'cli' | 'ide'
}

/** Result of one reader pass, so the UI can say which agent failed and why. */
export interface AgentScanResult {
  agent: AgentId
  sessions: HistorySession[]
  /** Non-null when the agent's data root is missing or unreadable. */
  error: string | null
  /** True when the agent is not installed on this machine. */
  notInstalled: boolean
  tookMs: number
}

/**
 * Which price catalogue priced the estimates, so the UI can say where the
 * numbers came from instead of presenting them as magic.
 */
export interface PricingStatus {
  /** Number of models in the catalogue that did the pricing. */
  models: number
  /** `YYYY-MM-DD` the catalogue was compiled/refreshed. */
  generatedOn: string
  /** True when a runtime refresh from models.dev is in use, not the snapshot. */
  refreshed: boolean
}

/** Result of a price-catalogue refresh. */
export interface PricingRefreshResult {
  ok: boolean
  /** Models in the catalogue after the attempt (unchanged on failure). */
  count: number
  generatedOn: string
  /** Why it failed, when it did. Offline is a normal answer, not a crash. */
  error?: string
}

export interface DiscoverResult {
  sessions: HistorySession[]
  results: AgentScanResult[]
  tookMs: number
  pricing: PricingStatus
}

/** Every reader returns this; a missing root is not an error. */
export interface ReaderContext {
  /** Overridable data root for tests and for GROK_HOME-style env overrides. */
  root: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// 派生：这一节被主进程和渲染进程共用，只有一份实现
// ─────────────────────────────────────────────────────────────────────────────

/** Sort key: the newer of updatedAt and createdAt, as epoch millis. */
export function sessionTime(session: HistorySession): number {
  const value = session.updatedAt ?? session.createdAt
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Newest first. Sessions with no timestamp at all sort last. */
export function sortSessions(sessions: readonly HistorySession[]): HistorySession[] {
  return [...sessions].sort((a, b) => {
    const delta = sessionTime(b) - sessionTime(a)
    if (delta) return delta
    return a.title.localeCompare(b.title)
  })
}

/** The top-level sessions a list should show: no sub-agents, no archived. */
export function visibleSessions(sessions: readonly HistorySession[]): HistorySession[] {
  return sortSessions(sessions.filter((session) => !session.subagent && !session.archived))
}

/** Every session, including sub-agents, grouped by the agent that owns it. */
export function groupByAgent(
  sessions: readonly HistorySession[]
): Map<AgentId, HistorySession[]> {
  const grouped = new Map<AgentId, HistorySession[]>()
  for (const session of sessions) {
    const bucket = grouped.get(session.agent)
    if (bucket) bucket.push(session)
    else grouped.set(session.agent, [session])
  }
  return grouped
}

/**
 * How much of a scan succeeded, for the status line above the list:
 * 「已安装 5 · 未安装 2 · 失败 0 · 顶层 379 · 子代理 148 · token 25.4B」.
 */
export interface DiscoverSummary {
  installed: number
  notInstalled: number
  failed: number
  /** Top-level sessions: what a list shows. */
  sessionCount: number
  /** Sub-agent sessions: hidden from the list but counted in usage. */
  subagentCount: number
  totalTokens: number
  /** Of `totalTokens`, how much sits in sub-agent sessions. */
  subagentTokens: number
}

export function summarise(result: DiscoverResult): DiscoverSummary {
  let installed = 0
  let notInstalled = 0
  let failed = 0
  for (const agent of result.results) {
    if (agent.error) failed++
    else if (agent.notInstalled) notInstalled++
    else installed++
  }
  let sessionCount = 0
  let subagentCount = 0
  let totalTokens = 0
  let subagentTokens = 0
  for (const session of result.sessions) {
    const tokens = session.usage.total
    if (session.subagent) {
      subagentCount++
      subagentTokens += tokens
    } else {
      sessionCount++
    }
    totalTokens += tokens
  }
  return { installed, notInstalled, failed, sessionCount, subagentCount, totalTokens, subagentTokens }
}

/** Token counters get long fast; nobody reads the last six digits. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(2)}B`
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(2)}M`
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}K`
  return String(Math.round(tokens))
}

/**
 * Dollars. Always `¥`-free: every agent bills in USD, and the conversion would
 * need a rate we do not have. Below a cent we still show something, because
 * "0.00" reads as free when it is not.
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 1000) return `$${usd.toFixed(2)}`
  return `$${usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}
