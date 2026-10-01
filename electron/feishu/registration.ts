/**
 * 飞书「扫码一键创建智能体应用」—— 设备码流程（OAuth 2.0 Device Authorization
 * Grant, RFC 8628）。
 *
 * 为什么要有这个文件：正常接飞书得让用户自己去开放平台建应用、勾权限、订事件、
 * 配回调，再把 App ID / App Secret 抄回来。飞书其实开放了一条免登流程：
 *
 *   1. 我们 POST `action=begin` 到 accounts.feishu.cn，拿到 device_code
 *      和一个 `verification_uri_complete`（形如
 *      `https://open.feishu.cn/page/launcher?user_code=XXXX-XXXX`）；
 *   2. 把它渲染成二维码，用户用飞书扫 → 确认页上已经预填好应用名/描述/权限/
 *      事件/回调（我们通过 `addons` 传进去）；
 *   3. 我们 POST `action=poll` 轮询，确认后**直接返回 client_id /
 *      client_secret**，不需要用户手抄任何东西。
 *
 * 走的是官方协议而不是 `@larksuiteoapi/node-sdk` 的 `registerApp()`，两个原因：
 * ① 那个方法把整段轮询包在一个不可取消的 promise 里，而我们要的是
 *    begin / poll 两个可以自由控制节奏的调用（UI 要能显示「等待扫码」，
 *    要能在用户关掉面板时取消）；② 这里只用得到 fetch 和 zlib，不引依赖。
 *
 * 事实依据（2026-09-30 本机实测 + 官方文档）：
 * - 端点 `POST https://accounts.feishu.cn/oauth/v1/app/registration`
 *   实测返回 `expires_in: 3600`、`interval: 5`，
 *   `verification_uri_complete = https://open.feishu.cn/page/launcher?user_code=JDMF-8GUL`。
 * - 官方文档：飞书开放平台 → 「一键创建飞书智能体应用」。
 * - RFC 8628 的 `authorization_pending` / `slow_down` 是**带 HTTP 400 返回的**
 *   （见 requestRegistration 里的注释），所以失败响应也必须读 body。
 */

import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'

const FEISHU_ACCOUNTS_DOMAIN = 'accounts.feishu.cn'
const LARK_ACCOUNTS_DOMAIN = 'accounts.larksuite.com'
const REGISTRATION_PATH = '/oauth/v1/app/registration'
const REQUEST_TIMEOUT_MS = 15_000
/** 进程内会话的兜底寿命，比服务端 expires_in 更宽松一点。 */
const SESSION_TTL_MS = 30 * 60_000

/**
 * 允许出现在二维码里的主机白名单。
 *
 * 这个 URL 会被渲染成二维码让用户去扫，所以一个被改过、带凭证或者指向别处的
 * URL 等于一次披着我们 UI 外衣的钓鱼。只放行飞书/飞书国际版的官方域名。
 */
const ALLOWED_VERIFICATION_HOSTS = new Set([
  'accounts.feishu.cn',
  'open.feishu.cn',
  'accounts.larksuite.com',
  'open.larksuite.com'
])

/**
 * 我们**真正会调用**的权限。
 *
 * 每一条都得有对应的调用点，否则就是在让用户授权我们根本用不到的东西：
 * - `im:message.p2p_msg:readonly` —— 收单聊消息（`im.message.receive_v1` 的前提）
 * - `im:message:send_as_bot`     —— 以机器人身份发卡片和回复
 *
 * 想加「显示配对者姓名」之类的能力时再加 `contact:user.base:readonly`，
 * 不要提前申请。
 */
export const FEISHU_REQUIRED_SCOPES = [
  'im:message.p2p_msg:readonly',
  'im:message:send_as_bot',
  /**
   * 多维表格：会话历史自动落表。
   *
   * 这是 agent-hub 那套跑通过的组合 —— v1 的 bitable 接口吃的是**老版合并权限**，
   * 一个 `bitable:app`（控制台里叫「查看、评论、编辑和管理多维表格」）就够，
   * 别去凑 `base:record:read` 那套新版细粒度名（那是 lark-cli 走的另一条接口路）。
   *
   * ⚠️ 对**已经创建**的应用，后补权限要重新发布版本才生效；
   * 这也是 provision 失败时会给用户「直达授权页」链接的原因。
   */
  'bitable:app'
] as const

/** 事件订阅：用户给机器人发消息。 */
export const FEISHU_REQUIRED_EVENTS = ['im.message.receive_v1'] as const

