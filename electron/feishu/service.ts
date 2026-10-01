/**
 * 飞书渠道的服务层。
 *
 * 一条线串起来：扫码（registration）→ 存凭据（store）→ 建长连接（channel）→
 * 把状态推给渲染进程。主进程是**唯一**的状态持有者，设置页只拿快照。
 *
 * ## 三个不变量
 *
 * 1. **App Secret 不出主进程。** 状态快照里只有脱敏后的 appId。
 * 2. **每个状态变化都必须广播一次。** 设置页不做乐观更新、不自己轮询 ——
 *    它是纯订阅者，所以「界面显示的和真实的对不上」这类 bug 在结构上就不存在。
 * 3. **对外的方法一律不抛错。** IPC 的 handler 抛错在渲染进程只是一个被拒的
 *    promise，而设置页要的是「把失败原因写在那一行状态里」。所以全部收敛成
 *    `status.error`。
 *
 * ## 准入（谁能驱使这台电脑）
 *
 * `pairedUsers` 是唯一名单。扫码人由注册流程直接写进去（我们申请了
 * `request_user_info=open_id`）；万一没拿到，**不会**退化成「谁发消息都放行」。
 * 那种兜底等于把终端交出去 —— 见 `electron/feishu/router.ts` 里的配对指令。
 */

import type {
  FeishuConnectionState,
  FeishuManualBindInput,
  FeishuProvisionInfo,
  FeishuScanTicket,
  FeishuStatus
} from '../../shared/ipc-contract'
import { FEISHU_IDLE_STATUS, FEISHU_PROVISION_IDLE } from '../../shared/ipc-contract'
import type { BridgeHistorySession } from '../../shared/bridge-protocol'
import {
  beginFeishuRegistration,
  cancelFeishuRegistration,
  pollFeishuRegistration
} from './registration'
import { FeishuChannel, type FeishuChannelHandlers, type FeishuChannelOptions, type FeishuOutboundMessage } from './channel'
import { FeishuStore, isFeishuAppId, maskAppId, type FeishuBinding } from './store'
import {
  provisionFeishuWorkspace,
  feishuProvisionIdle,
  type FeishuProvisionOutcome
} from './provision'
import type { BitableRestClient } from './bitable'

/**
 * 服务层对长连接的**全部**依赖。
 *
 * 抽这一层是为了让服务能被测试：真的 `FeishuChannel` 一 `start()` 就会往飞书
 * 发起 WS 握手，测试里塞不了假凭据。测试注入一个假的实现，就能把
 * 「扫码 → 存凭据 → 建连接 → 状态广播」这条链完整跑一遍而**一个包都不发**。
 * `FeishuChannel` 结构上满足这个接口，生产代码里直接传它。
 */
export interface FeishuChannelLike {
  start(): Promise<{ error: string | null }>
  connectionState(): FeishuConnectionState
  /**
   * 出站：给单个用户发文本/卡片。长连接只管收，发走 REST —— 飞书本来就这么分。
   * **不抛错**，失败折进返回值（引导流程要的是「写进状态」不是「断链路」）。
   */
  sendMessage?(
    openId: string,
    message: { text?: string; card?: Record<string, unknown> }
  ): Promise<{ error: string | null; code: number | null }>
  /** 多维表格用的 REST 客户端；没建连时为 null。 */
  bitableClient?(): BitableRestClient | null
  dispose(): Promise<void>
}

/**
 * 入站事件的落点。由 main 注入真正的实现（router）。
 *
 * 不注入时事件会被**记录但不处理** —— 心跳照常走，只是没人应答。
 * 这是刻意的：能在「还没接上应答逻辑」的时候单独验证「连接真的活着」。
 */
export interface FeishuInboundHandlers {
  onMessage: FeishuChannelHandlers['onMessage']
  onCardAction: FeishuChannelHandlers['onCardAction']
}

export interface FeishuServiceOptions {
  store: FeishuStore
  broadcast: (status: FeishuStatus) => void
  handlers?: FeishuInboundHandlers
  /** 显示在飞书确认页上的应用名，用户仍可改。 */
  appName?: string
  appDescription?: string
  /**
   * 历史会话的来源。给了它 + `bitableStatePath`，连接成功后就会自动
   * 建多维表格、同步会话历史、发引导卡。不给就什么都不做（判卷/纯连接模式）。
   */
  history?: () => Promise<BridgeHistorySession[]>
  /** 多维表格账本的落盘位置（`<userData>/feishu-bitable.json`）。 */
  bitableStatePath?: string
  /** 测试用：替换全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 测试用：替换长连接实现。生产代码不要传。 */
  channelFactory?: (options: FeishuChannelOptions) => FeishuChannelLike
}

