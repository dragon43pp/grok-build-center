#!/usr/bin/env node
/**
 * 飞书设置面板的端到端判卷（CDP 驱动真机 UI）。
 *
 * 验的是**渲染进程到主进程这一整条线**：面板能不能出现、扫码按钮点下去
 * 二维码会不会出来、二维码里编的到底是不是飞书官方那个地址。
 * 单跑服务层判卷是验不出这些的 —— 中间隔着 preload、IPC 频道、React 挂载
 * 三道关，任何一道写错都表现为「点了没反应」。
 *
 * 前提：应用带 `--remote-debugging-port=<port>` 启动。
 * 用法：node tools/feishu_ui_check.mjs <port> <截图路径>
 *
 * ⚠️ **必须对一个隔离 userData 的实例跑**：
 *
 *   GBC_USER_DATA_DIR="$TEMP/gbc-grade-ud" \
 *     ./node_modules/electron/dist/electron.exe ./out/main/index.js --remote-debugging-port=9368
 *
 * 因为这套断言以「**从未绑定**」为起点（未绑定态、扫码按钮可点、二维码要出来）。
 * 拿用户真实 userData 起的实例一旦扫过码，`feishu.json` 里就有凭据，
 * 面板直接是「已连接」，于是 15 条会集体失败 —— 那不是缺陷，是判卷用错了对象。
 * 2026-09-30 实际踩过：用户已经扫码绑好了，我还拿他的实例去跑，白报一片红。
 *
 * 隔离实例和用户实例**可以共存**（userData 不同 = 单实例锁不同），
 * 但窗口会多一个，判完记得只关隔离那个（按端口找 pid，别按进程名全杀）。
 */

import { writeFileSync } from 'node:fs'

const port = Number(process.argv[2] || 9333)
const shotPath = process.argv[3] || 'feishu-ui.png'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 顶层 await 抛出来只会得到 Node 那句「unsettled top-level await」，
// 真正的原因全被吞掉。这里把它捞出来，让失败可诊断。
process.on('unhandledRejection', (err) => {
  console.error(`\n判卷中断：${err?.message || err}`)
  process.exit(1)
})

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

async function findPages(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`)
      const list = await res.json()
      const pages = list.filter(
        (t) => t.type === 'page' && !t.url.startsWith('devtools://') && t.webSocketDebuggerUrl
      )
      if (pages.length) return pages
      lastErr = `只有 ${list.length} 个 target`
    } catch (err) {
      lastErr = String(err?.message || err)
    }
    await sleep(600)
  }
  throw new Error(`等不到可驱动的页面（${lastErr}）`)
}

let ws = null
let page = null
let seq = 0
const pending = new Map()
const SEND_TIMEOUT_MS = 15_000

/** 把回复分发给等待中的 promise。必须在发第一条命令**之前**挂上。 */
function attachMessageHandler(socket) {
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

async function connect() {
  // 不能只试一轮：应用冷启动要 20-30 秒，期间 target 已经在 /json 里了，
  // 但 renderer 还没准备好答话。整轮失败要重来，而不是直接判死。
  const deadline = Date.now() + 90_000
  let lastErr = 'no candidate'
  while (Date.now() < deadline) {
    let candidates = []
    try {
      candidates = await findPages(Math.max(1000, deadline - Date.now()))
    } catch (err) {
      lastErr = String(err?.message || err)
      await sleep(1000)
      continue
    }
    for (const candidate of candidates) {
      const socket = new WebSocket(candidate.webSocketDebuggerUrl)
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000)
          socket.addEventListener(
            'open',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true }
          )
          socket.addEventListener(
            'error',
            (err) => {
              clearTimeout(timer)
              reject(err)
            },
            { once: true }
          )
        })
        ws = socket
        attachMessageHandler(socket)
        // 连上不等于活着：renderer 已死的 target 收得下连接但永远不回话。
        // 先探一针；探不通就换下一个 / 等下一轮。
        await send('Runtime.evaluate', { expression: '1', returnByValue: true })
        page = candidate
        return
      } catch (err) {
        lastErr = String(err?.message || err)
        try {
          socket.close()
        } catch {
          // 已经断开就算了
        }
        ws = null
      }
    }
    await sleep(1000)
  }
  throw new Error(`所有 target 都不可驱动（${lastErr}）`)
}

await connect()
console.log(`页面: ${page.title || '(无标题)'}  ${page.url}`)
console.log(`WS: ${page.webSocketDebuggerUrl}`)

/**
 * 发一条 CDP 命令。
 *
 * 必须有超时：target 还挂在 /json 列表里、但 renderer 已经死掉时（重载/崩溃后
 * 最容易出现），WebSocket 连得上，命令却永远不会回。早先没超时，脚本就那样
 * 干等 6 分钟才被外层掐掉，报出来的是「unsettled top-level await」——
 * 离真正的原因十万八千里。
 */
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} 超时 ${SEND_TIMEOUT_MS}ms（target 可能已死）`))
    }, SEND_TIMEOUT_MS)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise
  })
  if (r.result?.exceptionDetails) {
    return 'ERR: ' + (r.result.exceptionDetails.exception?.description || 'unknown')
  }
  return r.result?.result?.value
}

