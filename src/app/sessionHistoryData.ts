/**
 * One session scan, shared by every page that needs it.
 *
 * A full scan reads 157k files under `~/.codex` and takes ~2.5s, so the history
 * page and the usage page must not each trigger their own. This is a plain
 * module-scoped store rather than a React context: the pages are rendered
 * independently by AppShell and neither owns the other.
 *
 * Nothing is persisted, and nothing is cached across a rescan — the list must be
 * able to show what a CLI wrote five seconds ago.
 */
import { useEffect, useState } from 'react'
import type { DiscoverResult } from '../../shared/session-history'

export interface ScanSnapshot {
  result: DiscoverResult | null
  scanning: boolean
  error: string | null
}

type Listener = (snapshot: ScanSnapshot) => void

let snapshot: ScanSnapshot = { result: null, scanning: false, error: null }
let inflight: Promise<void> | null = null
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener(snapshot)
}

/**
 * Start a scan, or join the one already running.
 *
 * Concurrent callers share a single pass, which is the point of the module: two
 * pages mounting together must not double the disk load.
 */
export function scanSessions(): Promise<void> {
  if (inflight) return inflight

  snapshot = { ...snapshot, scanning: true, error: null }
  emit()

  inflight = window.sessionsApi
    .discover()
    .then((result) => {
      snapshot = { result, scanning: false, error: null }
    })
    .catch((error: unknown) => {
      snapshot = {
        result: null,
        scanning: false,
        error: error instanceof Error ? error.message : String(error)
      }
    })
    .finally(() => {
      inflight = null
      emit()
    })

  return inflight
}

export function useSessions(): ScanSnapshot & { scan: () => void } {
  const [state, setState] = useState<ScanSnapshot>(snapshot)

  useEffect(() => {
    const listener: Listener = (next): void => setState(next)
    listeners.add(listener)
    setState(snapshot)
    // 首次挂载自动扫；已经有结果就不重复读盘。
    if (!snapshot.result && !snapshot.scanning) void scanSessions()
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return { ...state, scan: (): void => void scanSessions() }
}

/**
 * 刷新价目表，然后重扫一遍。
 *
 * 必须重扫：估算金额是扫描时算出来写进会话对象的，刷新了价目表却不重扫，
 * 页面上还是旧价格 —— 那种「刷新了但数字没动」最容易让人以为按钮坏了。
 * 刷新失败（比如断网）不抛异常，原样把原因交给调用方显示；旧价目表继续用。
 */
export async function refreshPricingAndRescan(): Promise<string | null> {
  const outcome = await window.sessionsApi.refreshPricing()
  if (outcome.ok) {
    await scanSessions()
    return null
  }
  return outcome.error ?? 'unknown'
}
