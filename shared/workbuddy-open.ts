/**
 * 国内 WorkBuddy 的打开链接。
 *
 * 只认 `workbuddy://chat/<uuid>`。host 必须是 `chat`，这是客户端注册的深链。
 * 国际版 `workbuddy-ai://` 不在这里拼。id 只接受 uuid，避免把路径或查询串拼进协议。
 */

const WORKBUDDY_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface WorkbuddyOpenCandidate {
  id: string
  title?: string
  updatedAt?: string | null
  createdAt?: string | null
}

/** 合法 id 返回国内深链，否则返回 null。调用方不得自己拼接。 */
export function workbuddyChatUrl(sessionId: string): string | null {
  const id = sessionId.trim()
  if (!WORKBUDDY_SESSION_ID.test(id)) return null
  return `workbuddy://chat/${id}`
}

function activityMs(session: WorkbuddyOpenCandidate): number {
  const value = session.updatedAt ?? session.createdAt ?? null
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * 最近一场。时间和 `sortSessions` 同一口径：updatedAt 优先于 createdAt，
 * 时间相同再按标题排，取排在最前的那条。
 */
export function pickLatestWorkbuddy<T extends WorkbuddyOpenCandidate>(
  sessions: readonly T[]
): T | null {
  if (sessions.length === 0) return null
  const ranked = [...sessions].sort((a, b) => {
    const delta = activityMs(b) - activityMs(a)
    if (delta) return delta
    return (a.title ?? '').localeCompare(b.title ?? '')
  })
  return ranked[0] ?? null
}
