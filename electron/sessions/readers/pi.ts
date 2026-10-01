/**
 * Pi — `<session root>/--<encoded-project-path>--/<timestamp>_<uuid>.jsonl`
 *
 * One append-only JSONL per session. Pi's session root is configurable in three
 * places and a wrong guess silently yields zero sessions, so the resolution in
 * `paths.piSessionDir()` mirrors Pi's own order exactly.
 *
 * The directory name encodes the project path (`/Users/me/apps/blog` becomes
 * `--Users-me-apps-blog--`), but that encoding is lossy — a path with a dash in
 * it decodes wrong — so it is only a fallback. The authoritative `cwd` comes
 * from the records.
 *
 * NOT VERIFIED ON THIS MACHINE: Pi is not installed here.
 */
import { join } from 'node:path'
import type { HistorySession, TokenUsage } from '../types'
import { withTotal } from '../types'
import {
  countLines,
  isoFromString,
  listDir,
  num,
  readHeadLines,
  toTitle
} from '../fsUtil'
import { piSessionDir } from '../paths'

type Json = Record<string, unknown>

/** `--Users-me-apps-blog--` -> `/Users/me/apps/blog`. Best effort only. */
function decodeProjectDir(name: string): string {
  const inner = name.replace(/^--/, '').replace(/--$/, '')
  if (!inner) return ''
  return '/' + inner.replace(/-/g, '/')
}

/** `2026-08-23T09-49-28-819Z_01a02e06-....jsonl` */
const SESSION_FILE = /^(?<stamp>[^_]+)_(?<id>[0-9a-fA-F-]{8,})\.jsonl$/

/** `2026-08-23T09-49-28-819Z` -> ISO. Colons were swapped for dashes. */
function timestampFromName(stamp: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp)
  if (!match) return isoFromString(stamp)
  return isoFromString(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
}

function usageFrom(record: Json): TokenUsage | null {
  const raw = (record.usage ?? record.tokenUsage ?? record.tokens) as Json | undefined
  if (!raw || typeof raw !== 'object') return null
  const usage = withTotal({
    input: num(raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens),
    output: num(raw.output ?? raw.outputTokens ?? raw.output_tokens ?? raw.completionTokens),
    cacheRead: num(raw.cacheRead ?? raw.cachedReadTokens ?? raw.cache_read_input_tokens),
    cacheWrite: num(raw.cacheWrite ?? raw.cacheCreationTokens ?? raw.cache_creation_input_tokens),
    reasoning: num(raw.reasoning ?? raw.reasoningTokens ?? raw.reasoning_output_tokens)
  })
  return usage.total > 0 ? usage : null
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value) {
    if (block && typeof block === 'object') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

export async function readPiSessions(rootOverride?: string | null): Promise<HistorySession[]> {
  const root = rootOverride || (await piSessionDir())
  const sessions: HistorySession[] = []

  for (const projectDir of await listDir(root)) {
    const projectPath = join(root, projectDir)
    for (const file of await listDir(projectPath)) {
      const match = SESSION_FILE.exec(file)
      if (!match?.groups) continue
      const path = join(projectPath, file)

      let cwd = ''
      let model = ''
      let title = ''
      let createdAt: string | null = null
      let updatedAt: string | null = null
      let messageCount = 0
      let usage: TokenUsage | null = null
      let subagent = false

      // Head for identity and the opening prompt, tail for the final cumulative
      // usage: both ends matter and neither needs the middle of the file.
      for (const line of await readHeadLines(path, 65536)) {
        if (!line.includes('{')) continue
        let record: Json
        try {
          record = JSON.parse(line) as Json
        } catch {
          continue
        }
        if (!cwd && typeof record.cwd === 'string') cwd = record.cwd
        if (!model && typeof record.model === 'string') model = record.model
        const timestamp = isoFromString(record.timestamp ?? record.time ?? record.createdAt)
        if (timestamp) {
          if (!createdAt || timestamp < createdAt) createdAt = timestamp
          if (!updatedAt || timestamp > updatedAt) updatedAt = timestamp
        }
        const role = record.role ?? record.type
        if (role === 'user' || role === 'assistant') messageCount++
        if (record.isSidechain === true || record.subagent === true) subagent = true
        if (!title && role === 'user') {
          title = toTitle(contentText(record.content ?? record.text) || record.text)
        }
        usage = usageFrom(record) ?? usage
      }

      if (!cwd) cwd = decodeProjectDir(projectDir)
      if (!messageCount) messageCount = await countLines(path)

      sessions.push({
        agent: 'pi',
        id: match.groups.id,
        title: title || '(untitled)',
        cwd,
        createdAt: createdAt ?? timestampFromName(match.groups.stamp),
        updatedAt,
        messageCount,
        model,
        usage: usage ?? withTotal({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
        costUsd: 0,
        costSource: usage ? 'unpriced' : 'none',
        storage: 'file',
        path,
        archived: false,
        subagent
      })
    }
  }

  return sessions
}
