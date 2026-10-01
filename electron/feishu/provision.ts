/**
 * 连接成功后的「下文」—— 用户问的是「对接了一个机器人，然后该怎么做呢」。
 *
 * 之前做到「已连接」就停了，等于把人领进门然后关灯：机器人躺在那里，
 * 表格里什么都没有，飞书那边一句引导都没有。这个模块把三件事一次做完：
 *
 *   1. 自动建多维表格（幂等：有就复用）
 *   2. 把会话历史同步进去（幂等：只推变化过的行）
 *   3. 给扫码人发一张**引导卡**，写清楚现在能干嘛、还差什么
 *
 * ## 纪律
 *
 * - **整条链路不抛错**，失败全部折进返回值。引导流程挂了不该把连接也判死。
 * - **错误码要透传**：`99991672`（应用缺权限）是最常见的失败，拿到它就能
 *   给用户一个**点一下就到**的授权链接，而不是一句「同步失败」。
 * - **卡片必须诚实**：还没实现的指令就写「下一版」，绝不发一张
 *   「发『列表』查看会话」然后机器人毫无反应的卡 —— 那比不发更伤信任。
 */

import { readFile, writeFile, rename, chmod } from 'node:fs/promises'
import type { BridgeHistorySession } from '../../shared/bridge-protocol'
import {
  BitableSync,
  feishuErrorCodeOf,
  BITABLE_BASE_NAME,
  BITABLE_TABLE_NAME,
  type BitableRestClient,
  type BitableRecordLedger
} from './bitable'

/** 应用缺权限的飞书错误码：`app_scope_not_applied`。 */
const ERR_APP_SCOPE_NOT_APPLIED = 99991672

export interface FeishuProvisionDeps {
  appId: string
  client: BitableRestClient
  history: () => Promise<BridgeHistorySession[]>
  /** 接收引导卡的人。只发给准入名单里的人，绝不广播。 */
  pairedOpenIds: readonly string[]
  sendCard: (
    openId: string,
    card: Record<string, unknown>
  ) => Promise<{ error: string | null; code: number | null }>
  /** 账本落盘位置。空串表示不持久化（判卷用）。 */
  statePath: string
  /** 最多同步多少场，防止几百合机器把表格撑爆。 */
  limit?: number
}

export interface FeishuProvisionOutcome {
  state: 'done' | 'failed'
  bitableUrl: string | null
  synced: number | null
  error: string | null
  /** 缺权限时给用户的直达授权页。 */
  permissionUrl: string | null
  /** 表都建好了、只是引导卡没发出去时单独记（这不影响表本身）。 */
  welcomeError: string | null
  ranAt: number
}

const IDLE_OUTCOME: FeishuProvisionOutcome = {
  state: 'failed',
  bitableUrl: null,
  synced: null,
  error: null,
  permissionUrl: null,
  welcomeError: null,
  ranAt: 0
}

export function feishuProvisionIdle(): FeishuProvisionOutcome {
  return { ...IDLE_OUTCOME }
}

// ------------------------------------------------------------------ 状态文件

interface StoredState extends BitableRecordLedger {
  appId?: string
  appToken?: string
  tableId?: string
  bitableUrl?: string | null
}

/**
 * 读账本。**读失败一律当「没有」** —— 宁可重建索引，也不要拿半份状态去推。
 * （agent-hub 的 `rebuildLedger` 就是为这种时刻准备的。）
 */
async function loadState(statePath: string, appId: string): Promise<StoredState> {
  if (!statePath) return { records: {} }
  try {
    const raw = await readFile(statePath, 'utf8')
    const parsed = JSON.parse(raw) as StoredState
    if (!parsed || typeof parsed !== 'object' || typeof parsed.records !== 'object') {
      return { records: {} }
    }
    // 换了应用（重新扫码）就作废 —— 表是跟着应用走的。
    if (parsed.appId && parsed.appId !== appId) return { records: {} }
    return {
      ...parsed,
      records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {}
    }
  } catch {
    return { records: {} }
  }
}

async function saveState(statePath: string, state: StoredState): Promise<void> {
  if (!statePath) return
  const body = JSON.stringify(state, null, 1)
  const tmp = `${statePath}.tmp`
  try {
    await writeFile(tmp, body, 'utf8')
    // 0600：里面只有表 id 和行号，不算敏感，但保持和 feishu.json 一个待遇。
    await chmod(tmp, 0o600).catch(() => undefined)
    await rename(tmp, statePath)
  } catch {
    // 账本写不进去只影响「下次会重复推几行」，不值得让引导流程报错。
  }
}

// ------------------------------------------------------------------ 引导卡

/** 缺权限时给用户的直达授权页 —— 点一下就到，比让人去翻菜单快得多。 */
export function feishuPermissionUrl(appId: string, scope = 'bitable:app'): string {
  return `https://open.feishu.cn/app/${appId}/auth?q=${encodeURIComponent(scope)}&token_type=tenant`
}

