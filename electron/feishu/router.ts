/**
 * 飞书入站路由 —— 「在飞书上继续会话」这一半。
 *
 * 出站（状态推送、多维表格、引导卡）在 `provision.ts`；这里管**入站**：
 * 机器人收到消息 / 卡片按钮被点，变成对会话的真实操作。
 *
 * ## 指令面（刻意小）
 *
 *   /列表            最近可恢复的历史会话（卡片，带按钮）
 *   /继续 <序号>      在电脑上打开那场会话 —— 手机做决定，电脑接着聊
 *   /打开            打开上次的国内 WorkBuddy 会话（不选模型、不投喂）
 *   /会话            现在开着的会话
 *   /发 <序号> <文字>  往开着的会话里投喂一句话
 *   /帮助            用法
 *
 * 「手机上替它跑完一整场」还做不到也不急着做：resume 是在电脑上开标签页，
 * 投喂只对已打开且空闲的会话生效。这是诚实的能力边界，不是偷懒。
 *
 * ## 安全
 *
 * 只应答 `pairedUsers` 名单里的人（`isPaired`），单聊之外一概忽略。
 * 名单是扫码时写死的，不存在「发条消息就能配对」的口子。
 *
 * ## 不抛错
 *
 * 入站回调抛错会被 SDK 吞掉或变成未处理拒绝 —— 全部折成给用户的
 * 一句人话回复。用户看到的永远不是沉默。
 */

import type {
  BridgeHistorySession,
  BridgeResumeResult,
  BridgeSessionInfo
} from '../../shared/bridge-protocol'
import type {
  FeishuInboundCardAction,
  FeishuInboundMessage,
  FeishuOutboundMessage
} from './channel'
import { cliOptionOf } from './bitable'

export interface FeishuRouterDeps {
  /** 磁盘上的历史会话（`sessions.history`）。 */
  history: () => Promise<BridgeHistorySession[]>
  /** 现在开着的会话（`sessions.list`）。 */
  listActive: () => Promise<BridgeSessionInfo[]>
  /**
   * 恢复一场历史会话（`session.resume`）—— 在电脑上开新标签页。
   * `model` 可选：给定时恢复命令带 `--model`（三个已收录 CLI 都实测有这面旗）。
   */
  resume: (
    sessionId: string,
    agent?: string,
    model?: string
  ) => Promise<BridgeResumeResult>
  /** 某个 CLI 可选的模型清单（「默认」之外的选择）。空数组 = 只有默认。 */
  getModels: (agent: string) => string[]
  /** 往开着的会话里发一句话（`session.send`）。 */
  send: (
    sessionId: string,
    text: string,
    agent?: string
  ) => Promise<{ accepted: true; mode: string }>
  /** 给单个用户回消息。失败只记日志，绝不往上抛。 */
  sendTo: (openId: string, message: FeishuOutboundMessage) => Promise<unknown>
  /** 准入名单判定。不在名单里的人发什么都不理。 */
  isPaired: (openId: string) => boolean
  /**
   * 打开上次的国内 WorkBuddy 会话。不走终端、不选模型、不投喂。
   * 没接上时 /打开 会说明，列表卡也不放这个按钮。
   */
  openLatestWorkbuddy?: () => Promise<{ ok: boolean; message: string }>
  /** 「恢复后自动投喂」的轮询节奏，判卷用小值。默认 3 秒一次、最多等 45 秒。 */
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

// ------------------------------------------------------------------ 指令解析

export type RouterCommand =
  | { cmd: 'help' }
  | { cmd: 'list' }
  | { cmd: 'active' }
  | { cmd: 'resume'; n: number; text?: string }
  | { cmd: 'send'; n: number; text: string }
  | { cmd: 'open-workbuddy' }
  | { cmd: 'unknown' }

export function parseCommand(rawText: string): RouterCommand {
  const text = rawText.trim()
  if (!text.startsWith('/')) return { cmd: 'unknown' }
  const parts = text.split(/\s+/)
  const word = parts[0]!.slice(1).toLowerCase()
  const n = Number(parts[1])
  const hasN = Number.isInteger(n) && n >= 1

  if (word === '帮助' || word === 'help') return { cmd: 'help' }
  if (word === '列表' || word === 'list') return { cmd: 'list' }
  if (word === '会话' || word === 'sessions') return { cmd: 'active' }
  if (word === '打开' || word === 'open') return { cmd: 'open-workbuddy' }
  if (word === '继续' || word === 'resume') {
    if (!hasN) return { cmd: 'unknown' }
    // 序号后面还跟着字 = 恢复之后把这句话自动投喂给 CLI（一步到位）。
    const body = parts.slice(2).join(' ').trim()
    return { cmd: 'resume', n, ...(body ? { text: body } : {}) }
  }
  if (word === '发' || word === 'send') {
    const body = parts.slice(2).join(' ').trim()
    if (!hasN || !body) return { cmd: 'unknown' }
    return { cmd: 'send', n, text: body }
  }
  return { cmd: 'unknown' }
}

// ------------------------------------------------------------------ 小工具

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `2026-10-01T08:15:00Z` → `10-01 16:15`（本机时区）。没有就给 —。 */
function fmtTime(iso: string | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const STATUS_LABELS: Record<string, string> = {
  working: '🟢 运行中',
  needsYou: '🟠 等你确认',
  done: '✅ 完成',
  error: '🔴 出错',
  idle: '⚪ 空闲',
  exited: '⚫ 已退出'
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

// ------------------------------------------------------------------ 卡片

function button(n: number, item: { sid: string; agent: string; title: string }) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: String(n) },
    type: 'primary',
    // 点下去先**选模型**（pick），选定后才真正 resume —— 见 onCardAction。
    value: { cmd: 'pick', sid: item.sid, agent: item.agent, title: item.title }
  }
}

