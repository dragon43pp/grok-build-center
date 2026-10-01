import { randomUUID } from 'node:crypto'
import type { CliInstallation, CliScanReport } from '../../shared/ipc-contract'
import {
  MODEL_ID_PATTERN,
  SEND_TEXT_LIMIT_BYTES,
  SESSION_NAME_LIMIT,
  type BridgeAgent,
  type BridgeBlocked,
  type BridgeCreateResult,
  type BridgeDelta,
  type BridgeHistoryBlockedCode,
  type BridgeHistorySession,
  type BridgeLaunchRequest,
  type BridgeModelsResult,
  type BridgeResumeResult,
  type BridgeRuntime,
  type BridgeSessionInfo,
  type BridgeTurnResult,
  type BridgeWatchEvent
} from '../../shared/bridge-protocol'
import type { AgentId, HistorySession } from '../../shared/session-history'
import { AGENT_IDS, sortSessions } from '../../shared/session-history'
import { planResume } from '../../shared/session-resume'
import type {
  AgentSessionPhase,
  AgentSessionRecord
} from '../agents/AgentSessionRuntime'
import type { ObserverControl } from '../agents/adapters/types'
import {
  collectKeys,
  cursorBeforeLastTurn,
  emptyCursor,
  extractLastClosedTurn,
  extractSinceCursor,
  parseOpenCodeMessages,
  type MessageCursor
} from '../agents/adapters/opencode/OpenCodeMessages'
import { byteLength, emptyDelta, isEmptyDelta, truncateDelta } from './delta'
import { BridgeError } from './errors'
import { parseOpenCodeModelsOutput } from './models'
import type { BridgeStateStore } from './state'

const MODELS_TIMEOUT_MS = 15_000
const CREATE_TIMEOUT_MS = 45_000
const CREATE_POLL_MS = 100
const SNAPSHOT_RETRIES = 3
const SNAPSHOT_RETRY_MS = 150
/**
 * 恢复时等新终端登记进 runtime 的上限。比 `CREATE_TIMEOUT_MS` 短是因为恢复
 * 只是「起一个 TUI」，不需要等 OpenCode 的控制面握手；超时也不报错 ——
 * 终端确实已经开出来了，只是还没和 sessionId 对上（见 `resume` 的返回注释）。
 */
const RESUME_RECORD_TIMEOUT_MS = 20_000
const RESUME_POLL_MS = 150
const HISTORY_LIMIT_DEFAULT = 50
const HISTORY_LIMIT_MAX = 500
/** 历史扫描一次要读七种 CLI 的目录（冷 Codex 扫描最重），挡一下密集刷新。 */
const HISTORY_CACHE_MS = 5_000

/**
 * 「不能恢复」的中文说明。⚠️ 这里**故意不做多语言**：桥是给本机外部进程
 * （飞书那侧）用的，它拿不到、也不该猜 App 当前的语言。要本地化就按
 * `blockedCode` 自己翻 —— 同样几句话在 `src/app/i18n/*.ts` 里有权威版本，
 * 那边改文案时这里要跟着改（两处都保留是因为主进程不能 import renderer 的 i18n）。
 */
const RESUME_BLOCKER_TEXT: Record<BridgeHistoryBlockedCode, string> = {
  subagent: '子代理会话属于另一场会话，单独恢复没有意义',
  'no-session-id': '这场会话没有可用的 id',
  'no-resume-command': '这个 CLI 的恢复命令本机没实测过，先不提供',
  'no-workspace': '这场会话没记工作目录，从桥恢复会在错误目录里开工（请在本 App 里恢复）'
}

export interface ControlPlaneDiscovery {
  scan(force?: boolean): Promise<CliScanReport>
  resolveInstallation(installationId: string): Promise<CliInstallation | null>
  resolveWorkspace(installationId: string, workspace: string): Promise<string>
  runInstallationCommand(
    installation: CliInstallation,
    args: readonly string[],
    timeoutMs?: number
  ): Promise<{
    stdout: string
    stderr: string
    timedOut: boolean
    code: number | null
  }>
}

export interface ControlPlaneRuntime {
  getRecord(sessionId: string): AgentSessionRecord | null
  listRecords(): AgentSessionRecord[]
  subscribe(
    listener: (record: AgentSessionRecord, phase: AgentSessionPhase) => void
  ): () => void
  observerControl(sessionId: string): ObserverControl | undefined
  stop(sessionId: string): Promise<void>
  rename(sessionId: string, name: string): { name?: string } | null
  setAgent(sessionId: string, agent: BridgeAgent): void
}

export interface OpenCodeControlPlaneDeps {
  discovery: ControlPlaneDiscovery
  runtime: ControlPlaneRuntime
  state: BridgeStateStore
  requireForegroundWindow(): void
  launchVisible(request: BridgeLaunchRequest): Promise<string | null>
  /**
   * 读历史会话（磁盘上各 CLI 自己留下的记录）。由 main 接
   * `discoverSessions()`；缺省时 `sessions.history` 报 not-implemented，
   * 别的能力不受影响（e2e 里只造了 PTY/控制面，没造磁盘）。
   */
  history?(): Promise<HistorySession[]>
  /**
   * 这个终端里的程序有没有产生过输出 —— 也就是「它起来了没」。
   *
   * 判的是「子进程写过任何东西」，不是「有人订阅过输出」：后者在没人 attach
   * 时永远是 false，会把正常会话永久判成没起来。
   *
   * ⚠️ 别把这个当成「吞字 bug 的解药」。观测到过一次开头 5 个字符被吞，但受控
   * 实验（resume 返回后 0.24s 就发）完全没能复现，原因至今不明；当时的终端里
   * 还有人在打字。这个探针的价值只是「CLI 界面还没画出来时别打字」，
   * 实测约 6 秒就打开、且早于 `session.resume` 返回。
   */
  terminalReady?(terminalId: string): boolean
  /**
   * 往一个已经开着的终端里写字 —— 等价于替人在键盘上敲。
   * 返回 false 表示那个终端已经没了（`PTYManager.write` 找不到 pty 时是**静默**
   * 返回的，所以这里必须由实现方断言存活，不能靠它自己报错）。
   *
   * 这是 grok/codex/claude 唯一的「继续对话」通道：它们是 TUI，没有 OpenCode
   * 那样的私有控制面。缺省时 `session.send` 对这类会话报 uncontrolled。
   */
  writeTerminal?(terminalId: string, data: string): boolean
  now?: () => number
}

export type WatchHandler = (event: BridgeWatchEvent) => void

