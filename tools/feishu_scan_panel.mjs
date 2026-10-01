#!/usr/bin/env node
/**
 * 把应用里那张飞书扫码二维码，搬到一个能直接扫的 HTML 面板上。
 *
 * ## 为什么需要这个（别删）
 *
 * 从 Agent 这边拉起的 GUI 进程**到不了用户的真实桌面**（进程树挂在会话 Job 上，
 * 调用一结束就被回收）。所以「窗口已经开了，你去点设置里的扫码」这句话是无效交付 ——
 * 用户根本看不见那个窗口。做法只能是：把二维码从应用里读出来，渲染成一个
 * 自包含的 HTML，用 present_files 推到用户眼前。
 *
 * ## 三条纪律
 *
 * 1. **读的是活票据**。二维码地址来自运行中应用的 `data-qr-url`（未经渲染的原始 URL），
 *    不是自己拼的。扫码后是**那个应用**在轮询、在存凭据、在建长连接 ——
 *    所以必须保证应用还在跑，否则扫了也没人接。
 * 2. **倒计时也读真的**。有效期从面板上的文字里解出来（`二维码还有 N 秒过期`），
 *    自己估会偏。
 * 3. **不含任何外部依赖**。uqr 出 SVG 字符串直接 inline，不引 CDN、不引字体，
 *    面板过期前一直是活的。
 *
 * 用法：node tools/feishu_scan_panel.mjs <port> <outHtmlPath> [--json]
 *   <port>        应用启动时的 --remote-debugging-port
 *   <outHtmlPath> 输出 HTML 路径（推荐放 artifacts/ 下，见下）
 *   --json        只打印读到的票据，不写 HTML
 *
 * ⚠️ 输出位置：`artifacts/` 在 package.json 的 build.files 里被显式排除
 * （`!artifacts` 前缀那一条），放这里不会被打包时的 files 通配打进 asar。
 * 别放进项目根目录当一次性文件用。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { renderSVG } from 'uqr'

const port = Number(process.argv[2])
const outPath = process.argv[3]
const jsonOnly = process.argv.includes('--json')
if (!port) {
  console.error('用法: node tools/feishu_scan_panel.mjs <port> <outHtmlPath> [--json]')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SEND_TIMEOUT_MS = 12_000

let seq = 0
const pending = new Map()
let ws = null

function attach(socket) {
  socket.addEventListener('message', (ev) => {
    let msg = null
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg?.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} 超时`))
    }, SEND_TIMEOUT_MS)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.result?.exceptionDetails) {
    throw new Error(
      '表达式抛错: ' + (r.result.exceptionDetails.exception?.description || '?')
    )
  }
  return r.result?.result?.value
}

/** 连上并确认能答话（target 还在 /json 里但 renderer 已死时，连得上但永不回话）。 */
async function connect(deadlineMs = 60_000) {
  const deadline = Date.now() + deadlineMs
  let lastErr = 'no target'
  while (Date.now() < deadline) {
    let list = []
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
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
    const socket = new WebSocket(candidate.webSocketDebuggerUrl)
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS 连接超时')), 8000)
        socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
        socket.addEventListener('error', (e) => { clearTimeout(timer); reject(e) }, { once: true })
      })
      ws = socket
      attach(socket)
      await send('Runtime.evaluate', { expression: '1', returnByValue: true })
      return
    } catch (err) {
      lastErr = String(err?.message || err)
      ws = null
      try { socket.close() } catch { /* 已断 */ }
      await sleep(800)
    }
  }
  throw new Error(`连不上端口 ${port} 上的应用（${lastErr}）`)
}

await connect()

// 首启引导会盖在整页上，点击会打在遮罩上
if ((await evaluate(`!!document.querySelector('[data-testid=first-run-onboarding]')`)) === true) {
  await evaluate(`document.querySelector('[data-testid=onboarding-complete]').click()`)
  await sleep(900)
}

// 进设置 → 飞书
if (!(await evaluate(`!!document.querySelector('[data-testid=settings-feishu]')`))) {
  await evaluate(`document.querySelector('[data-testid=titlebar-settings]').click()`)
  await sleep(1800)
  await evaluate(`document.querySelector('[data-testid=settings-category-feishu]').click()`)
  await sleep(2500)
}

// 还没在扫码就点一下
if (!(await evaluate(`!!document.querySelector('[data-testid=settings-feishu-qr]')`))) {
  await evaluate(`document.querySelector('[data-testid=settings-feishu-scan]').click()`)
  await sleep(4000)
}

const ticket = await evaluate(`(() => {
  const qr = document.querySelector('[data-testid=settings-feishu-qr]')
  const st = document.querySelector('[data-testid=settings-feishu-status]')
  const ex = document.querySelector('[data-testid=settings-feishu-scan-expires]')
  return {
    url: qr ? qr.dataset.qrUrl : null,
    scanning: !!qr,
    phase: st ? st.dataset.feishuPhase : null,
    expiresText: ex ? ex.textContent : null
  }
})()`)

