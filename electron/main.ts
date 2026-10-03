import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWindow } from './window'
import { registerIpc, type IpcContext } from './ipc'
import { PTYManager } from './pty/PTYManager'
import { EventLog } from './events/EventLog'
import { loadMainPrefs, getMainPrefs } from './main-prefs'
import { markQuitting } from './quitting'
import {
  registerGlobalShortcut,
  unregisterGlobalShortcut,
  isGlobalShortcutRegistered
} from './shortcuts'
import {
  createTray,
  rebuildTrayMenu,
  toggleWindowVisibility,
  clickTrayMenuItem,
  trayMenuState,
  type Tray,
  type TrayCallbacks
} from './tray'
import { startThemeWatcher, stopThemeWatcher } from './themes-watch'
import {
  AppEventChannel,
  FeishuEventChannel,
  RemoteEventChannel,
  UpdateEventChannel,
  type BridgeLaunchAck,
  type BridgeLaunchRequest
} from '../shared/ipc-contract'
import {
  ElectronFloatingWindowController,
  isAgentProjectionChannel,
  type FloatingWindowController
} from './floating/FloatingWindowController'
import { registerFloatingRendererScheme } from './floating/FloatingRendererProtocol'
import { AiCliDiscoveryService } from './ai-cli-discovery'
import { AgentSessionRuntime } from './agents/AgentSessionRuntime'
import { ObserverRegistry } from './agents/ObserverRegistry'
import { FixtureObserverAdapter } from './agents/adapters/fixture'
import { ClaudeObserverAdapter } from './agents/adapters/claude/ClaudeObserverAdapter'
import { OpenCodeObserverAdapter } from './agents/adapters/opencode'
import { CodexObserverAdapter } from './agents/adapters/codex'
import { PiObserverAdapter } from './agents/adapters/pi'
import { KimiObserverAdapter } from './agents/adapters/kimi'
import { GrokObserverAdapter } from './agents/adapters/grok'
import { HookIngress } from './hooks/HookIngress'
import { WorkspaceReader } from './workspace/WorkspaceReader'
import { WorkspaceReaderEventChannel } from '../shared/workspace-reader'
import { DshHostManager } from './dsh-host/DshHostManager'
import { DshWireProxy } from './dsh-host/DshWireProxy'
import { DshProjectionBridge } from './dsh-host/DshProjectionBridge'
import { DshSessionProjector } from './dsh-host/DshSessionProjector'
import { DshWebSurfaceController } from './dsh-surface/DshWebSurfaceController'
import { ElectronUpdaterDriver } from './update/UpdateDriver'
import { UpdateService } from './update/UpdateService'
import packageMetadata from '../package.json'
import { registerWindowsAppUserModelId } from './app-icons'
import { resolveAppUserDataDir } from './app-paths'
import type { BridgeHistorySession, BridgeResumeResult, BridgeSessionInfo } from '../shared/bridge-protocol'
import { createFeishuRouter } from './feishu/router'
import { openDomesticWorkbuddy } from './sessions/open-workbuddy'
import { extractGbcCliArgv, runGbcCli } from './cli/gbcCli'
import { BridgeServer } from './bridge/BridgeServer'
import { OpenCodeControlPlane } from './bridge/OpenCodeControlPlane'
import { BridgeStateStore } from './bridge/state'
import { BridgeError } from './bridge/errors'
import { RemoteDesktopClient } from './remote/RemoteDesktopClient'
import { RemoteDshCoordinator } from './remote/RemoteDshCoordinator'
import { FeishuService } from './feishu/service'
import { FeishuStore } from './feishu/store'
import { runtimeSessionSource } from './remote/runtimeSessionSource'
import {
  combineRemoteSessionSources,
  dshRemoteSessionSource
} from './remote/dshRemoteSessionSource'
import { runtimeRemotePtyHost } from './remote/runtimeRemotePtyHost'
import { runtimeRemoteLaunchHost } from './remote/runtimeRemoteLaunchHost'
import { runtimeRemoteWorkspaceHost } from './remote/runtimeRemoteWorkspaceHost'
import { DiagnosticLog } from './diagnostics/DiagnosticLog'
import { configurePricingCache } from './sessions/pricing'
import { discoverSessions } from './sessions'
import { DiagnosticLogEventChannel } from '../shared/diagnostic-log'


