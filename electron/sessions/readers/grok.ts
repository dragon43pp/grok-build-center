/**
 * Grok Build — `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/`
 *
 * Grok is the agent we care about most, and the one that gives us the most:
 * `summary.json` carries title, cwd, model, timestamps and message counts, and
 * `usage.json` carries the token breakdown **and the dollar cost Grok itself
 * recorded**. No other agent on this machine records its own cost, so for Grok
 * we can show a real bill instead of a catalogue estimate.
 *
 * Two traps:
 *
 *  - `sessions/` is not a list of sessions. It holds one directory per working
 *    directory, each containing one directory per session, plus at least one
 *    stray file (`session_search.sqlite`). Anything that treats the first level
 *    as sessions reports a handful of nonsense entries.
 * Which nesting is correct is settled by billing, because `usage.json` is the
 * only place on this machine where an agent records what it actually paid. The
 * counters are priced with the first-party model prices (`tools/verify_pricing.ts`)
 * and compared against `costUsdTicks` across all 34 model blocks that carry one:
 *
 *   treating the counters as siblings  ->  $4407 predicted vs $3825 recorded (×1.15)
 *   subtracting cached reads           ->  $1160 predicted vs $3825 recorded (×0.30)
 *
 * So `inputTokens` does **not** include `cachedReadTokens`: they are separate
 * counters that must be added. This is the opposite of Codex, whose
 * `input_tokens` does contain `cached_input_tokens` — see readers/codex.ts.
 * Getting the two backwards is the easy way to be off by 3×.
 *
 * ⚠️ **But do not read ×1.15 as "we reproduce Grok's bill".** We do not, and no
 * choice of nesting makes the bill reproducible: two sessions on this machine
 * spend almost identical counters (23 501 vs 24 000 input, 128 cached) and were
 * billed $0.47 and $0.95; a third at 22 925 input was billed $0.08. Per-block the
 * ratio spreads from ×0.10 to ×1.79, and the cheap first-call sessions are
 * systematically *under*predicted (median ×0.31) — there is a cost driver Grok
 * bills for that its counters do not expose. Additive wins by a factor of ~4,
 * which is why the shape is what it is; the *magnitude* is an estimate, which is
 * also why Grok's own recorded figure always outranks anything we compute.
 *
 * `usage.session.totalTokens` meanwhile is *defined* as `inputTokens +
 * outputTokens`, so it silently omits the cache counters. That is a misleading
 * field rather than an undercount, and it is why we build the total ourselves.
 *
 * Which nested counter does exist: `reasoningTokens` is inside `outputTokens`,
 * and the bill confirms it is not charged a second time. It is therefore carved
 * out of `output` so that our five components do not count it twice.
 */
import { join } from 'node:path'
import type { AgentId, HistorySession, TokenUsage } from '../types'
import { withTotal } from '../types'
import {
  countLines,
  exists,
  firstText,
  isoFromString,
  listSubdirs,
  num,
  readHeadLines,
  readJson,
  toTitle
} from '../fsUtil'
import { grokHome } from '../paths'

/** Grok writes cost in "ticks" of 1e-9 USD. */
const COST_TICKS_PER_USD = 1e9

interface GrokSummary {
  info?: { id?: string; cwd?: string }
  session_summary?: string
  created_at?: string
  updated_at?: string
  num_messages?: number
  num_chat_messages?: number
  current_model_id?: string
  agent_name?: string
}

interface GrokUsageBlock {
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  modelCalls?: number
  costUsdTicks?: number
  primaryModelId?: string
}

interface GrokUsageFile {
  sessionId?: string
  updatedAt?: string
  session?: GrokUsageBlock
  turns?: unknown[]
}

/**
 * Map Grok's counters onto our five components.
 *
 * `inputTokens` and `cachedReadTokens` are siblings — add them, do not nest
 * them. `reasoningTokens` is a subset of `outputTokens`, so it is subtracted
 * out of `output` and exposed on its own. The reasoning behind both calls, and
 * the billing measurement that settles them, is in the file header.
 *
 * `cacheCreationTokens` is 0 in every one of the 58 usage blocks on this
 * machine, so the bill cannot say whether a cache write is a fresh input token
 * or an extra one. It is treated as extra, which is what a cache *creation*
 * means: the token is written to the cache in addition to being processed.
 */
