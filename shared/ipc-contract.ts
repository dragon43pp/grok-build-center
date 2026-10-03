/**
 * IPC 契约 —— 主进程 / preload / renderer 三方共享的单一事实来源。
 * 对齐 SPEC §3。M2：PTY 输出使用 Uint8Array，并由 renderer 在 xterm
 * 解析完成后 ack，主进程据此执行有界背压。
 */

import type { UserThemeFile } from './theme-schema'
import type { FloatingAppearance } from './floating-window'
import type { TerminalBackgroundPickResult } from './terminal-background'
import type { RemoteWebSurface } from './remote-protocol'
import type { AgentId, DiscoverResult, PricingRefreshResult } from './session-history'
export {
  FloatingWindowEventChannel,
  FloatingWindowInvokeChannel,
  type FloatingRendererApi,
  type FloatingWindowApi,
  type FloatingWindowState
} from './floating-window'

// ───── Renderer → Main（ipcMain.handle，请求-响应）─────────

export interface PtyTerminalIdentity {
  terminalId: string
  kind: 'terminal' | 'agent'
  name: string
  shellId: string
  cwd: string
  /** Ordinary terminal grouped beneath an AI session in the sidebar. */
  parentSessionId?: string
  /** In-memory launch recipe used to clone an AI session after renderer reload. */
  agentSelection?: CliLaunchSelection
}

export interface SpawnOptions {
  /** 未提供时由主进程按平台选默认 shell（Windows→pwsh，类 Unix→$SHELL/bash）。 */
  shell?: string
  /** Windows command shims may require a verbatim command line for node-pty. */
  args?: string[] | string
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  /**
   * Renderer reload 后重建终端的稳定身份。PTYManager 只保存通用终端
   * 元数据，不解析 CLI 品牌或 Agent 事件。
   */
  terminal?: PtyTerminalIdentity
}

export interface SpawnResult {
  ptyId: string
}

export interface RecoverablePty extends PtyTerminalIdentity {
  ptyId: string
  exited: boolean
}

export interface ExitPayload {
  code: number
  signal?: number
}

export interface PtyResizeCursorSync {
  /** ConPTY 当前视口内的 1-based 光标行列。 */
  row: number
  column: number
}

export interface PtyHistoryOutputEvent {
  sequence: number
  kind: 'output'
  data: string
  byteLength: number
}

export interface PtyHistoryResizeEvent {
  sequence: number
  kind: 'resize'
  cols: number
  rows: number
}

export interface PtyHistoryCursorSyncEvent {
  sequence: number
  kind: 'cursor-sync'
  row: number
  column: number
}

export type PtyHistoryEvent =
  | PtyHistoryOutputEvent
  | PtyHistoryResizeEvent
  | PtyHistoryCursorSyncEvent

/** 主进程权威历史源的只读快照。P0 保存原始流；后续 P1/P2 在此之上做重放。 */
export interface PtyHistorySnapshot {
  /** false 表示会话超过容量上限，最旧事件已被淘汰。 */
  complete: boolean
  retainedOutputBytes: number
  droppedOutputBytes: number
  droppedEvents: number
  events: PtyHistoryEvent[]
}

export interface PtyFlowControlSnapshot {
  highWaterMarkBytes: number
  lowWaterMarkBytes: number
  maxBufferedBytes: number
  unackedBytes: number
  queuedBytes: number
  bufferedBytes: number
  maxObservedBufferedBytes: number
  paused: boolean
  pauseCount: number
  resumeCount: number
  overflowed: boolean
  rejectedBytes: number
}

export interface AllTimeStats {
  sessions: number
  toolCalls: number
  blocked: number
  approvals: number
}

export type HistoryEventKind =
  | 'tool_call'
  | 'completed'
  | 'approved'
  | 'blocked'
  | 'message'
  | 'session_start'
  | 'session_exit'

export interface HistoryEvent {
  id: string
  kind: HistoryEventKind
  adapterId: string
  occurredAt: number
  title: string
  detail: string
}

export interface HistoryQuery {
  limit: number
  before?: number
}

export interface ShellOption {
  id: string
  name: string
  hint: string
  shell: string
  args?: string[]
}

