/**
 * 飞书入站路由的离线判卷：/帮助 /列表 /继续 /会话 /发 + 卡片按钮 + 准入。
 *
 * 不碰网络、不碰 Electron。重点盯：
 *   1. 安全：非配对人、非单聊一律沉默（sendTo 一次都不能被调）；
 *   2. 序号靠缓存：没拉过列表就 /继续，必须提示而不是瞎开；
 *   3. 错误折成给用户的人话，路由本体绝不抛错；
 *   4. 卡片按钮的 value 形状和消息指令走同一条操作路径。
 *
 * 跑法：
 *   node_modules/.bin/esbuild tools/feishu_router_check.ts --bundle \
 *     --platform=node --format=esm --outfile=tools/_feishu_router_check.mjs \
 *     && node tools/_feishu_router_check.mjs
 */

import type { BridgeHistorySession, BridgeResumeResult, BridgeSessionInfo } from '../shared/bridge-protocol'
import type { FeishuInboundCardAction, FeishuInboundMessage } from '../electron/feishu/channel'
import { parseCommand, createFeishuRouter } from '../electron/feishu/router'
import { planResume } from '../shared/session-resume'

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

// ------------------------------------------------------------------ 解析

{
  check('/帮助', parseCommand('/帮助').cmd === 'help')
  check('/help', parseCommand('/help').cmd === 'help')
  check('/列表', parseCommand('/列表').cmd === 'list')
  check('/会话', parseCommand('/会话').cmd === 'active')
  check('/继续 3', (() => { const c = parseCommand('/继续 3'); return c.cmd === 'resume' && c.n === 3 && !c.text })())
  check(
    '/继续 1 继续干活 → resume 带话',
    (() => {
      const c = parseCommand('/继续 1 继续干活')
      return c.cmd === 'resume' && c.n === 1 && c.text === '继续干活'
    })()
  )
  check('/发 2 你好 世界', (() => {
    const c = parseCommand('/发 2 你好 世界')
    return c.cmd === 'send' && c.n === 2 && c.text === '你好 世界'
  })())
  check('前导空格容忍', parseCommand('  /列表  ').cmd === 'list')
  check('/继续 没序号 → unknown', parseCommand('/继续').cmd === 'unknown')
  check('/发 2 没正文 → unknown', parseCommand('/发 2').cmd === 'unknown')
  check('不是斜杠开头 → unknown', parseCommand('你好').cmd === 'unknown')
  check('/瞎写 → unknown', parseCommand('/瞎写').cmd === 'unknown')
  check('/继续 0 → unknown', parseCommand('/继续 0').cmd === 'unknown')
}

// ------------------------------------------------------------------ 假件

function makeSession(overrides: Partial<BridgeHistorySession> = {}): BridgeHistorySession {
  return {
    agent: 'grok',
    sessionId: 'ses-1',
    title: '造书成剧 · 首页改版',
    workspace: 'D:/wx/造书成剧',
    updatedAt: '2026-10-01T08:00:00.000Z',
    messageCount: 42,
    resumable: true,
    ...overrides
  }
}

const resumeResult: BridgeResumeResult = {
  historySessionId: 'ses-1',
  agent: 'grok',
  workspace: 'D:/wx/造书成剧',
  installationId: 'inst-1',
  args: ['--resume', 'ses-1'],
  dryRun: false,
  terminalId: 'term-1',
  sessionId: 'live-1'
}

interface Deps {
  historyImpl?: () => Promise<BridgeHistorySession[]>
  listActiveImpl?: () => Promise<BridgeSessionInfo[]>
  resumeImpl?: (sessionId: string, agent?: string) => Promise<BridgeResumeResult>
  sendImpl?: (sessionId: string, text: string, agent?: string) => Promise<{ accepted: true; mode: string }>
  paired?: string[]
  /** 带话恢复的轮询参数（判卷用小值）。 */
  pollIntervalMs?: number
  pollTimeoutMs?: number
  /** 第 N 次 listActive 之后终端才算就绪（模拟 CLI 启动耗时）。 */
  listReadyAfterCalls?: number
}