/** 选模型卡片：默认 + 该 CLI 的可选模型。 */
function modelPickerCard(input: {
  sid: string
  agent: string
  title: string
  models: string[]
}): Record<string, unknown> {
  const resumeValue = (model?: string) => ({
    cmd: 'resume',
    sid: input.sid,
    agent: input.agent,
    title: input.title,
    ...(model ? { model } : {})
  })
  const actions: Array<Record<string, unknown>> = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '默认（不指定）' },
      type: 'primary',
      value: resumeValue()
    },
    ...input.models.map((model) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: model },
      type: 'default',
      value: resumeValue(model)
    }))
  ]
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `选择模型 · ${truncate(input.title, 30)}` }
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `CLI：${cliOptionOf(input.agent)}` } },
      { tag: 'action', actions },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: '选定后会在电脑上打开这场会话' }
        ]
      }
    ]
  }
}

function helpCard(): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '会话助手 · 用法' }
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            '**/列表** —— 最近可恢复的历史会话（点序号 → 选模型 → 打开）',
            '**/继续 序号 [第一句话]** —— 打开会话；带上话就自动投喂，它直接开跑',
            '**/打开** —— 在电脑上打开上次的国内 WorkBuddy 会话（不选模型，不自动发消息）',
            '**/会话** —— 现在开着的会话',
            '**/发 序号 一句话** —— 往开着的会话里投喂一句话'
          ].join('\n')
        }
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            '**能力边界**',
            '- 「继续」是在电脑上开标签页：手机上做决定，回到电脑就能接着聊',
            '- 「打开」只开国内 WorkBuddy 里最近一场，国际版不在这里恢复',
            '- 「发」只对**开着的**会话生效；会话正忙时不收',
            '- 列表序号 30 分钟内有效，过期重发 /列表'
          ].join('\n')
        }
      }
    ]
  }
}

interface CachedItem {
  sid: string
  agent: string
  title: string
}

const CACHE_TTL_MS = 30 * 60 * 1000

// ------------------------------------------------------------------ 路由本体

