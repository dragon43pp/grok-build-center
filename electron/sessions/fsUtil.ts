/**
 * Small, dependency-free filesystem helpers for the history readers.
 *
 * Everything in electron/sessions/ is read-only. These helpers exist mostly so
 * that the readers never have to think about two things that bite on Windows:
 * extended-length paths (`\\?\D:\...`) written by Codex, and JSONL files that
 * are megabytes long when we only need one line out of them.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** `~/.grok` -> `C:\Users\me\.grok`. `os.homedir()` already handles the rest. */
export function expandHome(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2))
  }
  return trimmed
}

/**
 * Codex stores `\\?\D:\codex-home\sessions\...` in its database. Node accepts
 * that form, but nothing else does — string comparisons, `join`, and the UI all
 * want `D:\codex-home\sessions\...`. Strip it on the way in.
 */
export function normalizeStoredPath(input: string): string {
  if (input.startsWith('\\\\?\\UNC\\')) return '\\\\' + input.slice(8)
  if (input.startsWith('\\\\?\\')) return input.slice(4)
  return input
}

/** Resolve an env-provided directory: absolute wins, relative resolves under home. */
export function resolveDir(value: string | undefined, fallback: string): string {
  if (!value || !value.trim()) return fallback
  const expanded = expandHome(value)
  return isAbsolute(expanded) ? expanded : join(homedir(), expanded)
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Directory entries, or [] when the directory is missing/unreadable. */
export async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

export async function listSubdirs(path: string): Promise<string[]> {
  const entries = await listDir(path)
  const out: string[] = []
  for (const name of entries) {
    if (await isDirectory(join(path, name))) out.push(name)
  }
  return out
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * A file's modification time as ISO, or null when it is unreadable.
 *
 * Agents that do not stamp a timestamp (Antigravity's step records have one,
 * but a truncated transcript may have lost the first one) still need a number
 * to sort by, and the OS already keeps one.
 */
export async function mtimeIso(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString()
  } catch {
    return null
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * The last `maxBytes` of a file, as whole lines, oldest last.
 *
 * Codex's rollouts and Grok's `updates.jsonl` end with the information we want
 * (the newest cumulative token count, the newest turn), and they can be tens of
 * megabytes. Reading the tail is the difference between a snappy list and a
 * scan that takes a minute.
 *
 * The first line of the result is dropped when we did not start at offset 0 —
 * it is almost certainly a partial line.
 */
export async function readTailLines(path: string, maxBytes = 65536): Promise<string[]> {
  let handle
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    const from = Math.max(0, size - maxBytes)
    const length = size - from
    if (length <= 0) return []
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, from)
    const lines = buffer.toString('utf8').split('\n')
    if (from > 0) lines.shift()
    return lines
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Whole file as lines. For small index files only. */
export async function readLines(path: string): Promise<string[]> {
  const text = await readText(path)
  return text === null ? [] : text.split('\n')
}

/**
 * The first `maxBytes` of a file, as whole lines.
 *
 * Used to dig a session's title out of the head of a transcript without reading
 * a megabyte of history. The last line of the result is dropped when we did not
 * reach EOF — it may be cut mid-record.
 */
export async function readHeadLines(path: string, maxBytes = 65536): Promise<string[]> {
  let handle
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    if (size <= 0) return []
    const length = Math.min(maxBytes, size)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (bytesRead < size) lines.pop()
    return lines
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Count JSONL records without parsing them.
 *
 * `readFile().split()` on a 30 MB file allocates ~30 MB of strings for a number
 * we only want to display. Stream the bytes and count newlines instead.
 */
export async function countLines(path: string): Promise<number> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(1 << 16)
    let count = 0
    let lastByte = 0x0a
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      position += bytesRead
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0x0a) count++
      }
      lastByte = buffer[bytesRead - 1]
    }
    // A file not ending in a newline still has one record on its last line.
    return lastByte === 0x0a ? count : count + 1
  } catch {
    return 0
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Stream a text file line by line without loading it.
 *
 * A Claude or Pi transcript is append-only and unbounded — a long session is
 * easily tens of megabytes — so the readers that need every record have to
 * stream. `onLine` may be async; lines are delivered in order.
 */
export async function forEachLine(
  path: string,
  onLine: (line: string) => void
): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) onLine(line)
  } catch {
    // A file being rewritten underneath us: keep whatever we already saw.
  } finally {
    reader.close()
    stream.close()
  }
}

/** Parse JSONL, skipping malformed lines instead of failing the whole file. */
export function parseJsonLines(lines: readonly string[]): unknown[] {
  const out: unknown[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // A writer mid-flush can leave a torn line; skipping beats throwing.
    }
  }
  return out
}

/** Epoch millis -> ISO, or null when the value is not a usable number. */
export function isoFromMs(value: unknown): string | null {
  const ms = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return null
  // Seconds that were passed off as millis land in 1970; treat as unusable.
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Epoch seconds -> ISO. */
export function isoFromSeconds(value: unknown): string | null {
  const seconds = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
}

export function isoFromString(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** First argument that is a non-empty string. */
export function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * Titles come from user input, so they can be a pasted 200 KB document, contain
 * newlines, or be a wall of markdown. Collapse to one line and clip.
 */
export function toTitle(value: unknown, max = 120): string {
  const text = firstText(value)
  if (!text) return ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

export function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}
