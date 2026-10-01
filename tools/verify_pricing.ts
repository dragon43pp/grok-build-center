/**
 * 判卷：内置价目表 + grok 读取口径，对不对？
 *
 * Grok 是本机唯一一个**自己记账**的 CLI（`usage.json` 里的 `costUsdTicks`），
 * 所以它是唯一一处能拿真账单当答案的地方。这个脚本把两件事一起判了：
 *
 *   A. 价目表 —— 用**产品里实际会跑的那张表**（`priceForModel`）给每个模型的
 *      token 定价，和 grok 记的账比。偏了就说明单价取错渠道了。
 *   B. 读取口径 —— 把 reader 归一化后的五个分量，和 usage.json 的原始计数器
 *      逐个对上。口径错（比如把并列当成嵌套）这里会立刻露出来。
 *
 * 为什么必须走产品代码而不是另写一遍公式：另写一遍只能证明「我算对了」，
 * 证明不了「发出去的那张表是对的」。
 *
 *   node tools/_verify_pricing.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { priceForModel, estimateCost, loadPricingCache } from '../electron/sessions/pricing'
import { readGrokSessions } from '../electron/sessions/readers/grok'
import { grokHome } from '../electron/sessions/paths'

const TICKS_PER_USD = 1e9

interface Block {
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  costUsdTicks?: number
}

interface UsageFile {
  session?: Block & { modelUsage?: Record<string, Block> }
}

function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function usageJsonPaths(): string[] {
  const root = join(grokHome(), 'sessions')
  const out: string[] = []
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const id of readdirSync(groupDir)) {
      const file = join(groupDir, id, 'usage.json')
      try {
        if (statSync(file).isFile()) out.push(file)
      } catch {
        /* 会话目录里没有 usage.json，跳过 */
      }
    }
  }
  return out
}

/* ── A. 价目表判卷 ─────────────────────────────────────────────── */

interface BlockRow {
  id: string
  model: string
  recorded: number
  additive: number
  nested: number
}

const blocks: BlockRow[] = []
const seenModels = new Map<string, { provider: string; input: number; output: number; cacheRead: number | null }>()

for (const path of usageJsonPaths()) {
  let data: UsageFile
  try {
    data = JSON.parse(readFileSync(path, 'utf8')) as UsageFile
  } catch {
    continue
  }
  const session = data.session
  if (!session) continue
  const id = path.split(/[\\/]/).slice(-2, -1)[0] ?? path

  for (const [modelId, block] of Object.entries(session.modelUsage ?? {})) {
    const ticks = n(block.costUsdTicks)
    if (ticks <= 0) continue
    const match = priceForModel(modelId)
    if (!match) continue
    seenModels.set(modelId, {
      provider: match.price.provider,
      input: match.price.input,
      output: match.price.output,
      cacheRead: match.price.cacheRead
    })
    const units = (tokens: number, unit: number): number => (tokens / 1e6) * unit
    const input = n(block.inputTokens)
    const output = n(block.outputTokens)
    const cacheRead = n(block.cachedReadTokens)
    const cacheWrite = n(block.cacheCreationTokens)
    const price = match.price

    blocks.push({
      id,
      model: modelId,
      recorded: ticks / TICKS_PER_USD,
      // 现口径：并列相加 + reasoning 已在 output 里
      additive:
        units(input, price.input) +
        units(output, price.output) +
        units(cacheRead + cacheWrite, price.cacheRead ?? 0),
      // 被否掉的口径：input 里已含缓存
      nested:
        units(input - cacheRead - cacheWrite, price.input) +
        units(output, price.output) +
        units(cacheRead + cacheWrite, price.cacheRead ?? 0)
    })
  }
}

const sum = (pick: (row: BlockRow) => number): number =>
  blocks.reduce((total, row) => total + pick(row), 0)
const recordedTotal = sum((row) => row.recorded)
const additiveTotal = sum((row) => row.additive)
const nestedTotal = sum((row) => row.nested)

const cache = loadPricingCache()
console.log('══ A. 价目表判卷（对比 grok 自记账单）══')
console.log(
  `价目表来源: ${cache.loaded ? `刷新缓存 ${cache.count} 条` : `内置快照 ${cache.generatedOn}`}`
)
console.log(`可判卷模型块: ${blocks.length} 个（有 costUsdTicks 的 modelUsage 块）`)
console.log(`命中模型    : ${[...seenModels.keys()].join(', ') || '(无)'}`)
console.log(
  '单价        : ' +
    [...seenModels]
      .map(([id, p]) => `${id}=$${p.input}/$${p.output}/$${p.cacheRead ?? '—'}`)
      .join('  ')
)
console.log('')
console.log(`记录合计      $${recordedTotal.toFixed(2)}`)
console.log(
  `并列相加(现)  $${additiveTotal.toFixed(2)}   ×${(additiveTotal / recordedTotal).toFixed(3)}`
)
console.log(
  `嵌套扣缓存    $${nestedTotal.toFixed(2)}   ×${(nestedTotal / recordedTotal).toFixed(3)}   ← 被否掉的口径`
)

/** 分块看离散度：总量比值会被少数大块掩盖，所以要看中位数和极值。 */
function spread(label: string, pick: (row: BlockRow) => number, filter: (row: BlockRow) => boolean): void {
  const ratios = blocks.filter(filter).map((row) => pick(row) / row.recorded).sort((a, b) => a - b)
  if (!ratios.length) return
  const median = ratios[ratios.length >> 1] ?? 0
  console.log(
    `${label}（${ratios.length} 块）: 中位 ×${median.toFixed(2)}  最小 ×${ratios[0]?.toFixed(2)}  最大 ×${ratios[ratios.length - 1]?.toFixed(2)}`
  )
}