if (!ticket?.url) {
  console.error(`应用里没有可用的二维码（phase=${ticket?.phase}）。`)
  console.error('可能是上一次的扫码还没取消、或者生成失败了 —— 去设置页看那行错误提示。')
  process.exit(1)
}

const secondsLeft = Number(/二维码还有\s*(\d+)\s*秒/.exec(ticket.expiresText || '')?.[1] || 0)

if (jsonOnly) {
  console.log(JSON.stringify({ ...ticket, secondsLeft, expiresAt: Date.now() + secondsLeft * 1000 }, null, 2))
  process.exit(0)
}

const svg = renderSVG(ticket.url, {
  pixelSize: 5,
  border: 4,
  whiteColor: '#ffffff',
  blackColor: '#111111'
})

const expiresAt = Date.now() + secondsLeft * 1000
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>飞书扫码连接 · Grok Build Center</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 20px 40px;
    font: 14px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    background: #f6f7f9; color: #1f2328;
    display: flex; justify-content: center;
  }
  .card { width: 100%; max-width: 560px; }
  h1 { font-size: 19px; margin: 0 0 4px; letter-spacing: .2px; }
  .sub { color: #6b7280; font-size: 13px; margin: 0 0 22px; }
  .qrbox {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 14px;
    padding: 20px; display: flex; flex-direction: column; align-items: center;
    box-shadow: 0 1px 2px rgba(16,24,40,.04);
  }
  .qrbox svg { display: block; width: 260px; height: 260px; }
  .count {
    margin-top: 14px; font-variant-numeric: tabular-nums;
    font-size: 13px; color: #6b7280;
  }
  .count b { color: #1f2328; font-weight: 600; }
  .count.warn b { color: #b42318; }
  h2 { font-size: 13px; margin: 26px 0 8px; color: #374151; letter-spacing: .2px; }
  ol, ul { margin: 0; padding-left: 20px; }
  li { margin: 0 0 7px; }
  code {
    background: #eef1f4; border-radius: 4px; padding: 1px 5px;
    font: 12px/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  .url {
    margin-top: 8px; word-break: break-all;
    font: 12px/1.6 ui-monospace, "Cascadia Mono", Consolas, monospace;
    color: #4b5563; background: #fff; border: 1px solid #e5e7eb;
    border-radius: 8px; padding: 10px 12px;
  }
  .note {
    margin-top: 24px; padding: 13px 15px; border-radius: 10px;
    background: #fffbeb; border: 1px solid #fde68a; color: #7c4a03;
  }
  .note b { color: #78350f; }
  .muted { color: #6b7280; font-size: 12.5px; margin-top: 6px; }
</style>
</head>
<body>
<div class="card">
  <h1>用飞书扫码连接</h1>
  <p class="sub">扫完就在你的飞书里建好这个应用，本机随之建立长连接。</p>

  <div class="qrbox">
    ${svg}
    <div class="count" id="count"></div>
  </div>

  <h2>怎么扫</h2>
  <ol>
    <li>打开<b>手机飞书</b>，用扫一扫 / 相机扫上面这个码。</li>
    <li>会跳到确认页 —— 这是<b>新建</b>一个应用（<code>createOnly=true</code>），不会碰到你已有的应用。</li>
    <li>确认后本机会自动存下凭据、建长连接。设置页的「连接」会变成<b>已连接</b>。</li>
  </ol>

  <h2>扫码页上的地址（桌面上可直接点）</h2>
  <div class="url">${ticket.url.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>

  <div class="note">
    <b>现在扫完，发消息不会有回复。</b>
    <div class="muted" style="color:#8a5a12">
      这一步做到的是「绑定 + 长连接」——也就是你问的「扫哪里」。但把消息变成动作的
      应答逻辑（<code>electron/feishu/router.ts</code>）还没写，所以给机器人发消息
      目前只会更新「最近事件」心跳，不会有应答。
    </div>
  </div>
</div>

<script>
  var expiresAt = ${expiresAt};
  var el = document.getElementById('count');
  function tick() {
    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    var m = Math.floor(left / 60), s = left % 60;
    el.className = 'count' + (left < 120 ? ' warn' : '');
    el.innerHTML = left > 0
      ? '二维码有效期还剩 <b>' + m + ' 分 ' + String(s).padStart(2, '0') + ' 秒</b>'
      : '<b>二维码已过期</b> —— 让助手重新生成一张';
  }
  tick();
  setInterval(tick, 1000);
</script>
</body>
</html>
`

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, html, 'utf8')

console.log(`phase=${ticket.phase} 剩余=${secondsLeft}s`)
console.log(`二维码地址: ${ticket.url.slice(0, 120)}...`)
console.log(`已写入 ${outPath}`)
process.exit(0)