// E2E/开发：隔离 userData，保证 stats/主题等持久化断言从干净状态出发。
// 必须在 app ready 之前调用。
registerWindowsAppUserModelId()
const userDataOverride =
  process.env['GBC_USER_DATA_DIR'] || process.env['HRACK_USER_DATA_DIR']
if (userDataOverride) {
  app.setPath('userData', userDataOverride)
} else {
  const userDataDir = resolveAppUserDataDir(
    app.getPath('appData'),
    app.isPackaged
  )
  mkdirSync(userDataDir, { recursive: true })
  app.setPath('userData', userDataDir)
}
registerFloatingRendererScheme()
// 事件提示音在后台/非聚焦时也可能触发；允许无手势自动播放。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const cliArgv = extractGbcCliArgv(process.argv)
if (cliArgv) {
  void runGbcCli(cliArgv, {
    stdout: process.stdout,
    stderr: process.stderr,
    userDataDir: app.getPath('userData')
  }).then((code) => app.exit(code))
}

const isPrimaryInstance = cliArgv ? false : app.requestSingleInstanceLock()

const diagnosticLog = new DiagnosticLog(
  join(app.getPath('userData'), 'logs', 'gbc-diagnostic.jsonl')
)
if (isPrimaryInstance) {
  diagnosticLog.installConsoleCapture()
  app.on('web-contents-created', (_event, contents) => {
    diagnosticLog.captureWebContents(contents)
  })
}

