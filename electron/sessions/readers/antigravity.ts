/**
 * Antigravity — `<data dir>/brain/<conversation-uuid>/.system_generated/logs/`
 *
 * Antigravity keeps its history under one of two sibling roots and the reader
 * scans both:
 *
 *   ~/.gemini/antigravity-cli/   the `agy` CLI      -> resumable, origin 'cli'
 *   ~/.gemini/antigravity/       the IDE chat       -> origin 'ide'
 *
 * A conversation is a UUID directory holding two competing transcripts:
 *
 *   .system_generated/logs/transcript.jsonl        rolling window
 *   .system_generated/logs/transcript_full.jsonl   "complete", also truncated
 *
 * Neither is authoritative. The CLI compacts at checkpoints and *rewrites the
 * whole file* when it does, so `transcript.jsonl` is not append-only and
 * `transcript_full.jsonl` is regularly the shorter of the two. The rule that
 * holds in practice is to read whichever is larger, which is what
 * `preferredTranscript()` does. A consequence worth remembering: any tail-based
 * watcher has to cope with the file shrinking, not just growing.
 *
 * The step records have no token, usage or cost field anywhere, so
 * `costSource` is always 'none' for this agent. There is a model, but only
 * implicitly — the user changing it shows up as a `Model Selection` sentence
 * inside a settings-change block, so the model is recovered best-effort.
 *
 * The index at the root, `history.jsonl`, is what says which project a
 * conversation belongs to (`{display, timestamp, workspace, conversationId}`).
 * It is CLI-only and may be absent, in which case the workspace is inferred
 * from the paths the agent touched.
 *
 * NOT VERIFIED: the CLI store (`~/.gemini/antigravity-cli`) does not exist on
 * this machine. The IDE store does, and the layout below was written against
 * real transcripts from it.
 */
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { HistorySession, TokenUsage } from '../types'
import { emptyUsage } from '../types'
import {
  exists,
  forEachLine,
  isDirectory,
  listDir,
  mtimeIso,
  readText,
  toTitle
} from '../fsUtil'
import { antigravityCliHome, antigravityIdeHome } from '../paths'

type Json = Record<string, unknown>
type Origin = 'cli' | 'ide'

const LOGS_REL = join('.system_generated', 'logs')
const TRANSCRIPT_NAME = 'transcript.jsonl'
const FULL_TRANSCRIPT_NAME = 'transcript_full.jsonl'

/** Marks a user rename; the CLI appends it as a plain line, not as JSON. */
const RENAME_MARKER = '$rename:'

/**
 * Conversation directories are UUIDs. This is deliberately as loose as the
 * layout allows — 36 characters of hex and dashes — rather than a strict
 * 8-4-4-4-12 pattern, so an id shape we have not seen still gets read. It is
 * enough to exclude the sibling `tempmediaStorage/` directory.
 */
function isConversationDir(name: string): boolean {
  if (name.length !== 36) return false
  for (const char of name) {
    if (!/^[0-9a-fA-F-]$/.test(char)) return false
  }
  return true
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * The larger of the two transcripts. `transcript_full.jsonl` is not reliably
 * the fuller one — see the file header.
 */
export async function preferredTranscript(conversationDir: string): Promise<string> {
  const rolling = join(conversationDir, LOGS_REL, TRANSCRIPT_NAME)
  const full = join(conversationDir, LOGS_REL, FULL_TRANSCRIPT_NAME)
  const rollingSize = await sizeOf(rolling)
  const fullSize = await sizeOf(full)
  if (!fullSize) return rolling
  return fullSize >= rollingSize ? full : rolling
}

/** Antigravity wraps user input in XML and appends a metadata block after it. */
function stripUserRequest(content: string): string {
  const open = content.indexOf('<USER_REQUEST>')
  if (open < 0) return content.trim()
  const after = content.slice(open + '<USER_REQUEST>'.length)
  const close = after.indexOf('</USER_REQUEST>')
  return (close >= 0 ? after.slice(0, close) : after).trim()
}

/**
 * Tool arguments arrive double-encoded: a path shows up as the *string*
 * `"C:\\x"`, quotes included, because the CLI serialises its args one level too
 * deep. Unwrap it properly rather than trimming quotes, so `\\` stays one
 * separator rather than becoming literal text.
 */
function argString(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'string') return parsed
    } catch {
      // Not JSON after all; fall through with the raw text.
    }
  }
  return trimmed
}

