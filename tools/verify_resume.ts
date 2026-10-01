/**
 * 判卷：从会话恢复，参数到底拼得对不对？
 *
 * `planResume` 是个纯函数，但纯函数「看着对」不等于「发的 id 是 CLI 认得的那
 * 个」。这个脚本拿**本机真实会话**当答案，判五件事，任何一件不成立就 exit 1：
 *
 *   A. 分类 —— 每个 agent 里有多少场可恢复、有多少被哪条规则挡住。数字要对得上
 *      直觉（子代理不该出现、没装 CLI 的 agent 不该有可恢复项）。
 *   B. 参数 —— 末位必须是这场会话自己的 id（原地续，不是分叉），首位必须与
 *      CLI 自己 `--help` 里的写法一致。写法是**抄在本脚本里的实测证据**，
 *      有人改 SPECS 就得同时改这里，改不动就说明改错了。
 *   C. 引用可用 —— 把 id 拿回 CLI 自己的存储里找：grok 的目录名、claude 的
 *      `<id>.jsonl`、codex 的 rollout 文件名。找得到才证明这个 id 是 CLI 认的
 *      那个，而不是我们自己编的序号。这一条是**唯一**能证明 id 语义的地方。
 *   D. 预填文本可逆 —— 目录没了要把参数摆进输入框让人过一眼，那段文本必须能
 *      被 `parseCommandLine` 解析回同一个 argv，否则用户点确认时跑的不是同一
 *      条命令。
 *   E. 空 cwd 的拦截顺序 —— `resolveWorkspace('')` 不报错，它把空工作区解析成
 *      Home。恢复路径必须抢在它之前拦住空 cwd，拦在后面等于没拦。这条是源码级
 *      绊线，防的是「顺手把它简化掉」。
 *
 * 首轮跑出来两处真问题，都已修：
 *   ① grok reader 会把一个只有 0 字节 `summary.json.lock` 的残壳目录当成会话
 *      （无标题、0 消息、**无 cwd**），现在要求目录里有 summary.json 或
 *      updates.jsonl 才算；
 *   ② 就是上面 E —— 那个空 cwd 会一路走到 `resolveWorkspace`，被解析成 Home。
 *
 * 只读：不启动任何 CLI，不写任何会话文件。真的点一次恢复会往 `~/.grok/sessions`
 * 里追加内容 —— 那是用户在实际用的会话，测试里不做。
 *
 *   node tools/_verify_resume.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { discoverSessions } from '../electron/sessions'
import { grokHome, claudeConfigDir, codexHome } from '../electron/sessions/paths'
import { planResume, formatArgs } from '../shared/session-resume'
import { parseCommandLine } from '../src/app/launchOptions'
import { AGENT_IDS, type AgentId, type HistorySession } from '../shared/session-history'

/**
 * 实测证据表：agent -> CLI 自己 `--help` 里那一行。
 *
 * 这些字符串是 2026-09-30 在本机 grep `--help` 抄下来的，不是猜测。
 * SPECS 改了而这里没改 = 测试失败，这正是它存在的意义。
 */
const VERIFIED_HELP: Record<string, { argv: string[]; help: string }> = {
  grok: {
    argv: ['--resume', '<id>'],
    help: '-r, --resume [<SESSION_ID_OR_TITLE>]  (UUID required; titles are directory-scoped)'
  },
  codex: {
    argv: ['resume', '<id>'],
    help: 'codex resume <SESSION_ID>'
  },
  claude: {
    argv: ['--resume', '<id>'],
    help: '-r, --resume [value]'
  }
}

let failures = 0

