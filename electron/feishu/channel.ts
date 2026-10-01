/**
 * 飞书长连接（WebSocket）—— 入站事件适配器。
 *
 * ## 为什么必须用官方 SDK，不能自己撸协议
 *
 * 飞书的长连接**在握手之后切成了 protobuf 帧**。自己按 JSON over WS 写，
 * 表现是「连上了、ping/pong 也通、但永远收不到任何事件」—— 不报错，静默的。
 * 所以这里薄薄包一层 `WSClient` + `EventDispatcher`，不做任何协议层的事。
 *
 * ## 只订阅两个东西，都是注册流程里同时申请的
 *
 * - `im.message.receive_v1` —— 用户给机器人发消息
 * - `card.action.trigger`    —— 卡片上的按钮被点
 *
 * ⚠️ 第二个在开放平台里是**回调**（「事件与回调」页签下的另一半），不是事件。
 * 注册时只订事件的话，卡片按钮点下去毫无反应，而且没有任何报错。
 *
 * ## 可观测性三件套
 *
 * 这个文件里所有「失败了但看起来像成功」的坑都靠三样东西兜：
 *   1. `connectionState()` —— 直通 SDK，UI 上能看见 connecting / reconnecting；
 *   2. `onActivity`        —— **每一个**入站帧都打点，无论我们认不认识，
 *                            这是「连接真的活着」唯一不会骗人的证据；
 *   3. 明确的错误回传      —— SDK 的 `onError` / `start()` 的静默 return
 *                            都要变成服务层的 error 字符串。
 */

import {
  Client,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  Domain
} from '@larksuiteoapi/node-sdk'
import type { FeishuConnectionState, FeishuDomain } from '../../shared/ipc-contract'
import type { BitableRestClient } from './bitable'

/** 订阅键，跟开放平台里勾的完全一致。 */
export const FEISHU_MESSAGE_EVENT = 'im.message.receive_v1'
export const FEISHU_CARD_CALLBACK = 'card.action.trigger'

export interface FeishuInboundMessage {
  /** 发送者的 open_id（`ou_…`）。准入判定只认这个。 */
  openId: string
  chatId: string
  messageId: string
  /** `p2p` / `group`。我们只订了单聊，但群里 @ 也可能进来，如实带上。 */
  chatType: string
  /** 目前只有 `text` 会被解析成文本，其余原样带上类型名。 */
  messageType: string
  text: string
  receivedAt: number
}

export interface FeishuInboundCardAction {
  openId: string
  chatId: string | null
  messageId: string | null
  actionTag: string
  /** 按钮上挂的 `value`，我们已经约定成 `{cmd: '…'}` 这类结构。 */
  value: Record<string, unknown>
  receivedAt: number
}

export interface FeishuChannelHandlers {
  onMessage: (message: FeishuInboundMessage) => void | Promise<void>
  /**
   * 卡片按钮被点。
   *
   * 返回值会**原样回给飞书**当作这次回调的响应（`{toast:{…}}` 之类）。
   * 返回 undefined 表示不给任何即时反馈。
   */
  onCardAction: (
    action: FeishuInboundCardAction
  ) => Promise<unknown> | unknown
  /** 每收到一个入站帧就调一次（含我们不认识的帧），用于心跳。 */
  onActivity: (summary: string) => void
  onConnectionChange: (state: FeishuConnectionState) => void
}

/** 出站消息。文本和交互卡片二选一，都塞进一个参数免得方法翻倍。 */
export interface FeishuOutboundMessage {
  text?: string
  /** 飞书卡片 JSON（`msg_type:'interactive'` 的 content，原样传）。 */
  card?: Record<string, unknown>
}

export interface FeishuChannelOptions {
  appId: string
  appSecret: string
  domain: FeishuDomain
  handlers: FeishuChannelHandlers
}

