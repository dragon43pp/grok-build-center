/**
 * 多维表格（Base）—— 会话历史的落表。
 *
 * 这是 agent-hub（Python）里跑通过的那套设计的 TS 移植，关键决定都沿用了：
 *
 * ## 为什么是表，不是卡片
 *
 * 卡片一页只能放 10 条，几百场会话要翻几十页，手机上点到手酸。
 * 多维表格是原生表格视图：按 CLI 筛、按时间排序、按标题搜，而且**免费**、
 * **可以分享给别人看**。分工：表 = 完整清单；卡片 = 一眼看 + 当场动手。
 *
 * ## 为什么一个 `bitable:app` 就够
 *
 * v1 的 bitable 接口吃的是**老版合并权限**。`base:record:read` 那套是新版
 * Base 接口的细粒度名 —— 两条路权限名不一样，别混着凑。
 *
 * ## 幂等
 *
 * 靠「会话 → record_id + 内容哈希」的本地状态只推变化过的行。几百场会话
 * 每次全量重推既慢又浪费配额；稳态下每轮通常是 0～3 行。
 * 状态由**调用方**持久化（见 `provision.ts`），本模块只管逻辑 —— 这样
 * 离线判卷不用碰文件系统。
 *
 * ## 单选字段的选项必须预先建好
 *
 * 写入一个不存在的选项会直接报错。所以 CLI 用「已知全集 + 其他」兜底，
 * 新出现的 CLI 不会把整轮同步搞挂。
 */

// 注意：这里是 `BridgeHistorySession`（`sessionId/workspace/resumable`），
// 不是 shared/session-history 的 `HistorySession`（`id/cwd`）——
// `sessions.history` 出来的就是桥的形状，别再犯 agent-hub 时代的字段名混淆。
import type { BridgeHistorySession } from '../../shared/bridge-protocol'

/** 官方《字段编辑指南》的类型编号：1 文本 / 2 数字 / 3 单选 / 5 日期 / 7 复选框。 */
export const BITABLE_FIELD_TYPE = {
  text: 1,
  number: 2,
  singleSelect: 3,
  date: 5,
  checkbox: 7
} as const

export const BITABLE_BASE_NAME = 'AI 会话中心'
export const BITABLE_TABLE_NAME = 'AI 会话'

/** 单选选项必须预先建好 —— 已知全集 + 兜底「其他」。 */
export const BITABLE_CLI_OPTIONS = [
  'Grok Build',
  'Codex',
  'Claude Code',
  'OpenCode',
  'Kimi CLI',
  'Pi',
  'WorkBuddy',
  '其他'
] as const

export interface BitableFieldSpec {
  name: string
  type: number
  options?: readonly string[]
}

export const SESSION_TABLE_FIELDS: readonly BitableFieldSpec[] = [
  { name: '标题', type: BITABLE_FIELD_TYPE.text },
  { name: '会话ID', type: BITABLE_FIELD_TYPE.text },
  { name: 'CLI', type: BITABLE_FIELD_TYPE.singleSelect, options: BITABLE_CLI_OPTIONS },
  { name: '项目目录', type: BITABLE_FIELD_TYPE.text },
  { name: '最后活动', type: BITABLE_FIELD_TYPE.date },
  { name: '消息数', type: BITABLE_FIELD_TYPE.number },
  { name: '可恢复', type: BITABLE_FIELD_TYPE.checkbox },
  { name: '不能恢复原因', type: BITABLE_FIELD_TYPE.text }
]

const AGENT_LABELS: Record<string, string> = {
  grok: 'Grok Build',
  codex: 'Codex',
  claude: 'Claude Code',
  opencode: 'OpenCode',
  kimi: 'Kimi CLI',
  pi: 'Pi',
  workbuddy: 'WorkBuddy'
}