export function createFeishuRouter(deps: FeishuRouterDeps): {
  onMessage: (message: FeishuInboundMessage) => Promise<void>
  onCardAction: (action: FeishuInboundCardAction) => Promise<unknown>
} {
  /** 「序号 → 会话」的对照表，/列表 和 /会话 时各自刷新。 */
  const historyCache = new Map<string, { items: CachedItem[]; at: number }>()
  const activeCache = new Map<string, { items: CachedItem[]; at: number }>()
  const pollIntervalMs = deps.pollIntervalMs ?? 3_000
  const pollTimeoutMs = deps.pollTimeoutMs ?? 45_000

  const cacheGet = (
    cache: Map<string, { items: CachedItem[]; at: number }>,
    openId: string
  ): CachedItem[] | null => {
    const entry = cache.get(openId)
    if (!entry || Date.now() - entry.at > CACHE_TTL_MS) return null
    return entry.items
  }

  const cachePut = (
    cache: Map<string, { items: CachedItem[]; at: number }>,
    openId: string,
    items: CachedItem[]
  ): void => {
    cache.set(openId, { items, at: Date.now() })
  }

  async function sendText(openId: string, text: string): Promise<void> {
    await deps.sendTo(openId, { text })
  }

  const workbuddyButton = deps.openLatestWorkbuddy
    ? {
        tag: 'button',
        text: { tag: 'plain_text', content: '打开上次的 WorkBuddy' },
        type: 'default',
        value: { cmd: 'open-workbuddy' }
      }
    : null

  async function sendList(openId: string): Promise<void> {
    const resumable = (await deps.history()).filter((session) => session.resumable)
    if (resumable.length === 0) {
      if (!workbuddyButton) {
        await sendText(openId, '这台电脑上还没有可恢复的会话。先在桌面端跑几场再来。')
        return
      }
      await deps.sendTo(openId, {
        card: {
          config: { wide_screen_mode: true },
          header: {
            template: 'blue',
            title: { tag: 'plain_text', content: '没有可在终端恢复的会话' }
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: '终端会话还没有。国内 WorkBuddy 可以打开上次那场。'
              }
            },
            { tag: 'action', actions: [workbuddyButton] }
          ]
        }
      })
      return
    }
    const top = resumable.slice(0, 10)
    cachePut(historyCache, openId, top.map((session) => ({
      sid: session.sessionId,
      agent: session.agent,
      title: session.title
    })))

    const lines = top.map(
      (session, index) =>
        `**${index + 1}.** ${truncate(session.title.trim() || '(未命名)', 40)}\n${cliOptionOf(session.agent)} · ${fmtTime(session.updatedAt)}`
    )
    // 按钮一次最多 10 个，拆成两排稳妥。
    const actions = top.map((session, index) => button(index + 1, {
      sid: session.sessionId,
      agent: session.agent,
      title: session.title
    }))
    const grouped: Array<Array<Record<string, unknown>>> = []
    for (let i = 0; i < actions.length; i += 5) grouped.push(actions.slice(i, i + 5))

    await deps.sendTo(openId, {
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: 'blue',
          title: { tag: 'plain_text', content: `最近可恢复 ${top.length} 场` }
        },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
          ...grouped.map((group) => ({ tag: 'action', actions: group })),
          ...(workbuddyButton ? [{ tag: 'action', actions: [workbuddyButton] }] : []),
          {
            tag: 'note',
            elements: [
              {
                tag: 'plain_text',
                content: workbuddyButton
                  ? '点序号选模型，选完在电脑上打开；「打开上次的 WorkBuddy」不选模型。序号 30 分钟内有效'
                  : '点序号选模型，选完在电脑上打开；序号 30 分钟内有效'
              }
            ]
          }
        ]
      }
    })
  }

  async function sendActiveList(openId: string): Promise<void> {
    const active = await deps.listActive()
    if (active.length === 0) {
      await sendText(
        openId,
        '电脑上现在没有开着的会话。要续旧的发 /列表，要新开就回电脑。'
      )
      return
    }
    const top = active.slice(0, 10)
    cachePut(activeCache, openId, top.map((session) => ({
      sid: session.sessionId,
      agent: session.adapterId ?? session.agent ?? '',
      title: session.name
    })))
    const lines = top.map(
      (session, index) =>
        `**${index + 1}.** ${truncate(session.name.trim() || '(未命名)', 40)}\n${statusLabel(session.status)} · ${session.workspace || '无目录'}`
    )
    await sendText(openId, lines.join('\n') + '\n\n投喂：/发 序号 一句话')
  }

  async function doResume(
    openId: string,
    n: number,
    model?: string,
    text?: string
  ): Promise<string> {
    const items = cacheGet(historyCache, openId)
    if (!items) return '先用 /列表 拉一次会话列表（序号 30 分钟内有效）。'
    const item = items[n - 1]
    if (!item) return `序号超出范围，现在是 1-${items.length}。`
    try {
      const result = await deps.resume(item.sid, item.agent, model)
      const opened = `✅ 已在电脑上打开「${truncate(item.title, 40)}」${model ? `（模型 ${model}）` : ''}\n目录：${result.workspace}`
      if (!text) {
        return `${opened}\n回到电脑就能接着聊。想让它直接开工：/继续 ${n} <第一句话>。`
      }

      // 带话模式：恢复后轮询等终端就绪（CLI 起来要几秒），然后把话递进去。
      if (!result.sessionId && !result.terminalId) {
        console.log(
          '[feishu-router] resume 没拿到句柄 sid=%s terminalId=%s',
          result.sessionId,
          result.terminalId
        )
        return `${opened}\n⚠️ 没拿到新会话的句柄，投喂不了——稍后在电脑上直接说。`
      }
      console.log(
        '[feishu-router] resume ok，开始等就绪 terminalId=%s sessionId=%s',
        result.terminalId,
        result.sessionId
      )
      const deadline = Date.now() + pollTimeoutMs
      while (Date.now() < deadline) {
        await sleep(pollIntervalMs)
        try {
          const active = await deps.listActive()
          const match = active.find((s) =>
            result.sessionId
              ? s.sessionId === result.sessionId
              : s.terminalId === result.terminalId
          )
          if (match) {
            console.log(
              '[feishu-router] 轮询命中 status=%s ready=%s sessionId=%s',
              match.status,
              match.ready,
              match.sessionId
            )
          } else {
            console.log(
              '[feishu-router] 轮询未命中（活动会话 %d 个，找 terminalId=%s sessionId=%s）',
              active.length,
              result.terminalId,
              result.sessionId
            )
          }
          if (
            match &&
            (match.status === 'idle' || match.status === 'done') &&
            match.ready !== false
          ) {
            await deps.send(match.sessionId, text, item.agent || undefined)
            console.log('[feishu-router] 投喂成功 sessionId=%s', match.sessionId)
            return `${opened}\n📨 已投喂：「${truncate(text, 40)}」——它开跑了。`
          }
        } catch (error) {
          console.log(
            '[feishu-router] 轮询出错（继续等）：%s',
            error instanceof Error ? error.message : String(error)
          )
        }
      }
      console.log('[feishu-router] 投喂超时，放弃自动投喂')
      return `${opened}\n⚠️ 等了太久 CLI 还没就绪，话没递进去。稍后 /会话 看状态，就绪后用 /发 投喂。`
    } catch (error) {
      return `❌ 没开成：${messageOf(error)}`
    }
  }

  async function openLatestWorkbuddyText(): Promise<string> {
    if (!deps.openLatestWorkbuddy) {
      return '这台电脑还没接上国内 WorkBuddy 的打开器。'
    }
    try {
      const result = await deps.openLatestWorkbuddy()
      if (!result.ok) return `❌ ${result.message}`
      return `✅ ${result.message}\n这场不经过终端，也不会自动发消息。`
    } catch (error) {
      return `❌ 没开成：${messageOf(error)}`
    }
  }

  async function doSend(openId: string, n: number, text: string): Promise<string> {
    let items = cacheGet(activeCache, openId)
    if (!items) {
      // 没拉过 /会话：能自动解析就别折腾人 —— 只有一场开着就直接用它。
      const active = await deps.listActive()
      if (active.length === 0) {
        return '电脑上现在没有开着的会话。要续旧的发 /列表，要新开就回电脑。'
      }
      if (active.length > 1) {
        await sendActiveList(openId)
        return `现在开着 ${active.length} 场，看上面序号：/发 <序号> <一句话>。`
      }
      items = [
        {
          sid: active[0]!.sessionId,
          agent: active[0]!.adapterId ?? active[0]!.agent ?? '',
          title: active[0]!.name
        }
      ]
      cachePut(activeCache, openId, items)
    }
    const item = items[n - 1]
    if (!item) return `序号超出范围，现在是 1-${items.length}。`
    try {
      const result = await deps.send(item.sid, text, item.agent || undefined)
      return `✅ 已投喂「${truncate(item.title, 40)}」${result.mode === 'control' ? '（受控通道）' : '（终端打字）'}`
    } catch (error) {
      return `❌ 没发出去：${messageOf(error)}`
    }
  }

  return {
    async onMessage(message: FeishuInboundMessage): Promise<void> {
      try {
        // 安全边界：非单聊、非配对人，一概沉默。群聊里回话等于广播终端。
        if (message.chatType !== 'p2p') return
        if (!deps.isPaired(message.openId)) return
        if (message.messageType !== 'text') {
          await sendText(message.openId, '目前只认文字指令。发 /帮助 看用法。')
          return
        }

        const command = parseCommand(message.text)
        switch (command.cmd) {
          case 'help':
            await deps.sendTo(message.openId, { card: helpCard() })
            return
          case 'list':
            await sendList(message.openId)
            return
          case 'active':
            await sendActiveList(message.openId)
            return
          case 'open-workbuddy':
            await sendText(message.openId, await openLatestWorkbuddyText())
            return
          case 'resume':
            await sendText(
              message.openId,
              await doResume(message.openId, command.n, undefined, command.text)
            )
            return
          case 'send':
            await sendText(
              message.openId,
              await doSend(message.openId, command.n, command.text)
            )
            return
          default:
            await sendText(
              message.openId,
              '不认识这个指令。发 /帮助 看可用命令。'
            )
        }
      } catch (error) {
        // 兜底：入站回调绝不抛错，但要让人知道出了事。
        try {
          await sendText(message.openId, `处理失败：${messageOf(error)}`)
        } catch {
          // 连回话都发不出去（比如掉线）—— 只能到此为止。
        }
      }
    },

    async onCardAction(action: FeishuInboundCardAction): Promise<unknown> {
      if (!deps.isPaired(action.openId)) return undefined
      const value = action.value ?? {}
      try {
        // 第一步按钮：选会话 → 回模型选择卡。
        if (value['cmd'] === 'pick' && typeof value['sid'] === 'string') {
          const sid = value['sid']
          const agent = typeof value['agent'] === 'string' ? value['agent'] : undefined
          const title = typeof value['title'] === 'string' ? value['title'] : '会话'
          const models = agent ? deps.getModels(agent) : []
          await deps.sendTo(action.openId, {
            card: modelPickerCard({ sid, agent: agent ?? '', title, models })
          })
          return { toast: { type: 'success', content: '选个模型' } }
        }
        // 第二步按钮：选模型 → 真正 resume。
        if (value['cmd'] === 'resume' && typeof value['sid'] === 'string') {
          const title = typeof value['title'] === 'string' ? value['title'] : '会话'
          const agent = typeof value['agent'] === 'string' ? value['agent'] : undefined
          const model = typeof value['model'] === 'string' ? value['model'] : undefined
          await deps.resume(value['sid'], agent, model)
          await sendText(
            action.openId,
            `✅ 已在电脑上打开「${truncate(title, 40)}」${model ? `（模型 ${model}）` : ''}，回去就能接着聊。`
          )
          return { toast: { type: 'success', content: '已在电脑上打开' } }
        }
        if (value['cmd'] === 'open-workbuddy') {
          if (!deps.openLatestWorkbuddy) {
            await sendText(action.openId, '这台电脑还没接上国内 WorkBuddy 的打开器。')
            return { toast: { type: 'error', content: '没有 WorkBuddy 打开器' } }
          }
          const result = await deps.openLatestWorkbuddy()
          await sendText(
            action.openId,
            result.ok
              ? `✅ ${result.message}\n这场不经过终端，也不会自动发消息。`
              : `❌ ${result.message}`
          )
          return {
            toast: {
              type: result.ok ? 'success' : 'error',
              content: result.ok ? '已在 WorkBuddy 里打开' : truncate(result.message, 60)
            }
          }
        }
        if (value['cmd'] === 'list') {
          await sendList(action.openId)
          return { toast: { type: 'success', content: '已发最新列表' } }
        }
        if (value['cmd'] === 'help') {
          await deps.sendTo(action.openId, { card: helpCard() })
          return { toast: { type: 'success', content: '已发用法' } }
        }
      } catch (error) {
        return { toast: { type: 'error', content: truncate(messageOf(error), 60) } }
      }
      return undefined
    }
  }
}