const manager = new PTYManager()
// 价目表缓存落在我们自己的 userData 下（`<userData>/pricing/models.json`），
// 绝不写进用户的 CLI 目录。会话层本身不认识 electron，所以在这里注入路径。
configurePricingCache(app.getPath('userData'))
const cliDiscovery = new AiCliDiscoveryService(
  join(app.getPath('userData'), 'ai-cli-scan.json')
)
const eventLog = new EventLog()
let floatingController: FloatingWindowController | null = null
const broadcastToAllWindows = (channel: string, payload: unknown): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      // Frame 已销毁（重载/导航/关窗途中）时 send 可能直接抛。
      // 注意：Electron 多数情况下不抛，而是自己 console.error —— 那条错误会被
      // DiagnosticLog 捕获，必须靠 DiagnosticLog 的重入闸门兜住，否则会形成
      // 「广播失败 → 记日志 → 又广播」的死循环。两边都不能少。
    }
  }
}
diagnosticLog.onChanged((change) => {
  broadcastToAllWindows(DiagnosticLogEventChannel.Changed, change)
})
const broadcastAgentChannel = (channel: string, payload: unknown): void => {
  if (isAgentProjectionChannel(channel, payload)) {
    floatingController?.publishProjection(payload)
  }
  broadcastToAllWindows(channel, payload)
}
// S1：Agent Observer 基础设施。fixture adapter 仅在 E2E 环境变量下启用。
const observerRegistry = new ObserverRegistry()
const hookIngress = new HookIngress()
const workspaceReader = new WorkspaceReader()
workspaceReader.onChanged((change) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(WorkspaceReaderEventChannel.Changed, change)
    }
  }
})
manager.onTerminalRemoved((terminalId) => workspaceReader.unmount(terminalId))
observerRegistry.register(new ClaudeObserverAdapter(hookIngress))
observerRegistry.register(new OpenCodeObserverAdapter())
observerRegistry.register(new CodexObserverAdapter())
observerRegistry.register(new PiObserverAdapter())
observerRegistry.register(new KimiObserverAdapter())
observerRegistry.register(new GrokObserverAdapter())
observerRegistry.register(new FixtureObserverAdapter())
const agentRuntime = new AgentSessionRuntime({
  pty: manager,
  discovery: cliDiscovery,
  history: eventLog,
  registry: observerRegistry,
  workspace: workspaceReader,
  options: {
    runDirRoot: join(app.getPath('userData'), 'observer-runs'),
    broadcast: broadcastAgentChannel
  }
})
// DSH host：只启动扫描到的本机 / WSL 安装；懒启动并随 app 退出回收。
let dshSurfaceController: DshWebSurfaceController | null = null
let remoteDshCoordinator: RemoteDshCoordinator | null = null
const dshHost = new DshHostManager({
  defaultDshHome: join(app.getPath('userData'), 'dsh-home'),
  discovery: cliDiscovery,
  broadcast: broadcastToAllWindows,
  onBecameReady: () => dshProjector.start(),
  onLeftReady: () => {
    dshProjector.stop()
    dshSurfaceController?.hostStopped()
    remoteDshCoordinator?.hostStopped()
  },
  onRestarting: () => {
    dshProjector.pause()
  }
})
const dshProjections = new DshProjectionBridge({
  broadcast: broadcastAgentChannel
})
const dshProjector = new DshSessionProjector(dshHost, dshProjections)
const dshWire = new DshWireProxy(dshHost, broadcastToAllWindows)
let shutdownStarted = false
let winRef: BrowserWindow | null = null
let mainWindowRaiseSequence = 0
let shutdownPromise: Promise<void> | null = null
const pendingBridgeLaunches = new Map<string, (error: string | null) => void>()
const bridgeState = BridgeStateStore.inUserData(app.getPath('userData'))
const controlPlane = new OpenCodeControlPlane({
  discovery: cliDiscovery,
  runtime: agentRuntime,
  state: bridgeState,
  requireForegroundWindow: () => {
    const win = winRef && !winRef.isDestroyed() ? winRef : null
    if (!win) {
      throw BridgeError.unavailable('Grok Build Center window is not available')
    }
    if (!raiseMainWindow(win)) {
      throw BridgeError.unavailable(
        'Open the Grok Build Center window first (tray-only is not enough)'
      )
    }
  },
  launchVisible: async (request: BridgeLaunchRequest) => {
    const win = winRef && !winRef.isDestroyed() ? winRef : null
    if (!win || win.webContents.isDestroyed()) {
      return 'Grok Build Center window is not available'
    }
    if (!raiseMainWindow(win)) {
      return 'Open the Grok Build Center window first (tray-only is not enough)'
    }
    try {
      const started = await agentRuntime.start({
        terminalId: request.terminalId,
        selection: request.selection,
        name: request.name,
        ...estimateTerminalSize(win)
      })
      win.webContents.send(AppEventChannel.BridgeLaunch, {
        ...request,
        ptyId: started.ptyId
      })
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  },
  /**
   * 往已开着的终端写字（`session.send` 对 grok/codex/claude 的通道）。
   *
   * `PTYManager.write` 在找不到 pty 时是**静默 return** 的，所以存活性必须
   * 在这儿自己断言 —— 否则「写进了一个已经死掉的终端」会表现为成功。
   */
  writeTerminal: (terminalId: string, data: string) => {
    const ptyId = manager.ptyIdForTerminal(terminalId)
    if (!ptyId || !manager.isRunning(ptyId)) return false
    try {
      manager.write(ptyId, data)
      return true
    } catch (error) {
      console.warn('[bridge] writeTerminal failed:', error)
      return false
    }
  },
  /**
   * 终端里的程序起来了没 —— 只看「子进程有没有写过任何东西」。
   *
   * `lastOutputAt` 在 `PTYManager` 里是**每个 pty.onData 都会打点**的（不管有没有
   * 订阅者），所以它能当判据；如果哪天改成只有被人订阅才算，这里就会把所有会话
   * 永久判成没起来 —— 那时要换信号，不能放宽判据。
   */
  terminalReady: (terminalId: string) => {
    const ptyId = manager.ptyIdForTerminal(terminalId)
    if (!ptyId) return false
    return (manager.lastOutputAt(ptyId) ?? 0) > 0
  },
  /**
   * 历史会话（只读）。走的是和会话历史页完全同一条扫描 —— 没有第二份实现，
   * 所以桥看到的场次数和 App 里看到的必然一致。`configurePricingCache` 在
   * 上面已经注入过 userData，价目表缓存路径不用在这里再管。
   */
  history: async () => (await discoverSessions()).sessions
})
const bridgeServer = new BridgeServer({
  userDataDir: app.getPath('userData'),
  plane: controlPlane
})

function completeBridgeLaunch(ack: BridgeLaunchAck): void {
  const pending = pendingBridgeLaunches.get(ack.requestId)
  if (!pending) return
  pendingBridgeLaunches.delete(ack.requestId)
  pending(ack.error)
}

const remoteClient = new RemoteDesktopClient({
  sessions: combineRemoteSessionSources(
    runtimeSessionSource(agentRuntime),
    dshRemoteSessionSource(dshProjections)
  ),
  broadcast: (state) =>
    broadcastToAllWindows(RemoteEventChannel.StateChanged, state),
  pty: runtimeRemotePtyHost(agentRuntime, manager),
  launch: runtimeRemoteLaunchHost(cliDiscovery, agentRuntime, (request) => {
    const win = winRef && !winRef.isDestroyed() ? winRef : null
    if (!win || win.webContents.isDestroyed()) return
    win.webContents.send(AppEventChannel.RemoteLaunch, request)
  }),
  workspace: runtimeRemoteWorkspaceHost(cliDiscovery),
  focusSession: (sessionId) => {
    const focused = floatingController?.focusSession(sessionId) ?? false
    const win = winRef && !winRef.isDestroyed() ? winRef : null
    if (win) raiseMainWindow(win)
    return focused
  },
  broadcastDrive: (state) =>
    broadcastToAllWindows(RemoteEventChannel.DriveChanged, state),
  onDshTunnelLease: (lease) => remoteDshCoordinator?.acceptLease(lease)
})

remoteDshCoordinator = new RemoteDshCoordinator({
  userDataDir: app.getPath('userData'),
  host: dshHost,
  remote: remoteClient,
  broadcast: (state) =>
    broadcastToAllWindows(RemoteEventChannel.DshStateChanged, state)
})

/**
 * 飞书渠道。
 *
 * `handlers`（把消息变成对会话的操作）在 `./feishu/router` 里，这一轮先留空 ——
 * 空着的时候连接照样建、心跳照样走，只是没人应答消息。这是刻意留的缝：
 * 「长连接真的活着」和「消息真的被处理了」是两件要分开验证的事。
 */
/** 会话历史的唯一来源：磁盘全扫（provision 同步和飞书路由共用同一份）。 */
const feishuHistory = async (): Promise<BridgeHistorySession[]> => {
  const result = await controlPlane.handle('sessions.history', { limit: 300 })
  return (result.kind === 'json' ? result.value : []) as BridgeHistorySession[]
}

/**
 * 每个 CLI 的可选模型清单（飞书「选模型再恢复」用）。
 * 来源：userData 下的 `feishu-models.json`（用户可自己加，如 grok 的中转模型 id）；
 * 没有这个文件时用内置默认 —— claude 的三个别名直接来自 --help 帮助文本（实测），
 * grok / codex 的模型 id 随中转配置变化，不好枚举，默认空 = 只有「默认」按钮。
 */
function feishuModelOptions(): (agent: string) => string[] {
  const defaults: Record<string, string[]> = { claude: ['sonnet', 'opus', 'haiku'] }
  return (agent: string) => {
    // 每次调用都重读：用户改 feishu-models.json 后下一发 /列表 就生效，不用重启。
    let custom: Record<string, string[]> = {}
    try {
      custom = JSON.parse(
        readFileSync(join(app.getPath('userData'), 'feishu-models.json'), 'utf8')
      ) as Record<string, string[]>
    } catch {
      // 没有自定义清单就用默认 —— 这是正常路径，不是错误。
    }
    const list = custom[agent] ?? defaults[agent] ?? []
    return Array.isArray(list) ? list.filter((m) => typeof m === 'string' && m.trim()) : []
  }
}

/**
 * 飞书入站路由：把消息和卡片按钮变成对会话的操作（/列表 /继续 /发 …）。
 * 准入名单在 service 里（pairedUsers），路由只管「接了之后干什么」。
 */
const feishuRouter = createFeishuRouter({
  history: feishuHistory,
  listActive: async () => {
    const result = await controlPlane.handle('sessions.list', {})
    return (result.kind === 'json' ? result.value : []) as BridgeSessionInfo[]
  },
  resume: async (sessionId, agent, model) => {
    const result = await controlPlane.handle('session.resume', {
      sessionId,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {})
    })
    if (result.kind !== 'json') throw new Error('resume 返回了 watch，不该发生')
    return result.value as BridgeResumeResult
  },
  getModels: feishuModelOptions(),
  send: async (sessionId, text, agent) => {
    const result = await controlPlane.handle('session.send', {
      sessionId,
      text,
      ...(agent ? { agent } : {})
    })
    if (result.kind !== 'json') throw new Error('send 返回了 watch，不该发生')
    return result.value as { accepted: true; mode: string }
  },
  sendTo: async (openId, message) => {
    await feishu.sendToOpenId(openId, message)
  },
  isPaired: (openId) => feishu.isPaired(openId),
  openLatestWorkbuddy: async () => {
    // 单独按 workbuddy 取 1 条。混在全部 CLI 的前 300 里会把国内会话挤掉。
    const result = await controlPlane.handle('sessions.history', {
      agent: 'workbuddy',
      limit: 1,
      refresh: true
    })
    const rows = (result.kind === 'json' ? result.value : []) as BridgeHistorySession[]
    const latest = rows[0]
    if (!latest?.sessionId) {
      return { ok: false, message: '这台电脑上还没有国内 WorkBuddy 会话。' }
    }
    return openDomesticWorkbuddy(latest.sessionId)
  }
})