export type CliRuntime =
  | { kind: 'host'; platform: 'windows' | 'macos' | 'linux' }
  | { kind: 'wsl'; distro: string }

export interface CliInstallation {
  id: string
  definitionId: string
  runtime: CliRuntime
  resolvedExecutable: string
  detectedVia: 'path' | 'known-path'
  version?: string
  verification: 'verified'
}

/** Interactive skip-approval launch. Injected only when the start-modal checkbox is on. */
export interface CliSkipApprovalLaunch {
  args: string[]
  /**
   * Equivalent or conflicting tokens already in the user's extra args.
   * If any match, do not inject `args` again.
   */
  alreadyPresent?: string[]
  /** Product mode name shown as "Start {label} mode". */
  label: string
}

export interface LaunchableCliDefinition {
  id: string
  adapterId: string
  displayName: string
  hint: string
  iconId: string
  skipApproval?: CliSkipApprovalLaunch
}

export interface LaunchableCli {
  definition: LaunchableCliDefinition
  installations: CliInstallation[]
}

export interface CliRuntimeError {
  runtime: CliRuntime
  /** 探针针对某个产品失败时标出定义；运行环境整体不可用时省略。 */
  definitionId?: string
  code: 'unavailable' | 'timeout' | 'probe-failed'
  detail: string
}

export interface CliScanReport {
  startedAt: number
  finishedAt: number
  launchable: LaunchableCli[]
  runtimeErrors: CliRuntimeError[]
}

export interface CliLaunchSelection {
  installationId: string
  workspace: string
  args: string[]
}

/** 平台元信息。 */
export interface PtyMeta {
  platform: string
  /**
   * 仅 Windows。告知 xterm 当前使用 ConPTY 及系统 build，使其采用对应的 Windows
   * buffer/reflow 兼容路径。它本身不能阻止 ConPTY resize 整屏重画；后者由主进程
   * ConptyResizeFilter 隔离。
   */
  windowsPty?: { backend: 'conpty' | 'winpty'; buildNumber: number }
}

export const PtyInvokeChannel = {
  Spawn: 'pty:spawn',
  Attach: 'pty:attach',
  ListRecoverable: 'pty:list-recoverable',
  Write: 'pty:write',
  Resize: 'pty:resize',
  Kill: 'pty:kill',
  KillTerminal: 'pty:kill-terminal',
  Ack: 'pty:ack',
  History: 'pty:history',
  FlowControl: 'pty:flow-control'
} as const

export const ClipboardInvokeChannel = {
  WriteText: 'clipboard:write-text',
  ReadForTerminalPaste: 'clipboard:read-for-terminal-paste'
} as const

export type TerminalClipboardPaste =
  | { kind: 'empty' }
  | { kind: 'image' }
  | { kind: 'text'; text: string }

export const WindowInvokeChannel = {
  Minimize: 'window:minimize',
  ToggleMaximize: 'window:toggle-maximize',
  Close: 'window:close',
  IsMaximized: 'window:is-maximized',
  IsFullScreen: 'window:is-full-screen',
  GetPosition: 'window:get-position'
} as const

/**
 * 窗口左上角相对"当前所在显示器"的位置与该显示器尺寸。
 * 侧栏环境渐变把一张显示器大小的虚拟渐变画布锚定在屏幕上，
 * 用该偏移取窗口对应的切片；跨显示器移动时坐标系自动跟随。
 */
export interface WindowPositionPayload {
  x: number
  y: number
  screenWidth: number
  screenHeight: number
}

export const ThemeInvokeChannel = {
  ListUser: 'theme:list-user',
  SaveCustom: 'theme:save-custom'
} as const

export const DialogInvokeChannel = {
  PickDirectory: 'dialog:pick-directory'
} as const

export const TerminalBackgroundInvokeChannel = {
  Pick: 'terminal-background:pick',
  Clear: 'terminal-background:clear'
} as const

export interface DirectoryPickerRequest {
  defaultPath?: string
  runtime: CliRuntime
}

export const ShellInvokeChannel = {
  ListAvailable: 'shell:list-available'
} as const

export const CliInvokeChannel = {
  Scan: 'cli:scan',
  PrepareLaunch: 'cli:prepare-launch',
  ResolveWorkspace: 'cli:resolve-workspace'
} as const