interface WatchSubscriber {
  sessionId: string
  emit: WatchHandler
  close: (error?: Error) => void
  cursor: MessageCursor
  lastBlockedKey: string | null
  hadActivity: boolean
  closed: boolean
  busy: boolean
  pending: { record: AgentSessionRecord; phase: AgentSessionPhase } | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asAgent(value: unknown): BridgeAgent {
  if (value === undefined || value === null || value === '') return 'build'
  if (value === 'build' || value === 'plan') return value
  throw BridgeError.invalid('agent must be build or plan')
}

function requiredAgent(value: unknown): BridgeAgent {
  if (value === 'build' || value === 'plan') return value
  throw BridgeError.invalid('agent must be build or plan')
}

function parseApprovalRequestId(
  requestId: string
): { nativeSessionId: string; nativePermissionId: string } | null {
  const match = /^opencode:(.+):approval:(.+)$/.exec(requestId)
  return match
    ? { nativeSessionId: match[1], nativePermissionId: match[2] }
    : null
}

function parseInputRequestId(
  requestId: string
): { nativeSessionId: string; nativeQuestionId: string } | null {
  const match = /^opencode:(.+):input:(.+)$/.exec(requestId)
  return match
    ? { nativeSessionId: match[1], nativeQuestionId: match[2] }
    : null
}

function isHttpMissing(error: unknown): boolean {
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status?: number }).status === 404
  ) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP 404|not found/i.test(message)
}

function questionSummary(item: Record<string, unknown>): string | undefined {
  const questions = Array.isArray(item.questions) ? item.questions : []
  const first = questions[0]
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const record = first as Record<string, unknown>
    if (typeof record.header === 'string' && record.header.trim()) {
      return record.header.trim()
    }
    if (typeof record.question === 'string' && record.question.trim()) {
      return record.question.trim()
    }
  }
  if (typeof item.summary === 'string' && item.summary.trim()) return item.summary
  if (typeof item.prompt === 'string' && item.prompt.trim()) return item.prompt
  return undefined
}

type WaitUntil = 'blocked' | 'turn' | 'exited'

function asWaitUntil(value: unknown): WaitUntil {
  if (value === 'blocked' || value === 'turn' || value === 'exited') return value
  throw BridgeError.invalid('until must be blocked, turn, or exited')
}

function matchesWait(type: BridgeWatchEvent['type'], until: WaitUntil): boolean {
  if (until === 'blocked') return type === 'blocked'
  if (until === 'turn') return type === 'turn'
  return type === 'exited' || type === 'failed'
}

function boundedName(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'OpenCode'
  if (typeof value !== 'string') throw BridgeError.invalid('name must be a string')
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  if (!name) return 'OpenCode'
  if (name.length > SESSION_NAME_LIMIT) {
    throw BridgeError.invalid(`name must be 1–${SESSION_NAME_LIMIT} characters`)
  }
  return name
}

function describeBlocked(record: AgentSessionRecord): BridgeBlocked {
  const approvals = Object.entries(record.projection.correlation.pendingApprovals)
  if (approvals[0]) {
    const [requestId, info] = approvals[0]
    return {
      kind: 'permission',
      requestId,
      summary: info.summary ?? info.category
    }
  }
  const inputs = Object.entries(record.projection.correlation.pendingInputs)
  if (inputs[0]) {
    const [requestId, info] = inputs[0]
    return {
      kind: 'question',
      requestId,
      summary: info.prompt,
      form: info.prompt ? { prompt: info.prompt } : undefined
    }
  }
  return { kind: 'other', summary: record.projection.detail }
}

function runtimeOf(installation: CliInstallation): BridgeRuntime {
  return installation.runtime
}

export class OpenCodeControlPlane {
  private readonly lastClosedTurns = new Map<string, BridgeDelta>()
  private readonly watches = new Map<string, Set<WatchSubscriber>>()
  private readonly unsubscribe: () => void
  private readonly now: () => number
  private historyCache: { at: number; value: HistorySession[] } | null = null
  private historyInFlight: Promise<HistorySession[]> | null = null

  constructor(private readonly deps: OpenCodeControlPlaneDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.unsubscribe = deps.runtime.subscribe((record, phase) => {
      if (record.adapterId === 'opencode') {
        void this.deps.state.rememberInstallation(record.installationId)
      }
      void this.dispatchWatch(record, phase)
    })
  }

  dispose(): void {
    this.unsubscribe()
    for (const subscribers of this.watches.values()) {
      for (const subscriber of subscribers) {
        if (!subscriber.closed) subscriber.close()
      }
    }
    this.watches.clear()
    this.lastClosedTurns.clear()
    this.historyCache = null
  }

  async handle(
    method: string,
    params: unknown
  ): Promise<{ kind: 'json'; value: unknown } | { kind: 'watch'; sessionId: string }> {
    switch (method) {
      case 'opencode.models':
        return { kind: 'json', value: await this.models(params) }
      case 'opencode.create':
        return { kind: 'json', value: await this.create(params) }
      case 'sessions.list':
        return { kind: 'json', value: await this.sessions() }
      case 'session.send':
        return { kind: 'json', value: await this.send(params) }
      case 'session.turn':
        return { kind: 'json', value: await this.turn(params) }
      case 'session.watch':
        return { kind: 'watch', sessionId: this.watchSessionId(params) }
      case 'session.close':
        return { kind: 'json', value: await this.close(params) }
      case 'session.rename':
        return { kind: 'json', value: await this.rename(params) }
      case 'session.mode':
        return { kind: 'json', value: await this.mode(params) }
      case 'session.approve':
        return { kind: 'json', value: await this.approve(params) }
      case 'session.deny':
        return { kind: 'json', value: await this.deny(params) }
      case 'session.questions':
        return { kind: 'json', value: await this.questions(params) }
      case 'session.answer':
        return { kind: 'json', value: await this.answer(params) }
      case 'session.reject-question':
        return { kind: 'json', value: await this.rejectQuestion(params) }
      case 'session.wait':
        return { kind: 'json', value: await this.wait(params) }
      case 'sessions.history':
        return { kind: 'json', value: await this.history(params) }
      case 'session.resume':
        return { kind: 'json', value: await this.resume(params) }
      default:
        throw BridgeError.invalid(`Unknown method: ${method}`)
    }
  }

