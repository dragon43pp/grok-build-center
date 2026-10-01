/**
 * opencode — `$XDG_DATA_HOME/opencode/opencode.db`
 *
 * Unlike every other agent here, opencode keeps no per-session file: sessions,
 * messages and parts all live in one SQLite database. So the session list is a
 * single query, and `path` is a synthetic `opencode://<id>` because there is no
 * file to open, rename or move to the trash.
 *
 * The good news is that this row already has everything: usage broken into five
 * columns, a per-session `cost` recorded by the agent itself, `parent_id` for
 * sub-agent detection, `time_archived` for archiving and a real title.
 *
 * Note that a local opencode install may have no `storage/` directory at all
 * (the older file-based layout) — reading only the database is correct here.
 */
import { join } from 'node:path'
import type { HistorySession, TokenUsage } from '../types'
import { withTotal } from '../types'
import { exists, firstText, isoFromMs, num, toTitle } from '../fsUtil'
import { openReadOnly } from '../sqlite'
import { opencodeDataDir } from '../paths'

interface OpenCodeRow {
  id: string
  parent_id: string | null
  directory: string | null
  path: string | null
  title: string | null
  agent: string | null
  model: string | null
  cost: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  time_created: number | null
  time_updated: number | null
  time_archived: number | null
}

/** `{"id":"qwen-local","providerID":"colasoft","variant":"default"}` */
function modelLabel(raw: string | null): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; providerID?: unknown }
    const id = typeof parsed.id === 'string' ? parsed.id : ''
    const provider = typeof parsed.providerID === 'string' ? parsed.providerID : ''
    return provider && id ? `${provider}/${id}` : id || provider
  } catch {
    return raw
  }
}

export async function readOpenCodeSessions(rootOverride?: string | null): Promise<HistorySession[]> {
  const dbPath = join(rootOverride || opencodeDataDir(), 'opencode.db')
  if (!(await exists(dbPath))) return []

  // `openReadOnly` rather than a raw handle: it keeps SQLite from creating the
  // WAL sidecars in the user's data directory. See ../sqlite.ts.
  const db = openReadOnly(dbPath)
  try {
    // An opencode install that has never been used has the tables but no rows;
    // both queries are wrapped so a schema drift degrades instead of throwing.
    let rows: OpenCodeRow[] = []
    try {
      rows = db
        .prepare(
          `select id, parent_id, directory, path, title, agent, model, cost,
                  tokens_input, tokens_output, tokens_reasoning,
                  tokens_cache_read, tokens_cache_write,
                  time_created, time_updated, time_archived
             from session`
        )
        .all() as unknown as OpenCodeRow[]
    } catch {
      return []
    }

    const messageCounts = new Map<string, number>()
    try {
      const counts = db
        .prepare('select session_id, count(*) as n from message group by session_id')
        .all() as unknown as { session_id: string; n: number }[]
      for (const row of counts) messageCounts.set(row.session_id, num(row.n))
    } catch {
      // message table absent on very old schemas; counts just stay 0.
    }

    return rows.map((row): HistorySession => {
      const usage: TokenUsage = withTotal({
        input: num(row.tokens_input),
        output: num(row.tokens_output),
        cacheRead: num(row.tokens_cache_read),
        cacheWrite: num(row.tokens_cache_write),
        reasoning: num(row.tokens_reasoning)
      })
      const cost = typeof row.cost === 'number' && row.cost > 0 ? row.cost : 0

      return {
        agent: 'opencode',
        id: row.id,
        title: toTitle(row.title) || '(untitled)',
        cwd: firstText(row.directory, row.path),
        createdAt: isoFromMs(row.time_created),
        updatedAt: isoFromMs(row.time_updated),
        messageCount: messageCounts.get(row.id) ?? 0,
        model: modelLabel(row.model),
        usage,
        costUsd: cost,
        costSource: cost > 0 ? 'recorded' : usage.total > 0 ? 'unpriced' : 'none',
        storage: 'db',
        // No file backs this session; the id is the address.
        path: `opencode://${row.id}`,
        archived: num(row.time_archived) > 0,
        subagent: Boolean(row.parent_id && row.parent_id !== '')
      }
    })
  } finally {
    db.close()
  }
}