/** M5.c: real persistence behind stats/history; renderer reports lifecycle events. */
export const StatsInvokeChannel = {
  AllTime: 'stats:all-time',
  HistoryEvents: 'events:history',
  RecordEvent: 'events:record'
} as const

/**
 * 读各个 AI CLI 落在磁盘上的会话记录（`electron/sessions/`）。
 *
 * 和 `StatsInvokeChannel` 是两件事：那边是**本应用自己**看到的事件流水，
 * 这边是**外部 CLI 原生**的历史。主进程独占文件系统访问，渲染进程只拿结果。
 */
export const SessionsInvokeChannel = {
  Discover: 'sessions:discover',
  RefreshPricing: 'sessions:refresh-pricing',
  /**
   * 把一场会话移入系统回收站（可恢复）。主进程会先重新扫描该 agent 并核对
   * id+path 确实是扫描结果里的一场，才执行 shell.trashItem —— 防止渲染进程
   * 借这条通道删任意路径。db 型存储（workbuddy）与合成路径（opencode）拒绝。
   */
  TrashSession: 'sessions:trash-session',
  /**
   * 在国内 WorkBuddy 里打开一场会话（`workbuddy://chat/<id>`）。
   * 省略 id 打开最近一场；给出 id 时必须仍在国内库的未删除记录里。
   * 不开国际版，也不走 CLI 的 planResume。
   */
  OpenWorkbuddy: 'sessions:open-workbuddy'
} as const

export interface SessionsTrashRequest {
  agent: AgentId
  id: string
  path: string
}

export interface SessionsTrashResult {
  ok: boolean
  message?: string
}

export interface SessionsOpenWorkbuddyRequest {
  /** 省略则打开国内库里最近一场。给出则必须是未删除的国内会话。 */
  id?: string
}

export interface SessionsOpenWorkbuddyResult {
  ok: boolean
  message: string
  sessionId?: string
  title?: string
}

export interface SessionsDiscoverRequest {
  /**
   * 只扫这些 agent。省略即全部 7 家。
   * 逐项校验，因为 renderer 的入参一律不可信。
   */
  agents?: AgentId[]
}

export interface SessionsApi {
  /** 扫全部（或指定的）agent 的历史。读盘很重，调用方要自己做缓存。 */
  discover: (request?: SessionsDiscoverRequest) => Promise<DiscoverResult>
  /**
   * 从 models.dev 重新拉价目表，落到我们自己的 userData 里。
   * 只收模型原厂渠道 —— 转售商的价格会让估算差一个数量级。
   */
  refreshPricing: () => Promise<PricingRefreshResult>
  /** 把一场会话移入系统回收站。主进程核对后才执行，见 TrashSession 注释。 */
  trash: (request: SessionsTrashRequest) => Promise<SessionsTrashResult>
  /** 在国内 WorkBuddy 里打开最近一场，或打开一条仍存在的国内会话。 */
  openWorkbuddy: (
    request?: SessionsOpenWorkbuddyRequest
  ) => Promise<SessionsOpenWorkbuddyResult>
}

export type RecordEventInput = Pick<
  HistoryEvent,
  'kind' | 'adapterId' | 'title' | 'detail'
>

/**
 * 主进程偏好文件 `<userData>/main-prefs.json` 的可写子集。
 * renderer 上报界面主题 bg.app、全局快捷键开关与界面语言。
 */
export type MainPrefsUpdate = Partial<{
  backgroundColor: string
  uiThemeId: string
  globalShortcutEnabled: boolean
  language: string
  floatingAppearance: FloatingAppearance
}>

export interface MainPrefsSnapshot {
  uiThemeId: string
  language: string
}

export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** 主进程持有的应用更新权威快照；每个 updater 事件直接覆盖当前阶段。 */
export interface UpdateSnapshot {
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  releaseDate: string | null
  releaseNotes: string | null
  progress: UpdateProgress | null
  checkedAt: number | null
  error: string | null
}

export const UpdateInvokeChannel = {
  GetState: 'update:get-state',
  Check: 'update:check',
  Download: 'update:download',
  Install: 'update:install'
} as const

