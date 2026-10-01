/**
 * DiagnosticLog 重入闸门的回归判卷。
 *
 * 背景：往已销毁的 frame 广播时，Electron 不抛异常，而是自己
 * `console.error('Error sending from webFrameMain: ...')`。这句会被诊断日志的
 * 控制台捕获吃进 append，append 再 publish，监听者（main.ts 里那个
 * `diagnosticLog.onChanged(...)`）又广播一次，于是形成
 *   send 失败 → console.error → append → publish → broadcast → send 失败 → …
 * 的死循环。实测这个回路能灌出 500MB+ 的日志（2026-09-30，扫码期间刷新窗口）。
 *
 * 这里不去碰 Electron，直接复刻那个闭环的形状：让监听者在收到变更时又 append 一条。
 * 闸门生效时递归只能走一层；闸门一旦被删掉，这个脚本会直接栈溢出。
 *
 * 跑法：
 *   node_modules/.bin/esbuild tools/diag_loop_check.ts --bundle --platform=node \
 *     --format=esm --outfile=tools/_diag_loop_check.mjs && node tools/_diag_loop_check.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosticLog } from '../electron/diagnostics/DiagnosticLog'

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

const dir = mkdtempSync(join(tmpdir(), 'gbc-diag-loop-'))
const log = new DiagnosticLog(join(dir, 'diag.jsonl'))

// 复刻回路：监听者收到任何变更，就再 append 一条「广播失败」——
// 这正是 Electron 内部 console.error 被捕获后会发生的事。
let listenerCalls = 0
let depth = 0
let maxDepth = 0
log.onChanged(() => {
  listenerCalls += 1
  depth += 1
  maxDepth = Math.max(maxDepth, depth)
  try {
    if (listenerCalls <= 50) {
      log.append('error', 'main', 'Error sending from webFrameMain: 模拟广播失败')
    }
  } finally {
    depth -= 1
  }
})

log.append('info', 'main', '触发第一条日志')

check('监听者被调用（说明链路确实接上了）', listenerCalls >= 1, String(listenerCalls))
check('递归只走一层，没有无限自激', listenerCalls === 1, `listenerCalls=${listenerCalls}`)
check('深度不超过 1', maxDepth <= 1, `maxDepth=${maxDepth}`)

// 闸门是「不外推」，不是「不落盘」——日志本身必须照记。
const snapshot = log.snapshot()
const hasSimulated = snapshot.entries.some((e) => e.message.includes('模拟广播失败'))
check('被拦下的那条日志仍然记进了内存条目', hasSimulated, `entries=${snapshot.entries.length}`)

// 闸门放开后，新的 append 必须恢复广播，否则就是「一次卡死，永久哑火」。
const before = listenerCalls
log.append('info', 'main', '闸门后的正常日志')
check('闸门释放后广播恢复', listenerCalls > before, `${before} -> ${listenerCalls}`)

await log.clear()
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // 临时目录清理失败不影响判卷结论
}

console.log(`\n通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
