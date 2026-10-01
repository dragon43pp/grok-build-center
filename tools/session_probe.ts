/**
 * Live probe for the session layer. Not part of the product build.
 *
 *   node tools/run_session_probe.mjs
 *
 * Prints what each reader found on this machine, so the numbers can be checked
 * against the on-disk truth rather than assumed.
 */
import { discoverSessions, groupByAgent, summarise } from '../electron/sessions'

const pad = (value, width) => String(value).padEnd(width)

function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function clip(text, max = 46) {
  const one = String(text ?? '').replace(/\s+/g, ' ')
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const result = await discoverSessions()

console.log(`\n=== 扫描总耗时 ${result.tookMs} ms ===`)
for (const agent of result.results) {
  const state = agent.error ? `ERROR ${agent.error}` : agent.notInstalled ? '未安装' : '正常'
  console.log(
    `${pad(agent.agent, 13)} ${pad(agent.sessions.length + ' 场', 8)} ${pad(agent.tookMs + 'ms', 8)} ${state}`
  )
}

const summary = summarise(result)
console.log(
  `\n汇总: 已安装 ${summary.installed} · 未安装 ${summary.notInstalled} · 失败 ${summary.failed}` +
    ` · 顶层 ${summary.sessionCount} · 子代理 ${summary.subagentCount}` +
    ` · token 合计 ${fmt(summary.totalTokens)}`
)

const grouped = groupByAgent(result.sessions)
for (const [agent, sessions] of grouped) {
  console.log(`\n──── ${agent} (${sessions.length}) ────`)
  const sorted = [...sessions].sort(
    (a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? 0) - Date.parse(a.updatedAt ?? a.createdAt ?? 0)
  )
  for (const s of sorted.slice(0, 5)) {
    console.log(
      `  ${pad(s.id.slice(0, 12), 13)} ${pad(clip(s.title), 48)} ${pad(fmt(s.messageCount), 7)}` +
        ` tok=${pad(fmt(s.usage.total), 7)} $=${s.costUsd.toFixed(4)} ${pad(s.costSource, 9)}` +
        ` ${pad(s.subagent ? 'SUB' : '', 4)}${pad(s.origin ?? '', 4)} ${s.updatedAt ?? s.createdAt ?? '-'}`
    )
    console.log(`      cwd=${s.cwd || '(空)'}  model=${s.model || '(空)'}  ${clip(s.path, 90)}`)
  }
  if (sessions.length > 5) console.log(`  … 另有 ${sessions.length - 5} 场`)
}