export const UpdateEventChannel = {
  StateChanged: 'update:state-changed'
} as const

export type RemoteDesktopPhase =
  | 'idle'
  | 'connecting'
  | 'waiting-phone'
  | 'peer-online'
  | 'revoking'
  | 'error'

export type RemoteDesktopError =
  | 'invalid-url'
  | 'invalid-scheme'
  | 'insecure-remote'
  | 'invalid-room'
  | 'missing-room'
  | 'occupied'
  | 'bad-key'
  | 'revoked'
  | 'connect-failed'
  | 'not-connected'
  | 'revoke-unconfirmed'

export interface RemoteDesktopState {
  phase: RemoteDesktopPhase
  href: string | null
  origin: string | null
  error: RemoteDesktopError | null
  latencyMs: number | null
  uploadedBytes: number
  downloadedBytes: number
}

export const REMOTE_DESKTOP_IDLE_STATE: RemoteDesktopState = {
  phase: 'idle',
  href: null,
  origin: null,
  error: null,
  latencyMs: null,
  uploadedBytes: 0,
  downloadedBytes: 0
}

export const RemoteInvokeChannel = {
  Connect: 'remote:connect',
  Disconnect: 'remote:disconnect',
  Revoke: 'remote:revoke',
  GetState: 'remote:get-state',
  GetDriveState: 'remote:get-drive-state',
  Reclaim: 'remote:reclaim',
  SetRecentWorkspaces: 'remote:set-recent-workspaces',
  GetDshState: 'remote:get-dsh-state',
  SetDshEnabled: 'remote:set-dsh-enabled'
} as const

export const RemoteEventChannel = {
  StateChanged: 'remote:state-changed',
  DriveChanged: 'remote:drive-changed',
  DshStateChanged: 'remote:dsh-state-changed'
} as const

export interface RemoteDshState {
  enabled: boolean
  relaySupported: boolean
  surface: RemoteWebSurface | null
}

export type RemoteDriveState =
  | {
      phase: 'idle'
      sessionId: null
      terminalId: null
      cols: null
      rows: null
    }
  | {
      phase: 'driven'
      sessionId: string
      terminalId: string
      cols: number
      rows: number
    }

export const REMOTE_DRIVE_IDLE_STATE: RemoteDriveState = {
  phase: 'idle',
  sessionId: null,
  terminalId: null,
  cols: null,
  rows: null
}

export interface RemoteApi {
  connect: (joinUrl: string) => Promise<RemoteDesktopState>
  disconnect: () => Promise<RemoteDesktopState>
  revoke: () => Promise<RemoteDesktopState>
  getState: () => Promise<RemoteDesktopState>
  getDriveState: () => Promise<RemoteDriveState>
  reclaim: (sessionId: string) => Promise<RemoteDriveState>
  setRecentWorkspaces: (workspaces: string[]) => Promise<void>
  getDshState: () => Promise<RemoteDshState>
  setDshEnabled: (enabled: boolean) => Promise<RemoteDshState>
  onStateChange: (cb: (state: RemoteDesktopState) => void) => () => void
  onDriveStateChange: (cb: (state: RemoteDriveState) => void) => () => void
  onDshStateChange: (cb: (state: RemoteDshState) => void) => () => void
}

/**
 * 飞书渠道。
 *
 * 设计取向和 remote 那套一致：主进程是唯一的状态持有者，渲染进程只拿一份
 * 只读快照 + 订阅变更。**App Secret 永远不下发到渲染进程** —— 这里出现的
 * `appIdMasked` 是脱敏串，真实凭据只在主进程和磁盘上。
 */
export type FeishuDomain = 'feishu' | 'lark'

/** 直通 `@larksuiteoapi/node-sdk` 的 `WSClient.getConnectionStatus().state`。 */
export type FeishuConnectionState =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'failed'

export type FeishuPhase =
  /** 没有凭据，功能关闭。 */
  | 'unbound'
  /** 二维码已生成，等用户拿飞书扫。 */
  | 'scanning'
  /** 有凭据，长连接建立中。 */
  | 'connecting'
  /** 长连接在线，能收消息了。 */
  | 'connected'
  | 'error'