console.log('')
console.log('离散度（总量比值会被少数大块带偏，中位数才是常态）:')
spread('  全部', (row) => row.additive, () => true)
spread('  大块 $1 以上', (row) => row.additive, (row) => row.recorded >= 1)
spread('  小块 $1 以下', (row) => row.additive, (row) => row.recorded < 1)
spread('  嵌套（对照）', (row) => row.nested, () => true)
console.log('')
console.log('⚠️ 结论只能是「口径选对了」，不是「账单能复现」：')
console.log('   同一个数量级的会话，grok 记的账能差 6 倍，说明有它计费、但计数器里没有的开销。')
console.log('   所以 catalog 估算永远只是估算，且永远让位给 recorded。')
console.log('')
console.log('逐块（只列偏差 > 30% 的）:')
let outliers = 0
for (const row of blocks) {
  const ratio = row.additive / row.recorded
  if (Math.abs(ratio - 1) <= 0.3) continue
  outliers++
  console.log(
    `  ${row.id.slice(0, 12)}  ${row.model.padEnd(16)} 记录 $${row.recorded.toFixed(2)}` +
      `  并列 $${row.additive.toFixed(2)} ×${ratio.toFixed(2)}` +
      `  嵌套 $${row.nested.toFixed(2)}`
  )
}
if (!outliers) console.log('  （无）')

/* ── B. 读取口径判卷 ───────────────────────────────────────────── */

console.log('')
console.log('══ B. 读取口径判卷（reader 归一化 vs usage.json 原始计数器）══')

const sessions = await readGrokSessions(null)
const byId = new Map(sessions.map((session) => [session.id, session]))
let checked = 0
const mismatches: string[] = []

for (const path of usageJsonPaths()) {
  let data: UsageFile
  try {
    data = JSON.parse(readFileSync(path, 'utf8')) as UsageFile
  } catch {
    continue
  }
  const raw = data.session
  if (!raw) continue
  const id = path.split(/[\\/]/).slice(-2, -1)[0] ?? ''
  const session = byId.get(id)
  if (!session) {
    mismatches.push(`${id}: reader 没读到这场会话`)
    continue
  }
  checked++

  const rawInput = n(raw.inputTokens)
  const rawOutput = n(raw.outputTokens)
  const rawCR = n(raw.cachedReadTokens)
  const rawCW = n(raw.cacheCreationTokens)
  const rawReasoning = n(raw.reasoningTokens)

  if (session.usage.input !== rawInput) {
    mismatches.push(`${id}: input ${session.usage.input} != ${rawInput}`)
  }
  // output 被挖掉了 reasoning，两者相加必须还原
  if (session.usage.output + session.usage.reasoning !== rawOutput) {
    mismatches.push(
      `${id}: output+reasoning ${session.usage.output + session.usage.reasoning} != ${rawOutput}`
    )
  }
  if (session.usage.cacheRead !== rawCR) {
    mismatches.push(`${id}: cacheRead ${session.usage.cacheRead} != ${rawCR}`)
  }
  if (session.usage.cacheWrite !== rawCW) {
    mismatches.push(`${id}: cacheWrite ${session.usage.cacheWrite} != ${rawCW}`)
  }
  if (session.usage.reasoning !== rawReasoning) {
    mismatches.push(`${id}: reasoning ${session.usage.reasoning} != ${rawReasoning}`)
  }
  if (session.usage.total !== rawInput + rawOutput + rawCR + rawCW) {
    mismatches.push(
      `${id}: total ${session.usage.total} != ${rawInput + rawOutput + rawCR + rawCW}`
    )
  }
}

console.log(`逐字段核对 ${checked} 场会话 × 6 个字段`)
if (mismatches.length === 0) {
  console.log('结果：全部一致 —— 并列相加 + reasoning 从 output 里挖出，口径成立。')
} else {
  console.log(`结果：${mismatches.length} 处不一致`)
  for (const line of mismatches.slice(0, 20)) console.log('  ' + line)
}

/* ── C. 成本函数自洽 ───────────────────────────────────────────── */

console.log('')
console.log('══ C. 会话级估算自洽（estimateCost 对整场会话）══')

let priced = 0
let unpriced = 0
const reasons = new Map<string, number>()
const pricedRows: string[] = []

for (const session of sessions) {
  const estimate = estimateCost(session.model, session.usage)
  if (estimate.source === 'catalog') {
    priced++
    pricedRows.push(
      `  ${session.id.slice(0, 12)}  ${session.model || '(无型号)'}  ` +
        `估算 $${estimate.usd.toFixed(2)}` +
        (session.costSource === 'recorded'
          ? `  记录 $${session.costUsd.toFixed(2)}  ×${(estimate.usd / session.costUsd).toFixed(2)}`
          : '')
    )
  } else {
    unpriced++
    const reason = estimate.reason ?? 'unknown'
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
}

console.log(`grok 会话 ${sessions.length} 场：可估 ${priced} · 无法估 ${unpriced}`)
if (reasons.size) {
  console.log('  无法估的原因：' + [...reasons].map(([k, v]) => `${k}=${v}`).join('  '))
}
console.log('')
console.log('有自记账的场次（估算 vs 记录）:')
for (const row of pricedRows.filter((row) => row.includes('记录'))) console.log(row)