const feishu = new FeishuService({
  store: FeishuStore.inUserData(app.getPath('userData')),
  broadcast: (status) => broadcastToAllWindows(FeishuEventChannel.StatusChanged, status),
  appName: 'Grok Build Center',
  appDescription: '在这台电脑上跑 AI 编程会话，并从飞书查看 / 继续它们。',
  // 入站应答：消息和卡片按钮 → feishuRouter（空着时连接照活，只是没人应答）。
  handlers: feishuRouter,
  // 连接成功后自动把会话历史同步进多维表格（对齐 agent-hub 的体验）。
  // 没有这两项时 maybeProvision 直接跳过 —— 只有连接没有引导是半成品。
  history: feishuHistory,
  bitableStatePath: join(app.getPath('userData'), 'feishu-bitable.json')
})

const updateService = new UpdateService({
  enabled: false,
  currentVersion: packageMetadata.version,
  driver: new ElectronUpdaterDriver(),
  autoDownload: false,
  initialCheckDelayMs: 0,
  broadcast: (snapshot) =>
    broadcastToAllWindows(UpdateEventChannel.StateChanged, snapshot),
  beforeInstall: () => prepareShutdown()
})

function prepareShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  shutdownStarted = true
  markQuitting()
  updateService.dispose()
  shutdownPromise = (async () => {
    // Agent Runtime 先写入退出事实并回收 observer；随后兜底关闭普通终端。
    controlPlane.dispose()
    remoteDshCoordinator?.dispose()
    remoteClient.dispose()
    // 飞书长连接要显式关：否则进程退出时 WS 还挂着，飞书那边会认为机器人还在线。
    await feishu.dispose()
    await bridgeServer.stop()
    await agentRuntime.disposeAll()
    await hookIngress.dispose()
    dshProjector.stop()
    dshWire.dispose()
    dshSurfaceController?.dispose()
    dshSurfaceController = null
    await dshHost.dispose()
    floatingController?.dispose()
    workspaceReader.clear()
    manager.killAll()
    unregisterGlobalShortcut()
    stopThemeWatcher()
  })()
  return shutdownPromise
}