/** 未知的 CLI 落到「其他」，绝不因为一个新名字把同步搞挂。 */
export function cliOptionOf(agent: string): string {
  const label = AGENT_LABELS[agent]
  if (label) return label
  const hit = BITABLE_CLI_OPTIONS.find(
    (option) => option !== '其他' && option.toLowerCase() === agent.toLowerCase()
  )
  return hit ?? '其他'
}

/**
 * 一场历史会话 → 表里的一行。
 *
 * ⚠️ 日期字段要的是**毫秒**时间戳（13 位）。传秒会被解析成 1970 年 ——
 * agent-hub 时代就踩过，别再踩一次。`updatedAt` 是 ISO 串，缺省表示该 CLI 没记。
 */
export function historySessionToFields(session: BridgeHistorySession): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    标题: session.title?.trim() || '(未命名)',
    会话ID: session.sessionId,
    CLI: cliOptionOf(session.agent),
    项目目录: session.workspace || '',
    消息数: Number.isFinite(session.messageCount) ? session.messageCount : 0,
    可恢复: Boolean(session.resumable),
    不能恢复原因: session.blockedReason || ''
  }
  const updatedAtMs = session.updatedAt ? Date.parse(session.updatedAt) : NaN
  if (Number.isFinite(updatedAtMs)) fields['最后活动'] = updatedAtMs
  return fields
}

