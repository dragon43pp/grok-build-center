/**
 * OpenCode Bridge 契约（SPEC-OPENCODE-BRIDGE）。
 * CLI 与主进程共用同一套请求/响应/事件形状。
 *
 * ⚠️ 2026-09-30 起这套契约**不再只服务 OpenCode**。为了能从飞书那侧恢复历史
 * 会话、并继续跟活着的会话对话，新增了三个能力（都是**增量**扩展，老调用方
 * 不受影响）：
 *   · `sessions.list` 现在覆盖全部 adapter（原先只列 opencode）；每一项多了
 *     `adapterId` 与 `controllable`，用来区分「能原生控制（opencode）」与
 *     「只能往终端里打字（grok/codex/claude）」。
 *   · `sessions.history` —— 列**历史**会话（只读，来自各 CLI 自己落在磁盘上的
 *     记录），这是「恢复一场过去的对话」的入口。
 *   · `session.resume` —— 按历史会话 id 起一个新终端并在其中恢复该会话。
 *
 * 顺带放宽两条**不需要私有控制面**的老方法（它们只动我们自己开的那个终端）：
 * `session.close` 现在能关任意 adapter 的会话，`session.rename` 能改任意会话
 * 在侧边栏里的名字（OpenCode 自己那份标题改不了时只报告、不报错）。
 * 其余 P2 方法（approve / deny / questions / answer / mode / turn / watch）
 * 仍然只认 OpenCode —— 它们吃的就是 OpenCode 的消息表和权限接口。
 *
 * `session.send` 的语义也随之放宽：有 `ObserverControl` 的（opencode）走原生
 * `submitPrompt`；**没有的走往 PTY 写入**，等价于替人在终端里敲这行字并回车。
 * 后者是通用做法（grok/codex/claude 都是 TUI，没有私有控制面），但也意味着
 * 拿到 token 的本地进程可以驱动这些 CLI —— 与 `session.send` 对 opencode 的
 * 既有能力同级，不再额外收窄。
 */

import type { CliRuntime } from './ipc-contract'

export const BRIDGE_PROTOCOL_VERSION = 1 as const

export const MODEL_ID_PATTERN =
  /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:+-]*$/

export const SEND_TEXT_LIMIT_BYTES = 64 * 1024
export const DELTA_TEXT_LIMIT_BYTES = 64 * 1024
export const DELTA_TOOL_JSON_LIMIT_BYTES = 32 * 1024
export const DELTA_TOOL_LIMIT = 64
export const DELTA_PACKET_LIMIT_BYTES = 256 * 1024
export const SESSION_NAME_LIMIT = 128

export type BridgeAgent = 'build' | 'plan'

export type BridgeRuntime = CliRuntime

export interface BridgeModel {
  id: string
  provider: string
  model: string
  label?: string
}

export interface BridgeDelta {
  text: string
  tools: BridgeToolDelta[]
  truncated?: boolean
}

export interface BridgeToolDelta {
  name: string
  callId: string
  input?: unknown
  output?: unknown
  error?: string
}

export interface BridgeBlocked {
  kind: 'permission' | 'question' | 'other'
  requestId?: string
  summary?: string
  form?: unknown
}

export interface BridgeWatchEvent {
  v: 1
  type: 'blocked' | 'turn' | 'failed' | 'exited'
  sessionId: string
  installationId: string
  runtime: BridgeRuntime
  status: 'needs-you' | 'done' | 'idle' | 'error' | 'exited'
  delta: BridgeDelta
  blocked?: BridgeBlocked
  error?: { message: string }
  occurredAt: number
}

export interface BridgeSessionInfo {
  sessionId: string
  terminalId: string
  name: string
  status: string
  agent?: BridgeAgent
  model?: string
  workspace: string
  installationId: string
  runtime: BridgeRuntime
  pendingAttentionCount: number
  /** 哪个 CLI（`grok` / `codex` / `claude` / `opencode`…）。2026-09-30 新增。 */
  adapterId?: string
  /**
   * 能不能**原生**控制（审批、结构化提问、读回消息）。只有 opencode 为 true；
   * 其它 CLI 仍是可用的 —— `session.send` 会退化成往 PTY 打字。
   */
  controllable?: boolean
  /**
   * 现在能不能真的接收 `session.send`。
   *
   * 判据是「这个终端的子进程有没有产生过输出」—— TUI 一起来就会画界面，
   * 一个字节都没输出过就说明里面的程序还没起来。**注意它和实测到的吞字现象
   * 无关**，别把两件事混起来：
   *
   *   · 观测到过一次吞字：resume 之后一次 send 进了 TUI 的
   *     `Reply with exactly: bridge-ok` 变成 ` with exactly: bridge-ok`（开头 5 个
   *     字符没了）。但**没能复现**——受控实验里 resume 返回后 0.24s 就发，
   *     30 个字符一个不少；同一场会话隔几分钟再发也完好。所以原因至今未明，
   *     唯一可疑的外部变量是：那个终端当时有**人在打字**（同一场会话紧接着
   *     出现了一条我没发过的 `继续`）。别拿这个字段当解药。
   *   · 这个字段自己的价值很朴素：CLI 还没画出界面时打字是没有意义的。
   *     实测闸门在 spawn 后约 6 秒打开，而且**早于 `session.resume` 返回**，
   *     所以正常调用链不会撞上它；它拦的是「拿 terminalId 直接乱写」。
   */
  ready?: boolean
}