const attachDshSurface = (window: BrowserWindow): void => {
  dshSurfaceController?.dispose()
  const controller = new DshWebSurfaceController(window, dshHost, {
    activateSlot: (slotId, sessionId) =>
      dshProjector.activateSlot(slotId, sessionId),
    setActiveSession: (sessionId) => dshProjector.setActiveSession(sessionId),
    unfollow: (slotId) => dshProjector.unfollow(slotId)
  })
  dshSurfaceController = controller
  window.once('closed', () => {
    controller.dispose()
    if (dshSurfaceController === controller) dshSurfaceController = null
  })
}

const showWindow = (): void => {
  if (!winRef || winRef.isDestroyed()) return
  raiseMainWindow(winRef)
}

function estimateTerminalSize(win: BrowserWindow): { cols: number; rows: number } {
  const [width, height] = win.getContentSize()
  const scale = win.webContents.getZoomFactor() || 1
  const innerWidth = Math.max(480, width - 248)
  const innerHeight = Math.max(320, height - 96)
  return {
    cols: Math.max(80, Math.min(320, Math.floor(innerWidth / (8.5 * scale)))),
    rows: Math.max(24, Math.min(90, Math.floor(innerHeight / (17.5 * scale))))
  }
}

function raiseMainWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  win.restore()
  win.show()
  if (process.platform === 'win32') {
    const sequence = ++mainWindowRaiseSequence
    let released = false
    let focusArmTimer: ReturnType<typeof setTimeout> | null = null
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    const releaseTopmost = (): void => {
      if (released || sequence !== mainWindowRaiseSequence) return
      released = true
      if (focusArmTimer) clearTimeout(focusArmTimer)
      if (fallbackTimer) clearTimeout(fallbackTimer)
      win.removeListener('focus', releaseAfterFocus)
      if (win.isDestroyed()) return
      win.setAlwaysOnTop(false)
      win.moveTop()
    }
    const releaseAfterFocus = (): void => {
      setTimeout(releaseTopmost, 250)
    }
    try {
      win.setAlwaysOnTop(true)
      win.moveTop()
      app.focus({ steal: true })
      win.focus()
    } catch {
      try {
        win.focus()
      } catch {
        // The fallback timer below still releases a successfully applied topmost state.
      }
    }
    focusArmTimer = setTimeout(() => {
      if (released || sequence !== mainWindowRaiseSequence || win.isDestroyed()) return
      win.once('focus', releaseAfterFocus)
    }, 500)
    fallbackTimer = setTimeout(releaseTopmost, 10_000)
  } else {
    win.focus()
  }
  return win.isVisible()
}

