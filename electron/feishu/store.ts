/**
 * 飞书凭据与配对名单的落盘。
 *
 * 为什么单独一个文件：这里存的是 **App Secret**。App Secret 等价于这个机器人的
 * 完整身份 —— 拿到它就能以机器人的名义收发消息。所以这个文件不许出现在日志里、
 * 不许进 git、读出来之后也不许原样塞进任何 IPC 响应给渲染进程。
 *
 * 落盘位置：`<userData>/feishu.json`（打包版是 `%APPDATA%\Grok Build Center`，
 * Dev 版是 `%APPDATA%\Grok Build Center Dev`）。刻意**不**放进 GBC 的目录，
 * 两套产品各有各的凭据。
 *
 * 三处防御：
 * - 写：临时文件 + rename 原子替换，权限 0600。半截的 JSON 永远不会成为正式内容。
 * - 读：解析失败一律当「未绑定」。**未绑定 = 不起长连接 = 谁也驱使不了这台电脑**，
 *   所以这个方向的降级是安全的；反过来（读失败就当成已绑定）才是危险的。
 * - 日志：只输出脱敏后的 appId（见 `maskAppId`），secret 一个字都不出现。
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type FeishuDomain = 'feishu' | 'lark'

/**
 * 允许配对（= 允许驱使这台电脑）的飞书用户。
 *
 * 这是**唯一**的准入名单。飞书那边任何一个能搜到机器人的同事都能给它发消息，
 * 不在这里挡住就等于把整台电脑的终端交出去了。
 */
export interface FeishuPairedUser {
  openId: string
  /** 可选备注。飞书昵称要另外申请通讯录权限才拿得到，所以这里通常是用户自己填的。 */
  name?: string
  pairedAt: number
}

export interface FeishuBinding {
  appId: string
  appSecret: string
  domain: FeishuDomain
  boundAt: number
  /** 第一个配对的人（= 扫码的那个）由注册流程直接写进来。 */
  pairedUsers: FeishuPairedUser[]
}

type FeishuStoreFile = {
  version: 1
  binding: FeishuBinding | null
}

const FILE_VERSION = 1

/**
 * 飞书自建应用的 App ID 形如 `cli_a1b2c3d4e5f60718`。
 *
 * 这个正则不是我们发明的，是 `@larksuiteoapi/node-sdk` 里 `WSClient.start()`
 * 自己的判据。**它不匹配时 SDK 只是打个 error 日志然后 return —— 不抛错。**
 * 所以「appId 写错了」在上层表现为「长连接永远连不上、没有任何事件、也没有异常」。
 * 我们在落盘和建连之前各查一次，就是为了把这种静默失败变成一个能看见的错误。
 */
const APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/

export function isFeishuAppId(value: unknown): value is string {
  return typeof value === 'string' && APP_ID_PATTERN.test(value)
}

/** 给 UI 和日志看的脱敏形式：`cli_a1b2…0718`。 */
export function maskAppId(appId: string): string {
  if (!appId) return ''
  if (appId.length <= 12) return `${appId.slice(0, 4)}…`
  return `${appId.slice(0, 8)}…${appId.slice(-4)}`
}

function isDomain(value: unknown): value is FeishuDomain {
  return value === 'feishu' || value === 'lark'
}

function parseBinding(raw: unknown): FeishuBinding | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<FeishuBinding>
  if (typeof value.appId !== 'string' || !value.appId) return null
  if (typeof value.appSecret !== 'string' || !value.appSecret) return null
  const pairedUsers = Array.isArray(value.pairedUsers)
    ? value.pairedUsers
        .filter(
          (user): user is FeishuPairedUser =>
            !!user &&
            typeof user === 'object' &&
            typeof (user as FeishuPairedUser).openId === 'string' &&
            !!(user as FeishuPairedUser).openId
        )
        .map((user) => ({
          openId: user.openId,
          name: typeof user.name === 'string' && user.name ? user.name : undefined,
          pairedAt:
            typeof user.pairedAt === 'number' && Number.isFinite(user.pairedAt)
              ? user.pairedAt
              : Date.now()
        }))
    : []
  return {
    appId: value.appId,
    appSecret: value.appSecret,
    domain: isDomain(value.domain) ? value.domain : 'feishu',
    boundAt:
      typeof value.boundAt === 'number' && Number.isFinite(value.boundAt)
        ? value.boundAt
        : Date.now(),
    pairedUsers
  }
}

export class FeishuStore {
  static inUserData(userDataDir: string): FeishuStore {
    return new FeishuStore(join(userDataDir, 'feishu.json'))
  }

  constructor(readonly filePath: string) {}

  /**
   * 读凭据。任何异常（文件不存在、权限不足、JSON 半截、字段缺失）都归到
   * 「未绑定」—— 见文件头的说明，这个方向的降级是安全的。
   */
  async read(): Promise<FeishuBinding | null> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      console.warn('[feishu] 凭据文件不是合法 JSON，按未绑定处理')
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const file = parsed as Partial<FeishuStoreFile>
    return parseBinding(file.binding)
  }

  async write(binding: FeishuBinding | null): Promise<void> {
    const payload: FeishuStoreFile = { version: FILE_VERSION, binding }
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    // 先建临时文件并立刻收紧权限，再 rename —— 这样 secret 从诞生的第一刻起
    // 就是 0600，不存在「先写成 0644 再改」的窗口。
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    try {
      await rename(tmp, this.filePath)
    } catch (error) {
      await unlink(tmp).catch(() => {})
      throw error
    }
    await chmod(this.filePath, 0o600).catch(() => {})
  }

  async clear(): Promise<void> {
    await this.write(null)
  }

  /**
   * 读-改-写。这里没有并发保护，也没需要 —— 所有调用点都在主进程，
   * 而且都是「用户点一下按钮」级别的频率。
   */
  async update(
    mutator: (current: FeishuBinding | null) => FeishuBinding | null
  ): Promise<FeishuBinding | null> {
    const current = await this.read()
    const next = parseBinding(mutator(current))
    await this.write(next)
    return next
  }

  /**
   * 把一个人加进准入名单。重复配对是幂等的（保留最早的配对时间与已有备注）。
   */
  async pairUser(openId: string, name?: string): Promise<FeishuBinding | null> {
    if (!openId) return this.read()
    return this.update((current) => {
      if (!current) return current
      const existing = current.pairedUsers.find((user) => user.openId === openId)
      if (existing) {
        return {
          ...current,
          pairedUsers: current.pairedUsers.map((user) =>
            user.openId === openId
              ? { ...user, name: name || user.name, pairedAt: user.pairedAt }
              : user
          )
        }
      }
      return {
        ...current,
        pairedUsers: [
          ...current.pairedUsers,
          { openId, name: name || undefined, pairedAt: Date.now() }
        ]
      }
    })
  }

  async unpairUser(openId: string): Promise<FeishuBinding | null> {
    return this.update((current) => {
      if (!current) return current
      return {
        ...current,
        pairedUsers: current.pairedUsers.filter((user) => user.openId !== openId)
      }
    })
  }
}
