/**
 * Opening an agent's SQLite index without writing to it.
 *
 * `new DatabaseSync(path, { readOnly: true })` reads reliably but is **not**
 * side-effect free: for a WAL-mode database SQLite creates or rewrites the
 * `-shm` (and sometimes `-wal`) sidecar. Measured on this machine, a single
 * read-only open of `$CODEX_HOME/state_5.sqlite` dropped two new files into the
 * user's data directory:
 *
 *     before  { main: 4452352, -wal: absent, -shm: absent }
 *     after   { main: 4452352, -wal: 0,      -shm: 32768  }
 *
 * That is normal SQLite behaviour rather than damage, and no committed data is
 * at risk. But these directories hold the user's live sessions, and the one
 * hard promise this app makes about them is that browsing history never
 * changes anything. So we avoid even that.
 *
 * SQLite's `immutable=1` URI parameter says the file cannot change, which lets
 * it skip the WAL machinery — and therefore the sidecars — entirely. The cost
 * is that the WAL is ignored, so this is only safe when the WAL holds nothing:
 * with an absent or empty `-wal`, the main file already contains every
 * committed row.
 *
 * If a writer *has* left data in the WAL, we used to fall back to a plain
 * read-only open **on the user's file**. That is the correct behaviour for a
 * database someone else is using (SQLite is built for exactly this), but it
 * still rewrites `-shm` in the user's own directory — and `tools/verify_readonly.py`
 * caught exactly that on 2026-09-30: both `$CODEX_HOME` roots reported
 * `thread_history_1.sqlite-shm` as modified after a full scan.
 *
 * So the fallback now **copies** the database (and its `-wal`) into our own
 * scratch directory and opens the copy. Any sidecar SQLite creates lands in the
 * scratch directory instead of the user's data. The copy is removed when the
 * caller closes the handle.
 *
 * Verified end to end by `tools/verify_readonly.py`, which snapshots whole
 * directories before and after a full scan.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite'

/** Absent, unreadable, or zero-byte `-wal`: the main file is self-contained. */
function walIsEmpty(path: string): boolean {
  try {
    return statSync(`${path}-wal`).size === 0
  } catch {
    return true
  }
}

/**
 * `file:` URI for the database. Windows backslashes become forward slashes, and
 * the three characters SQLite's URI parser treats specially are escaped so a
 * path containing one is still opened literally rather than interpreted.
 */
function sqliteUri(path: string, immutable: boolean): string {
  const encoded = path
    .replace(/\\/g, '/')
    .replace(/%/g, '%25')
    .replace(/\?/g, '%3F')
    .replace(/#/g, '%23')
  return `file:${encoded}${immutable ? '?immutable=1' : ''}`
}

/**
 * Read-only handle on a SQLite database. The caller owns `close()`.
 *
 * Throws when the file is missing or not a database, so callers keep their
 * existing try/finally shape and can decide whether a failure is fatal (Codex
 * without its index) or merely no data (opencode never used).
 */
export function openReadOnly(path: string): DatabaseSync {
  if (walIsEmpty(path)) {
    return new DatabaseSync(sqliteUri(path, true), { readOnly: true })
  }
  return new ScratchDatabase(path)
}

/**
 * 每进程一个目录：并发/残留的旧进程各写各的，清理时才不会删到别人正在用的副本。
 */
const SCRATCH_ROOT = join(tmpdir(), 'grok-build-center-sqlite')

/** 每个进程只扫一次：上次没关干净的副本（或崩溃残留）超过 6 小时就清掉。 */
let swept = false
function sweepStaleScratch(): void {
  if (swept) return
  swept = true
  try {
    for (const entry of readdirSync(SCRATCH_ROOT)) {
      const dir = join(SCRATCH_ROOT, entry)
      // 只认我们自己建的「pid」目录名，绝不递归到别处去。
      if (!/^\d+$/.test(entry)) continue
      const age = Date.now() - statSync(dir).mtimeMs
      if (age > 6 * 60 * 60 * 1000) rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    // 根目录还不存在（第一次跑）而已。
  }
}

/**
 * 数据库 + WAL 的**副本**上的只读句柄。
 *
 * 只在「WAL 里真有数据」时才走到这里（空 WAL 走 immutable，零副作用）。
 * 副本放在临时目录里，SQLite 因此只会在临时目录里生成 `-shm`，用户的
 * 数据目录一个字节都不会动。`close()` 顺手清掉副本。
 */
class ScratchDatabase extends DatabaseSync {
  private readonly scratch: string[]

  constructor(source: string) {
    const dir = join(SCRATCH_ROOT, String(process.pid))
    sweepStaleScratch()
    const target = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
    mkdirSync(dir, { recursive: true })
    const scratch = [target]
    copyFileSync(source, target)
    try {
      copyFileSync(`${source}-wal`, `${target}-wal`)
      scratch.push(`${target}-wal`)
    } catch {
      // 没有 -wal 就不用复制（walIsEmpty 已经判过一次，这里是竞态兜底）。
    }
    super(sqliteUri(target, false), { readOnly: true } satisfies DatabaseSyncOptions)
    this.scratch = scratch
  }

  override close(): void {
    try {
      super.close()
    } finally {
      for (const file of this.scratch) {
        try {
          rmSync(file, { force: true })
        } catch {
          // 关不掉就算了，下次启动的清理逻辑会收走。
        }
      }
    }
  }
}
