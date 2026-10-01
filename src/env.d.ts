import type {
  AgentApi
} from '../shared/agent-events'
import type {
  AppApi,
  AppThemeApi,
  CliApi,
  ClipboardApi,
  DialogApi,
  TerminalBackgroundApi,
  FloatingWindowApi,
  PtyApi,
  ShellApi,
  StatsApi,
  SessionsApi,
  ThemeApi,
  RemoteApi,
  FeishuApi,
  UpdateApi,
  WindowApi
} from '../shared/ipc-contract'
import type { NotificationSoundApi } from '../shared/notification-sound'
import type { FloatingRendererApi } from '../shared/floating-window'
import type { GBCDebugShellApi } from './app/AppShell'
import type { WorkspaceReaderApi } from '../shared/workspace-reader'
import type { DshApi, DshSurfaceApi, DshWireApi } from '../shared/dsh-ipc'
import type { DiagnosticLogApi } from '../shared/diagnostic-log'

// renderer 全局类型：preload 通过 contextBridge 注入 window.ptyApi。
declare global {
  interface Window {
    ptyApi: PtyApi
    clipboardApi: ClipboardApi
    windowApi: WindowApi
    floatingWindowApi: FloatingWindowApi
    gbcFloating: FloatingRendererApi
    themeApi: ThemeApi
    dialogApi: DialogApi
    terminalBackgroundApi: TerminalBackgroundApi
    notificationSoundApi: NotificationSoundApi
    shellApi: ShellApi
    cliApi: CliApi
    statsApi: StatsApi
  sessionsApi: SessionsApi
    agentApi: AgentApi
    workspaceReader: WorkspaceReaderApi
    appApi: AppApi
    updateApi: UpdateApi
    remoteApi: RemoteApi
    feishuApi: FeishuApi
    appThemeApi: AppThemeApi
    dshApi: DshApi
    dshWireApi: DshWireApi
    dshSurfaceApi: DshSurfaceApi
    diagnosticLogApi: DiagnosticLogApi
    __GBC_E2E__?: true
    __gbcDebugShell?: GBCDebugShellApi
  }
}

export {}