function toUsage(block: GrokUsageBlock | undefined): TokenUsage {
  if (!block) return withTotal({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })

  const reasoning = num(block.reasoningTokens)
  // `num()` clamps to >= 0, but the envelope can still be smaller than its own
  // subset if a writer ever resets one, so clamp again after subtracting.
  const output = Math.max(0, num(block.outputTokens) - reasoning)

  return withTotal({
    input: num(block.inputTokens),
    output,
    cacheRead: num(block.cachedReadTokens),
    cacheWrite: num(block.cacheCreationTokens),
    reasoning
  })
}

/**
 * The first thing the *user* typed, from the events the CLI actually rendered.
 *
 * We read `updates.jsonl` and never `chat_history.jsonl`: the latter is the
 * compacted model context, so its first "user" entry is a wall of system
 * scaffolding rather than anything a person wrote.
 */
function titleFromUpdates(lines: readonly string[]): string {
  for (const line of lines) {
    if (!line.includes('user_message_chunk')) continue
    try {
      const record = JSON.parse(line) as {
        params?: { update?: { content?: { text?: unknown } } }
      }
      const text = record.params?.update?.content?.text
      if (typeof text === 'string' && text.trim()) return toTitle(text)
    } catch {
      // torn line while the CLI is writing; keep looking
    }
  }
  return ''
}

export async function readGrokSessions(rootOverride?: string | null): Promise<HistorySession[]> {
  const sessionsRoot = join(rootOverride || grokHome(), 'sessions')
  const sessions: HistorySession[] = []

  for (const group of await listSubdirs(sessionsRoot)) {
    for (const id of await listSubdirs(join(sessionsRoot, group))) {
      const dir = join(sessionsRoot, group, id)

      // A directory holding nothing but a zero-byte `summary.json.lock` is not a
      // session — it is a launch that died before Grok wrote a single line. It
      // shows up as an untitled, zero-message entry with **no cwd**, and a
      // session with no cwd cannot be resumed anywhere: an empty workspace
      // resolves to the home directory rather than failing, so "resume" would
      // quietly drop the agent into `~`. One such leftover exists on this
      // machine (`sessions/D%3A%5Cgrok/01a0cd63-…/`). Require one of the two
      // files that actually make a session before listing it.
      if (!(await exists(join(dir, 'summary.json'))) && !(await exists(join(dir, 'updates.jsonl')))) {
        continue
      }

      const summary = await readJson<GrokSummary>(join(dir, 'summary.json'))
      const usageFile = await readJson<GrokUsageFile>(join(dir, 'usage.json'))

      const summaryUsage = usageFile?.session
      const usage = toUsage(summaryUsage)
      const ticks = num(summaryUsage?.costUsdTicks)

      const title =
        toTitle(summary?.session_summary) ||
        titleFromUpdates(await readHeadLines(join(dir, 'updates.jsonl'), 32768))

      // num_messages is 0 on sessions that clearly have messages; the chat
      // count is the one that tracks reality.
      let messageCount = num(summary?.num_chat_messages) || num(summary?.num_messages)
      if (!messageCount) {
        messageCount = await countLines(join(dir, 'updates.jsonl'))
      }

      sessions.push({
        agent: 'grok' as AgentId,
        id,
        title: title || firstText(summary?.agent_name, '(untitled)'),
        cwd: firstText(summary?.info?.cwd),
        createdAt: isoFromString(summary?.created_at),
        updatedAt: isoFromString(summary?.updated_at) ?? isoFromString(usageFile?.updatedAt),
        messageCount,
        model: firstText(summary?.current_model_id, summaryUsage?.primaryModelId),
        usage,
        costUsd: ticks > 0 ? ticks / COST_TICKS_PER_USD : 0,
        costSource: ticks > 0 ? 'recorded' : usage.total > 0 ? 'unpriced' : 'none',
        storage: 'dir',
        path: dir,
        archived: false,
        subagent: false
      })
    }
  }

  return sessions
}