/** 为什么这场历史会话**不能**由桥恢复。上游要本地化时读这个，别解析文案。 */
export type BridgeHistoryBlockedCode =
  /** 子代理会话：它属于另一场会话，单独恢复没有意义。 */
  | 'subagent'
  /** 会话没有可用的 id（拿不到就无从 `--resume`）。 */
  | 'no-session-id'
  /** 这个 CLI 的恢复命令本机没实测过。 */
  | 'no-resume-command'
  /**
   * 会话没记工作目录。**注意这一条与 App 内的行为不同**：App 里可以由人
   * 自己挑一个目录再恢复（`SessionHistoryPage` → 新建面板），而桥这边没有
   * 能挑目录的人，所以判为不可恢复 —— 否则会在 Home 里静默起一个会话
   * （`resolveWorkspace('')` 的语义就是 Home）。
   */
  | 'no-workspace'

/**
 * 一场**历史**会话（磁盘上留下的记录，不是活进程）。
 *
 * 与 `BridgeSessionInfo` 的区别：那个是「现在开着的」，这个是「过去发生过的」。
 * 恢复（`session.resume`）吃的就是这个 id。
 */
export interface BridgeHistorySession {
  /** `grok` / `codex` / `claude` …，与 `AGENT_IDS` 同域。 */
  agent: string
  sessionId: string
  title: string
  /** 项目目录，'' 表示该 CLI 没记。 */
  workspace: string
  /** ISO 时间串，缺省表示该 CLI 没记。 */
  updatedAt?: string
  messageCount: number
  /**
   * **这个桥能不能直接恢复它** —— 即 `session.resume` 用这个 id 会不会成功。
   * 判据是「恢复命令本机实测过 + 有 id + 非子代理 + 有工作目录」；
   * 「这个 CLI 装没装」不在这里面（它随机器变化，且一次扫描比逐条判断便宜）。
   */
  resumable: boolean
  /** `resumable=false` 时说明为什么。机器可读。 */
  blockedCode?: BridgeHistoryBlockedCode
  /** `resumable=false` 时的中文说明，直接可展示给用户。 */
  blockedReason?: string
}

export interface BridgeResumeResult {
  /** 要恢复的那场历史会话。 */
  historySessionId: string
  agent: string
  workspace: string
  installationId: string
  /** 最终要执行的参数，例如 `['--resume', '<uuid>']`。 */
  args: string[]
  /** `true` 时只算参数、不启动任何进程（给飞书做预览，也给测试用）。 */
  dryRun: boolean
  /** 新开的终端 id；`dryRun=true` 时为 null。 */
  terminalId: string | null
  /** 启动后拿到的新活会话 id；`dryRun=true` 或还没就绪时为 null。 */
  sessionId: string | null
}

export interface BridgeModelsResult {
  installationId: string
  runtime: BridgeRuntime
  models: BridgeModel[]
}

export interface BridgeCreateResult {
  sessionId: string
  terminalId: string
  name: string
  model: string
  agent: BridgeAgent
  workspace: string
  installationId: string
  runtime: BridgeRuntime
}

export interface BridgeTurnResult {
  sessionId: string
  installationId: string
  runtime: BridgeRuntime
  delta: BridgeDelta
}

export const P1_METHODS = [
  'opencode.models',
  'opencode.create',
  'sessions.list',
  'session.send',
  'session.turn',
  'session.watch',
  'session.close'
] as const

export const P2_METHODS = [
  'session.rename',
  'session.mode',
  'session.approve',
  'session.deny',
  'session.questions',
  'session.answer',
  'session.reject-question',
  'session.wait'
] as const

/**
 * P3：为「从外部（飞书）恢复并继续对话」加的能力。
 *
 * 单独一批而不是塞进 P1/P2，是因为它们的**对端假设不同**：P1/P2 建立在对
 * OpenCode 私有控制面的依赖上，而这三条对 grok/codex/claude 同样成立 ——
 * 恢复靠 `--resume`，继续对话靠往 PTY 打字。
 */
export const P3_METHODS = ['sessions.history', 'session.resume'] as const

export type BridgeP1Method = (typeof P1_METHODS)[number]
export type BridgeP2Method = (typeof P2_METHODS)[number]
export type BridgeP3Method = (typeof P3_METHODS)[number]
export type BridgeMethod = BridgeP1Method | BridgeP2Method | BridgeP3Method

export interface BridgeRequest {
  id: string
  token: string
  method: string
  params?: unknown
}

export type BridgeSocketMessage =
  | { kind: 'result'; id: string; ok: true; result: unknown }
  | { kind: 'result'; id: string; ok: false; error: BridgeErrorBody }
  | { kind: 'event'; id: string; event: BridgeWatchEvent }

export interface BridgeErrorBody {
  code: string
  message: string
}

export const BRIDGE_ERROR = {
  notImplemented: 'not-implemented',
  invalid: 'invalid',
  notFound: 'not-found',
  notAllowed: 'not-allowed',
  unavailable: 'unavailable',
  unauthorized: 'unauthorized',
  uncontrolled: 'uncontrolled',
  timeout: 'timeout',
  disconnected: 'disconnected'
} as const

export type {
  BridgeLaunchAck,
  BridgeLaunchRequest
} from './ipc-contract'