function toSdkDomain(domain: FeishuDomain): Domain {
  return domain === 'lark' ? Domain.Lark : Domain.Feishu
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function pickString(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 把 `im.message.receive_v1` 的原始负载压成我们自己的形状。
 *
 * 关键事实：`content` 是一个 **JSON 字符串**，不是对象。文本消息长这样：
 * `{"text":"@_user_1 你好"}` —— 单聊里被 @ 到时会插进一个占位符，
 * 不去掉的话就会把这段噪声当指令正文。
 */
export function normalizeFeishuMessage(raw: unknown): FeishuInboundMessage | null {
  const root = asRecord(raw)
  if (!root) return null
  const sender = asRecord(root.sender)
  const senderId = asRecord(sender?.sender_id)
  const message = asRecord(root.message)
  if (!message) return null

  const openId = pickString(senderId, 'open_id')
  const messageId = pickString(message, 'message_id')
  if (!openId || !messageId) return null

  const messageType = pickString(message, 'message_type') || 'unknown'
  const contentRaw = message.content
  let text = ''
  if (typeof contentRaw === 'string' && contentRaw.trim()) {
    try {
      const parsed = asRecord(JSON.parse(contentRaw))
      text = pickString(parsed, 'text')
    } catch {
      // content 不是 JSON 就把原文当文本，总比丢掉好。
      text = contentRaw
    }
  }
  // 去掉 @ 机器人留下的占位符（形如 `@_user_1`）。
  text = text.replace(/@_\w+\s*/g, '').trim()

  const createTime = Number(pickString(message, 'create_time'))
  return {
    openId,
    chatId: pickString(message, 'chat_id'),
    messageId,
    chatType: pickString(message, 'chat_type') || 'unknown',
    messageType,
    text,
    receivedAt: Number.isFinite(createTime) && createTime > 0 ? createTime : Date.now()
  }
}

/**
 * 把 `card.action.trigger` 的原始负载压成我们自己的形状。
 *
 * 这个负载的字段位置在飞书的不同文档版本里不太一致（有的把操作人放在顶层
 * `open_id`，有的放在 `operator.open_id`），所以这里按「先找嵌套、再找顶层」
 * 的顺序宽容地取。
 */
export function normalizeFeishuCardAction(
  raw: unknown
): FeishuInboundCardAction | null {
  const root = asRecord(raw)
  if (!root) return null
  const operator = asRecord(root.operator)
  const openId = pickString(operator, 'open_id') || pickString(root, 'open_id')
  if (!openId) return null

  const action = asRecord(root.action)
  const context = asRecord(root.context)
  const value = asRecord(action?.value)

  return {
    openId,
    chatId: pickString(context, 'open_chat_id') || pickString(root, 'open_chat_id') || null,
    messageId:
      pickString(context, 'open_message_id') ||
      pickString(root, 'open_message_id') ||
      null,
    actionTag: pickString(action, 'tag') || 'unknown',
    value: value ? { ...value } : {},
    receivedAt: Date.now()
  }
}

export class FeishuChannel {
  private client: WSClient | null = null
  private dispatcher: EventDispatcher | null = null
  /**
   * REST 客户端，**只用来发消息**（长连接收、REST 发 —— 飞书本来就是这么分的）。
   *
   * 之前只有 WSClient，等于只长了一只耳朵：事件进得来，一个字都出不去。
   * 引导卡片、指令应答都得靠它。
   */
  private rest: Client | null = null
  private disposed = false
  private lastError: string | null = null

  constructor(private readonly options: FeishuChannelOptions) {}

  /**
   * 建连。**不会抛错** —— 所有失败都变成返回值里的 error 字符串。
   *
   * 这样做的理由：长连接的失败模式是异步的（DNS 挂了、app 没开长连接模式、
   * 凭证被重置），一次 `await` 的成败说明不了什么；把它当同步错误处理会让人
   * 以为「没抛错就是连上了」。真正的连接状态由 `connectionState()` 提供。
   */
  async start(): Promise<{ error: string | null }> {
    if (this.disposed) return { error: 'channel disposed' }
    // 重连走的是「同一个实例再 start 一次」，所以这里只能拆掉旧连接，
    // **不能**调 dispose() —— 那个会把 disposed 锁上，于是新连接刚建好就被判死。
    this.teardown()

    const { appId, appSecret, domain, handlers } = this.options
    let dispatcher: EventDispatcher
    let client: WSClient
    try {
      dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
        [FEISHU_MESSAGE_EVENT]: async (data: unknown) => {
          handlers.onActivity('收到消息事件')
          try {
            const message = normalizeFeishuMessage(data)
            if (message) await handlers.onMessage(message)
          } catch (error) {
            console.warn('[feishu] message handler failed:', error)
          }
        },
        [FEISHU_CARD_CALLBACK]: async (data: unknown) => {
          handlers.onActivity('收到卡片回调')
          try {
            const action = normalizeFeishuCardAction(data)
            if (!action) return
            return await handlers.onCardAction(action)
          } catch (error) {
            console.warn('[feishu] card handler failed:', error)
            return { toast: { type: 'error', content: '处理失败，请稍后再试' } }
          }
        }
      })

      client = new WSClient({
        appId,
        appSecret,
        domain: toSdkDomain(domain),
        // warn 而不是 info：默认级别会把 SDK 那段「去开发者后台配长连接模式」
        // 的长提示打到控制台，真出问题时反而淹没了有用的行。
        loggerLevel: LoggerLevel.warn,
        autoReconnect: true,
        // 注意：重连间隔**改不了**。SDK 的 `wsConfig` 覆盖只开放 `pingTimeout`，
        // ping/reconnect 的间隔由服务端在 pong 帧里下发（默认 120s）。所以
        // 「炸了要等两分钟」这件事没法从客户端修 —— 设置页那个「重连」按钮
        // 才是真正的逃生口，`onReconnecting` 状态就是它存在的理由。
        onReady: () => handlers.onConnectionChange('connected'),
        onReconnecting: () => handlers.onConnectionChange('reconnecting'),
        onReconnected: () => handlers.onConnectionChange('connected'),
        onError: () => handlers.onConnectionChange('failed')
      })
      // ⚠️ SDK 在 appId 不匹配 `cli_[0-9a-fA-F]{16}` 时**静默 return**，
      // 不抛错、不回调。所以这一层自己先查一遍，把它变成一句人话。
      if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
        return { error: `App ID 格式不对（应为 cli_ 开头的 16 位十六进制）：${appId}` }
      }
      handlers.onConnectionChange('connecting')
      await client.start({ eventDispatcher: dispatcher })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
      handlers.onConnectionChange('failed')
      return { error: message }
    }

    this.client = client
    this.dispatcher = dispatcher
    this.rest = new Client({
      appId,
      appSecret,
      domain: toSdkDomain(domain),
      loggerLevel: LoggerLevel.warn
    })
    return { error: null }
  }

  connectionState(): FeishuConnectionState {
    if (!this.client) return this.lastError ? 'failed' : 'idle'
    try {
      const status = this.client.getConnectionStatus()
      return (status?.state as FeishuConnectionState) ?? 'idle'
    } catch {
      return 'idle'
    }
  }

  lastErrorMessage(): string | null {
    return this.lastError
  }

  /**
   * 多维表格用的 REST 客户端。跟 `sendMessage` 共用同一个凭据、同一个域名。
   * 还没建连时返回 null —— 调用方（provision）据此跳过而不是报一个
   * 「没连接」的错，因为引导流程本来就是连接成功后才跑的。
   */
  bitableClient(): BitableRestClient | null {
    return this.rest as unknown as BitableRestClient | null
  }

  /**
   * 给单个用户发一条消息（文本或卡片）。
   *
   * **不抛错** —— 和 `start()` 同一条纪律：调用方（引导流程）要的是
   * 「把失败原因写进状态里」，不是一个会让整条链路断掉的异常。
   * 飞书的错误码在这里原样透传（比如 `99991672` = 缺 IM 权限），
   * 上层拿它能生成有针对性的引导，而不是一句「发送失败」。
   */
  async sendMessage(
    openId: string,
    message: FeishuOutboundMessage
  ): Promise<{ error: string | null; code: number | null }> {
    if (this.disposed) return { error: 'channel disposed', code: null }
    const rest = this.rest
    if (!rest) return { error: '还没有建立连接，无法发消息', code: null }
    if (!message.text && !message.card) {
      return { error: '消息内容为空', code: null }
    }

    const content = message.card
      ? JSON.stringify(message.card)
      : JSON.stringify({ text: message.text ?? '' })
    try {
      const response = await rest.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: message.card ? 'interactive' : 'text',
          content
        }
      })
      // SDK 的失败不抛异常，是 code != 0 的正常返回 —— 必须自己判。
      const code = Number(response?.code ?? 0)
      if (code !== 0) {
        const msg = response?.msg || '飞书返回了未知错误'
        return { error: `飞书错误 ${code}: ${msg}`, code }
      }
      return { error: null, code: 0 }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        code: null
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.rest = null
    this.teardown()
  }

  /** 拆连接，但不锁死活口。`close()` 是同步的，内部把 dataCache 也销毁了，
   *  所以拆过的 client 不能复用 —— 调用方必须建新的（`start()` 里就是这么做的）。 */
  private teardown(): void {
    const client = this.client
    this.client = null
    this.dispatcher = null
    if (!client) return
    try {
      // force=false：给 SDK 一个正常关闭握手的机会；它内部有超时兜底。
      client.close({ force: false })
    } catch (error) {
      console.warn('[feishu] ws close failed:', error)
    }
  }
}