export class FeishuService {
  private readonly store: FeishuStore
  private readonly broadcast: (status: FeishuStatus) => void
  private readonly handlers: FeishuInboundHandlers | null
  private readonly appName: string | undefined
  private readonly appDescription: string | undefined
  private readonly fetchImpl: typeof fetch | undefined
  private readonly channelFactory: (options: FeishuChannelOptions) => FeishuChannelLike
  private channel: FeishuChannelLike | null = null

  private binding: FeishuBinding | null = null
  private scanTicket: FeishuScanTicket | null = null
  private scanTimer: ReturnType<typeof setTimeout> | null = null
  /** 递增代际：任何一次取消/重来都会让上一轮的轮询回调自杀。 */
  private scanGeneration = 0

  private connection: FeishuStatus['connection'] = 'idle'
  private lastEventAt: number | null = null
  private lastEventSummary: string | null = null
  private eventCount = 0
  private error: string | null = null
  private ready = false
  /** 连接成功后的自动建档进度（多维表格 + 会话历史 + 引导卡）。 */
  private provision: FeishuProvisionInfo = FEISHU_PROVISION_IDLE
  /** 单飞闸门：引导流程跑着的时候，连接抖动不该叠出第二跑。 */
  private provisioning = false
  private readonly history: (() => Promise<BridgeHistorySession[]>) | undefined
  private readonly bitableStatePath: string | undefined

  constructor(options: FeishuServiceOptions) {
    this.store = options.store
    this.broadcast = options.broadcast
    this.handlers = options.handlers ?? null
    this.appName = options.appName
    this.appDescription = options.appDescription
    this.fetchImpl = options.fetchImpl
    this.channelFactory =
      options.channelFactory ?? ((channelOptions) => new FeishuChannel(channelOptions))
    this.history = options.history
    this.bitableStatePath = options.bitableStatePath
  }

  /**
   * 进程启动时调一次：把磁盘上的凭据读进来并建立长连接。
   *
   * 刻意**不**在启动路径上抛错 —— 一个飞书凭据坏了不该让整个应用起不来。
   */
  async initialize(): Promise<FeishuStatus> {
    if (this.ready) return this.snapshot()
    this.ready = true
    this.binding = await this.store.read()
    if (this.binding) {
      await this.startChannel()
    }
    return this.snapshot()
  }

  getStatus(): FeishuStatus {
    return this.snapshot()
  }

  /**
   * 飞书用户在不在准入名单里 —— 入站路由用来挡陌生人。
   * 名单是扫码时写死的 `pairedUsers`，不存在「发消息就能配对」的口子。
   */
  isPaired(openId: string): boolean {
    return this.binding?.pairedUsers.some((user) => user.openId === openId) ?? false
  }

  /**
   * 给单个用户发消息（路由回话用）。长连接没就绪时如实返回错误，
   * 不抛 —— 调用方（路由）还要继续处理后面的消息。
   */
  async sendToOpenId(
    openId: string,
    message: FeishuOutboundMessage
  ): Promise<{ error: string | null; code: number | null }> {
    const channel = this.channel
    if (!channel?.sendMessage) return { error: '长连接未就绪', code: null }
    return channel.sendMessage(openId, message)
  }

  /**
   * 生成二维码，开始等扫码。返回的是**已经带上票据的快照**，UI 直接渲染。
   */
  async beginScan(): Promise<FeishuStatus> {
    this.stopScanTimer()
    this.error = null
    const generation = ++this.scanGeneration

    let begun
    try {
      begun = await beginFeishuRegistration({
        appName: this.appName,
        appDescription: this.appDescription,
        fetchImpl: this.fetchImpl
      })
    } catch (error) {
      this.error = message(error, '无法生成飞书二维码')
      this.scanTicket = null
      return this.emit()
    }

    this.scanTicket = {
      sessionKey: begun.sessionKey,
      verificationUri: begun.verificationUri,
      expiresAt: Date.now() + begun.expiresInSeconds * 1000,
      intervalSeconds: begun.intervalSeconds
    }
    this.emit()
    this.scheduleScanPoll(generation, begun.intervalSeconds)
    return this.snapshot()
  }

  cancelScan(): FeishuStatus {
    const ticket = this.scanTicket
    this.scanTicket = null
    this.scanGeneration += 1
    this.stopScanTimer()
    if (ticket) cancelFeishuRegistration(ticket.sessionKey)
    return this.emit()
  }