/**
 * 回调：卡片按钮。
 *
 * ⚠️ 飞书把「卡片回调」算作**回调**而不是事件，在开放平台里是**另一个页签**
 * （「回调配置」）。只订事件不订回调的话，卡片上的按钮点下去会毫无反应。
 */
export const FEISHU_REQUIRED_CALLBACKS = ['card.action.trigger'] as const

export type FeishuRegistrationBegin = {
  sessionKey: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
  message: string
}

export type FeishuRegistrationPoll =
  | { status: 'success'; appId: string; appSecret: string; domain: 'feishu' | 'lark'; openId?: string }
  | { status: 'waiting'; intervalSeconds: number; message: string }
  | { status: 'expired' | 'denied' | 'failed' | 'not_started'; message: string }

type RegistrationSession = {
  sessionKey: string
  deviceCode: string
  accountsDomain: string
  domain: 'feishu' | 'lark'
  intervalSeconds: number
  domainSwitched: boolean
  startedAt: number
  expiresAt: number
}

type RegistrationResponse = {
  device_code?: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
  client_id?: string
  client_secret?: string
  user_info?: { open_id?: string; tenant_brand?: string }
  error?: string
  error_description?: string
}

const sessions = new Map<string, RegistrationSession>()

/**
 * `addons` 在 URL 上的编码形状是平台定死的：gzip → base64 → URL-safe → 去掉 `=`。
 * 不是我们选的编码，别改。
 */
