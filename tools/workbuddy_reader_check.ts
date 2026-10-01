/**
 * WorkBuddy reader 的离线判卷。
 *
 * 用 node:sqlite 造一个和真实 `workbuddy.db` 同 schema 的 fixture 库，
 * 验：映射（标题/时间/软删过滤）、库缺失返回空、只读纪律（扫描前后目录
 * 逐字节一致 —— 用户正在用 WorkBuddy，浏览历史绝不能在人家目录里落文件）。
 *
 * 跑法：
 *   node_modules/.bin/esbuild tools/workbuddy_reader_check.ts --bundle \
 *     --platform=node --format=esm --outfile=tools/_workbuddy_reader_check.mjs \
 *     && node tools/_workbuddy_reader_check.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readWorkbuddySessions } from '../electron/sessions/readers/workbuddy'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    pass += 1
    console.log(`  \u2714 ${name}`)
  } else {
    fail += 1
    console.log(`  \u2716 ${name}${extra ? ` \u2014 ${extra}` : ''}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'gbc-wb-reader-'))
const home = join(dir, 'workbuddy-home')
mkdirSync(home, { recursive: true })
const dbPath = join(home, 'workbuddy.db')

// ---- 造 fixture：和真实库同 schema（只放判卷用到的列）
{
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE sessions (
    id TEXT, cwd TEXT, title TEXT, custom_title TEXT, status TEXT,
    created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, model TEXT,
    last_activity_at INTEGER
  )`)
  db.exec(`CREATE TABLE session_usage (session_id TEXT, used INTEGER, size INTEGER, updated_at INTEGER, credit_json TEXT)`)
  const insert = db.prepare(
    'INSERT INTO sessions (id, cwd, title, custom_title, status, created_at, updated_at, deleted_at, model, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  )
  // ses-a 的 last_activity_at 比 updated_at 更新 —— 排序必须认它
  insert.run('ses-a', 'D:/wx/造书成剧', '造书成剧 · 首页改版', null, 'completed', 1790840000000, 1790843600000, null, 'hy4-preview-f', 1790845000000)
  // ses-b 没有 last_activity_at —— 应回落到 updated_at
  insert.run('ses-b', 'D:/workbuudy/营销', '自动起标题', '自定义标题优先', 'completed', 1790830000000, 1790835000000, null, 'glm-5.3-flash', null)
  insert.run('ses-deleted', 'D:/x', '已被删除的会话', null, 'completed', 1790820000000, 1790820000000, 1790830000000, null, null)
  db.close()
}

// ---- 1. 基本映射
{
  const sessions = await readWorkbuddySessions(home)
  check('读到 2 场（软删的被过滤）', sessions.length === 2, String(sessions.length))
  const first = sessions[0]!
  const second = sessions[1]!
  check('agent=workbuddy', first.agent === 'workbuddy')
  check('按 last_activity 倒序（最新在前）', first.id === 'ses-a', first.id)
  check('标题映射', first.title === '造书成剧 · 首页改版')
  check('cwd 映射', first.cwd === 'D:/wx/造书成剧')
  check('时间是 ISO 串', typeof first.updatedAt === 'string' && first.updatedAt.includes('T'), String(first.updatedAt))
  check('updatedAt 用 last_activity_at（与排序同口径）', first.updatedAt === new Date(1790845000000).toISOString(), String(first.updatedAt))
  check('ses-b 无 last_activity_at 时回落 updated_at', second.updatedAt === new Date(1790835000000).toISOString(), String(second.updatedAt))
  check('model 带出来', first.model === 'hy4-preview-f')
  check('custom_title 优先于 title', second.title === '自定义标题优先', second.title)
  check('诚实标注：不可恢复的会话由 planResume 判（这里只验字段）', first.messageCount === 0 && first.costSource === 'none')
}

// ---- 1b. 旧版 schema（没有 last_activity_at 列）→ 优雅降级返回空，不抛
{
  const oldHome = join(dir, 'workbuddy-old')
  mkdirSync(oldHome, { recursive: true })
  const db = new DatabaseSync(join(oldHome, 'workbuddy.db'))
  db.exec(`CREATE TABLE sessions (
    id TEXT, cwd TEXT, title TEXT, custom_title TEXT, status TEXT,
    created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, model TEXT
  )`)
  db.prepare('INSERT INTO sessions (id, cwd, title) VALUES (?,?,?)').run('ses-x', 'D:/y', '旧版会话')
  db.close()
  const rows = await readWorkbuddySessions(oldHome)
  check('旧版 schema 缺列 → 返回空数组（不抛、不挂扫描）', Array.isArray(rows) && rows.length === 0, String(rows.length))
}

// ---- 2. 库缺失 → 空，不抛
{
  const empty = await readWorkbuddySessions(join(dir, 'nope'))
  check('库缺失返回空数组', Array.isArray(empty) && empty.length === 0)
}

// ---- 3. 只读纪律：扫描前后目录逐字节一致
{
  const before = new Map<string, number>()
  for (const name of readdirSync(home)) {
    const p = join(home, name)
    before.set(name, statSync(p).size + statSync(p).mtimeMs)
  }
  await readWorkbuddySessions(home)
  let changed = 0
  for (const name of readdirSync(home)) {
    const p = join(home, name)
    const sig = statSync(p).size + statSync(p).mtimeMs
    if (before.get(name) !== sig) changed += 1
    if (!before.has(name)) changed += 1
  }
  check('扫描前后目录零变化（没有 -shm/-wal 残留）', changed === 0, `changed=${changed}`)
}

// ---- 4. 真实库冒烟（本机 WorkBuddy 在装，~/.workbuddy 真实存在）
{
  const real = await readWorkbuddySessions(null)
  check(
    '真实库能读出会话（本机 1800+ 场）',
    real.length > 100,
    String(real.length)
  )
  check('真实库：没有空 id 的行', real.every((s) => s.id.length > 0))
}

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // 临时目录清理失败不影响判卷结论
}

console.log(`\n通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