/** 等某个选择器出现，返回它是否出现过。 */
async function waitForSelector(selector, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
    if (found === true) return true
    await sleep(300)
  }
  return false
}

async function click(selector) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing'
    el.click()
    return 'clicked'
  })()`)
}

await send('Runtime.enable')
await sleep(2500)

console.log('\n飞书设置面板 · 真机判卷')

// 0. 一次性 userData 会带出首次运行引导，先把它点掉 —— 它盖在整页上，
//    不关掉的话后面所有 click 都会打在遮罩上（表现是「元素存在但点不动」）。
const onboarding = await evaluate(`!!document.querySelector('[data-testid=first-run-onboarding]')`)
if (onboarding === true) {
  console.log('  \u25CB 检测到首次运行引导，先关掉')
  await click('[data-testid=onboarding-complete]')
  const gone = await evaluate(
    `!document.querySelector('[data-testid=first-run-onboarding]')`
  )
  check('能关掉首次运行引导', gone === true)
  await sleep(800)
}

// 1. ★ 一级入口：飞书必须**在首页标题栏就能看见**。
//    藏在设置的第七个分类里等于没有 —— 这是本产品的主线功能，
//    「把这台电脑的 AI 会话接到飞书」，用户第一眼就该看到它。
const entry = await evaluate(`(() => {
  const b = document.querySelector('[data-testid=titlebar-feishu]')
  if (!b) return null
  const r = b.getBoundingClientRect()
  return {
    w: Math.round(r.width),
    h: Math.round(r.height),
    phase: b.dataset.feishuPhase ?? null,
    label: (b.textContent || '').trim()
  }
})()`)
check(
  '首页标题栏就有飞书入口',
  Boolean(entry && entry.w > 0 && entry.h > 0),
  JSON.stringify(entry)
)
check(
  '入口带状态标识（不看设置也知道连没连上）',
  Boolean(entry?.phase),
  JSON.stringify(entry)
)

// 2. 点这个入口要**直接落在飞书分类**上，而不是落在设置第一项让人再找一遍
await click('[data-testid=titlebar-feishu]')
const navOk = await waitForSelector('[data-testid=settings-nav]', 15_000)
check('能打开设置页', navOk)
const deepLink = await waitForSelector('[data-testid=settings-feishu]', 8_000)
check('点标题栏飞书直接落在飞书分类（深链）', deepLink)

// 3. 导航里也要有这一项 —— 同时验了 SETTINGS_CATEGORIES 和 5 个语种的 sections 都补上了
const feishuNav = await click('[data-testid=settings-category-feishu]')
check('导航里有「飞书」这一项', feishuNav === 'clicked', feishuNav)
const panelOk = await waitForSelector('[data-testid=settings-feishu]', 15_000)
check('飞书面板挂载成功（IPC 通）', panelOk)

// 判卷必须自己把状态归零。面板停在「扫码中」时**没有扫码按钮**，
// 直接往下跑会误报两条失败（未绑定态 / 扫码按钮可点）——
// 这个坑本轮实际踩过一次，别指望外部先手工清场。
const prePhase = await evaluate(
  `(document.querySelector('[data-testid=settings-feishu-status]')||{dataset:{}}).dataset?.feishuPhase || ''`
)
if (prePhase === 'scanning') {
  console.log('  \u25CB 上一轮扫码还挂着，先取消（判卷自愈）')
  await click('[data-testid=settings-feishu-scan-cancel]')
  await waitForSelector('[data-testid=settings-feishu-scan]', 8_000)
}

const initial = await evaluate(`(() => {
  const el = document.querySelector('[data-testid=settings-feishu-status]')
  return el ? { text: el.textContent, phase: el.dataset.feishuPhase } : null
})()`)
check('拿到了初始状态快照', Boolean(initial), JSON.stringify(initial))
check(
  '未绑定时状态是 unbound',
  initial?.phase === 'unbound' || initial?.phase === 'connecting',
  String(initial?.phase)
)
check('未绑定时不显示 appId', !String(initial?.text ?? '').includes('cli_'), String(initial?.text))

// 3. 点扫码
const scanClicked = await click('[data-testid=settings-feishu-scan]')
check('扫码按钮可点', scanClicked === 'clicked', scanClicked)

const qrOk = await waitForSelector('[data-testid=settings-feishu-qr]', 25_000)
const qrUrl = qrOk
  ? await evaluate(`document.querySelector('[data-testid=settings-feishu-qr]').dataset.qrUrl`)
  : ''
check('二维码渲染出来了', qrOk)
check('二维码里编的是飞书官方地址', String(qrUrl).startsWith('https://open.feishu.cn/page/launcher'), String(qrUrl).slice(0, 80))

let qrParams = null
try {
  qrParams = new URL(String(qrUrl)).searchParams
} catch {
  qrParams = null
}
check('带 createOnly=true（不绑已有应用）', qrParams?.get('createOnly') === 'true')
check('带 source 标识', qrParams?.get('source') === 'grok-build-center', String(qrParams?.get('source')))
check('带已编码的 addons', (qrParams?.get('addons')?.length ?? 0) > 40)

// ★ 回归：二维码必须**真的画出来**。
// 早先这里只断言「元素存在」（waitForSelector），而 uqr 出的 SVG **只有 viewBox、
// 没有 width/height 属性** —— 不给它定尺寸就塌成 0×0。外层容器因为 padding 还有
// 约 10×10 的盒子，于是「元素存在、尺寸非零」，判卷一路绿灯，用户屏幕上却是一片空白。
// 所以这里量的是 **SVG 的渲染尺寸**，不是元素的存在性。
const qrBox = await evaluate(`(() => {
  const el = document.querySelector('[data-testid=settings-feishu-qr]')
  if (!el) return null
  const svg = el.querySelector('svg')
  const r = el.getBoundingClientRect()
  const sr = svg ? svg.getBoundingClientRect() : null
  return {
    box: [Math.round(r.width), Math.round(r.height)],
    svg: sr ? [Math.round(sr.width), Math.round(sr.height)] : null,
    viewBox: svg ? svg.getAttribute('viewBox') : null
  }
})()`)
const svgW = qrBox?.svg?.[0] ?? 0
const svgH = qrBox?.svg?.[1] ?? 0
check(
  '二维码有可见尺寸（不是塌成 0×0）',
  svgW >= 120 && svgH >= 120,
  JSON.stringify(qrBox)
)
check('二维码接近正方形', Math.abs(svgW - svgH) <= 4, JSON.stringify(qrBox?.svg))
check('二维码有 viewBox（尺寸由 CSS 给，不是 SVG 自带）', Boolean(qrBox?.viewBox), String(qrBox?.viewBox))

const phases = await evaluate(`(() => {
  const el = document.querySelector('[data-testid=settings-feishu-status]')
  return el ? el.dataset.feishuPhase : null
})()`)
check('phase 切到 scanning', phases === 'scanning', String(phases))

const expiresText = await evaluate(
  `(document.querySelector('[data-testid=settings-feishu-scan-expires]') || {}).textContent || ''`
)
check('显示了倒计时', /\d/.test(String(expiresText)), String(expiresText))

const closeVisible = await evaluate(
  `!!document.querySelector('[data-testid=settings-feishu-scan-cancel]')`
)
check('扫码中有取消按钮', closeVisible === true)

// 回归：扫码还没完成时，「已授权」那块不能提前冒出来。
// 早先 UI 拿 `phase !== 'unbound'` 当「已绑定」，于是二维码刚出来就显示
// 「已授权 0 个账号 · 还没有授权任何飞书账号」，看着像出了问题。
const pairedShownWhileScanning = await evaluate(
  `!!document.querySelector('[data-testid=settings-feishu-paired-count]')`
)
check('扫码中不显示准入名单（bound 才是判据）', pairedShownWhileScanning === false)

// 4. 收尾：取消掉，别把进程里的轮询会话留着
await click('[data-testid=settings-feishu-scan-cancel]')
const backToIdle = await waitForSelector('[data-testid=settings-feishu-scan]', 8_000)
const afterCancel = await evaluate(
  `(document.querySelector('[data-testid=settings-feishu-status]') || {}).dataset?.feishuPhase || ''`
)
check('取消后回到未绑定', backToIdle && afterCancel === 'unbound', String(afterCancel))
const qrGone = await evaluate(`!document.querySelector('[data-testid=settings-feishu-qr]')`)
check('取消后二维码消失', qrGone === true)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (shot.result?.data) {
  writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'))
  console.log(`\n已写入 ${shotPath}`)
}

console.log(`\n通过 ${pass} · 失败 ${fail}`)
ws.close()
process.exit(fail === 0 ? 0 : 1)
