#!/usr/bin/env node
/**
 * 「往已销毁 frame 广播」死循环的真机回归。
 *
 * 这是 2026-09-30 那次 536MB 日志事故的复现与守卫。
 *
 * ── 真正的触发条件（踩过两次弯路才找对）──
 * 不是重载页面，是**renderer 进程死亡**而 BrowserWindow 还活着：
 *   isDestroyed() === false、getAllWindows() 里还挂着它，但 frame 已经没了。
 * 此时 `webContents.send()` 不抛异常，Electron 自己
 * `console.error('Error sending from webFrameMain: ...')`；
 * 那句被 DiagnosticLog 的控制台捕获吃进 append，append 再 publish，
 * 监听者（main.ts 的 diagnosticLog.onChanged）又广播一次 —— 于是：
 *   send 失败 → console.error → append → publish → broadcast → send 失败 → …
 * 每轮只写一行，但永不停。现场实测 12 秒 105,276 行 / 4.48MB（约 838 倍于修复后）。
 *
 * 第一次写的版本用「反复重载页面」当触发条件 —— 那不是触发条件，判卷全绿但从没打到靶子。
 * 所以这个脚本宁可多绕一步：直接用 CDP 定位 renderer 的 pid 并杀掉它。
 *
 * 判据是**有界**，不是「零错误」：拆除过程中出现有限条 disposed 错误是正常的。
 * 回路还在的话，这个数字会是几千。
 *
 * 用法：node tools/broadcast_flood_check.mjs <port> <launchLogPath>
 */

import { readFileSync, statSync } from 'node:fs'

const port = Number(process.argv[2] || 9357)
const launchLog = process.argv[3]
if (!launchLog) {
  console.error('用法: node tools/broadcast_flood_check.mjs <port> <launchLogPath>')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SEND_TIMEOUT_MS = 12_000
const OBSERVE_MS = 12_000

// 修复后的实测：5341 字节 / 7 条。给约 10 倍余量，既能容忍抖动，
// 又远低于回路的量级（4.4MB / 5120 条）。
const BYTE_BUDGET = 96 * 1024
const DISPOSED_BUDGET = 120

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  \u2714 ${name}`)
  } else {
    fail += 1
    console.log(`  \u2716 ${name}${extra ? ` \u2014 ${extra}` : ''}`)
  }
}

function logStats() {
  try {
    const text = readFileSync(launchLog, 'utf8')
    return {
      bytes: statSync(launchLog).size,
      lines: text.split('\n').length,
      disposed: (text.match(/Render frame was disposed/g) || []).length
    }
  } catch (err) {
    throw new Error(`读不到启动日志 ${launchLog}：${err.message}`)
  }
}

/** 极简 CDP 客户端：带超时、带存活性探测，连不上立刻报错不挂死。 */
class Cdp {
  constructor(url) {
    this.url = url
    this.seq = 0
    this.pending = new Map()
    this.ws = null
  }

  async open() {
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      let msg = null
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg?.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg)
        this.pending.delete(msg.id)
      }
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e) }, { once: true })
    })
    return this
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, SEND_TIMEOUT_MS)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true })
    if (r.result?.exceptionDetails) {
      throw new Error(
        '表达式抛错: ' + (r.result.exceptionDetails.exception?.description || '?')
      )
    }
    return r.result?.result?.value
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      // 已经断开了
    }
  }
}

async function targets() {
  return await (await fetch(`http://127.0.0.1:${port}/json`)).json()
}