export interface FeishuScanTicket {
  /** 进程内轮询会话的句柄；只在这个进程里有意义。 */
  sessionKey: string
  /** 要渲染成二维码的地址（`https://open.feishu.cn/page/launcher?user_code=…`）。 */
  verificationUri: string
  /** 绝对时间戳（ms），到点自动作废。 */
  expiresAt: number
  /** 轮询间隔（秒），初值来自服务端 `interval`。 */
  intervalSeconds: number
}

/**
 * 连接成功之后的「下文」：自动建多维表格 + 同步会话历史 + 发引导卡。
 *
 * 之前做到「已连接」就停了 —— 用户问的是「对接了一个机器人，然后该怎么做呢」，
 * 这块就是答案的落点，`state` 描述的是**这一次**运行的结果（重连会重跑）。
 */
export type FeishuProvisionState = 'idle' | 'running' | 'done' | 'failed'

export interface FeishuProvisionInfo {
  state: FeishuProvisionState
  /** 多维表格的链接；建好才有。 */
  bitableUrl: string | null
  /** 这次同步进表里的会话数。 */
  synced: number | null
  error: string | null
  /** 缺 `bitable:app` 权限时的直达授权页，点一下就到，不用去翻菜单。 */
  permissionUrl: string | null
  /** 表都建好了、只是引导卡没发出去时单独记（不影响表本身）。 */
  welcomeError: string | null
  ranAt: number | null
}

export const FEISHU_PROVISION_IDLE: FeishuProvisionInfo = {
  state: 'idle',
  bitableUrl: null,
  synced: null,
  error: null,
  permissionUrl: null,
  welcomeError: null,
  ranAt: null
}

export interface FeishuStatus {
  phase: FeishuPhase
  /**
   * 磁盘上确实有凭据。
   *
   * 和 `phase` 是两件事：**扫码发生在绑定之前**，那时 `phase` 已经是
   * `scanning`，但一条凭据都还没有。UI 里凡是「只有绑定了才有意义」的区块
   * （准入名单、解绑按钮）都必须看这个字段，不能拿 `phase !== 'unbound'` 顶替
   * —— 那会让二维码还没扫完就冒出一堆空数据。
   */
  bound: boolean
  /** 脱敏后的 App ID，给人确认「连的是哪个机器人」；未绑定时为 null。 */
  appIdMasked: string | null
  domain: FeishuDomain | null
  boundAt: number | null
  connection: FeishuConnectionState
  /**
   * 最近一次收到飞书事件的时间戳。
   *
   * 这是**唯一的**「长连接真的活着」证据：连接状态是 SDK 的一面之词，
   * 而事件到达时间不会骗人。设置页拿它做过期提示。
   */
  lastEventAt: number | null
  /** 最近一次事件的简述（如「收到 ou_… 的消息」），**不含消息正文**。 */
  lastEventSummary: string | null
  /** 本进程内累计处理过的事件数。 */
  eventCount: number
  scan: FeishuScanTicket | null
  /** 已配对的飞书用户数。不等于 0 才可能有人驱使这台电脑。 */
  pairedUserCount: number
  /** 连接成功后的自动建档进度（多维表格 + 会话历史同步 + 引导卡）。 */
  provision: FeishuProvisionInfo
  /** 最近一次失败的原文（已过滤，不含凭据）。 */
  error: string | null
}

export const FEISHU_IDLE_STATUS: FeishuStatus = {
  phase: 'unbound',
  bound: false,
  appIdMasked: null,
  domain: null,
  boundAt: null,
  connection: 'idle',
  lastEventAt: null,
  lastEventSummary: null,
  eventCount: 0,
  scan: null,
  pairedUserCount: 0,
  provision: FEISHU_PROVISION_IDLE,
  error: null
}

export const FeishuInvokeChannel = {
  GetStatus: 'feishu:get-status',
  BeginScan: 'feishu:begin-scan',
  CancelScan: 'feishu:cancel-scan',
  /** 手填凭据的兜底通道：扫码走不通时用户仍然能自救。 */
  BindManual: 'feishu:bind-manual',
  Unbind: 'feishu:unbind',
  Reconnect: 'feishu:reconnect',
  UnpairUser: 'feishu:unpair-user'
} as const

