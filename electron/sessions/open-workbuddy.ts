/**
 * 在国内 WorkBuddy 里打开一场会话。
 *
 * 读的是 `~/.workbuddy`（已排除软删）。不读国际版，不用 cmd / rundll32。
 * 链接交给 Electron 的 `shell.openExternal`，由系统协议处理程序拉起
 * 已注册的 WorkBuddy.exe。用户要的就是这一个窗口。
 */
import { shell } from 'electron'
import type { SessionsOpenWorkbuddyResult } from '../../shared/ipc-contract'
import { pickLatestWorkbuddy, workbuddyChatUrl } from '../../shared/workbuddy-open'
import { readWorkbuddySessions } from './readers/workbuddy'

export async function openDomesticWorkbuddy(
  sessionId?: string
): Promise<SessionsOpenWorkbuddyResult> {
  if (sessionId !== undefined && sessionId.trim() === '') {
    return { ok: false, message: '会话 id 不合法。' }
  }

  let sessions: Awaited<ReturnType<typeof readWorkbuddySessions>>
  try {
    sessions = await readWorkbuddySessions()
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }

  const target = sessionId
    ? (sessions.find((session) => session.id === sessionId) ?? null)
    : pickLatestWorkbuddy(sessions)
  if (!target) {
    return {
      ok: false,
      message: sessionId
        ? '这场会话不在国内 WorkBuddy 记录里。'
        : '这台电脑上还没有国内 WorkBuddy 会话。'
    }
  }

  const url = workbuddyChatUrl(target.id)
  if (!url) {
    return { ok: false, message: '会话 id 不能拼成国内链接。' }
  }

  try {
    await shell.openExternal(url)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }

  return {
    ok: true,
    message: `已在 WorkBuddy 里打开「${target.title}」。`,
    sessionId: target.id,
    title: target.title
  }
}
