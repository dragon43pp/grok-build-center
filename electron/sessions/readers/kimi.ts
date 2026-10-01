/**
 * Kimi Code — `$KIMI_CODE_HOME/sessions/wd_<name>_<hash>/session_<uuid>/`
 *
 * Sessions are directories: metadata in `state.json`, transcript in
 * `agents/main/wire.jsonl` (the `agents/` level exists because one session can
 * run several agents; `main` is the one the user talked to). A flat index at
 * the root, `session_index.jsonl`, carries title and updated time.
 *
 * NOT VERIFIED ON THIS MACHINE: Kimi Code is not installed here, so the field
 * names below are the ones the format documents, read through a tolerant
 * picker that tries the plausible spellings. Everything degrades to an empty
 * string or zero rather than throwing, and `state.json` is treated as the
 * authority whenever it has something to say.
 *
 * Important: the history store is `~/.kimi-code`, which is *not* the `~/.kimi`
 * directory the live observer adapter configures. Different lifetimes.
 */
import { join } from 'node:path'
import type { HistorySession, TokenUsage } from '../types'
import { withTotal } from '../types'
import {
  countLines,
  exists,
  isoFromMs,
  isoFromString,
  listSubdirs,
  num,
  readHeadLines,
  readJson,
  readLines,
  toTitle
} from '../fsUtil'
import { kimiCodeHome } from '../paths'

type Json = Record<string, unknown>

/** First key that exists and is a non-empty string. */
function pick(obj: Json | null | undefined, ...keys: string[]): string {
  if (!obj) return ''
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function pickNumber(obj: Json | null | undefined, ...keys: string[]): number {
  if (!obj) return 0
  for (const key of keys) {
    const found = num(obj[key])
    if (found) return found
  }
  return 0
}

/** Timestamps appear as seconds, millis or ISO depending on the writer. */
function pickTime(obj: Json | null | undefined, ...keys: string[]): string | null {
  if (!obj) return null
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string') {
      const iso = isoFromString(value)
      if (iso) return iso
      const asNumber = Number(value)
      if (Number.isFinite(asNumber) && asNumber > 0) {
        return isoFromMs(asNumber > 1e12 ? asNumber : asNumber * 1000)
      }
    }
    if (typeof value === 'number' && value > 0) {
      return isoFromMs(value > 1e12 ? value : value * 1000)
    }
  }
  return null
}

function usageFrom(state: Json | null): TokenUsage {
  const nested =
    (state?.usage as Json | undefined) ??
    (state?.tokens as Json | undefined) ??
    (state?.tokenUsage as Json | undefined)
  if (!nested || typeof nested !== 'object') {
    return withTotal({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  }
  return withTotal({
    input: pickNumber(nested, 'input', 'inputTokens', 'input_tokens', 'promptTokens'),
    output: pickNumber(nested, 'output', 'outputTokens', 'output_tokens', 'completionTokens'),
    cacheRead: pickNumber(nested, 'cacheRead', 'cachedReadTokens', 'cache_read_input_tokens'),
    cacheWrite: pickNumber(nested, 'cacheWrite', 'cacheCreationTokens', 'cache_creation_input_tokens'),
    reasoning: pickNumber(nested, 'reasoning', 'reasoningTokens', 'reasoning_output_tokens')
  })
}

function titleFromWire(lines: readonly string[]): string {
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Json
      const role = record.role ?? record.author ?? record.sender
      if (role !== 'user' && role !== 'human') continue
      const text =
        (typeof record.text === 'string' && record.text) ||
        (typeof record.content === 'string' && record.content) ||
        ''
      if (text.trim()) return toTitle(text)
    } catch {
      // torn line
    }
  }
  return ''
}

export async function readKimiSessions(rootOverride?: string | null): Promise<HistorySession[]> {
  const home = rootOverride || kimiCodeHome()

  // session_index.jsonl is optional; it only improves titles.
  const index = new Map<string, Json>()
  for (const line of await readLines(join(home, 'session_index.jsonl'))) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const record = JSON.parse(trimmed) as Json
      const id = pick(record, 'id', 'sessionId', 'session_id')
      if (id) index.set(id, record)
    } catch {
      // ignore
    }
  }

  const sessions: HistorySession[] = []
  for (const group of await listSubdirs(join(home, 'sessions'))) {
    for (const dirName of await listSubdirs(join(home, 'sessions', group))) {
      const dir = join(home, 'sessions', group, dirName)
      const state = await readJson<Json>(join(dir, 'state.json'))
      const id = pick(state, 'id', 'sessionId', 'session_id') || dirName.replace(/^session_/, '')
      const indexed = index.get(id)

      const wire = join(dir, 'agents', 'main', 'wire.jsonl')
      const usage = usageFrom(state)
      const cost = pickNumber(state, 'cost', 'costUsd')

      let messageCount = pickNumber(state, 'messageCount', 'numMessages', 'message_count')
      if (!messageCount && (await exists(wire))) messageCount = await countLines(wire)

      const title =
        toTitle(pick(state, 'title', 'name', 'summary')) ||
        toTitle(pick(indexed, 'title', 'name')) ||
        titleFromWire(await readHeadLines(wire, 32768))

      sessions.push({
        agent: 'kimi',
        id,
        title: title || '(untitled)',
        cwd: pick(state, 'cwd', 'directory', 'workspace', 'projectPath', 'path'),
        createdAt: pickTime(state, 'createdAt', 'created_at', 'created'),
        updatedAt:
          pickTime(state, 'updatedAt', 'updated_at', 'updated') ??
          pickTime(indexed, 'updated_at', 'updatedAt'),
        messageCount,
        model: pick(state, 'model', 'modelId', 'model_id'),
        usage,
        costUsd: cost,
        costSource: cost > 0 ? 'recorded' : usage.total > 0 ? 'unpriced' : 'none',
        storage: 'dir',
        path: dir,
        archived: false,
        subagent: pick(state, 'parentId', 'parent_id') !== ''
      })
    }
  }

  return sessions
}
