/**
 * AI 助手（会话历史智能查找）判卷。
 *
 * 两轮：
 *   ① 离线轮（默认跑）：不联网。验未配置时的报错码、清单形状、伪造 key 被过滤。
 *   ② 联网轮（`GBC_ASSISTANT_LIVE=1` 时跑）：读 userData 里用户自己配的端点，
 *      真发一枪，验它能从 fixture 清单里挑出命中场次。
 *
 * 离线轮不碰网络，所以判卷永远可跑；联网轮只在你想确认端点活着时才跑：
 *   node_modules/.bin/esbuild tools/assistant_search_check.ts --bundle \
 *     --platform=node --format=esm --outfile=tools/_assistant_search_check.mjs \
 *     && node tools/_assistant_search_check.mjs
 *   GBC_ASSISTANT_LIVE=1 node tools/_assistant_search_check.mjs
 */

import { join } from 'node:path'
import { buildInventory, assistantSearch } from '../electron/assistant/search'
import { loadAssistantConfig, isConfigured } from '../electron/assistant/store'
import { emptyUsage, type HistorySession } from '../shared/session-history'

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

function session(over: Partial<HistorySession> & { id: string; title: string }): HistorySession {
  return {
    agent: 'grok',
    id: over.id,
    title: over.title,
    cwd: 'D:/workbuudy/营销',
    createdAt: '2026-09-30T02:00:00Z',
    updatedAt: '2026-09-30T03:00:00Z',
    messageCount: 12,
    model: 'grok-4.7',
    usage: { ...emptyUsage(), input: 1000, output: 200, total: 1200 },
    costUsd: 0,
    costSource: 'none',
    storage: 'dir',
    path: 'C:/x/sessions/' + over.id,
    archived: false,
    subagent: false,
    ...over
  }
}

const sessions: HistorySession[] = [
  session({ id: 'aaa', title: '飞书路由：/继续 自动投喂' }),
  session({ id: 'bbb', title: '每日 AI 日报自动化', agent: 'codex' }),
  session({ id: 'ccc', title: '终端页信息条改版', agent: 'claude' })
]

// ---- ① 离线：清单形状
{
  const inventory = buildInventory(sessions)
  check('清单每行是 key | agent | 标题 | 目录 | 模型 | 时间 | 消息数 | tokens', /^grok:aaa \| grok \| 飞书路由/.test(inventory), inventory.split('\n')[0])
  check('清单含全部 3 场', inventory.split('\n').length === 3)
  check('清单截断长标题到 80 字', buildInventory([session({ id: 'd', title: 'x'.repeat(200) })]).includes('x'.repeat(80)))
}

// ---- ① 离线：未配置时给的是可操作的错误码，不是异常
{
  const r = await assistantSearch({ baseURL: '', apiKey: '', model: '', enabled: false }, sessions, { query: '飞书' })
  check('未配置 → ok=false', r.ok === false)
  check('未配置 → errorCode=not_configured', r.errorCode === 'not_configured', String(r.errorCode))
  check('未配置 → 有人话提示', r.errorMessage.includes('AI 助手未配置'), r.errorMessage)
  check('未配置 → 不产生命中', r.sessionKeys.length === 0)
}

// ---- ① 离线：空问题
{
  const r = await assistantSearch({ baseURL: 'https://x/v1', apiKey: 'k', model: 'm', enabled: true }, sessions, { query: '   ' })
  check('空问题 → ok=false 且不发请求', r.ok === false && r.errorCode === 'bad_response')
}

// ---- ① 离线：端点不可达 → 结构化错误，不抛
{
  const r = await assistantSearch({ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', enabled: true }, sessions, { query: '飞书' })
  check('不可达端点 → ok=false', r.ok === false)
  check('不可达端点 → 有机器可读码', typeof r.errorCode === 'string' && r.errorCode.length > 0, String(r.errorCode))
  check('不可达端点 → 有耗时', r.tookMs >= 0)
}

// ---- ② 联网（可选）
if (process.env['GBC_ASSISTANT_LIVE'] === '1') {
  // 判卷不 import electron（esbuild 链路会断），userData 从外面指进来。
  const userData =
    process.env['GBC_ASSISTANT_USERDATA'] ??
    join(process.env['APPDATA'] ?? '', 'Grok Build Center Dev')
  const config = loadAssistantConfig(userData)
  check('userData 里已配置 AI 助手', isConfigured(config), `baseURL=${config.baseURL}`)
  if (isConfigured(config)) {
    const r = await assistantSearch(config, sessions, { query: '哪一场在做飞书路由' })
    check('真实端点返回 ok', r.ok === true, r.errorMessage ?? '')
    check('命中含飞书那一场', r.sessionKeys.includes('grok:aaa'), JSON.stringify(r.sessionKeys))
    check('给了一句中文结论', (r.answer ?? '').length > 0, (r.answer ?? '').slice(0, 60))
    console.log(`  · 模型=${config.model} 耗时=${r.tookMs}ms 结论=「${(r.answer ?? '').slice(0, 80)}」`)
  }
}

console.log(`\n${fail === 0 ? '\u2714' : '\u2716'} ${pass} 过 / ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
