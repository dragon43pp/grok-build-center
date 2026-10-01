/**
 * Codex — `$CODEX_HOME/state_<N>.sqlite` (index) + `sessions/<Y>/<M>/<D>/rollout-*.jsonl`
 *
 * Codex is the only agent here whose index is a SQL database, which makes the
 * listing cheap and complete: titles, cwd, archive flag, sub-agent edges and
 * even a message count are all in one place. It reads the database, never
 * writes it.
 *
 * Token accounting is the interesting part. The `threads.tokens_used` column is
 * a single opaque number that is 0 on plenty of threads that clearly did work,
 * so we do not trust it for the total. Each rollout ends with cumulative
 * `event_msg/token_count` records that carry the full breakdown, so we read the
 * **tail** of the rollout and take the last one. The column stays as a fallback
 * for rollouts that have been moved or deleted.
 *
 * Two Windows-specific traps: the schema number in `state_<N>.sqlite` climbs
 * with each Codex release, so the live file has to be discovered rather than
 * hardcoded; and `rollout_path` / `cwd` are stored with the `\\?\` extension
 * prefix, which has to be stripped before anything else can use them.
 */
import { join } from 'node:path'
import type { HistorySession, TokenUsage } from '../types'
import { withTotal } from '../types'
import {
  countLines,
  firstText,
  isoFromMs,
  listDir,
  normalizeStoredPath,
  num,
  parseJsonLines,
  readTailLines,
  toTitle
} from '../fsUtil'
import { openReadOnly } from '../sqlite'
import { codexHome } from '../paths'

/** `state_5.sqlite` -> 5. Unversioned or unparsable names score -1. */
const STATE_DB = /^state_(\d+)\.sqlite$/
const HISTORY_DB = /^thread_history_(\d+)\.sqlite$/

function newestDb(files: readonly string[], pattern: RegExp): string | null {
  let best: { version: number; name: string } | null = null
  for (const name of files) {
    const match = pattern.exec(name)
    if (!match) continue
    const version = Number(match[1])
    if (!best || version > best.version) best = { version, name }
  }
  return best?.name ?? null
}

interface CodexTokenUsage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

/**
 * Map Codex's counters onto our five components.
 *
 * The field names read like siblings, but Codex nests:
 *
 *   total_tokens = input_tokens + output_tokens
 *   cached_input_tokens     ⊂ input_tokens
 *   reasoning_output_tokens ⊂ output_tokens
 *
 * All three relations hold on 396 of 396 local rollouts
 * (`tools/probe_codex_usage.py`), and they match OpenAI's documented API shape,
 * where `*_details` counters are subsets of the totals beside them.
 *
 * Note this is **not** how Grok's fields behave, even though the names are
 * nearly identical — Grok's `inputTokens` excludes `cachedReadTokens`. See
 * readers/grok.ts, where the difference is pinned down with a real bill.
 *
 * So the five components are built by subtracting the subsets back out, which
 * leaves their sum equal to Codex's own `total_tokens`.
 */
function fromCodexUsage(raw: CodexTokenUsage | undefined): TokenUsage | null {
  if (!raw) return null
  const cacheRead = num(raw.cached_input_tokens)
  const cacheWrite = num(raw.cache_write_input_tokens)
  const reasoning = num(raw.reasoning_output_tokens)
  const usage = withTotal({
    input: Math.max(0, num(raw.input_tokens) - cacheRead - cacheWrite),
    output: Math.max(0, num(raw.output_tokens) - reasoning),
    cacheRead,
    cacheWrite,
    reasoning
  })
  return usage.total > 0 ? usage : null
}

/**
 * The last cumulative token count in a rollout.
 *
 * `total_token_usage` is running, not per-turn, and the tail may start mid
 * record, so we scan backwards for the newest well-formed one.
 */
async function usageFromRollout(rolloutPath: string): Promise<TokenUsage | null> {
  const lines = await readTailLines(rolloutPath, 131072)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('total_token_usage')) continue
    let record: { payload?: { info?: { total_token_usage?: CodexTokenUsage } } }
    try {
      record = JSON.parse(line) as typeof record
    } catch {
      continue
    }
    const usage = fromCodexUsage(record.payload?.info?.total_token_usage)
    if (usage) return usage
  }
  return null
}

interface CodexRow {
  id: string
  rollout_path: string
  created_at: number
  updated_at: number
  cwd: string
  title: string
  name: string | null
  preview: string
  first_user_message: string
  model: string | null
  model_provider: string | null
  tokens_used: number
  archived: number
  thread_source: string | null
  source: string
}

export async function readCodexSessions(rootOverride?: string | null): Promise<HistorySession[]> {
  const root = rootOverride || codexHome()
  const files = await listDir(root)
  const stateName = newestDb(files, STATE_DB)
  if (!stateName) return []

  const db = openReadOnly(join(root, stateName))
  try {
    const rows = db
      .prepare(
        `select id, rollout_path, created_at, updated_at, cwd, title, name, preview,
                first_user_message, model, model_provider, tokens_used, archived,
                thread_source, source
           from threads`
      )
      .all() as unknown as CodexRow[]

    // Sub-agent threads are recorded as edges, not as a column.
    const childIds = new Set<string>()
    try {
      const edges = db
        .prepare('select child_thread_id from thread_spawn_edges')
        .all() as unknown as { child_thread_id: string }[]
      for (const edge of edges) childIds.add(edge.child_thread_id)
    } catch {
      // Older schemas have no spawn edges; every thread is a top-level one.
    }

    // Message counts live in a different database, keyed by thread.
    const itemCounts = new Map<string, number>()
    const historyName = newestDb(files, HISTORY_DB)
    if (historyName) {
      try {
        const history = openReadOnly(join(root, historyName))
        try {
          const counts = history
            .prepare('select thread_id, count(*) as n from thread_items group by thread_id')
            .all() as unknown as { thread_id: string; n: number }[]
          for (const row of counts) itemCounts.set(row.thread_id, num(row.n))
        } finally {
          history.close()
        }
      } catch {
        // Optional enrichment only.
      }
    }

    const sessions: HistorySession[] = []
    for (const row of rows) {
      const rolloutPath = normalizeStoredPath(row.rollout_path)
      const usage =
        (await usageFromRollout(rolloutPath)) ??
        // Fallback: the column is a lump total with no breakdown. Putting it in
        // `input` keeps our computed total honest even though the split is lost.
        (num(row.tokens_used) > 0
          ? withTotal({
              input: num(row.tokens_used),
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: 0
            })
          : withTotal({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }))

      sessions.push({
        agent: 'codex',
        id: row.id,
        // `title` is the full first exchange and can be thousands of characters;
        // `name` is Codex's own short label and is what the CLI shows.
        title:
          toTitle(row.name) ||
          toTitle(row.first_user_message) ||
          toTitle(row.preview) ||
          toTitle(row.title) ||
          '(untitled)',
        cwd: normalizeStoredPath(firstText(row.cwd)),
        createdAt: isoFromMs(row.created_at * 1000),
        updatedAt: isoFromMs(row.updated_at * 1000),
        messageCount: itemCounts.get(row.id) ?? (await countLines(rolloutPath)),
        model: firstText(row.model, row.model_provider),
        usage,
        costUsd: 0,
        costSource: usage.total > 0 ? 'unpriced' : 'none',
        storage: 'file',
        path: rolloutPath,
        archived: num(row.archived) === 1,
        subagent: childIds.has(row.id) || row.thread_source === 'subagent'
      })
    }
    return sessions
  } finally {
    db.close()
  }
}
