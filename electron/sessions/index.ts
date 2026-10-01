/**
 * Session discovery — the registry that runs all seven readers.
 *
 * One agent's data directory being missing, corrupt or mid-write must never
 * take the session list down with it, so every reader runs in isolation and
 * reports its own outcome: the UI can then say "Codex failed: <why>" instead of
 * showing an empty list and letting the user think we do not support Codex.
 *
 * `notInstalled` is separate from `error` on purpose. A missing directory is
 * normal — most machines have three of these seven agents — so it is not an
 * error; an empty list from a directory that *does* exist is a different
 * message to the user than an agent that was never installed.
 *
 * Everything here is read-only.
 */
import type {
  AgentId,
  AgentScanResult,
  DiscoverResult,
  HistorySession,
  PricingStatus
} from './types'
import { AGENT_IDS, sortSessions } from './types'
import { isDirectory } from './fsUtil'
import { estimateCost, loadPricingCache } from './pricing'
import { BUILTIN_PRICES } from './pricing-table'
import {
  antigravityCliHome,
  workbuddyHome,
  antigravityIdeHome,
  claudeConfigDir,
  codexHome,
  grokHome,
  kimiCodeHome,
  opencodeDataDir,
  piSessionDir
} from './paths'
import { readAntigravitySessions } from './readers/antigravity'
import { readClaudeSessions } from './readers/claude'
import { readCodexSessions } from './readers/codex'
import { readGrokSessions } from './readers/grok'
import { readKimiSessions } from './readers/kimi'
import { readOpenCodeSessions } from './readers/opencode'
import { readPiSessions } from './readers/pi'
import { readWorkbuddySessions } from './readers/workbuddy'

interface ReaderSpec {
  agent: AgentId
  read: (root: string | null) => Promise<HistorySession[]>
  /** Where the agent keeps its history. */
  root: () => Promise<string>
  /**
   * A second root that also means "installed". Only Antigravity has one: its
   * CLI and its IDE keep separate stores, and either counts.
   */
  altRoot?: () => Promise<string>
}

const SPECS: Record<AgentId, ReaderSpec> = {
  grok: {
    agent: 'grok',
    read: readGrokSessions,
    root: async () => grokHome()
  },
  claude: {
    agent: 'claude',
    read: readClaudeSessions,
    root: async () => claudeConfigDir()
  },
  codex: {
    agent: 'codex',
    read: readCodexSessions,
    root: async () => codexHome()
  },
  opencode: {
    agent: 'opencode',
    read: readOpenCodeSessions,
    root: async () => opencodeDataDir()
  },
  kimi: {
    agent: 'kimi',
    read: readKimiSessions,
    root: async () => kimiCodeHome()
  },
  pi: {
    agent: 'pi',
    read: readPiSessions,
    // Pi's session root is configurable, so probing it means doing the same
    // three-step resolution the reader does.
    root: piSessionDir
  },
  antigravity: {
    agent: 'antigravity',
    read: readAntigravitySessions,
    root: async () => antigravityCliHome(),
    altRoot: async () => antigravityIdeHome()
  },
  workbuddy: {
    agent: 'workbuddy',
    read: readWorkbuddySessions,
    root: async () => workbuddyHome()
  }
}

export interface DiscoverOptions {
  /** Restrict the scan to some agents. Defaults to all seven. */
  agents?: readonly AgentId[]
  /** Point an agent at a fixture directory instead of its real one. */
  roots?: Partial<Record<AgentId, string | null>>
  /**
   * Per-agent ceiling. A data directory on a dead network share would otherwise
   * hang the whole list; the read itself cannot be cancelled, but the caller
   * gets control back and the agent is reported as failed.
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([work, expiry]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

/**
 * Turn `unpriced` sessions into `catalog` ones wherever the catalogue can
 * actually price them.
 *
 * This is done once, centrally, rather than in each reader: readers only know
 * how many tokens were spent, and duplicating the price lookup seven times is
 * how you get seven slightly different estimates. `recorded` is never touched —
 * a CLI's own bill always outranks our arithmetic.
 */
function priceSessions(sessions: readonly HistorySession[]): HistorySession[] {
  return sessions.map((session) => {
    if (session.costSource !== 'unpriced') return session
    const estimate = estimateCost(session.model, session.usage)
    if (estimate.source !== 'catalog') return session
    return { ...session, costUsd: estimate.usd, costSource: 'catalog' }
  })
}

async function scanOne(spec: ReaderSpec, options: DiscoverOptions): Promise<AgentScanResult> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const override = options.roots?.[spec.agent]

  try {
    const root = override ?? (await spec.root())
    let installed = await isDirectory(root)
    if (!installed && !override && spec.altRoot) {
      installed = await isDirectory(await spec.altRoot())
    }

    const sessions = priceSessions(
      await withTimeout(spec.read(override ?? null), timeoutMs, spec.agent)
    )
    return {
      agent: spec.agent,
      sessions,
      error: null,
      // A fixture root is taken at its word: the caller asked for that
      // directory, so "there is nothing in it" is the answer, not "missing".
      notInstalled: !installed && !override,
      tookMs: Date.now() - started
    }
  } catch (error) {
    return {
      agent: spec.agent,
      sessions: [],
      error: describe(error),
      notInstalled: false,
      tookMs: Date.now() - started
    }
  }
}

/**
 * Read every installed agent's history.
 *
 * Readers run concurrently because they are all independent I/O waits, and the
 * slowest one (a cold Codex scan over a large rollout set) sets the wall clock
 * rather than the sum of all seven.
 */
export async function discoverSessions(options: DiscoverOptions = {}): Promise<DiscoverResult> {
  const started = Date.now()
  const wanted = options.agents ?? AGENT_IDS
  const specs = wanted.map((agent) => SPECS[agent]).filter(Boolean)

  const results = await Promise.all(specs.map((spec) => scanOne(spec, options)))

  const sessions = sortSessions(results.flatMap((result) => result.sessions))
  return {
    sessions,
    results,
    tookMs: Date.now() - started,
    pricing: describePricing()
  }
}

/**
 * The snapshot's size, for when no refreshed cache exists. Computed once —
 * `BUILTIN_PRICES` has a few hundred entries and the status line is rebuilt on
 * every scan.
 */
let builtinCount: number | null = null
function countBuiltinModels(): number {
  if (builtinCount === null) builtinCount = Object.keys(BUILTIN_PRICES).length
  return builtinCount
}

/**
 * Which catalogue priced the estimates. Reported alongside the sessions so the
 * UI can name its source; an estimate whose provenance is invisible is just a
 * number pretending to be a fact.
 */
function describePricing(): PricingStatus {
  const loaded = loadPricingCache()
  return {
    models: loaded.loaded ? loaded.count : countBuiltinModels(),
    generatedOn: loaded.generatedOn,
    refreshed: loaded.loaded
  }
}

// 派生视图（排序 / 分组 / 汇总）只有一份实现，在 shared/session-history.ts ——
// 主进程和渲染进程共用，避免列表和统计页算出两个不同的总数。这里原样透出，
// 让主进程侧的调用方仍然只依赖 electron/sessions/。
export {
  formatTokens,
  formatUsd,
  groupByAgent,
  sessionTime,
  sortSessions,
  summarise,
  visibleSessions,
  type DiscoverSummary
} from '../../shared/session-history'
