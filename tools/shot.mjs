#!/usr/bin/env node
/**
 * 通过 CDP 给运行中的窗口截图。
 *
 * 为什么不用系统截屏：CDP 拿的是渲染器真实输出，不受窗口遮挡、置顶、DPI 缩放影响，
 * 也不用把窗口抢到前台打扰用户。
 *
 * 前提：应用启动时带 `--remote-debugging-port=<port>`。
 *
 * 用法：node tools/shot.mjs [输出路径] [端口] [等待毫秒] [截图前执行的 JS]
 *
 * 第 4 个参数用来先导航再拍，例如点侧栏按钮进「会话历史」页：
 *   node tools/shot.mjs out.png 9333 20000 "document.querySelector('[data-testid=rail-sessions]').click()"
 */
import { writeFileSync } from 'node:fs'

const out = process.argv[2] || 'shot.png'
const port = Number(process.argv[3] || 9333)
const waitMs = Number(process.argv[4] || 15000)
const preShot = process.argv[5] || ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage() {
  const deadline = Date.now() + waitMs
  let lastErr = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`)
      const list = await res.json()
      const pages = list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
      // 多于一个 page target 时必须说清楚 —— 悬浮窗、远程 surface 都是独立窗口，
      // 挑错了就会「点了 A 窗、拍了 B 窗」，表现是截图和日志互相矛盾。
      if (pages.length > 1) {
        console.log(`⚠️ 有 ${pages.length} 个 page target，取第一个：`)
        for (const p of pages) console.log(`   - ${p.title || '(无标题)'}  ${p.url}`)
      }
      const page = pages[0]
      if (page?.webSocketDebuggerUrl) return page
      lastErr = `只有 ${list.length} 个 target，没有 page`
    } catch (err) {
      lastErr = String(err?.message || err)
    }
    await sleep(600)
  }
  throw new Error(`等不到可截图的页面（${lastErr}）`)
}

const page = await findPage()
console.log(`页面: ${page.title || '(无标题)'}  ${page.url}`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.result?.exceptionDetails) {
    return 'ERR: ' + (r.result.exceptionDetails.exception?.description || 'unknown')
  }
  return r.result?.result?.value
}

// 页面稳定下来再拍：等字体与首屏渲染完成
await send('Runtime.enable')
await evaluate('document.fonts && document.fonts.ready')
await sleep(2500)

const info = {
  title: await evaluate('document.title'),
  bodySize: await evaluate('document.body ? document.body.innerText.length : -1'),
  sample: await evaluate('(document.body ? document.body.innerText : "").slice(0, 300)')
}
console.log('标题:', info.title)
console.log('正文长度:', info.bodySize)

if (preShot) {
  // awaitPromise：前置脚本常要「点一下、等一会儿、再点一下」，得能返回 Promise。
  console.log('抓拍前页面:', await evaluate('location.href + "  hash=" + location.hash'))
  const result = await evaluate(`(async () => { ${preShot} })()`, true)
  console.log('前置脚本:', result === undefined ? '(已执行)' : result)
  await sleep(6000)
  const after = await evaluate('(document.body ? document.body.innerText : "").slice(0, 400)')
  console.log('导航后正文前 400 字:\n' + String(after).split('\n').map((l) => '  ' + l).join('\n'))
} else {
  console.log('正文前 300 字:\n' + String(info.sample).split('\n').map((l) => '  ' + l).join('\n'))
}

// 落盘前再报一次当前页面：截图和日志必须指向同一个页面，否则排查时全是猜。
console.log('抓拍页面:', await evaluate('location.href + "  hash=" + location.hash'))
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
const data = shot.result?.data
if (!data) {
  console.error('截图失败:', JSON.stringify(shot).slice(0, 400))
  process.exit(1)
}
writeFileSync(out, Buffer.from(data, 'base64'))
console.log(`已写入 ${out}  (${Buffer.from(data, 'base64').length} 字节)`)
ws.close()