export function encodeFeishuAddons(addons: Record<string, unknown>): string {
  return gzipSync(Buffer.from(JSON.stringify(addons), 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * 预置进确认页的增量配置。
 *
 * `preset: false` 是关键：它把飞书那套默认模板（一堆用不到的权限）换成最小基线，
 * 于是确认页上**只显示我们这里声明的东西**——用户看到的就是我们真正要用的。
 */
function defaultAddons(): Record<string, unknown> {
  return {
    preset: false,
    scopes: { tenant: [...FEISHU_REQUIRED_SCOPES] },
    events: { items: { tenant: [...FEISHU_REQUIRED_EVENTS] } },
    callbacks: { items: [...FEISHU_REQUIRED_CALLBACKS] }
  }
}

export function assertFeishuVerificationUrl(value: string | undefined): URL {
  if (!value) throw new Error('飞书没有返回验证链接')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('飞书返回的验证链接无法解析')
  }
  const safePort = !url.port || url.port === '443'
  if (
    url.protocol !== 'https:' ||
    !ALLOWED_VERIFICATION_HOSTS.has(url.hostname) ||
    !safePort ||
    url.username ||
    url.password
  ) {
    throw new Error('飞书返回的验证链接指向了非官方域名')
  }
  return url
}

async function requestRegistration(
  accountsDomain: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<RegistrationResponse> {
  const response = await fetchImpl(`https://${accountsDomain}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  // RFC 8628 把 authorization_pending / slow_down 也走 HTTP 400，
  // 所以**失败也要读 body**——读不到才算是传输错误。
  const data = (await response.json().catch(() => null)) as RegistrationResponse | null
  if (!data) {
    throw new Error(`飞书接口返回 HTTP ${response.status} 且响应体不可解析`)
  }
  return data
}

function purgeExpiredSessions(): void {
  const now = Date.now()
  for (const [key, session] of sessions) {
    if (now - session.startedAt > SESSION_TTL_MS || now > session.expiresAt) {
      sessions.delete(key)
    }
  }
}

export type BeginFeishuRegistrationOptions = {
  sessionKey?: string
  /** 显示在确认页上的来源标识。 */
  source?: string
  /** 预填的应用名/说明，用户仍可改。 */
  appName?: string
  appDescription?: string
  /** 国际版租户可以从 Lark 域名起步。 */
  domain?: 'feishu' | 'lark'
  fetchImpl?: typeof fetch
}

export async function beginFeishuRegistration(
  options: BeginFeishuRegistrationOptions = {}
): Promise<FeishuRegistrationBegin> {
  purgeExpiredSessions()

  const fetchImpl = options.fetchImpl ?? fetch
  const domain = options.domain === 'lark' ? 'lark' : 'feishu'
  const accountsDomain = domain === 'lark' ? LARK_ACCOUNTS_DOMAIN : FEISHU_ACCOUNTS_DOMAIN

  const begun = await requestRegistration(
    accountsDomain,
    {
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id'
    },
    fetchImpl
  )
  if (begun.error) {
    throw new Error(`飞书拒绝发起扫码：${begun.error_description || begun.error}`)
  }

  const deviceCode = begun.device_code?.trim()
  if (!deviceCode) throw new Error('飞书没有返回 device_code')

  const verificationUrl = assertFeishuVerificationUrl(begun.verification_uri_complete)
  verificationUrl.searchParams.set('from', 'sdk')
  verificationUrl.searchParams.set('source', options.source || 'grok-build-center')
  verificationUrl.searchParams.set('tp', 'sdk')
  // 只允许**新建**：绑已有应用等于让我们这个流程悄悄改掉用户正在跑的机器人的回调配置。
  verificationUrl.searchParams.set('createOnly', 'true')
  if (options.appName) verificationUrl.searchParams.set('name', options.appName)
  if (options.appDescription) verificationUrl.searchParams.set('desc', options.appDescription)
  verificationUrl.searchParams.set('addons', encodeFeishuAddons(defaultAddons()))

  const expiresInSeconds =
    Number.isFinite(Number(begun.expires_in)) && Number(begun.expires_in) > 0
      ? Number(begun.expires_in)
      : 600
  const intervalSeconds =
    Number.isFinite(Number(begun.interval)) && Number(begun.interval) > 0 ? Number(begun.interval) : 5

  const sessionKey = options.sessionKey || randomUUID()
  const startedAt = Date.now()
  sessions.set(sessionKey, {
    sessionKey,
    deviceCode,
    accountsDomain,
    domain,
    intervalSeconds,
    domainSwitched: false,
    startedAt,
    expiresAt: startedAt + expiresInSeconds * 1000
  })

  return {
    sessionKey,
    verificationUri: verificationUrl.toString(),
    expiresInSeconds,
    intervalSeconds,
    message: '用飞书扫这个二维码，确认后会自动创建机器人。'
  }
}

export async function pollFeishuRegistration(options: {
  sessionKey: string
  fetchImpl?: typeof fetch
}): Promise<FeishuRegistrationPoll> {
  purgeExpiredSessions()

  const session = sessions.get(options.sessionKey)
  if (!session) {
    return { status: 'not_started', message: '没有进行中的扫码，请重新生成二维码。' }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  let data = await requestRegistration(
    session.accountsDomain,
    { action: 'poll', device_code: session.deviceCode },
    fetchImpl
  )

  // 国际版租户会在 Lark 域名上收尾。这个切换是单向的、只发生一次，跟官方 SDK 一致。
  if (data.user_info?.tenant_brand === 'lark' && !session.domainSwitched) {
    session.domainSwitched = true
    session.domain = 'lark'
    session.accountsDomain = LARK_ACCOUNTS_DOMAIN
    data = await requestRegistration(
      session.accountsDomain,
      { action: 'poll', device_code: session.deviceCode },
      fetchImpl
    )
  }

  if (data.client_id && data.client_secret) {
    sessions.delete(options.sessionKey)
    return {
      status: 'success',
      appId: data.client_id,
      appSecret: data.client_secret,
      domain: session.domain,
      openId: data.user_info?.open_id
    }
  }

  switch (data.error) {
    case undefined:
    case '':
    case 'authorization_pending':
      return {
        status: 'waiting',
        intervalSeconds: session.intervalSeconds,
        message: '等待飞书扫码确认…'
      }
    case 'slow_down':
      // 服务端要求拉长间隔，本轮之内都听它的。
      session.intervalSeconds += 5
      return {
        status: 'waiting',
        intervalSeconds: session.intervalSeconds,
        message: '等待飞书扫码确认…'
      }
    case 'expired_token':
      sessions.delete(options.sessionKey)
      return { status: 'expired', message: '二维码已过期，请重新生成。' }
    case 'access_denied':
      sessions.delete(options.sessionKey)
      return { status: 'denied', message: '飞书授权被拒绝。' }
    default:
      sessions.delete(options.sessionKey)
      // error_description 可能回显服务端细节，不进 UI 表面，也不记任何可能带凭据的东西。
      return { status: 'failed', message: '飞书扫码授权失败，请重试。' }
  }
}

export function cancelFeishuRegistration(sessionKey: string): void {
  sessions.delete(sessionKey)
}

/** 测试用：模块级会话表不能跨用例泄漏。 */
export function resetFeishuRegistrationsForTest(): void {
  sessions.clear()
}