function fail(message: string): void {
  failures += 1
  console.log(`  FAIL  ${message}`)
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message)
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function clip(text: string, max = 52): string {
  const one = String(text ?? '').replace(/\s+/g, ' ')
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** id 在 CLI 自己的存储里找得到吗？这是 id 语义的唯一证据。 */
function idExistsInCliStore(session: HistorySession): boolean {
  try {
    if (session.agent === 'grok') {
      // `sessions/<encoded-cwd>/<session-id>/` —— 目录名就是 id。
      // 判据用「有 summary.json 或 updates.jsonl」而不是「目录存在」：只有一把
      // `summary.json.lock` 的残壳目录也算存在，但 reader 已经不再把它当会话。
      const root = join(grokHome(), 'sessions')
      if (!existsSync(root)) return false
      for (const group of readdirSync(root)) {
        const dir = join(root, group, session.id)
        if (
          existsSync(join(dir, 'summary.json')) ||
          existsSync(join(dir, 'updates.jsonl'))
        ) {
          return true
        }
      }
      return false
    }
    if (session.agent === 'claude') {
      // `projects/<slug>/<uuid>.jsonl`
      const root = join(claudeConfigDir(), 'projects')
      if (!existsSync(root)) return false
      for (const slug of readdirSync(root)) {
        if (existsSync(join(root, slug, `${session.id}.jsonl`))) return true
      }
      return false
    }
    if (session.agent === 'codex') {
      // 读取时拿到的 rollout 路径本身就是证据：文件名里含 id。
      return session.path ? basename(session.path).includes(session.id) : false
    }
  } catch {
    return false
  }
  return false
}

const result = await discoverSessions()
const sessions = result.sessions

console.log(`\n=== 扫描：${sessions.length} 场 · ${result.tookMs} ms ===`)

// ── A. 分类 ───────────────────────────────────────────────────────────────
interface Tally {
  total: number
  resumable: number
  subagent: number
  noId: number
  noCommand: number
}

const tallies = new Map<AgentId, Tally>()
for (const agent of AGENT_IDS) {
  tallies.set(agent, { total: 0, resumable: 0, subagent: 0, noId: 0, noCommand: 0 })
}

const resumable: HistorySession[] = []

for (const session of sessions) {
  const tally = tallies.get(session.agent)
  if (!tally) continue
  tally.total += 1
  const plan = planResume(session)
  if (plan.ok) {
    tally.resumable += 1
    resumable.push(session)
    continue
  }
  if (plan.blocker === 'subagent') tally.subagent += 1
  else if (plan.blocker === 'no-session-id') tally.noId += 1
  else tally.noCommand += 1
}

console.log('\n===== A. 分类 =====')
console.log(
  `${pad('agent', 14)}${pad('总数', 7)}${pad('可恢复', 8)}${pad('子代理', 8)}${pad('无id', 7)}无恢复命令`
)
for (const [agent, tally] of tallies) {
  if (tally.total === 0) continue
  console.log(
    `${pad(agent, 14)}${pad(String(tally.total), 7)}${pad(String(tally.resumable), 8)}` +
      `${pad(String(tally.subagent), 8)}${pad(String(tally.noId), 7)}${tally.noCommand}`
  )
}
console.log(`\n可恢复合计：${resumable.length} 场`)

// 子代理一条都不该漏进可恢复集合。
const leakedSubagents = resumable.filter((session) => session.subagent)
check(leakedSubagents.length === 0, `有 ${leakedSubagents.length} 场子代理会话被判成可恢复`)

// 没有实测命令的 agent 一律不可恢复。
for (const agent of ['opencode', 'kimi', 'pi', 'antigravity'] as AgentId[]) {
  const tally = tallies.get(agent)
  if (!tally) continue
  check(
    tally.resumable === 0,
    `${agent} 有 ${tally.resumable} 场被判成可恢复，但它没有实测过的恢复命令`
  )
}

// ── B / C. 参数与引用 ─────────────────────────────────────────────────────
console.log('\n===== B. 参数（末位 = 本场 id；首位 = CLI 实测写法）=====')
const argvKinds = new Map<string, { count: number; sample: HistorySession; args: string[] }>()
for (const session of resumable) {
  const plan = planResume(session)
  if (!plan.ok) {
    fail(`${session.agent}/${session.id}: 分类与 plan 不一致`)
    continue
  }
  const spec = VERIFIED_HELP[plan.cliId]
  if (!spec) {
    fail(`cliId=${plan.cliId} 没有实测证据，不能给恢复按钮`)
    continue
  }
  // 末位必须是本场 id：原地续，不是 fork。
  check(
    plan.args[plan.args.length - 1] === session.id,
    `${session.agent}/${session.id}: 参数末位是 ${plan.args[plan.args.length - 1]}，不是本场 id`
  )
  // 首位（codex 是两个 token 的子命令）必须与实测写法同形。
  const head = plan.args.slice(0, plan.args.length - 1)
  const expectedHead = spec.argv.slice(0, -1)
  check(
    head.length === expectedHead.length && head.every((token, i) => token === expectedHead[i]),
    `${session.agent}/${session.id}: 参数头部 ${JSON.stringify(head)} != 实测 ${JSON.stringify(expectedHead)}`
  )
  // cwd 必须非空：恢复要在原目录里起，空目录等于在别处开新会话。
  check(
    session.cwd.trim().length > 0,
    `${session.agent}/${session.id}: cwd 为空，恢复会落到错误目录`
  )

  const key = `${session.agent} ${head.join(' ')} <id>`
  const bucket = argvKinds.get(key)
  if (bucket) bucket.count += 1
  else argvKinds.set(key, { count: 1, sample: session, args: plan.args })
}
for (const [key, bucket] of argvKinds) {
  console.log(`  ${pad(key, 30)} ×${pad(String(bucket.count), 5)}  ${clip(bucket.sample.title)}`)
}

console.log('\n===== C. id 在 CLI 自己的存储里 =====')
for (const [key, bucket] of argvKinds) {
  const agent = bucket.sample.agent
  const found = idExistsInCliStore(bucket.sample)
  console.log(`  ${pad(agent, 14)} ${found ? 'ok' : 'FAIL'}  样本 ${bucket.sample.id}`)
  check(found, `${agent}: id ${bucket.sample.id} 在 CLI 自己的存储里找不到`)
}

// 抽样全量校验（不只样本）：可恢复的每一场都要能满足 B/C 的硬条件。
let refChecked = 0
let refMissing = 0
for (const session of resumable) {
  if (session.agent !== 'grok') continue
  refChecked += 1
  if (!idExistsInCliStore(session)) {
    refMissing += 1
    fail(`grok/${session.id}: 目录不存在，恢复会失败`)
  }
}
console.log(`  grok 全量引用校验：${refChecked - refMissing}/${refChecked} 命中`)

// ── D. 预填文本可逆 ───────────────────────────────────────────────────────
console.log('\n===== D. formatArgs 往返 =====')
const roundTrips: string[][] = [
  ['--resume', '0199a4e2-7c31-7b02-9c4d-2f8a0b6e51d3'],
  ['resume', '5f2a91c8-0d4e-4a7b-bb31-6e2d9c8f0a12'],
  ['--resume', 'title with spaces'],
  ['--resume', 'quote"inside'],
  ['--resume', 'C:\\Users\\admin\\my project']
]
for (const argv of roundTrips) {
  const text = formatArgs(argv)
  const back = parseCommandLine(text)
  const same = back.length === argv.length && back.every((token, i) => token === argv[i])
  console.log(`  ${same ? 'ok  ' : 'FAIL'}  ${JSON.stringify(argv)} -> "${text}" -> ${JSON.stringify(back)}`)
  check(same, `预填文本不可逆：${JSON.stringify(argv)}`)
}

// ── E. 空 cwd 的拦截顺序 ──────────────────────────────────────────────────
//
// 这一条是源码级绊线。主进程的 `resolveWorkspace('')` **不报错** —— 它把空
// 工作区解析成 Home（新建会话时那是有意为之）。恢复路径因此必须在调用之前
// 就把空 cwd 拦下来，否则会出现「按钮点下去、会话在 Home 里起来了」这种
// 用户完全看不出异常的结果。拦在调用之后等于没拦。
console.log('\n===== E. 空 cwd 必须拦在 resolveWorkspace 之前 =====')
{
  const shell = readFileSync(join(import.meta.dirname, '..', 'src', 'app', 'AppShell.tsx'), 'utf8')
  const guard = shell.indexOf('if (!session.cwd.trim())')
  const call = shell.indexOf('resolveWorkspace(installation.id, session.cwd)')
  if (guard < 0) fail('AppShell.tsx 里找不到空 cwd 的拦截')
  else if (call < 0) fail('AppShell.tsx 里找不到恢复用的 resolveWorkspace 调用')
  else {
    const ordered = guard < call
    console.log(`  ${ordered ? 'ok  ' : 'FAIL'}  guard@${guard} ${ordered ? '<' : '>'} call@${call}`)
    check(ordered, '空 cwd 的拦截写在了 resolveWorkspace 之后 —— 空 cwd 会被解析成 Home')
  }
}

// ── 收尾 ──────────────────────────────────────────────────────────────────
console.log('\n===== 结论 =====')
if (failures === 0) {
  console.log(`全部通过 · 可恢复 ${resumable.length} 场 · 未启动任何 CLI、未写入任何会话`)
} else {
  console.log(`${failures} 项失败 —— 不要发这个版本`)
}
process.exit(failures === 0 ? 0 : 1)
