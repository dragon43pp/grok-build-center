/**
 * WorkBuddy —— 本机 GUI 会话记录（`~/.workbuddy/workbuddy.db` 的 `sessions` 表）。
 *
 * WorkBuddy 不是 CLI：它的会话没有终端可恢复（`workbuddy://` 协议注册是个
 * 空壳——只有 URL Protocol，没有 shell/open/command），所以这里的会话
 * **永远 resumable=false**，由 `planResume` 的 no-resume-command 兜底，
 * 历史页会如实标「这个 CLI 的恢复命令本机没实测过」。这是能力边界，不是缺陷。
 *
 * 数据形状（2026-10-01 实测，1890 行）：
 *   - `sessions`：id / cwd / title / status / created_at / updated_at（毫秒）/
 *     model / deleted_at（软删，过滤掉）。
 *   - `session_usage`：used（上下文 token，不是计费 token）——**故意不映射进
 *     usage**：把它当 input tokens 会让统计页虚报，宁可 costSource='none'。
 *
 * 只读纪律见 `../sqlite.ts`：immutable 优先；WAL 里有数据就拷到临时目录。
 * WorkBuddy 常开，这个库是活 WAL —— 走副本路径是常态。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HistorySession } from '../types'
import { emptyUsage } from '../types'
import { isoFromMs, toTitle } from '../fsUtil'
import { openReadOnly } from '../sqlite'
import { workbuddyHome } from '../paths'

interface SessionRow {
  id: unknown
  cwd: unknown
  title: unknown
  custom_title: unknown
  created_at: unknown
  updated_at: unknown
  last_activity_at: unknown
  model: unknown
}

function ms(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export async function readWorkbuddySessions(
  rootOverride?: string | null
): Promise<HistorySession[]> {
  const home = rootOverride || workbuddyHome()
  const dbPath = join(home, 'workbuddy.db')
  if (!existsSync(dbPath)) return []

  const db = openReadOnly(dbPath)
  try {
    let rows: SessionRow[]
    try {
      rows = db
        .prepare(
          `SELECT id, cwd, title, custom_title, created_at, updated_at,
                  last_activity_at, model
           FROM sessions WHERE deleted_at IS NULL
           ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC`
        )
        .all() as unknown as SessionRow[]
    } catch {
      // 旧版本没有这张表（或列变了）—— 如实返回空，别把扫描搞挂。
      return []
    }

    const sessions: HistorySession[] = []
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : ''
      if (!id) continue
      const title =
        toTitle(
          typeof row.custom_title === 'string' && row.custom_title.trim()
            ? row.custom_title
            : row.title
        ) || '(untitled)'
      sessions.push({
        agent: 'workbuddy',
        id,
        title,
        cwd: typeof row.cwd === 'string' ? row.cwd : '',
        createdAt: isoFromMs(ms(row.created_at)),
        // 与 SQL 的 ORDER BY 同口径：last_activity 优先，页面再排序不会翻乱
        updatedAt: isoFromMs(
          ms(row.last_activity_at) || ms(row.updated_at) || ms(row.created_at)
        ),
        // 库里没有消息计数；不编数字。
        messageCount: 0,
        model: typeof row.model === 'string' ? row.model : '',
        usage: emptyUsage(),
        costUsd: 0,
        costSource: 'none',
        storage: 'db',
        path: `workbuddy://${id}`,
        archived: false,
        subagent: false
      })
    }
    return sessions
  } finally {
    db.close()
  }
}