export const FeishuEventChannel = {
  StatusChanged: 'feishu:status-changed'
} as const

export interface FeishuManualBindInput {
  appId: string
  appSecret: string
  domain: FeishuDomain
}

export interface FeishuApi {
  getStatus: () => Promise<FeishuStatus>
  beginScan: () => Promise<FeishuStatus>
  cancelScan: () => Promise<FeishuStatus>
  bindManual: (input: FeishuManualBindInput) => Promise<FeishuStatus>
  unbind: () => Promise<FeishuStatus>
  reconnect: () => Promise<FeishuStatus>
  unpairUser: (openId: string) => Promise<FeishuStatus>
  onStatusChange: (cb: (status: FeishuStatus) => void) => () => void
}

export const AppInvokeChannel = {
  SetMainPrefs: 'app:set-main-prefs'
} as const

export const AppEventChannel = {
  OpenNewSession: 'app:open-new-session',
  FocusSession: 'app:focus-session',
  MainPrefsChanged: 'app:main-prefs-changed',
  BridgeLaunch: 'bridge:launch',
  RemoteLaunch: 'remote:launch'
} as const

export const BridgeInvokeChannel = {
  LaunchResult: 'bridge:launch-result'
} as const

export interface FocusSessionPayload {
  sessionId: string
  terminalId: string
}

export const ThemeEventChannel = {
  UserThemesChanged: 'theme:user-themes-changed'
} as const

// ───── Main → Renderer（webContents.send，事件流）─────────
export const WindowEventChannel = {
  MaximizedChanged: 'window:maximized-changed',
  FullScreenChanged: 'window:full-screen-changed',
  PositionChanged: 'window:position-changed'
} as const

export const ptyDataChannel = (ptyId: string): string => `pty:data:${ptyId}`
export const ptyExitChannel = (ptyId: string): string => `pty:exit:${ptyId}`
export const ptyResizeCursorSyncChannel = (ptyId: string): string =>
  `pty:resize-cursor-sync:${ptyId}`

// ───── preload 暴露给 renderer 的收窄 API 形状 ────────────
export interface PtyApi {
  /** 同步返回平台元信息（Terminal 构造前需要 windowsPty）。 */
  getMeta: () => PtyMeta
  spawn: (opts: SpawnOptions) => Promise<SpawnResult>
  /** 原子重置旧 renderer 的背压账本并取回权威历史。 */
  attach: (ptyId: string) => Promise<PtyHistorySnapshot | null>
  listRecoverable: () => Promise<RecoverablePty[]>
  write: (ptyId: string, data: string) => Promise<void>
  resize: (ptyId: string, cols: number, rows: number) => Promise<void>
  kill: (ptyId: string) => Promise<void>
  killTerminal: (terminalId: string) => Promise<void>
  ack: (ptyId: string, bytes: number) => Promise<void>
  /** 读取主进程中 resize 免疫的原始历史快照。 */
  getHistory: (ptyId: string) => Promise<PtyHistorySnapshot | null>
  /** 读取 M2 背压水位；供诊断与压力测试使用。 */
  getFlowControl: (ptyId: string) => Promise<PtyFlowControlSnapshot | null>
  /** 注册 pty 输出回调，返回取消订阅函数（cleanup 必调，防 channel 泄漏）。 */
  onData: (ptyId: string, cb: (data: Uint8Array) => void) => () => void
  onResizeCursorSync: (
    ptyId: string,
    cb: (payload: PtyResizeCursorSync) => void
  ) => () => void
  onExit: (ptyId: string, cb: (payload: ExitPayload) => void) => () => void
  /** 把终端 resize 诊断写入统一的本机诊断日志。 */
  diagLog: (line: string) => Promise<void>
}

export interface ClipboardApi {
  /** 把纯文本写入系统剪贴板。 */
  writeText: (text: string) => Promise<void>
  /** 图片只暴露类型事实；文本由 xterm 以 bracketed paste 语义写入 PTY。 */
  readForTerminalPaste: () => Promise<TerminalClipboardPaste>
}