export function buildWelcomeCard(input: {
  bitableUrl: string | null
  synced: number | null
  error: string | null
  permissionUrl: string | null
  appName: string
}): Record<string, unknown> {
  const lines: string[] = []
  if (input.bitableUrl) {
    lines.push(
      `**已把这台电脑的会话历史同步进多维表格**${input.synced != null ? `（${input.synced} 场）` : ''}。`,
      '在表里可以按 CLI 筛、按时间排序、按标题搜，也能直接分享给别人看。'
    )
  } else if (input.permissionUrl) {
    lines.push(
      '**还差一步授权**：这台应用还没有多维表格权限，所以会话历史暂时同步不了。',
      '点下面的按钮补上授权，回到桌面端点一下「重连」就好。'
    )
  } else {
    lines.push(
      `**连接成功，但同步遇到了问题**：${input.error ?? '未知原因'}。`,
      '可以先在桌面端「设置 → 飞书」里看详细状态。'
    )
  }

  const actions: Array<Record<string, unknown>> = []
  if (input.bitableUrl) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '打开多维表格' },
      type: 'primary',
      url: input.bitableUrl
    })
  }
  if (input.permissionUrl) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '去补授权' },
      type: 'primary',
      url: input.permissionUrl
    })
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: input.bitableUrl ? 'green' : 'orange',
      title: {
        tag: 'plain_text',
        content: input.bitableUrl
          ? `${input.appName} · 会话历史已同步`
          : `${input.appName} · 连上了，还差一步`
      }
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: lines.join('\n') }
      },
      ...(actions.length > 0 ? [{ tag: 'action', actions }] : []),
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            '**现在能做的**',
            '- 在多维表格里翻、筛、搜全部历史会话',
            '- 桌面端标题栏有「飞书」入口，状态灯一眼看连接',
            '- 想继续某场会话：桌面端「会话历史」里点它就行',
            '**下一版**：直接在这里给机器人发指令（列会话 / 续会话 / 转达一句话）'
          ].join('\n')
        }
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '这张卡只在绑定完成时发一次；表会随会话变化自动增量更新。'
          }
        ]
      }
    ]
  }
}

// ------------------------------------------------------------------ 主流程

export async function provisionFeishuWorkspace(
  deps: FeishuProvisionDeps
): Promise<FeishuProvisionOutcome> {
  const ranAt = Date.now()
  const failed = (error: string, extra: Partial<FeishuProvisionOutcome> = {}): FeishuProvisionOutcome => ({
    ...feishuProvisionIdle(),
    state: 'failed',
    error,
    ranAt,
    ...extra
  })

  if (deps.pairedOpenIds.length === 0) {
    return failed('还没有授权任何飞书账号，引导卡没人可发')
  }

  const state = await loadState(deps.statePath, deps.appId)
  const sync = new BitableSync(deps.client, state)

  let appToken = state.appToken
  let tableId = state.tableId
  let bitableUrl = state.bitableUrl ?? null
  let permissionUrl: string | null = null

  try {
    if (!appToken) {
      const created = await sync.createBase(BITABLE_BASE_NAME)
      appToken = created.appToken
      bitableUrl = created.url
      state.appToken = appToken
      state.bitableUrl = bitableUrl
      state.appId = deps.appId
      await saveState(deps.statePath, state)
    }

    if (!tableId) {
      tableId = await sync.ensureTable(appToken)
      state.tableId = tableId
      await saveState(deps.statePath, state)
    }

    // 账本是空的但表里可能已有行（状态文件被删过）—— 先重建索引防重复。
    if (Object.keys(state.records).length === 0) {
      await sync.rebuildLedger(appToken, tableId)
      await saveState(deps.statePath, state)
    }

    const sessions = (await deps.history()).slice(0, deps.limit ?? 300)
    const stats = await sync.sync(appToken, tableId, sessions)
    await saveState(deps.statePath, state)

    const card = buildWelcomeCard({
      bitableUrl,
      synced: stats.total,
      error: null,
      permissionUrl: null,
      appName: 'Grok Build Center'
    })
    const welcomeError = await sendToAll(deps, card)

    return {
      state: 'done',
      bitableUrl,
      synced: stats.total,
      error: null,
      permissionUrl: null,
      welcomeError,
      ranAt
    }
  } catch (error) {
    // 缺权限有两种抛法：走 assertOk 的是 BitableApiError；HTTP 层就被 SDK
    // 抛掉的是 axios 错误（错误码藏在 response.data.code）—— 两种都要认。
    const code = feishuErrorCodeOf(error)
    const isPermission = code === ERR_APP_SCOPE_NOT_APPLIED
    let message = error instanceof Error ? error.message : String(error)
    if (isPermission) {
      permissionUrl = feishuPermissionUrl(deps.appId)
      // axios 那种 400 原文对用户毫无信息量，换成一句人话。
      message = '机器人缺少「多维表格」权限（飞书错误 99991672）'
    } else if (code != null) {
      message = `${message}（飞书错误 ${code}）`
    }

    // 权限缺失时表都建不出来，引导卡反而更重要 —— 把「怎么补救」发出去。
    let welcomeError: string | null = null
    if (permissionUrl) {
      const card = buildWelcomeCard({
        bitableUrl: null,
        synced: null,
        error: message,
        permissionUrl,
        appName: 'Grok Build Center'
      })
      welcomeError = await sendToAll(deps, card)
    }

    return failed(message, { permissionUrl, welcomeError, bitableUrl })
  }
}

async function sendToAll(
  deps: Pick<FeishuProvisionDeps, 'pairedOpenIds' | 'sendCard'>,
  card: Record<string, unknown>
): Promise<string | null> {
  const failures: string[] = []
  for (const openId of deps.pairedOpenIds) {
    const result = await deps.sendCard(openId, card)
    if (result.error) failures.push(`${result.error}`)
  }
  return failures.length > 0 ? failures.join('；') : null
}

/** 给设置页/标题栏展示用：把 outcome 折成一句人话。 */
export function summarizeProvision(outcome: FeishuProvisionOutcome): string {
  if (outcome.state === 'done' && outcome.bitableUrl) {
    return `已同步 ${outcome.synced ?? 0} 场会话到多维表格`
  }
  if (outcome.permissionUrl) return '缺多维表格权限，点卡片里的按钮补授权'
  if (outcome.error) return `同步失败：${outcome.error}`
  return ''
}