/** `Cwd`/`DirectoryPath` name a directory; the rest name a file. */
const DIRECTORY_ARGS = ['Cwd', 'DirectoryPath']
const FILE_ARGS = ['AbsolutePath', 'TargetFile', 'SearchPath']

/**
 * Filesystem paths are case-insensitive on Windows, so `c:\Users\admin` from a
 * tool argument and `C:\Users\admin` from a config file are the same directory
 * but two different strings. Only the drive letter is normalised — the rest of
 * the path is left exactly as the agent wrote it, because a case-insensitive
 * comparison of the whole path would be wrong on Linux and macOS.
 */
const DRIVE_LETTER = /^([a-z]):(?=[\\/])/

function normalizeDriveLetter(value: string): string {
  return value.replace(DRIVE_LETTER, (_, letter: string) => `${letter.toUpperCase()}:`)
}

/**
 * Recover the project directory from the paths the agent touched.
 *
 * Only used when `history.jsonl` has nothing to say. Antigravity's own
 * directories are skipped — a run that only ever touched `~/.gemini` would
 * otherwise claim the agent's install dir as the user's project.
 */
function inferCwd(calls: unknown, agentDirs: readonly string[]): string {
  if (!Array.isArray(calls)) return ''
  const lower = agentDirs.map((dir) => dir.toLowerCase())
  const isUserDir = (value: string): boolean => {
    if (!value || !isAbsolute(value)) return false
    const lowered = value.toLowerCase()
    return !lower.some(
      (dir) => lowered === dir || lowered.startsWith(dir + '\\') || lowered.startsWith(dir + '/')
    )
  }

  let fallback = ''
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue
    const args = (call as Json).args
    if (!args || typeof args !== 'object') continue
    const record = args as Json

    for (const key of DIRECTORY_ARGS) {
      const value = argString(record[key])
      if (isUserDir(value)) return normalizeDriveLetter(value)
    }
    if (!fallback) {
      for (const key of FILE_ARGS) {
        const value = argString(record[key])
        if (isUserDir(value)) {
          fallback = normalizeDriveLetter(dirname(value))
          break
        }
      }
    }
  }
  return fallback
}

/**
 * The model, recovered from the CLI's settings-change chatter.
 *
 * A change reads ``The user changed setting `Model Selection` from A to B``,
 * and checkpoints embed earlier ones as escaped JSON, so several can pile up in
 * one string — the last wins.
 */
function lastModelSelection(text: string): string {
  const marker = '`Model Selection` from '
  let found = ''
  let from = 0
  for (;;) {
    const at = text.indexOf(marker, from)
    if (at < 0) break
    from = at + marker.length
    const after = text.slice(from)
    const to = after.indexOf(' to ')
    if (to < 0) continue
    const rest = after.slice(to + 4)
    const stops = ['. No need', '. ', '\\n']
      .map((stop) => rest.indexOf(stop))
      .filter((index) => index >= 0)
    const value = rest
      .slice(0, stops.length ? Math.min(...stops) : rest.length)
      .trim()
      .replace(/\.$/, '')
    if (value && value !== 'None') found = value
  }
  return found
}

interface Conversation {
  id: string
  dir: string
  transcript: string
}

interface Store {
  root: string
  origin: Origin
}

/** Every UUID conversation directory that actually has a transcript. */
async function listConversations(root: string): Promise<Conversation[]> {
  const brain = join(root, 'brain')
  const out: Conversation[] = []
  for (const name of await listDir(brain)) {
    if (!isConversationDir(name)) continue
    const dir = join(brain, name)
    if (!(await isDirectory(dir))) continue
    const transcript = await preferredTranscript(dir)
    // Brain directories without a transcript are leftovers from runs whose
    // history was compacted away; there is nothing to list, so they are
    // skipped rather than shown as empty sessions.
    if (!(await exists(transcript))) continue
    out.push({ id: name, dir, transcript })
  }
  return out
}

/**
 * `history.jsonl` maps a conversation to the workspace it ran in, plus a title
 * and a timestamp. CLI-only, and optional.
 */
async function loadHistoryIndex(root: string): Promise<Map<string, Json>> {
  const index = new Map<string, Json>()
  const text = await readText(join(root, 'history.jsonl'))
  if (!text) return index
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const record = JSON.parse(trimmed) as Json
      const id = record.conversationId
      if (typeof id === 'string' && id) index.set(id, record)
    } catch {
      // A writer mid-flush can leave a torn line.
      continue
    }
  }
  return index
}