/** 等到有一个能答话的页面 target，返回连好的客户端。应用冷启动要 20-30 秒。 */
async function connectPage(deadlineMs = 90_000) {
  const deadline = Date.now() + deadlineMs
  let lastErr = 'no target'
  while (Date.now() < deadline) {
    let list = []
    try {
      list = await targets()
    } catch (err) {
      lastErr = String(err?.message || err)
      await sleep(800)
      continue
    }
    const candidate = list.find(
      (t) => t.type === 'page' && !t.url.startsWith('devtools://') && t.webSocketDebuggerUrl
    )
    if (!candidate) {
      lastErr = '还没有 page target'
      await sleep(800)
      continue
    }
    const cdp = new Cdp(candidate.webSocketDebuggerUrl)
    try {
      await cdp.open()
      await cdp.eval('1')
      return cdp
    } catch (err) {
      lastErr = String(err?.message || err)
      cdp.close()
      await sleep(800)
    }
  }
  throw new Error(`等不到可驱动的页面（${lastErr}）`)
}

/** 借 browser target 的 SystemInfo 找出 renderer 进程 —— 不依赖任何外部 shell。 */
async function rendererPids() {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await new Cdp(version.webSocketDebuggerUrl).open()
  try {
    await browser.send('SystemInfo.enable')
    const r = await browser.send('SystemInfo.getProcessInfo')
    const info = r.result?.processInfo || []
    return info.filter((p) => p.type === 'renderer').map((p) => p.id)
  } finally {
    browser.close()
  }
}

console.log('广播死循环回归 · 真机')
const page = await connectPage()

// 首启引导盖在整页上，不关掉后面所有 click 都打在遮罩上
if ((await page.eval(`!!document.querySelector('[data-testid=first-run-onboarding]')`)) === true) {
  await page.eval(`document.querySelector('[data-testid=onboarding-complete]').click()`)
  await sleep(900)
}

// 让广播流起来：扫码每轮都会推状态
await page.eval(`document.querySelector('[data-testid=titlebar-settings]').click()`)
await sleep(1500)
await page.eval(`document.querySelector('[data-testid=settings-category-feishu]').click()`)
await sleep(2000)
await page.eval(`document.querySelector('[data-testid=settings-feishu-scan]').click()`)

let phase = ''
for (let i = 0; i < 25; i += 1) {
  phase = await page.eval(
    `(document.querySelector('[data-testid=settings-feishu-status]')||{dataset:{}}).dataset?.feishuPhase || ''`
  )
  if (phase === 'scanning') break
  await sleep(600)
}
check('扫码已启动（广播正在流动）', phase === 'scanning', String(phase))

const before = logStats()
console.log(`  起始：${before.bytes} 字节 / ${before.lines} 行 / disposed ${before.disposed} 条`)

// ── 核心动作：杀掉 renderer，让窗口变成「活着但没 frame」 ──
const pids = await rendererPids()
check('定位到 renderer 进程', pids.length > 0, `pids=${JSON.stringify(pids)}`)
for (const pid of pids) {
  try {
    process.kill(pid, 'SIGKILL')
    console.log(`  已杀 renderer pid=${pid}`)
  } catch (err) {
    console.log(`  杀 pid=${pid} 失败：${err.message}`)
  }
}

console.log(`  观察 ${OBSERVE_MS}ms，让潜在回路自己暴露…`)
await sleep(OBSERVE_MS)

const after = logStats()
const dBytes = after.bytes - before.bytes
const dLines = after.lines - before.lines
const dDisposed = after.disposed - before.disposed
console.log(
  `  收尾：${after.bytes} 字节 / ${after.lines} 行 / disposed ${after.disposed} 条`
)
console.log(`  增长：${dBytes} 字节 / ${dLines} 行 / ${dDisposed} 条 disposed`)

check(
  `日志增长有界（<= ${BYTE_BUDGET / 1024}KB，实测 ${dBytes} 字节）`,
  dBytes <= BYTE_BUDGET,
  `实测 ${dBytes} 字节`
)
check(
  `disposed 错误有界（<= ${DISPOSED_BUDGET}，实测 ${dDisposed}）`,
  dDisposed <= DISPOSED_BUDGET,
  `实测 ${dDisposed} 条`
)

console.log(`\n通过 ${pass} · 失败 ${fail}`)
page.close()
process.exit(fail === 0 ? 0 : 1)