  /**
   * 手填凭据的兜底。扫码走不通（企业策略禁用、账号被限制）时用户仍然能自救。
   */
  async bindManual(input: FeishuManualBindInput): Promise<FeishuStatus> {
    const appId = input.appId.trim()
    const appSecret = input.appSecret.trim()
    if (!isFeishuAppId(appId)) {
      this.error = 'App ID 格式不对（应为 cli_ 开头的 16 位十六进制）'
      return this.emit()
    }
    if (!appSecret) {
      this.error = 'App Secret 不能为空'
      return this.emit()
    }
    this.cancelScan()
    this.binding = await this.store.update((current) => ({
      appId,
      appSecret,
      domain: input.domain,
      boundAt: Date.now(),
      // 手工绑定时保留原有准入名单：换凭证不该顺手清掉已授权的人。
      pairedUsers: current?.pairedUsers ?? []
    }))
    this.error = null
    // 新凭据 → 引导流程重来一次（表跟着应用走，账本文件里会判废旧 appId）。
    this.provision = feishuProvisionIdle()
    await this.startChannel()
    return this.snapshot()
  }

  /** 解绑：拆连接、删凭据、清准入名单。 */
  async unbind(): Promise<FeishuStatus> {
    this.cancelScan()
    await this.disposeChannel()
    await this.store.clear()
    this.binding = null
    this.connection = 'idle'
    this.error = null
    this.lastEventAt = null
    this.lastEventSummary = null
    this.eventCount = 0
    // 换了应用，多维表格的账本也作废（账本文件里记着 appId，读回来时同样会判废）。
    this.provision = feishuProvisionIdle()
    return this.emit()
  }

  /** 重连：拆掉当前连接重新建。凭据和名单都不动。 */
  async reconnect(): Promise<FeishuStatus> {
    if (!this.binding) {
      this.error = '还没有绑定飞书应用'
      return this.emit()
    }
    this.error = null
    await this.startChannel()
    return this.snapshot()
  }

  async unpairUser(openId: string): Promise<FeishuStatus> {
    if (!openId) return this.snapshot()
    this.binding = await this.store.unpairUser(openId)
    return this.emit()
  }