  watch(
    sessionId: string,
    emit: WatchHandler,
    close: (error?: Error) => void
  ): () => void {
    const record = this.requireOpenCode(sessionId)
    const subscriber: WatchSubscriber = {
      sessionId,
      emit,
      close,
      cursor: emptyCursor(),
      lastBlockedKey: null,
      hadActivity: record.projection.status === 'working',
      closed: false,
      busy: false,
      pending: null
    }
    let set = this.watches.get(sessionId)
    if (!set) {
      set = new Set()
      this.watches.set(sessionId, set)
    }
    set.add(subscriber)
    queueMicrotask(() => {
      void this.primeWatch(subscriber)
    })
    return () => {
      subscriber.closed = true
      set?.delete(subscriber)
      if (set && set.size === 0) this.watches.delete(sessionId)
    }
  }

  private watchSessionId(params: unknown): string {
    const sessionId = this.stringParam(params, 'sessionId', true)
    this.requireOpenCode(sessionId)
    return sessionId
  }

  async models(params: unknown): Promise<BridgeModelsResult> {
    const installation = await this.resolveOpenCodeInstallation(
      this.optionalString(params, 'installationId')
    )
    const result = await this.deps.discovery.runInstallationCommand(
      installation,
      ['models'],
      MODELS_TIMEOUT_MS
    )
    if (result.timedOut) {
      throw BridgeError.timeout('opencode models timed out')
    }
    if (result.code !== 0 && result.code !== null && result.stdout.trim() === '') {
      throw BridgeError.unavailable(
        result.stderr.trim() || 'opencode models failed'
      )
    }
    return {
      installationId: installation.id,
      runtime: runtimeOf(installation),
      models: parseOpenCodeModelsOutput(result.stdout)
    }
  }

  async create(params: unknown): Promise<BridgeCreateResult> {
    const workspaceInput = this.stringParam(params, 'workspace', true)
    const model = this.stringParam(params, 'model', true)
    const agent = asAgent(this.optionalString(params, 'agent'))
    const name = boundedName(this.optionalString(params, 'name'))
    if (!MODEL_ID_PATTERN.test(model)) {
      throw BridgeError.invalid(`Invalid model id: ${model}`)
    }

    const installation = await this.resolveOpenCodeInstallation(
      this.optionalString(params, 'installationId')
    )
    const listed = await this.models({ installationId: installation.id })
    if (listed.models.length === 0) {
      throw BridgeError.unavailable(
        'No OpenCode models available; run /connect in OpenCode first'
      )
    }
    if (!listed.models.some((item) => item.id === model)) {
      throw BridgeError.invalid(`Model is not in the installation list: ${model}`)
    }

    const workspace = await this.deps.discovery.resolveWorkspace(
      installation.id,
      workspaceInput
    )
    this.deps.requireForegroundWindow()

    const terminalId = randomUUID()
    const requestId = randomUUID()
    const args = [workspace, '-m', model, '--agent', agent]
    const launchError = await this.deps.launchVisible({
      requestId,
      terminalId,
      name,
      workspace,
      selection: {
        installationId: installation.id,
        workspace,
        args
      }
    })
    if (launchError) throw BridgeError.unavailable(launchError)

    const startedAt = this.now()
    let record: AgentSessionRecord | null = null
    while (this.now() - startedAt < CREATE_TIMEOUT_MS) {
      record =
        this.deps.runtime
          .listRecords()
          .find((item) => item.terminalId === terminalId) ?? null
      if (record) break
      await sleep(CREATE_POLL_MS)
    }
    if (!record) {
      throw BridgeError.unavailable(
        'Timed out waiting for the OpenCode tab to register'
      )
    }
    await this.deps.state.rememberInstallation(installation.id)
    return {
      sessionId: record.sessionId,
      terminalId: record.terminalId,
      name: record.name || name,
      model,
      agent,
      workspace: record.workspace,
      installationId: installation.id,
      runtime: runtimeOf(installation)
    }
  }