function makeFixture(deps: Deps = {}) {
  const sent: Array<{ openId: string; message: Record<string, unknown> }> = []
  const calls = { history: 0, listActive: 0, resume: 0, send: 0 }
  const resumeArgs: Array<{ sid: string; agent?: string; model?: string }> = []
  const router = createFeishuRouter({
    history: async () => {
      calls.history += 1
      return deps.historyImpl
        ? deps.historyImpl()
        : Promise.resolve([
            makeSession({ sessionId: 'ses-1' }),
            makeSession({ sessionId: 'ses-2', agent: 'codex', title: 'hrack 排查' })
          ])
    },
    listActive: async () => {
      calls.listActive += 1
      if (deps.listActiveImpl) return deps.listActiveImpl()
      return Promise.resolve([
        {
          sessionId: 'live-1',
          terminalId: 't1',
          name: '造书成剧 · 首页改版',
          status: 'idle',
          workspace: 'D:/wx/造书成剧',
          installationId: 'inst-1',
          runtime: 'pty',
          pendingAttentionCount: 0,
          adapterId: 'grok',
          // 模拟 CLI 启动：第 N 次轮询之后终端才画出界面（ready）。
          ready: calls.listActive > (deps.listReadyAfterCalls ?? 0)
        } as BridgeSessionInfo
      ])
    },
    resume: async (sessionId, agent, model) => {
      calls.resume += 1
      resumeArgs.push({ sid: sessionId, agent, model })
      if (deps.resumeImpl) return deps.resumeImpl(sessionId, agent)
      return { ...resumeResult, historySessionId: sessionId }
    },
    getModels: (agent: string) => (agent === 'grok' ? ['grok-4.7', 'x-460b'] : []),
    send: async (sessionId, text, agent) => {
      calls.send += 1
      if (deps.sendImpl) return deps.sendImpl(sessionId, text, agent)
      void agent
      return { accepted: true, mode: 'control' }
    },
    sendTo: async (openId, message) => {
      sent.push({ openId, message: message as Record<string, unknown> })
    },
    isPaired: (openId) => (deps.paired ?? ['ou_me']).includes(openId),
    pollIntervalMs: deps.pollIntervalMs,
    pollTimeoutMs: deps.pollTimeoutMs
  })

  const message = (overrides: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage => ({
    openId: 'ou_me',
    chatId: 'oc_chat',
    messageId: 'om_1',
    chatType: 'p2p',
    messageType: 'text',
    text: '/帮助',
    receivedAt: Date.now(),
    ...overrides
  })
  const cardAction = (value: Record<string, unknown>): FeishuInboundCardAction => ({
    openId: 'ou_me',
    chatId: 'oc_chat',
    messageId: 'om_1',
    actionTag: 'button',
    value,
    receivedAt: Date.now()
  })
  const lastText = (): string => {
    const last = sent[sent.length - 1]
    const message = last?.message as { text?: string }
    return message?.text ?? ''
  }
  const lastCard = (): Record<string, unknown> => {
    const last = sent[sent.length - 1]
    return (last?.message as { card?: Record<string, unknown> }).card ?? {}
  }
  return { router, sent, calls, resumeArgs, message, cardAction, lastText, lastCard }
}

// ------------------------------------------------------------------ 安全

{
  const { router, sent, message } = makeFixture({ paired: ['ou_other'] })
  await router.onMessage(message({ text: '/帮助' }))
  check('非配对人：一条消息都不回', sent.length === 0, String(sent.length))
  await router.onMessage(message({ openId: 'ou_me', chatType: 'group', text: '/帮助' }))
  check('群聊：不回', sent.length === 0, String(sent.length))
  const toast = await router.onCardAction(makeCardActionFor({ cmd: 'resume', sid: 'x' }, 'ou_stranger'))
  check('非配对人点按钮：无响应', toast === undefined)
}

function makeCardActionFor(value: Record<string, unknown>, openId = 'ou_me'): FeishuInboundCardAction {
  return {
    openId,
    chatId: 'oc',
    messageId: 'om',
    actionTag: 'button',
    value,
    receivedAt: Date.now()
  }
}

// ------------------------------------------------------------------ 基本流

{
  const { router, sent, message, lastCard, lastText } = makeFixture()

  await router.onMessage(message({ text: '/帮助' }))
  const card = lastCard()
  const header = (card as { header?: { title?: { content?: string } } }).header
  check('/帮助 回的是卡片', Boolean(header?.title?.content))
  check('/帮助 卡里写了 /列表', JSON.stringify(card).includes('/列表'))

  await router.onMessage(message({ text: '/列表' }))
  const listCard = lastCard() as {
    header?: { title?: { content?: string } }
    elements?: Array<{ tag?: string; actions?: Array<{ value?: Record<string, unknown> }> }>
  }
  check('/列表 卡片头带数量', listCard.header?.title?.content?.includes('2') === true)
  const buttons = listCard.elements?.flatMap((el) => el.actions ?? []) ?? []
  check('/列表 有两个序号按钮', buttons.length === 2, String(buttons.length))
  check(
    '按钮 value 带 sid+agent+title',
    buttons[0]?.value?.['sid'] === 'ses-1' &&
      buttons[0]?.value?.['agent'] === 'grok' &&
      typeof buttons[0]?.value?.['title'] === 'string'
  )

  await router.onMessage(message({ text: '/继续 2' }))
  check('/继续 2 回复带 ✅', lastText().includes('✅'), lastText())
  check('/继续 2 回复带目录', lastText().includes('D:/wx/造书成剧'))

  await router.onMessage(message({ text: '/会话' }))
  const activeText = lastText()
  check('/会话 列出开着的会话', activeText.includes('造书成剧'), activeText)
  check('/会话 状态翻成人话', activeText.includes('空闲'))

  await router.onMessage(message({ text: '/发 1 帮我把首页按钮改大一点' }))
  check('/发 回复 ✅', lastText().includes('✅'), lastText())
}

// ------------------------------------------------------------------ 序号与缓存

{
  const { router, message, lastText } = makeFixture()
  await router.onMessage(message({ text: '/继续 1' }))
  check('没拉过列表就 /继续：提示先 /列表', lastText().includes('/列表'), lastText())

  await router.onMessage(message({ text: '/会话' }))
  await router.onMessage(message({ text: '/发 1 你好' }))
  check('先 /会话 再 /发：通', lastText().includes('✅'))

  await router.onMessage(message({ text: '/列表' }))
  await router.onMessage(message({ text: '/继续 99' }))
  check('序号越界：范围提示', lastText().includes('1-2'), lastText())
}

// ------------------------------------------------------------------ 错误折人话

{
  const { router, message, lastText } = makeFixture({
    resumeImpl: async () => {
      throw new Error('原目录不可用（D:/gone）：目录不存在')
    },
    sendImpl: async () => {
      throw new Error('Cannot send while session is working')
    }
  })
  await router.onMessage(message({ text: '/列表' }))
  await router.onMessage(message({ text: '/继续 1' }))
  check('resume 失败：❌ + 原因', lastText().includes('❌') && lastText().includes('原目录不可用'), lastText())

  await router.onMessage(message({ text: '/会话' }))
  await router.onMessage(message({ text: '/发 1 hi' }))
  check('send 失败（正忙）：❌ + 原因', lastText().includes('❌') && lastText().includes('working'), lastText())
}

// ------------------------------------------------------------------ 卡片按钮

{
  const { router, calls, sent, cardAction, lastText } = makeFixture()
  const toast = await router.onCardAction(
    cardAction({ cmd: 'resume', sid: 'ses-9', agent: 'grok', title: '测试会话' })
  )
  check('按钮恢复：resume 被调', calls.resume === 1, String(calls.resume))
  check(
    '按钮恢复：toast success',
    (toast as { toast?: { type?: string } })?.toast?.type === 'success'
  )
  check('按钮恢复：私聊也收到 ✅', lastText().includes('✅'))

  await router.onCardAction(cardAction({ cmd: 'list' }))
  check('按钮 list：发出列表卡', sent.some((item) => 'card' in item.message))

  const boom = makeFixture({
    resumeImpl: async () => {
      throw new Error('mock resume failure')
    }
  })
  const errToast = (await boom.router.onCardAction(
    boom.cardAction({ cmd: 'resume', sid: 'boom' })
  )) as { toast?: { type?: string; content?: string } }
  check(
    '按钮恢复失败：toast error 带原因',
    errToast?.toast?.type === 'error' &&
      errToast.toast.content?.includes('mock resume failure') === true,
    JSON.stringify(errToast)
  )

  const unknown = await router.onCardAction(cardAction({ cmd: 'mystery' }))
  check('未知按钮：不炸不回话', unknown === undefined)
}

// ------------------------------------------------------------------ 选模型两步流

{
  const { router, calls, resumeArgs, sent, cardAction, lastCard } = makeFixture()

  // 第一步：点列表里的序号 → 回模型选择卡
  const pickToast = await router.onCardAction(
    cardAction({ cmd: 'pick', sid: 'ses-1', agent: 'grok', title: '造书成剧' })
  ) as { toast?: { type?: string } }
  check('pick：不直接 resume', calls.resume === 0, String(calls.resume))
  check('pick：toast success', pickToast?.toast?.type === 'success')
  const picker = lastCard() as {
    header?: { title?: { content?: string } }
    elements?: Array<{ tag?: string; actions?: Array<{ value?: Record<string, unknown> }> }>
  }
  check('pick：卡片头是「选择模型」', picker.header?.title?.content?.includes('选择模型') === true)
  const pickerButtons =
    picker.elements?.flatMap((el) => el.actions ?? []) ?? []
  const models = pickerButtons
    .map((b) => b.value?.['model'])
    .filter((m): m is string => typeof m === 'string')
  check(
    'pick：模型来自 getModels（默认 + grok 清单）',
    models.length === 2 && models[0] === 'grok-4.7' && models[1] === 'x-460b',
    JSON.stringify(models)
  )

  // 第二步：点具体模型 → resume 带上 model
  await router.onCardAction(
    cardAction({ cmd: 'resume', sid: 'ses-1', agent: 'grok', title: '造书成剧', model: 'grok-4.7' })
  )
  check('选模型恢复：resume 收到 model', resumeArgs[0]?.model === 'grok-4.7')

  // claude 没配清单：只有「默认」，resume 不带 model
  const claudePick = makeFixture()
  await claudePick.router.onCardAction(
    claudePick.cardAction({ cmd: 'pick', sid: 'ses-3', agent: 'claude', title: 'x' })
  )
  const claudeCard = claudePick.lastCard() as {
    elements?: Array<{ tag?: string; actions?: Array<{ value?: Record<string, unknown> }> }>
  }
  const claudeButtons = claudeCard.elements?.flatMap((el) => el.actions ?? []) ?? []
  check(
    'claude：只有默认按钮',
    claudeButtons.length === 1 && claudeButtons[0]?.value?.['model'] === undefined,
    String(claudeButtons.length)
  )

  // planResume 拼参：模型追加 --model
  const plan = planResume(
    { ...makeSession(), id: 'ses-1' } as never,
    'sonnet'
  )
  check('planResume 带 model：args 追加 --model', JSON.stringify(plan).includes('sonnet'))
  const planNoModel = planResume({ ...makeSession(), id: 'ses-1' } as never)
  check('planResume 无 model：args 原样', !JSON.stringify(planNoModel).includes('--model'))
}

// ------------------------------------------------------------------ 带话恢复（/继续 n <第一句话>）

{
  const { router, calls, message, lastText } = makeFixture({
    pollIntervalMs: 10,
    pollTimeoutMs: 500,
    listReadyAfterCalls: 1 // 第一次轮询还没就绪，第二次起可以投喂
  })
  await router.onMessage(message({ text: '/列表' }))
  await router.onMessage(message({ text: '/继续 1 继续干活' }))
  check('带话恢复：CLI 就绪后自动投喂', lastText().includes('📨'), lastText())
  check('带话恢复：send 真的被调了', calls.send === 1, String(calls.send))
  check('带话恢复：投喂的就是那句话', lastText().includes('继续干活'), lastText())
}

{
  const { router, calls, message, lastText } = makeFixture({
    pollIntervalMs: 10,
    pollTimeoutMs: 150,
    listReadyAfterCalls: 9999 // 永远不就绪
  })
  await router.onMessage(message({ text: '/列表' }))
  await router.onMessage(message({ text: '/继续 1 开跑' }))
  check('CLI 一直没就绪：超时提示 ⚠️', lastText().includes('⚠️'), lastText())
  check('CLI 一直没就绪：绝不瞎投喂', calls.send === 0, String(calls.send))
}

// ------------------------------------------------------------------ /发 免拉取

{
  const { router, calls, message, lastText } = makeFixture()
  await router.onMessage(message({ text: '/发 1 你好' }))
  check('/发 免拉取：只有一场开着直接投喂', lastText().includes('✅') && calls.send === 1, lastText())
}
{
  const twoSessions = async (): Promise<BridgeSessionInfo[]> => [
    {
      sessionId: 'live-1',
      terminalId: 't1',
      name: '甲',
      status: 'idle',
      workspace: 'D:/a',
      installationId: 'inst-1',
      runtime: 'pty',
      pendingAttentionCount: 0,
      adapterId: 'grok'
    },
    {
      sessionId: 'live-2',
      terminalId: 't2',
      name: '乙',
      status: 'idle',
      workspace: 'D:/b',
      installationId: 'inst-1',
      runtime: 'pty',
      pendingAttentionCount: 0,
      adapterId: 'codex'
    }
  ]
  const { router, message, lastText } = makeFixture({ listActiveImpl: twoSessions })
  await router.onMessage(message({ text: '/发 1 你好' }))
  check('/发 多场：列出让人挑', lastText().includes('2 场'), lastText())
  await router.onMessage(message({ text: '/发 2 给乙的话' }))
  check('/发 多场：第二次按序号投喂', lastText().includes('乙'), lastText())
}

// ------------------------------------------------------------------ 路由本体绝不抛

{
  const { router, message, lastText } = makeFixture({
    historyImpl: async () => {
      throw new Error('disk scan failed')
    }
  })
  await router.onMessage(message({ text: '/列表' }))
  check('history 炸了：回复失败原因而不是沉默', lastText().length > 0, lastText())
  await router.onMessage(message({ text: '随便聊一句' }))
  check('普通闲聊：引导 /帮助', lastText().includes('/帮助'))
}

console.log(`\n通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
