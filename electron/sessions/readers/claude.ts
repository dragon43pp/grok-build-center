/**
 * Claude Code — `$CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl`
 *
 * One append-only JSONL per session. The slug is the project path with
 * separators turned into dashes, but it is lossy, so `cwd` is read from the
 * records themselves.
 *
 * Two things matter here:
 *
 *  - `isSidechain` marks a session spawned by another session (a sub-agent).
 *    Those are real API calls and belong in the token totals, but listing them
 *    as if the user started them is noise.
 *  - A transcript mixes record types. `queue-operation` and summary entries
 *    carry no message at all, and `message.model` is `<synthetic>` on locally
 *    generated turns, which must not be reported as the session's model.
 */
import { join } from 'node:path'
import type { HistorySession } from '../types'
import { withTotal, type TokenUsage } from '../types'
import { forEachLine, isoFromString, listDir, num, toTitle } from '../fsUtil'
import { claudeConfigDir } from '../paths'

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface ClaudeRecord {
  type?: string
  timestamp?: string
  cwd?: string
  sessionId?: string
  isSidechain?: boolean
  message?: {
    role?: string
    model?: string
    content?: unknown
    usage?: ClaudeUsage
  }
}

/** `message.content` is either a string or a block array. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

export async function readClaudeSessions(rootOverride?: string | null): Promise<HistorySession[]> {
  const projectsRoot = join(rootOverride || claudeConfigDir(), 'projects')
  const sessions: HistorySession[] = []

  for (const slug of await listDir(projectsRoot)) {
    const projectDir = join(projectsRoot, slug)
    for (const file of await listDir(projectDir)) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(projectDir, file)

      let usage: TokenUsage = withTotal({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0
      })
      let input = 0
      let output = 0
      let cacheRead = 0
      let cacheWrite = 0
      let cwd = ''
      let model = ''
      let sessionId = ''
      let title = ''
      let createdAt: string | null = null
      let updatedAt: string | null = null
      let messageCount = 0
      let subagent = false

      await forEachLine(path, (line) => {
        if (!line.includes('{')) return
        let record: ClaudeRecord
        try {
          record = JSON.parse(line) as ClaudeRecord
        } catch {
          return
        }

        if (record.isSidechain === true) subagent = true
        if (!cwd && typeof record.cwd === 'string') cwd = record.cwd
        if (!sessionId && typeof record.sessionId === 'string') sessionId = record.sessionId

        const timestamp = isoFromString(record.timestamp)
        if (timestamp) {
          if (!createdAt || timestamp < createdAt) createdAt = timestamp
          if (!updatedAt || timestamp > updatedAt) updatedAt = timestamp
        }

        const message = record.message
        if (!message) return
        if (message.role === 'user' || message.role === 'assistant') messageCount++

        const messageModel = message.model
        if (typeof messageModel === 'string' && messageModel && messageModel !== '<synthetic>') {
          model = messageModel
        }

        if (!title && message.role === 'user') {
          const text = textOf(message.content)
          // Claude sometimes injects non-user turns under role "user".
          if (text && !text.includes('<command-name>')) title = toTitle(text)
        }

        const recordUsage = message.usage
        if (recordUsage) {
          input += num(recordUsage.input_tokens)
          output += num(recordUsage.output_tokens)
          cacheWrite += num(recordUsage.cache_creation_input_tokens)
          cacheRead += num(recordUsage.cache_read_input_tokens)
        }
      })

      usage = withTotal({ input, output, cacheRead, cacheWrite, reasoning: 0 })

      sessions.push({
        agent: 'claude',
        id: sessionId || file.replace(/\.jsonl$/, ''),
        title: title || '(untitled)',
        cwd,
        createdAt,
        updatedAt,
        messageCount,
        model,
        usage,
        // Claude Code records no per-session cost anywhere on disk. Pricing is
        // applied later from the model catalogue (task: token statistics).
        costUsd: 0,
        costSource: usage.total > 0 ? 'unpriced' : 'none',
        storage: 'file',
        path,
        archived: false,
        subagent
      })
    }
  }

  return sessions
}