interface Scan {
  title: string
  turns: number
  model: string
  createdAt: string | null
  updatedAt: string | null
  inferredCwd: string
}

/**
 * One streaming pass over a transcript. Everything the list needs is in the
 * file, and the files are bounded (the CLI compacts them), so a single pass
 * beats three partial reads.
 */
async function scanTranscript(path: string, agentDirs: readonly string[]): Promise<Scan> {
  const scan: Scan = {
    title: '',
    turns: 0,
    model: '',
    createdAt: null,
    updatedAt: null,
    inferredCwd: ''
  }

  await forEachLine(path, (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    // A rename is a bare `$rename:Name` line appended at the end of the file,
    // so it is seen after the first user input and overwrites it.
    if (trimmed.startsWith(RENAME_MARKER)) {
      const renamed = trimmed.slice(RENAME_MARKER.length).trim()
      if (renamed) scan.title = toTitle(renamed)
      return
    }
    if (!trimmed.includes('{')) return

    let record: Json
    try {
      record = JSON.parse(trimmed) as Json
    } catch {
      return
    }

    const source = typeof record.source === 'string' ? record.source : ''
    const type = typeof record.type === 'string' ? record.type : ''
    const content = typeof record.content === 'string' ? record.content : ''

    const stamp = record.created_at
    if (typeof stamp === 'string' && stamp) {
      if (!scan.createdAt || stamp < scan.createdAt) scan.createdAt = stamp
      if (!scan.updatedAt || stamp > scan.updatedAt) scan.updatedAt = stamp
    }

    if (!scan.inferredCwd && record.tool_calls) {
      scan.inferredCwd = inferCwd(record.tool_calls, agentDirs)
    }
    if (content.includes('Model Selection')) {
      const model = lastModelSelection(content)
      if (model) scan.model = model
    }

    // A "message" is a turn: what the user asked and what the agent answered.
    // Tool-result steps and system chatter are deliberately not counted, so the
    // figure is comparable with the turn counts of the other agents.
    if (type === 'USER_INPUT' && source === 'USER_EXPLICIT') {
      scan.turns++
      if (!scan.title) {
        const text = stripUserRequest(content)
        if (text) scan.title = toTitle(text)
      }
    } else if (type === 'PLANNER_RESPONSE' && source === 'MODEL') {
      scan.turns++
    }
  })

  return scan
}

export async function readAntigravitySessions(
  rootOverride?: string | null
): Promise<HistorySession[]> {
  // A caller-supplied root is always treated as the CLI store, so a fixture
  // directory behaves like the agent's primary one.
  const stores: Store[] = rootOverride
    ? [{ root: rootOverride, origin: 'cli' }]
    : [
        { root: antigravityCliHome(), origin: 'cli' },
        { root: antigravityIdeHome(), origin: 'ide' }
      ]

  const agentDirs = stores.map((store) => store.root)
  const seen = new Set<string>()
  const sessions: HistorySession[] = []

  for (const store of stores) {
    if (!(await isDirectory(store.root))) continue
    const index = await loadHistoryIndex(store.root)

    for (const conversation of await listConversations(store.root)) {
      // The CLI store is scanned first and a duplicate id belongs to it: that
      // is the one with a resumable session behind it.
      if (seen.has(conversation.id)) continue
      seen.add(conversation.id)

      const scan = await scanTranscript(conversation.transcript, agentDirs)
      const indexed = index.get(conversation.id)
      const workspace =
        (typeof indexed?.workspace === 'string' ? indexed.workspace : '') || scan.inferredCwd

      const usage: TokenUsage = emptyUsage()
      sessions.push({
        agent: 'antigravity',
        id: conversation.id,
        title:
          scan.title ||
          toTitle(typeof indexed?.display === 'string' ? indexed.display : '') ||
          '(untitled)',
        cwd: workspace,
        createdAt: scan.createdAt,
        updatedAt: scan.updatedAt ?? (await mtimeIso(conversation.transcript)),
        messageCount: scan.turns,
        model: scan.model,
        usage,
        costUsd: 0,
        // Antigravity records no token counts at all, so there is nothing to
        // price — not even an estimate. 'none' is the honest answer.
        costSource: 'none',
        storage: 'dir',
        // The unit a delete or an export would address is the conversation dir.
        path: conversation.dir,
        archived: false,
        subagent: false,
        origin: store.origin
      })
    }
  }

  return sessions
}