  async dispose(): Promise<void> {
    this.cancelScan()
    await this.disposeChannel()
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 连接成功后自动跑一轮「建档 + 同步 + 引导」。
   *
   * 三条前置都满足才跑：有凭据且有人可发、有历史来源和落盘位置、通道支持出站。
   * 已经成功过（done）就不重跑 —— 表会随之后的重连增量更新，不用每次推。
   */
  private async maybeProvision(): Promise<void> {
    if (this.provisioning) return
    if (this.provision.state === 'done' || this.provision.state === 'running') return
    const binding = this.binding
    if (!binding || binding.pairedUsers.length === 0) return
    if (!this.history || !this.bitableStatePath) return
    const channel = this.channel
    if (!channel?.sendMessage || !channel.bitableClient) return
    const client = channel.bitableClient()
    if (!client) return

    this.provisioning = true
    this.provision = { ...FEISHU_PROVISION_IDLE, state: 'running', ranAt: Date.now() }
    this.emit()
    try {
      const outcome = await provisionFeishuWorkspace({
        appId: binding.appId,
        client,
        history: this.history,
        pairedOpenIds: binding.pairedUsers.map((user) => user.openId),
        sendCard: async (openId, card) =>
          (await channel.sendMessage?.(openId, { card })) ?? {
            error: '通道不支持发消息',
            code: null
          },
        statePath: this.bitableStatePath
      })
      this.provision = {
        state: outcome.state,
        bitableUrl: outcome.bitableUrl,
        synced: outcome.synced,
        error: outcome.error,
        permissionUrl: outcome.permissionUrl,
        welcomeError: outcome.welcomeError,
        ranAt: outcome.ranAt
      }
    } catch (error) {
      // provision 内部不抛错；这里兜的是「将来有人改坏了」的保险。
      this.provision = {
        ...FEISHU_PROVISION_IDLE,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
        ranAt: Date.now()
      }
    } finally {
      this.provisioning = false
      this.emit()
    }
  }

  private scheduleScanPoll(generation: number, delaySeconds: number): void {
    this.stopScanTimer()
    this.scanTimer = setTimeout(() => {
      void this.runScanPoll(generation)
    }, Math.max(1, delaySeconds) * 1000)
  }

  private async runScanPoll(generation: number): Promise<void> {
    const ticket = this.scanTicket
    if (generation !== this.scanGeneration || !ticket) return
    if (Date.now() >= ticket.expiresAt) {
      this.scanTicket = null
      this.error = '二维码已过期，请重新生成'
      cancelFeishuRegistration(ticket.sessionKey)
      this.emit()
      return
    }

    let result
    try {
      result = await pollFeishuRegistration({
        sessionKey: ticket.sessionKey,
        fetchImpl: this.fetchImpl
      })
    } catch (error) {
      // 单次网络抖动不该把整轮扫码判死 —— 按原间隔再试。
      if (generation !== this.scanGeneration) return
      this.error = message(error, '轮询飞书失败')
      this.emit()
      this.scheduleScanPoll(generation, ticket.intervalSeconds)
      return
    }
    if (generation !== this.scanGeneration) return

    if (result.status === 'waiting') {
      this.error = null
      this.scanTicket = { ...ticket, intervalSeconds: result.intervalSeconds }
      this.emit()
      this.scheduleScanPoll(generation, result.intervalSeconds)
      return
    }

    this.scanTicket = null
    this.stopScanTimer()

    if (result.status !== 'success') {
      this.error = result.message
      this.emit()
      return
    }

    // 成功：存凭据 + 把扫码人写进准入名单，然后建连。
    this.binding = await this.store.update(() => ({
      appId: result.appId,
      appSecret: result.appSecret,
      domain: result.domain,
      boundAt: Date.now(),
      pairedUsers: result.openId
        ? [{ openId: result.openId, name: '扫码人', pairedAt: Date.now() }]
        : []
    }))
    this.error = result.openId ? null : '已绑定，但没能确认扫码人身份，请看下方准入名单'
    // 新凭据 → 引导流程重来一次。
    this.provision = feishuProvisionIdle()
    await this.startChannel()
  }

  /**
   * 建长连接。`start()` 本身不抛错，但这里再兜一层，并且把「连上了没」
   * 交给 `connection` 字段而不是返回值 —— 长连接的成败是异步的。
   */
  private async startChannel(): Promise<void> {
    await this.disposeChannel()
    const binding = this.binding
    if (!binding) {
      this.connection = 'idle'
      this.emit()
      return
    }

    const channel = this.channelFactory({
      appId: binding.appId,
      appSecret: binding.appSecret,
      domain: binding.domain,
      handlers: {
        onMessage: async (incoming) => {
          if (this.handlers) await this.handlers.onMessage(incoming)
        },
        onCardAction: async (action) => {
          if (!this.handlers) return undefined
          return await this.handlers.onCardAction(action)
        },
        onActivity: (summary) => this.recordActivity(summary),
        onConnectionChange: (state) => {
          if (this.connection === state) return
          this.connection = state
          if (state !== 'failed') this.error = null
          this.emit()
          // 连上之后的「下文」就在这里触发：建表、同步历史、发引导卡。
          // 失败不重试到死 —— 下次重连（用户点「重连」）会再试一次。
          if (state === 'connected') void this.maybeProvision()
        }
      }
    })
    this.channel = channel

    const started = await channel.start()
    if (started.error) {
      this.connection = 'failed'
      this.error = started.error
      this.emit()
      return
    }
    this.connection = channel.connectionState()
    this.emit()
  }

  private async disposeChannel(): Promise<void> {
    const channel = this.channel
    this.channel = null
    if (!channel) return
    await channel.dispose()
  }

  private recordActivity(summary: string): void {
    this.eventCount += 1
    this.lastEventAt = Date.now()
    this.lastEventSummary = summary
    this.emit()
  }

  private snapshot(): FeishuStatus {
    const binding = this.binding
    if (!binding) {
      // ⚠️ 这里必须把扫码票据一起带上。扫码**发生在绑定之前**，所以
      // 「没凭据」不等于「没在扫码」—— 早先漏了这个分支，二维码就永远
      // 显示不出来（UI 收到的是 unbound + scan: null），而设置页上表现为
      // 「点了扫码没反应」。
      return {
        ...FEISHU_IDLE_STATUS,
        phase: this.scanTicket ? 'scanning' : 'unbound',
        bound: false,
        scan: this.scanTicket,
        eventCount: this.eventCount,
        provision: this.provision,
        error: this.error
      }
    }
    let phase: FeishuStatus['phase']
    if (this.scanTicket) {
      phase = 'scanning'
    } else if (this.connection === 'connected') {
      phase = 'connected'
    } else if (this.connection === 'failed') {
      phase = 'error'
    } else {
      phase = 'connecting'
    }
    return {
      phase,
      bound: true,
      appIdMasked: maskAppId(binding.appId),
      domain: binding.domain,
      boundAt: binding.boundAt,
      connection: this.connection,
      lastEventAt: this.lastEventAt,
      lastEventSummary: this.lastEventSummary,
      eventCount: this.eventCount,
      scan: this.scanTicket,
      pairedUserCount: binding.pairedUsers.length,
      provision: this.provision,
      error: this.error
    }
  }

  private emit(): FeishuStatus {
    const status = this.snapshot()
    try {
      this.broadcast(status)
    } catch (error) {
      console.warn('[feishu] broadcast failed:', error)
    }
    return status
  }

  private stopScanTimer(): void {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer)
      this.scanTimer = null
    }
  }
}

function message(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  const text = String(error ?? '').trim()
  return text || fallback
}