  async close(params: unknown): Promise<{ sessionId: string; closed: true }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    // 关掉的是**我们开的那个终端**，不需要任何私有控制面，所以这里不看
    // adapter —— 否则从飞书看见一场 grok 卡住了却关不掉它。
    this.requireSession(sessionId)
    await this.deps.runtime.stop(sessionId)
    this.lastClosedTurns.delete(sessionId)
    this.historyCache = null
    return { sessionId, closed: true }
  }

  /**
   * 改名。侧边栏那一份是我们的，任何 adapter 都能改；OpenCode 自己那份标题
   * 只能顺带更新（没有控制面就只改本地，并在返回里说明，不报错 —— 下面这段
   * 逻辑本来就容忍 `control` 缺失）。
   */
  async rename(params: unknown): Promise<{
    sessionId: string
    name: string
    titleUpdated: boolean
    error?: { message: string }
  }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const name = this.requiredName(params)
    this.requireSession(sessionId)
    const renamed = this.deps.runtime.rename(sessionId, name)
    if (!renamed) throw BridgeError.invalid('Could not rename session')
    let titleUpdated = false
    let error: { message: string } | undefined
    const control = this.deps.runtime.observerControl(sessionId)
    if (!control?.setTitle) {
      error = {
        message: 'OpenCode session is not controllable; TUI is still available'
      }
    } else {
      try {
        await control.setTitle(name)
        titleUpdated = true
      } catch (caught) {
        error = {
          message: caught instanceof Error ? caught.message : String(caught)
        }
      }
    }
    return {
      sessionId,
      name: renamed.name || name,
      titleUpdated,
      ...(error ? { error } : {})
    }
  }

  async mode(
    params: unknown
  ): Promise<{ sessionId: string; agent: BridgeAgent }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const agent = requiredAgent(this.optionalString(params, 'agent'))
    const record = this.requireOpenCode(sessionId)
    if (record.projection.status === 'exited') {
      throw BridgeError.notAllowed('Cannot change mode on an exited session')
    }
    const control = this.requireControl(sessionId)
    if (!control.setAgent) {
      throw BridgeError.uncontrolled(
        'OpenCode has no write API to set plan/build; TUI is still available'
      )
    }
    try {
      await control.setAgent(agent)
    } catch (error) {
      throw BridgeError.uncontrolled(
        error instanceof Error ? error.message : String(error)
      )
    }
    this.deps.runtime.setAgent(sessionId, agent)
    return { sessionId, agent }
  }

  async approve(params: unknown): Promise<{
    sessionId: string
    requestId: string
    decision: 'approved'
    remember: boolean
    already?: true
  }> {
    return this.respondApproval(params, 'approved')
  }

  async deny(params: unknown): Promise<{
    sessionId: string
    requestId: string
    decision: 'denied'
    remember: boolean
    already?: true
  }> {
    return this.respondApproval(params, 'denied')
  }

  async questions(params: unknown): Promise<{
    sessionId: string
    questions: Array<{ requestId: string; summary?: string; form?: unknown }>
  }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const record = this.requireOpenCode(sessionId)
    const control = this.deps.runtime.observerControl(sessionId)
    if (control?.listQuestions) {
      try {
        const listed = await control.listQuestions()
        const items = Array.isArray(listed) ? listed : []
        if (items.length > 0) {
          return {
            sessionId,
            questions: items.map((item) => this.toQuestionInfo(item))
          }
        }
      } catch {
        // Fall back to the projection if the official list route is missing.
      }
    }
    return {
      sessionId,
      questions: Object.entries(record.projection.correlation.pendingInputs).map(
        ([requestId, info]) => ({
          requestId,
          summary: info.prompt,
          form: info.prompt ? { prompt: info.prompt } : undefined
        })
      )
    }
  }

  async answer(params: unknown): Promise<{
    sessionId: string
    requestId: string
    answered: true
    already?: true
  }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const requestId = this.stringParam(params, 'requestId', true)
    const record = this.requireOpenCode(sessionId)
    const parsed = parseInputRequestId(requestId)
    if (!parsed) throw BridgeError.invalid('requestId is not a question id')
    const payload = this.parseAnswerJson(params)
    if (!record.projection.correlation.pendingInputs[requestId]) {
      return { sessionId, requestId, answered: true, already: true }
    }
    const control = this.requireControl(sessionId)
    if (!control.answerQuestion) {
      throw BridgeError.uncontrolled(
        'OpenCode session is not controllable; TUI is still available'
      )
    }
    try {
      await control.answerQuestion(parsed.nativeQuestionId, payload)
    } catch (error) {
      if (isHttpMissing(error)) {
        return { sessionId, requestId, answered: true, already: true }
      }
      throw BridgeError.uncontrolled(
        error instanceof Error ? error.message : String(error)
      )
    }
    return { sessionId, requestId, answered: true }
  }

  async rejectQuestion(params: unknown): Promise<{
    sessionId: string
    requestId: string
    rejected: true
    already?: true
  }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const requestId = this.stringParam(params, 'requestId', true)
    const record = this.requireOpenCode(sessionId)
    const parsed = parseInputRequestId(requestId)
    if (!parsed) throw BridgeError.invalid('requestId is not a question id')
    if (!record.projection.correlation.pendingInputs[requestId]) {
      return { sessionId, requestId, rejected: true, already: true }
    }
    const control = this.requireControl(sessionId)
    if (!control.rejectQuestion) {
      throw BridgeError.uncontrolled(
        'OpenCode session is not controllable; TUI is still available'
      )
    }
    try {
      await control.rejectQuestion(parsed.nativeQuestionId)
    } catch (error) {
      if (isHttpMissing(error)) {
        return { sessionId, requestId, rejected: true, already: true }
      }
      throw BridgeError.uncontrolled(
        error instanceof Error ? error.message : String(error)
      )
    }
    return { sessionId, requestId, rejected: true }
  }

  async wait(params: unknown): Promise<BridgeWatchEvent> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const until = asWaitUntil(this.optionalString(params, 'until') ?? 'turn')
    this.requireOpenCode(sessionId)
    return new Promise<BridgeWatchEvent>((resolve, reject) => {
      let settled = false
      const stop = this.watch(
        sessionId,
        (event) => {
          if (!matchesWait(event.type, until)) return
          if (settled) return
          settled = true
          stop()
          resolve(event)
        },
        (error) => {
          if (settled) return
          settled = true
          stop()
          reject(
            error
              ? BridgeError.unavailable(
                  error instanceof Error ? error.message : String(error)
                )
              : BridgeError.unavailable('Watch closed before a matching event')
          )
        }
      )
    })
  }

  /**
   * 现在开着的会话，**全部 adapter**。
   *
   * 2026-09-30 之前这里 `.filter(adapterId === 'opencode')`：那时桥只服务
   * OpenCode，列出来的每一条都能被原生控制，过滤掉别的 adapter 是有意义的
   * 收窄。现在要能从飞书看见「哪场 grok 卡在等你」并往它里面打字，就不能再
   * 藏着了 —— 用 `controllable` 把「原生可控」和「只能往终端打字」区分开，
   * 这个信息比「干脆不列」有用得多。
   */
  async sessions(): Promise<BridgeSessionInfo[]> {
    return this.deps.runtime
      .listRecords()
      .map((record) => this.toSessionInfo(record))
  }

  /**
   * 历史会话（只读，来自各 CLI 落在磁盘上的记录）。
   *
   * 默认只给「顶层、未归档」的会话 —— 与 App 内会话历史页的默认口径一致
   * （`visibleSessions`）。子代理会话数量很大（本机 148 条）且恢复无意义，
   * 想看得显式 `includeHidden`。
   */
  async history(params: unknown): Promise<BridgeHistorySession[]> {
    const agent = this.agentParam(params)
    const query = this.optionalString(params, 'query')
    const includeHidden = this.booleanParam(params, 'includeHidden')
    const refresh = this.booleanParam(params, 'refresh')
    const limit = this.countParam(params, 'limit', HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX)

    const all = await this.loadHistory(refresh)
    const needle = query?.trim().toLowerCase()
    const picked = all.filter((session) => {
      if (!includeHidden && (session.subagent || session.archived)) return false
      if (agent && session.agent !== agent) return false
      if (needle) {
        // 标题和目录都搜：想续的往往是「那个在某某项目里跑的会话」，
        // 而项目名有时候只在 cwd 里而不在标题里。
        const haystack = `${session.title}\n${session.cwd}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })
    return sortSessions(picked)
      .slice(0, limit)
      .map((session) => this.toHistorySession(session))
  }

  /**
   * 按历史会话 id 起一个新终端并在其中恢复该会话。
   *
   * 不是什么特殊启动：它就是「args 里写着 resume、目录是那场会话的旧目录」的
   * 新会话，所以整条链路（解析安装 → 注入 adapter 的 hook/env → 起 PTY →
   * 渲染进程建 terminal 条目）都复用现有实现，见 `shared/session-resume.ts`。
   *
   * `dryRun` 只算参数不启动任何东西 —— 给飞书做「你确定要恢复这场吗」的预览，
   * 也是本机做只读验证的抓手（真要验只读，必须有一条不产生活进程的路径）。
   */
  async resume(params: unknown): Promise<BridgeResumeResult> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const agent = this.agentParam(params)
    const dryRun = this.booleanParam(params, 'dryRun')
    // 可选模型：飞书「选模型再恢复」用的就是它。拼进恢复命令的 --model。
    const model = this.optionalString(params, 'model') || undefined

    const all = await this.loadHistory(true)
    // 找的时候连归档/子代理一起找：id 是调用方给死的，没必要让「它刚好归档了」
    // 表现为 not-found。能不能恢复由下面的 planResume 判。
    const matches = all.filter(
      (session) => session.id === sessionId && (!agent || session.agent === agent)
    )
    if (matches.length === 0) {
      throw BridgeError.notFound(`History session not found: ${sessionId}`)
    }
    if (matches.length > 1) {
      throw BridgeError.invalid(
        `Session id ${sessionId} exists under ${matches.length} CLIs; pass agent to disambiguate`
      )
    }
    const session = matches[0]

    const plan = planResume(session, model)
    if (!plan.ok) {
      throw BridgeError.notAllowed(RESUME_BLOCKER_TEXT[plan.blocker])
    }
    // ⚠️ 空 cwd 必须在这里拦死。`resolveWorkspace('')` 的语义是 **Home**
    // （新建会话时那是有意为之），于是恢复会在 Home 里静默起一个会话 ——
    // 用户看不出异常，agent 却在错误的目录里开工了。App 内的恢复走另一条路：
    // 它把旧路径预填进新建面板让人自己挑（见 `AppShell.resumeSession`）。
    if (!session.cwd.trim()) {
      throw BridgeError.notAllowed(RESUME_BLOCKER_TEXT['no-workspace'])
    }

    const installation = await this.resolveInstallationForCli(plan.cliId)
    let workspace: string
    try {
      workspace = await this.deps.discovery.resolveWorkspace(installation.id, session.cwd)
    } catch (error) {
      // 典型是原目录被删了（claude 的两场 Temp 会话）。App 内可以改挑一个，
      // 桥这边没有能挑的人，所以如实报错。
      throw BridgeError.notAllowed(
        `原目录不可用（${session.cwd}）：${error instanceof Error ? error.message : String(error)}`
      )
    }
    const args = [...plan.args]
    const name = session.title.trim().slice(0, 60) || installation.definitionId

    if (dryRun) {
      return {
        historySessionId: session.id,
        agent: session.agent,
        workspace,
        installationId: installation.id,
        args,
        dryRun: true,
        terminalId: null,
        sessionId: null
      }
    }

    this.deps.requireForegroundWindow()
    const terminalId = randomUUID()
    const requestId = randomUUID()
    const launchError = await this.deps.launchVisible({
      requestId,
      terminalId,
      name,
      workspace,
      // renderer 拿它当 shellId；少了这个字段所有主进程发起的启动都会被
      // 当成 OpenCode（原先就是这样写死的）。
      adapterId: session.agent,
      selection: { installationId: installation.id, workspace, args }
    })
    if (launchError) throw BridgeError.unavailable(launchError)

    // 等新终端登记进 runtime，好把新 sessionId 一并还回去 —— 调用方紧接着要
    // 用它对这会话 `session.watch` / `session.send`。等不到也**不算失败**：
    // 终端确实已经开出来了，只是还没对上号（返回里 sessionId 为 null，
    // terminalId 仍然有效，调用方可以拿 terminalId 去 `sessions.list` 里找）。
    const startedAt = this.now()
    let record: AgentSessionRecord | null = null
    while (this.now() - startedAt < RESUME_RECORD_TIMEOUT_MS) {
      record =
        this.deps.runtime
          .listRecords()
          .find((item) => item.terminalId === terminalId) ?? null
      if (record) break
      await sleep(RESUME_POLL_MS)
    }
    // 刚起的会话不该在 5 秒缓存里留着旧快照，直接作废。
    this.historyCache = null
    return {
      historySessionId: session.id,
      agent: session.agent,
      workspace,
      installationId: installation.id,
      args,
      dryRun: false,
      terminalId,
      sessionId: record?.sessionId ?? null
    }
  }

  /**
   * 发一句话给一个活着的会话。
   *
   * 两条通道，按**能力**选而不是按 adapter 名选：
   *   · 有 `ObserverControl`（今天只有 opencode）→ 原生 `submitPrompt`，
   *     消息进它自己的消息表，结构化的；
   *   · 没有（grok / codex / claude 这些 TUI）→ 往 PTY 写文本 + 回车，
   *     等价于替人在终端里敲这行字。
   *
   * 两条通道共用**同一个**状态闸门：只有 `idle` / `done` 才允许投递。这不是
   * 保守 —— `working` 时往 TUI 里打字会把字塞进正在跑的那一轮，
   * `needs-you` 时 TUI 显示的是确认框（它要的是 y/n/方向键，不是一句话），
   * 两种都只会把会话搅乱。要答确认框需要按 adapter 单独实测按键序列，
   * 那是另一件事，没实测过就不做。
   */
  async send(params: unknown): Promise<{ accepted: true; mode: 'control' | 'terminal' }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const text = this.stringParam(params, 'text', true)
    const agentRaw = this.optionalString(params, 'agent')
    const agent = agentRaw ? asAgent(agentRaw) : undefined
    if (byteLength(text) > SEND_TEXT_LIMIT_BYTES) {
      throw BridgeError.invalid('send text exceeds 64 KiB')
    }
    const record = this.requireSession(sessionId)
    const status = record.projection.status
    if (status !== 'idle' && status !== 'done') {
      throw BridgeError.notAllowed(`Cannot send while session is ${status}`)
    }

    const control = this.deps.runtime.observerControl(sessionId)
    if (control) {
      try {
        await control.submitPrompt(text, agent)
      } catch (error) {
        throw BridgeError.uncontrolled(
          error instanceof Error ? error.message : String(error)
        )
      }
      return { accepted: true, mode: 'control' }
    }

    const write = this.deps.writeTerminal
    if (!write) {
      throw BridgeError.uncontrolled(
        `${record.adapterId} has no control plane and this build cannot write to its terminal`
      )
    }
    // 程序还没起来就别打字：界面都没画出来，打进去也没人接。
    // 缺省（实现方没接这个探针）时放行，不假装知道。
    if (this.deps.terminalReady && !this.deps.terminalReady(record.terminalId)) {
      throw BridgeError.notAllowed(
        `Terminal for session ${sessionId} has not produced any output yet; ` +
          'the CLI is still starting - retry in a moment'
      )
    }
    // TUI 的输入框是**单行提交**的：直接送多行，第一个换行就把半句话提交出去，
    // 后面的字变成下一条指令。折成一行会损失排版，但不会发出半句话。
    // （把多行当整体粘贴要用 bracketed paste 的 ESC[200~/201~，那要按 adapter
    // 实测 TUI 有没有开这个模式，没实测过不敢用。）
    const oneLine = text.replace(/\r\n|\r|\n/g, ' ').trim()
    if (!oneLine) throw BridgeError.invalid('text must not be empty')
    if (!write(record.terminalId, `${oneLine}\r`)) {
      throw BridgeError.unavailable(
        `Terminal for session ${sessionId} is no longer running`
      )
    }
    return { accepted: true, mode: 'terminal' }
  }

  async turn(params: unknown): Promise<BridgeTurnResult> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const record = this.requireOpenCode(sessionId)
    const cached = this.lastClosedTurns.get(sessionId)
    const delta = cached ?? (await this.snapshotClosedTurn(record))
    return {
      sessionId,
      installationId: record.installationId,
      runtime: record.runtime,
      delta
    }
  }

  private async snapshotClosedTurn(
    record: AgentSessionRecord
  ): Promise<BridgeDelta> {
    const control = this.deps.runtime.observerControl(record.sessionId)
    if (!control) return emptyDelta()
    try {
      const messages = parseOpenCodeMessages(await control.snapshotMessages())
      const delta = extractLastClosedTurn(messages)
      this.lastClosedTurns.set(record.sessionId, delta)
      return delta
    } catch {
      return this.lastClosedTurns.get(record.sessionId) ?? emptyDelta()
    }
  }

  private async dispatchWatch(
    record: AgentSessionRecord,
    phase: AgentSessionPhase
  ): Promise<void> {
    const subscribers = this.watches.get(record.sessionId)
    if (!subscribers || subscribers.size === 0) {
      if (phase === 'finalized') this.lastClosedTurns.delete(record.sessionId)
      return
    }
    for (const subscriber of [...subscribers]) {
      if (subscriber.closed) continue
      await this.enqueueWatch(subscriber, record, phase)
    }
    if (phase === 'finalized') this.lastClosedTurns.delete(record.sessionId)
  }

  private async primeWatch(subscriber: WatchSubscriber): Promise<void> {
    const current = this.deps.runtime.getRecord(subscriber.sessionId)
    if (!current || subscriber.closed) return
    const control = this.deps.runtime.observerControl(current.sessionId)
    if (control) {
      try {
        const messages = parseOpenCodeMessages(await control.snapshotMessages())
        const status = current.projection.status
        subscriber.cursor =
          subscriber.hadActivity ||
          status === 'working' ||
          status === 'needs-you' ||
          status === 'done'
            ? cursorBeforeLastTurn(messages)
            : { keys: collectKeys(messages) }
      } catch {
        // Keep an empty cursor; the first emit will retry the snapshot.
      }
    }
    if (!subscriber.closed) {
      await this.enqueueWatch(subscriber, current, 'updated')
    }
  }

  private async enqueueWatch(
    subscriber: WatchSubscriber,
    record: AgentSessionRecord,
    phase: AgentSessionPhase
  ): Promise<void> {
    subscriber.pending = { record, phase }
    if (subscriber.busy) return
    subscriber.busy = true
    try {
      while (subscriber.pending && !subscriber.closed) {
        const next = subscriber.pending
        subscriber.pending = null
        await this.advanceWatch(subscriber, next.record, next.phase)
      }
    } finally {
      subscriber.busy = false
    }
  }

  private async advanceWatch(
    subscriber: WatchSubscriber,
    record: AgentSessionRecord,
    phase: AgentSessionPhase
  ): Promise<void> {
    const status = record.projection.status
    if (status === 'working') {
      subscriber.hadActivity = true
      return
    }
    if (phase === 'finalized' || status === 'exited') {
      const snap = await this.snapshotForWatch(subscriber, record, 'tail')
      this.emitWatch(subscriber, record, {
        type: 'exited',
        status: 'exited',
        delta: snap.delta
      })
      subscriber.closed = true
      subscriber.close()
      this.watches.get(record.sessionId)?.delete(subscriber)
      return
    }
    if (status === 'needs-you') {
      const blocked = describeBlocked(record)
      const key = `${blocked.kind}:${blocked.requestId ?? ''}`
      if (subscriber.lastBlockedKey === key) return
      subscriber.lastBlockedKey = key
      const snap = await this.snapshotForWatch(subscriber, record, 'required')
      if (snap.failed) {
        subscriber.lastBlockedKey = null
        this.emitWatch(subscriber, record, {
          type: 'failed',
          status: 'error',
          delta: snap.delta,
          error: { message: snap.error }
        })
        return
      }
      this.emitWatch(subscriber, record, {
        type: 'blocked',
        status: 'needs-you',
        delta: snap.delta,
        blocked
      })
      return
    }
    if (status === 'error') {
      const snap = await this.snapshotForWatch(subscriber, record, 'tail')
      this.emitWatch(subscriber, record, {
        type: 'failed',
        status: 'error',
        delta: snap.delta,
        error: {
          message:
            record.projection.correlation.turnFailedMessage ??
            record.projection.detail ??
            'OpenCode turn failed'
        }
      })
      subscriber.lastBlockedKey = null
      return
    }
    if (
      (status === 'done' ||
        (status === 'idle' && record.projection.statusConfidence === 'high')) &&
      subscriber.hadActivity
    ) {
      const savedCursor = subscriber.cursor
      const snap = await this.snapshotForWatch(subscriber, record, 'required')
      if (snap.failed) {
        this.emitWatch(subscriber, record, {
          type: 'failed',
          status: 'error',
          delta: snap.delta,
          error: { message: snap.error }
        })
        subscriber.hadActivity = false
        subscriber.lastBlockedKey = null
        return
      }
      if (status === 'idle' && isEmptyDelta(snap.delta)) {
        subscriber.cursor = savedCursor
        return
      }
      this.emitWatch(subscriber, record, {
        type: 'turn',
        status: status === 'idle' ? 'idle' : 'done',
        delta: snap.delta
      })
      subscriber.hadActivity = false
      subscriber.lastBlockedKey = null
    }
  }

  private emitWatch(
    subscriber: WatchSubscriber,
    record: AgentSessionRecord,
    event: Omit<
      BridgeWatchEvent,
      'v' | 'sessionId' | 'installationId' | 'runtime' | 'occurredAt'
    >
  ): void {
    if (subscriber.closed) return
    subscriber.emit({
      v: 1,
      sessionId: record.sessionId,
      installationId: record.installationId,
      runtime: record.runtime,
      occurredAt: this.now(),
      ...event
    })
  }

  private async snapshotForWatch(
    subscriber: WatchSubscriber,
    record: AgentSessionRecord,
    mode: 'required' | 'tail'
  ): Promise<{ delta: BridgeDelta; failed: boolean; error: string }> {
    const control = this.deps.runtime.observerControl(record.sessionId)
    if (!control) {
      return {
        delta: emptyDelta(),
        failed: mode === 'required',
        error: 'OpenCode session is not controllable; TUI is still available'
      }
    }
    let lastError = 'snapshot failed'
    for (let attempt = 0; attempt < SNAPSHOT_RETRIES; attempt++) {
      try {
        const messages = parseOpenCodeMessages(await control.snapshotMessages())
        this.lastClosedTurns.set(record.sessionId, extractLastClosedTurn(messages))
        const extracted = extractSinceCursor(messages, subscriber.cursor)
        subscriber.cursor = extracted.cursor
        const delta = truncateDelta(extracted.delta)
        if (
          mode === 'required' &&
          isEmptyDelta(delta) &&
          extractLastClosedTurn(messages).text.length === 0 &&
          extractLastClosedTurn(messages).tools.length === 0
        ) {
          return { delta, failed: false, error: '' }
        }
        return { delta, failed: false, error: '' }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (attempt < SNAPSHOT_RETRIES - 1) await sleep(SNAPSHOT_RETRY_MS)
      }
    }
    return {
      delta: emptyDelta(),
      failed: true,
      error: lastError
    }
  }

  /**
   * 读一次历史会话，带 5 秒 TTL 与在途合并。
   *
   * 两个理由：① 一次冷扫描要并发读七种 CLI 的数据目录（Codex 那侧本机 5495
   * 个 rollout 文件），比任何单条 IPC 都贵；② 飞书那边卡片是会定期刷新的，
   * 不该每刷一次就把磁盘重扫一遍 —— 但也要能在用户刚恢复完一场之后立刻看到
   * 变化，所以 TTL 短、且 `resume` 会主动作废缓存。
   */
  private async loadHistory(refresh = false): Promise<HistorySession[]> {
    const read = this.deps.history
    if (!read) {
      // 不是「协议没实现」，是这个构建没接上扫描 —— 用 unavailable 而不是
      // not-implemented，免得调用方以为要等一个未来版本。
      throw BridgeError.unavailable('Session history is not wired up in this build')
    }
    if (!refresh && this.historyCache && this.now() - this.historyCache.at < HISTORY_CACHE_MS) {
      return this.historyCache.value
    }
    this.historyInFlight ??= (async () => {
      try {
        const value = await read()
        this.historyCache = { at: this.now(), value }
        return value
      } catch (error) {
        throw BridgeError.unavailable(
          error instanceof Error ? error.message : String(error)
        )
      } finally {
        this.historyInFlight = null
      }
    })()
    return this.historyInFlight
  }

  private toHistorySession(session: HistorySession): BridgeHistorySession {
    const plan = planResume(session)
    // 「桥能不能直接恢复」= 会话级条件（planResume）再加工作目录。见
    // `BridgeHistoryBlockedCode` 里对 no-workspace 的说明：这一条比 App 内更严。
    const blocked: BridgeHistoryBlockedCode | null = plan.ok
      ? session.cwd.trim()
        ? null
        : 'no-workspace'
      : plan.blocker
    const updatedAt = session.updatedAt ?? session.createdAt
    return {
      agent: session.agent,
      sessionId: session.id,
      title: session.title,
      workspace: session.cwd,
      ...(updatedAt ? { updatedAt } : {}),
      messageCount: session.messageCount,
      resumable: blocked === null,
      ...(blocked
        ? { blockedCode: blocked, blockedReason: RESUME_BLOCKER_TEXT[blocked] }
        : {})
    }
  }

  /** 扫描报告里某个 CLI 的全部安装。 */
  private async installationsFor(cliId: string): Promise<CliInstallation[]> {
    const report = await this.deps.discovery.scan(false)
    return report.launchable
      .filter((cli) => cli.definition.id === cliId)
      .flatMap((cli) => cli.installations)
  }

  /**
   * 任意 CLI 的安装解析 —— `resolveOpenCodeInstallation` 的通用版。
   *
   * 与它唯一的差别是**不查 `state.lastInstallationId()`**：那个记录只有
   * OpenCode 会写（构造函数的 subscribe 里按 adapterId 过滤），拿它去猜别的
   * CLI 的安装是错的。恢复命令自带 cliId（`plan.cliId`），所以也不需要猜。
   */
  private async resolveInstallationForCli(cliId: string): Promise<CliInstallation> {
    const installations = await this.installationsFor(cliId)
    if (installations.length === 1) return installations[0]
    if (installations.length === 0) {
      throw BridgeError.unavailable(
        `No ${cliId} installation found; install ${cliId} and rescan`
      )
    }
    const listed = installations
      .map((item) => {
        const runtime =
          item.runtime.kind === 'wsl'
            ? `wsl:${item.runtime.distro}`
            : `host:${item.runtime.platform}`
        return `${item.id} (${runtime})`
      })
      .join(', ')
    throw BridgeError.invalid(
      `Multiple ${cliId} installations; pass --installation. Available: ${listed}`
    )
  }

  private async resolveOpenCodeInstallation(
    installationId: string | undefined
  ): Promise<CliInstallation> {
    const installations = await this.installationsFor('opencode')
    if (installationId) {
      const found =
        installations.find((item) => item.id === installationId) ??
        (await this.deps.discovery.resolveInstallation(installationId))
      if (!found || found.definitionId !== 'opencode') {
        throw BridgeError.notFound(
          `OpenCode installation not found: ${installationId}`
        )
      }
      return found
    }
    const remembered = await this.deps.state.lastInstallationId()
    if (remembered) {
      const found = installations.find((item) => item.id === remembered)
      if (found) return found
    }
    if (installations.length === 1) return installations[0]
    if (installations.length === 0) {
      throw BridgeError.unavailable(
        'No OpenCode installation found; install OpenCode and rescan'
      )
    }
    const listed = installations
      .map((item) => {
        const runtime =
          item.runtime.kind === 'wsl'
            ? `wsl:${item.runtime.distro}`
            : `host:${item.runtime.platform}`
        return `${item.id} (${runtime})`
      })
      .join(', ')
    throw BridgeError.invalid(
      `Multiple OpenCode installations; pass --installation. Available: ${listed}`
    )
  }

  /**
   * 任意 adapter 的活会话。`close` / `rename` / `send` 用这个 ——
   * 它们要么只动我们自己的终端，要么自己判断「有没有控制面」。
   */
  private requireSession(sessionId: string): AgentSessionRecord {
    const record = this.deps.runtime.getRecord(sessionId)
    if (!record) throw BridgeError.notFound(`Session not found: ${sessionId}`)
    return record
  }

  private requireOpenCode(sessionId: string): AgentSessionRecord {
    const record = this.deps.runtime.getRecord(sessionId)
    if (!record || record.adapterId !== 'opencode') {
      throw BridgeError.notFound(`OpenCode session not found: ${sessionId}`)
    }
    return record
  }

  private requireControl(sessionId: string): ObserverControl {
    const control = this.deps.runtime.observerControl(sessionId)
    if (!control) {
      throw BridgeError.uncontrolled(
        'OpenCode session is not controllable; TUI is still available'
      )
    }
    return control
  }

  private toSessionInfo(record: AgentSessionRecord): BridgeSessionInfo {
    const controllable = Boolean(this.deps.runtime.observerControl(record.sessionId))
    return {
      sessionId: record.sessionId,
      terminalId: record.terminalId,
      // 兜底用 adapterId 而不是写死 'OpenCode'：这个列表现在装着全部 adapter
      // 的会话，把一场 grok 显示成 OpenCode 是彻底错的。
      name: record.name || record.adapterId,
      status: record.projection.status,
      agent: record.agent,
      model: record.model,
      workspace: record.workspace,
      installationId: record.installationId,
      runtime: record.runtime,
      pendingAttentionCount: record.projection.pendingAttentionCount,
      adapterId: record.adapterId,
      // 有控制面 = 能原生控制（审批、结构化提问、读回消息）。
      // 没有也能用：`session.send` 会退化成往 PTY 打字。
      controllable,
      // 有控制面就无所谓「程序起来没」（OpenCode 走 HTTP，不看 TUI）；
      // 没有就得看终端有没有输出过。没接探针时按「能收」放行，不假装知道。
      ready: controllable || this.deps.terminalReady?.(record.terminalId) !== false
    }
  }

  private async respondApproval<D extends 'approved' | 'denied'>(
    params: unknown,
    decision: D
  ): Promise<{
    sessionId: string
    requestId: string
    decision: D
    remember: boolean
    already?: true
  }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const requestId = this.stringParam(params, 'requestId', true)
    const remember =
      decision === 'approved' ? this.booleanParam(params, 'remember') : false
    const record = this.requireOpenCode(sessionId)
    const parsed = parseApprovalRequestId(requestId)
    if (!parsed) throw BridgeError.invalid('requestId is not a permission id')
    if (!record.projection.correlation.pendingApprovals[requestId]) {
      return { sessionId, requestId, decision, remember, already: true }
    }
    const control = this.requireControl(sessionId)
    if (!control.respondPermission) {
      throw BridgeError.uncontrolled(
        'OpenCode session is not controllable; TUI is still available'
      )
    }
    const response =
      decision === 'denied' ? 'reject' : remember ? 'always' : 'once'
    try {
      await control.respondPermission(parsed.nativePermissionId, response)
    } catch (error) {
      if (isHttpMissing(error)) {
        return { sessionId, requestId, decision, remember, already: true }
      }
      throw BridgeError.uncontrolled(
        error instanceof Error ? error.message : String(error)
      )
    }
    return { sessionId, requestId, decision, remember }
  }

  private toQuestionInfo(item: unknown): {
    requestId: string
    summary?: string
    form?: unknown
  } {
    const record = item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {}
    const nativeId =
      typeof record.id === 'string' && record.id
        ? record.id
        : typeof record.requestID === 'string'
          ? record.requestID
          : ''
    const nativeSession =
      typeof record.sessionID === 'string' && record.sessionID
        ? record.sessionID
        : 'unknown'
    const requestId = nativeId
      ? `opencode:${nativeSession}:input:${nativeId}`
      : `opencode:${nativeSession}:input:unknown`
    return {
      requestId,
      summary: questionSummary(record),
      form: item
    }
  }

  private requiredName(params: unknown): string {
    const value = this.stringParam(params, 'name', true)
    const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
    if (!name) throw BridgeError.invalid('name is required')
    if (name.length > SESSION_NAME_LIMIT) {
      throw BridgeError.invalid(`name must be 1–${SESSION_NAME_LIMIT} characters`)
    }
    return name
  }

  private parseAnswerJson(params: unknown): unknown {
    const raw = this.stringParam(params, 'json', true)
    if (byteLength(raw) > SEND_TEXT_LIMIT_BYTES) {
      throw BridgeError.invalid('answer JSON exceeds 64 KiB')
    }
    try {
      return JSON.parse(raw)
    } catch {
      throw BridgeError.invalid('answer --json must be valid JSON')
    }
  }

  private booleanParam(params: unknown, key: string): boolean {
    if (params === undefined || params === null) return false
    if (typeof params !== 'object' || Array.isArray(params)) {
      throw BridgeError.invalid('params must be an object')
    }
    const value = (params as Record<string, unknown>)[key]
    if (value === undefined || value === null || value === false || value === '') {
      return false
    }
    if (value === true) return true
    throw BridgeError.invalid(`${key} must be a boolean`)
  }

  private optionalString(
    params: unknown,
    key: string
  ): string | undefined {
    if (params === undefined || params === null) return undefined
    if (typeof params !== 'object' || Array.isArray(params)) {
      throw BridgeError.invalid('params must be an object')
    }
    const value = (params as Record<string, unknown>)[key]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') throw BridgeError.invalid(`${key} must be a string`)
    return value
  }

  private stringParam(
    params: unknown,
    key: string,
    required: true
  ): string {
    const value = this.optionalString(params, key)
    if (!value) throw BridgeError.invalid(`${key} is required`)
    return value
  }

  /**
   * `agent` 参数（要哪个 CLI）。校验而不是放行任意字符串：打错了应该立刻报错，
   * 而不是安静地返回空列表让人以为「本机没有这个 CLI 的历史」。
   */
  private agentParam(params: unknown): AgentId | undefined {
    const value = this.optionalString(params, 'agent')
    if (!value) return undefined
    if (!(AGENT_IDS as readonly string[]).includes(value)) {
      throw BridgeError.invalid(`agent must be one of: ${AGENT_IDS.join(', ')}`)
    }
    return value as AgentId
  }

  /** 正整数参数，缺省取 `fallback`，超过 `max` 直接夹到 `max`（不报错）。 */  private countParam(
    params: unknown,
    key: string,
    fallback: number,
    max: number
  ): number {
    if (params === undefined || params === null) return fallback
    if (typeof params !== 'object' || Array.isArray(params)) {
      throw BridgeError.invalid('params must be an object')
    }
    const value = (params as Record<string, unknown>)[key]
    if (value === undefined || value === null || value === '') return fallback
    const parsed =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw BridgeError.invalid(`${key} must be a positive integer`)
    }
    return Math.min(parsed, max)
  }
}