export function fieldsHash(fields: Record<string, unknown>): string {
  // 排序后序列化，保证同一内容不管字段顺序怎么变都算同一个哈希。
  const blob = JSON.stringify(fields, (_key, value) =>
    value === undefined ? null : value
  )
  // 轻量 FNV-1a：只用来判断「变没变」，不需要密码学强度。
  let hash = 0x811c9dc5
  for (let i = 0; i < blob.length; i += 1) {
    hash ^= blob.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ------------------------------------------------------------------ SDK 适配

/**
 * SDK 的返回统一是 `{code, msg, data}`，失败**不抛异常**。
 * 这里包一层把「code != 0」变成异常，调用方就不用每处都手判一遍 ——
 * 少判一处就是一个静默吞错的隐患。
 */
export class BitableApiError extends Error {
  constructor(
    readonly code: number,
    readonly feishuMsg: string,
    context: string
  ) {
    super(`${context} 失败：飞书错误 ${code} ${feishuMsg}`)
    this.name = 'BitableApiError'
  }
}

/**
 * 只声明我们用到的调用点。⚠️ Node 版 SDK 的约定：**路径参数放 `path`，
 * 查询参数放 `params`，请求体放 `data`** —— `app_token`/`table_id` 是路径段。
 * 全塞 `params` 是 Python SDK 的习惯，在 Node 这边飞书会报
 * `request miss app_token path argument`（2026-10-01 实测踩过）。
 */
export interface BitableRestClient {
  bitable: {
    app: {
      create: (args: { data: { name: string } }) => Promise<BitableApiResponse>
    }
    appTable: {
      list: (args: {
        path: { app_token: string }
        params: { page_size: number }
      }) => Promise<BitableApiResponse>
      create: (args: {
        path: { app_token: string }
        data: {
          table: {
            name: string
            default_view_name: string
            fields: Array<{
              field_name: string
              type: number
              property?: { options: Array<{ name: string }> }
            }>
          }
        }
      }) => Promise<BitableApiResponse>
    }
    appTableField: {
      list: (args: {
        path: { app_token: string; table_id: string }
        params: { page_size: number }
      }) => Promise<BitableApiResponse>
      update: (args: {
        path: { app_token: string; table_id: string; field_id: string }
        data: {
          field_name: string
          type: number
          property?: { options: Array<{ name: string }> }
        }
      }) => Promise<BitableApiResponse>
    }
    appTableRecord: {
      list: (args: {
        path: { app_token: string; table_id: string }
        params: {
          page_size: number
          page_token?: string
        }
      }) => Promise<BitableApiResponse>
      batchCreate: (args: {
        path: { app_token: string; table_id: string }
        data: { records: Array<{ fields: Record<string, unknown> }> }
      }) => Promise<BitableApiResponse>
      batchUpdate: (args: {
        path: { app_token: string; table_id: string }
        data: {
          records: Array<{ record_id: string; fields: Record<string, unknown> }>
        }
      }) => Promise<BitableApiResponse>
      batchDelete: (args: {
        path: { app_token: string; table_id: string }
        data: { records: string[] }
      }) => Promise<BitableApiResponse>
    }
  }
}

export interface BitableApiResponse {
  code?: number
  msg?: string
  data?: {
    app?: { app_token?: string; url?: string }
    table_id?: string
    /**
     * 记录 list 和字段 list 共用这个键（飞书两个接口都返回 items）：
     * 记录条目带 record_id/fields，字段条目带 field_id/type/property。
     */
    items?: Array<{
      table_id?: string
      name?: string
      record_id?: string
      fields?: Record<string, unknown>
      field_id?: string
      field_name?: string
      type?: number
      property?: { options?: Array<{ name?: string }> }
    }>
    has_more?: boolean
    page_token?: string
    records?: Array<{ record_id?: string }>
  }
}

async function assertOk(
  response: BitableApiResponse,
  context: string
): Promise<NonNullable<BitableApiResponse['data']>> {
  const code = Number(response?.code ?? 0)
  if (code !== 0) {
    throw new BitableApiError(code, response?.msg || '未知错误', context)
  }
  if (!response.data) throw new BitableApiError(-1, '返回里没有 data', context)
  return response.data
}

/**
 * 从任意异常里挖飞书错误码。
 *
 * ⚠️ SDK 底层是 axios：HTTP 层报错（比如缺权限时飞书回 400）会**直接抛异常**，
 * 根本走不到 `assertOk` —— 异常长得像
 * `Error('Request failed with status code 400')`，真正的飞书错误码藏在
 * `error.response.data.code`。不挖这一层，「缺权限 → 给授权链接」的引导就
 * 永远不会触发，用户只会看到一句莫名其妙的 400。
 */
export function feishuErrorCodeOf(error: unknown): number | null {
  if (error instanceof BitableApiError) return error.code
  const anyError = error as {
    response?: { data?: { code?: unknown } }
    code?: unknown
  }
  for (const candidate of [anyError?.response?.data?.code, anyError?.code]) {
    const code = Number(candidate)
    if (Number.isInteger(code) && code !== 0) return code
  }
  return null
}

// ------------------------------------------------------------------ 同步器

/** 「会话 → record_id + 哈希」的本地账本。由调用方持久化。 */
export interface BitableRecordLedger {
  records: Record<string, { rid: string; hash: string }>
}

export interface BitableSyncStats {
  total: number
  create: number
  update: number
  unchanged: number
  delete: number
}

/** 单次批量上限。官方 500，这里再切小一点，避免单请求体过大。 */
const CHUNK = 200

export class BitableSync {
  constructor(
    private readonly client: BitableRestClient,
    /** 账本对象**原地持有**：调用方存的就是它，模块改完调用方直接存。 */
    public ledger: BitableRecordLedger
  ) {}

  /** 新建一个 Base，返回 (app_token, url)。 */
  async createBase(name: string = BITABLE_BASE_NAME): Promise<{ appToken: string; url: string | null }> {
    // ⚠️ body 是 `ReqApp` 形状（`{name}`），不是 `CreateAppRequestBody` ——
    // agent-hub 时代验证过后者这个模型类不存在。
    const data = await assertOk(
      await this.client.bitable.app.create({ data: { name } }),
      '新建多维表格'
    )
    const appToken = data.app?.app_token
    if (!appToken) throw new BitableApiError(-1, '返回里没有 app_token', '新建多维表格')
    return { appToken, url: data.app?.url ?? null }
  }

  async listTables(appToken: string): Promise<Array<{ tableId: string; name: string }>> {
    const data = await assertOk(
      await this.client.bitable.appTable.list({
        path: { app_token: appToken },
        params: { page_size: 100 }
      }),
      '列数据表'
    )
    return (data.items ?? [])
      .filter((item) => item.table_id)
      .map((item) => ({ tableId: item.table_id as string, name: item.name ?? '' }))
  }

  /**
   * 表存在就复用；不存在就按 `SESSION_TABLE_FIELDS` 建一张。返回 table_id。
   * **必须先走 list 再建**，否则每轮同步都会多出一张同名空表。
   *
   * 拿到 tableId 后顺手把 CLI 单选字段补齐新选项 —— 这张表是第一次建的，
   * 之后每加一个 agent（比如 WorkBuddy）都得给旧表补 option，否则写入直接报错。
   */
  async ensureTable(appToken: string, tableName: string = BITABLE_TABLE_NAME): Promise<string> {
    const existing = await this.listTables(appToken)
    const found = existing.find((table) => table.name === tableName)
    let tableId: string
    if (found) {
      tableId = found.tableId
    } else {
      const data = await assertOk(
        await this.client.bitable.appTable.create({
          path: { app_token: appToken },
          data: {
            table: {
              name: tableName,
              default_view_name: '全部会话',
              fields: SESSION_TABLE_FIELDS.map((field) => ({
                field_name: field.name,
                type: field.type,
                ...(field.options
                  ? {
                      property: {
                        options: field.options.map((name) => ({ name }))
                      }
                    }
                  : {})
              }))
            }
          }
        }),
        '建数据表'
      )
      if (!data.table_id) {
        throw new BitableApiError(-1, '返回里没有 table_id', '建数据表')
      }
      tableId = data.table_id
    }
    await this.syncCliOptions(appToken, tableId)
    return tableId
  }

  /**
   * 把「CLI」单选字段的选项补到 `BITABLE_CLI_OPTIONS` 的全集。
   * 幂等：一个不缺就是一次 list，零写入。失败向上抛（调用方折进 outcome）。
   */
  async syncCliOptions(appToken: string, tableId: string): Promise<void> {
    const data = await assertOk(
      await this.client.bitable.appTableField.list({
        path: { app_token: appToken, table_id: tableId },
        params: { page_size: 100 }
      }),
      '列字段'
    )
    const cliField = (data.items ?? []).find((item) => item.field_name === 'CLI')
    if (!cliField?.field_id) return
    const existing = new Set(
      (cliField.property?.options ?? [])
        .map((option) => option.name)
        .filter((name): name is string => typeof name === 'string')
    )
    const missing = BITABLE_CLI_OPTIONS.filter((name) => !existing.has(name))
    if (missing.length === 0) return
    await assertOk(
      await this.client.bitable.appTableField.update({
        path: { app_token: appToken, table_id: tableId, field_id: cliField.field_id },
        data: {
          field_name: 'CLI',
          type: BITABLE_FIELD_TYPE.singleSelect,
          property: { options: BITABLE_CLI_OPTIONS.map((name) => ({ name })) }
        }
      }),
      '补 CLI 选项'
    )
  }

  /**
   * 把表里已有的行读回来，按「agent|会话ID」重建账本。
   *
   * 本地状态丢了（换机器、被删）时**必须**先走这一步，不然几百行会
   * 全部当成新行重插一遍，表里变成双份。
   */
  async rebuildLedger(appToken: string, tableId: string): Promise<number> {
    const index: BitableRecordLedger['records'] = {}
    let pageToken: string | undefined
    for (;;) {
      const data = await assertOk(
        await this.client.bitable.appTableRecord.list({
          path: { app_token: appToken, table_id: tableId },
          params: {
            page_size: 500,
            ...(pageToken ? { page_token: pageToken } : {})
          }
        }),
        '读记录'
      )
      for (const record of data.items ?? []) {
        const fields = record.fields ?? {}
        const sid = typeof fields['会话ID'] === 'string' ? (fields['会话ID'] as string) : ''
        const agent = typeof fields['CLI'] === 'string' ? (fields['CLI'] as string) : ''
        // 单选有时返回数组，宽容处理。
        const agentValue = Array.isArray(fields['CLI'])
          ? String((fields['CLI'] as Array<unknown>)[0] ?? '')
          : agent
        if (sid && record.record_id) {
          index[`${agentValue}|${sid}`] = { rid: record.record_id, hash: '' }
        }
      }
      if (!data.has_more) break
      pageToken = data.page_token || undefined
      if (!pageToken) break
    }
    this.ledger.records = index
    return Object.keys(index).length
  }

  /**
   * 同步会话进表。只推变化过的行；账本里有但本次没出现的行删掉。
   * `dryRun` 只算账不动表 —— 给判卷和「先看看会写什么」用。
   */
  async sync(
    appToken: string,
    tableId: string,
    sessions: readonly BridgeHistorySession[],
    dryRun = false
  ): Promise<BitableSyncStats> {
    const live = new Map<string, { fields: Record<string, unknown>; hash: string }>()
    for (const session of sessions) {
      // 没有 id 的会话没有稳定身份，跳过 —— 否则过期后留下孤儿行。
      if (!session.sessionId) continue
      const fields = historySessionToFields(session)
      // 键里的 agent 一侧必须用**表里落的名字**（cliOptionOf），不是原始 id：
      // rebuildLedger 从表里读回来的 CLI 字段就是显示名。两边不同源的话，
      // 账本一丢、重建的键就对不上，几百行会被当成新行全部重插一遍。
      live.set(`${cliOptionOf(session.agent)}|${session.sessionId}`, {
        fields,
        hash: fieldsHash(fields)
      })
    }

    const toCreate: Array<[string, { fields: Record<string, unknown>; hash: string }]> = []
    const toUpdate: Array<[string, string, { fields: Record<string, unknown>; hash: string }]> = []
    let unchanged = 0
    for (const [key, item] of live) {
      const known = this.ledger.records[key]
      if (!known) toCreate.push([key, item])
      else if (known.hash !== item.hash) toUpdate.push([key, known.rid, item])
      else unchanged += 1
    }
    const toDelete = Object.entries(this.ledger.records)
      .filter(([key]) => !live.has(key))
      .map(([key, record]) => [key, record.rid] as const)

    const stats: BitableSyncStats = {
      total: live.size,
      create: toCreate.length,
      update: toUpdate.length,
      unchanged,
      delete: toDelete.length
    }
    if (dryRun) return stats

    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const batch = toCreate.slice(i, i + CHUNK)
      const data = await assertOk(
        await this.client.bitable.appTableRecord.batchCreate({
          path: { app_token: appToken, table_id: tableId },
          data: { records: batch.map(([, item]) => ({ fields: item.fields })) }
        }),
        '批量新增'
      )
      // 建完必须把 record_id 记下来，否则下一轮全当成新行重插。
      const created = data.records ?? []
      batch.forEach(([key, item], index) => {
        const rid = created[index]?.record_id
        if (rid) this.ledger.records[key] = { rid, hash: item.hash }
      })
    }

    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      const batch = toUpdate.slice(i, i + CHUNK)
      await assertOk(
        await this.client.bitable.appTableRecord.batchUpdate({
          path: { app_token: appToken, table_id: tableId },
          data: {
            records: batch.map(([, rid, item]) => ({ record_id: rid, fields: item.fields }))
          }
        }),
        '批量更新'
      )
      for (const [key, , item] of batch) {
        const known = this.ledger.records[key]
        if (known) this.ledger.records[key] = { rid: known.rid, hash: item.hash }
      }
    }

    if (toDelete.length > 0) {
      for (let i = 0; i < toDelete.length; i += CHUNK) {
        const rids = toDelete.slice(i, i + CHUNK).map(([, rid]) => rid)
        await assertOk(
          await this.client.bitable.appTableRecord.batchDelete({
            path: { app_token: appToken, table_id: tableId },
            data: { records: rids }
          }),
          '批量删除'
        )
      }
      for (const [key] of toDelete) delete this.ledger.records[key]
    }

    return stats
  }
}