export interface WindowApi {
  /** Renderer uses this only to select native/custom title-bar controls. */
  platform: string
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  onMaximizedChange: (cb: (maximized: boolean) => void) => () => void
  isFullScreen: () => Promise<boolean>
  onFullScreenChange: (cb: (fullScreen: boolean) => void) => () => void
  getPosition: () => Promise<WindowPositionPayload>
  onPositionChange: (
    cb: (position: WindowPositionPayload) => void
  ) => () => void
}

export interface ThemeApi {
  listUser: () => Promise<UserThemeFile[]>
  saveCustom: (source: string) => Promise<void>
}

export interface DialogApi {
  pickDirectory: (request: DirectoryPickerRequest) => Promise<string | null>
}

export interface TerminalBackgroundApi {
  pick: () => Promise<TerminalBackgroundPickResult | null>
  clear: () => Promise<void>
}

export interface ShellApi {
  listAvailable: () => Promise<ShellOption[]>
}

export interface CliApi {
  scan: (force?: boolean) => Promise<CliScanReport>
  /** Returns a validated explicit workspace, or the selected runtime's Home. */
  resolveWorkspace: (installationId: string, workspace: string) => Promise<string>
  prepareLaunch: (selection: CliLaunchSelection) => Promise<SpawnOptions>
}

export interface StatsApi {
  /** all-time 聚合计数（统计文件单调累加，独立于日志截断）。 */
  allTime: () => Promise<AllTimeStats>
  /** 按 occurredAt 降序查询历史事件，`before` 游标支持分页。 */
  historyEvents: (query: HistoryQuery) => Promise<HistoryEvent[]>
  /** 写入口：id/occurredAt 由主进程生成。 */
  recordEvent: (input: RecordEventInput) => Promise<void>
}

export interface BridgeLaunchRequest {
  requestId: string
  terminalId: string
  name: string
  workspace: string
  selection: CliLaunchSelection
  /**
   * 这个终端属于哪个 adapter（`grok` / `codex` / `claude` / `opencode`…）。
   * renderer 用它当 `shellId`，否则所有主进程发起的启动都会被当成 OpenCode
   * （`RemoteVisibleLaunchRequest` 早就带了同一个字段，这里补齐）。
   */
  adapterId?: string
  /** 主进程已 spawn 时带上，renderer 只 attach，不再等 xterm 才 start。 */
  ptyId?: string
}

export interface BridgeLaunchAck {
  requestId: string
  error: string | null
}

export interface RemoteVisibleLaunchRequest {
  terminalId: string
  name: string
  adapterId: string
  workspace: string
  selection: CliLaunchSelection
  ptyId: string
}

export interface AppApi {
  /** 上报主进程偏好（backgroundColor / globalShortcutEnabled / language）。 */
  setMainPrefs: (update: MainPrefsUpdate) => Promise<void>
  /** 托盘「新建会话」菜单触发；与 Ctrl+Shift+T 同路径。 */
  onOpenNewSession: (cb: () => void) => () => void
  /** 悬浮窗条目 → 主窗口恢复并进入既有 Session terminal。 */
  onFocusSession: (cb: (payload: FocusSessionPayload) => void) => () => void
  onMainPrefsChanged: (cb: (prefs: MainPrefsSnapshot) => void) => () => void
  /** Bridge create：主进程请 renderer 打开可见 OpenCode tab。 */
  onBridgeLaunch: (cb: (request: BridgeLaunchRequest) => void) => () => void
  /** Remote create：主进程已 spawn，renderer 只显示并 attach tab。 */
  onRemoteLaunch: (
    cb: (request: RemoteVisibleLaunchRequest) => void
  ) => () => void
  reportBridgeLaunch: (ack: BridgeLaunchAck) => Promise<void>
}

export interface UpdateApi {
  getState: () => Promise<UpdateSnapshot>
  check: () => Promise<UpdateSnapshot>
  download: () => Promise<UpdateSnapshot>
  install: () => Promise<void>
  onStateChanged: (cb: (snapshot: UpdateSnapshot) => void) => () => void
}

export interface AppThemeApi {
  /** 用户主题目录变更（新增/修改/删除）后由主进程推送。 */
  onUserThemesChanged: (cb: () => void) => () => void
}