if (!cliArgv && !isPrimaryInstance) {
  app.quit()
} else if (isPrimaryInstance) {
  app.on('second-instance', showWindow)
}

if (isPrimaryInstance) app.whenReady().then(async () => {
  // M0 验收：抵达此行即证明 node-pty 已按 Electron ABI 成功加载
  console.log('[gbc] app ready; node-pty loaded against Electron ABI OK')
  try {
    mkdirSync(join(app.getPath('userData'), 'logs'), { recursive: true })
  } catch {
    /* ignore */
  }

  const prefs = await loadMainPrefs()
  await eventLog.init()

  let trayRef: Tray | null = null

  const trayCallbacks: TrayCallbacks = {
    toggleWindow: () => {
      if (winRef && !winRef.isDestroyed()) toggleWindowVisibility(winRef)
    },
    showWindow,
    openNewSession: () => {
      if (winRef && !winRef.isDestroyed() && !winRef.webContents.isDestroyed()) {
        winRef.webContents.send(AppEventChannel.OpenNewSession)
      }
    },
    quit: () => {
      markQuitting()
      app.quit()
    }
  }

  const ctx: IpcContext = {
    diagnosticLog,
    eventLog,
    cliDiscovery,
    agentRuntime,
    workspaceReader,
    dshHost,
    dshWire,
    dshProjections,
    updateService,
    remoteClient,
    remoteDshCoordinator,
    feishu,
    getDshSurfaceController: () => dshSurfaceController,
    getWindow: () => (winRef && !winRef.isDestroyed() ? winRef : null),
    getTray: () => trayRef,
    getFloatingWindowController: () => floatingController,
    rebuildTrayMenu: () => {
      if (trayRef) rebuildTrayMenu(trayRef, getMainPrefs().language, trayCallbacks)
    },
    completeBridgeLaunch
  }

  registerIpc(manager, ctx)
  // 飞书凭据若已存在就立刻建连。刻意不 await：读盘+建连都不该挡住窗口出现，
  // 而 initialize 内部已经把失败收敛成状态字段，晚到的状态会用广播补上。
  void feishu.initialize()
  // 启动即开始自动检查更新，不依赖窗口/设置页/托盘初始化完成。
  updateService.startAutomaticChecks()
  try {
    await bridgeServer.start()
  } catch (error) {
    // Official and Dev share \\.\pipe\gbc-bridge-<user>. A busy pipe must
    // not block the window — skip-approval / TUI still work without the bridge.
    console.warn('[gbc] bridge listen failed; continuing without it', error)
  }
  winRef = createWindow(prefs)
  attachDshSurface(winRef)
  floatingController = new ElectronFloatingWindowController({
    getMainWindow: () =>
      winRef && !winRef.isDestroyed() ? winRef : null,
    listActiveSessions: () => [
      ...agentRuntime.listActive(),
      ...dshProjections.listActive()
    ],
    renderersDirectory: join(
      app.getPath('userData'),
      'floating-renderers'
    ),
    builtinRendererRoot: join(__dirname, '../renderer'),
    builtinLive2dRoot: join(
      __dirname,
      '../../resources/floating-renderers/live2d-mao'
    )
  })
  await floatingController.setEnabled(prefs.floatingWindowEnabled)
  trayRef = createTray(prefs.language, trayCallbacks)
  if (prefs.globalShortcutEnabled) {
    registerGlobalShortcut(winRef)
  }
  startThemeWatcher()

  // E2E：主进程调试钩子（托盘菜单点击 / 快捷键注册状态无法从 renderer 注入）。
  if (process.env['GBC_E2E']) {
    ;(globalThis as Record<string, unknown>)['__gbcMainDebug'] = {
      hasTray: () => Boolean(trayRef),
      isWindowVisible: () => Boolean(winRef && !winRef.isDestroyed() && winRef.isVisible()),
      isWindowDestroyed: () => Boolean(winRef?.isDestroyed()),
      isShortcutRegistered: () => isGlobalShortcutRegistered(),
      forceUpdateAvailable: (version: unknown, releaseNotes: unknown) => {
        if (typeof version !== 'string' || !version.trim()) return false
        updateService.debugSetAvailable(
          version.trim(),
          typeof releaseNotes === 'string' ? releaseNotes : null
        )
        return true
      },
      toggleWindow: () => {
        if (winRef && !winRef.isDestroyed()) toggleWindowVisibility(winRef)
      },
      clickTrayItem: (index: number) => {
        const result = clickTrayMenuItem(index)
        return {
          ...trayMenuState(),
          invoked: result,
          visible: Boolean(winRef && !winRef.isDestroyed() && winRef.isVisible()),
          focused: Boolean(winRef && !winRef.isDestroyed() && winRef.isFocused())
        }
      },
      openNewSession: () => {
        if (winRef && !winRef.isDestroyed() && !winRef.webContents.isDestroyed()) {
          winRef.webContents.send(AppEventChannel.OpenNewSession)
        }
      },
      dshSurfaceSnapshot: () => dshSurfaceController?.snapshot() ?? null,
      dshSurfaceInspect: () => dshSurfaceController?.inspect() ?? null,
      dshSurfaceDismissOnboarding: () =>
        dshSurfaceController?.dismissOnboardingForTest() ?? false,
      dshSurfaceSelectSession: (sessionId: unknown) =>
        dshSurfaceController?.selectSessionForTest(sessionId) ?? false,
      floatingWindowInspect: () => floatingController?.inspect() ?? null,
      floatingWindowSetEnabled: (enabled: unknown) =>
        typeof enabled === 'boolean'
          ? floatingController?.setEnabled(enabled) ?? null
          : null,
      floatingWindowSetRenderer: (rendererId: unknown) =>
        typeof rendererId === 'string'
          ? floatingController?.setRenderer(rendererId) ?? null
          : null,
      floatingWindowRefreshRenderers: () =>
        floatingController?.refreshRenderers() ?? null,
      floatingWindowPublishProjection: (projection: unknown) => {
        if (
          projection &&
          typeof projection === 'object' &&
          typeof (projection as { sessionId?: unknown }).sessionId === 'string'
        ) {
          floatingController?.publishProjection(
            projection as Parameters<
              FloatingWindowController['publishProjection']
            >[0]
          )
          return true
        }
        return false
      }
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      winRef = createWindow(prefs)
      attachDshSurface(winRef)
    } else {
      showWindow()
    }
  })
})

if (isPrimaryInstance) app.on('before-quit', (event) => {
  if (shutdownStarted) return
  event.preventDefault()
  void prepareShutdown().then(() => app.quit())
})
