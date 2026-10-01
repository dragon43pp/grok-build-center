/**
 * 飞书「连接成功后的下文」离线判卷：多维表格自动建 + 会话历史同步 + 引导卡。
 *
 * 不碰网络、不碰 Electron、不碰真实凭据 —— 全部打在一张 FakeBitable 上。
 * 重点盯四件会翻车的事：
 *
 *   1. 幂等：第二轮同步必须一个新行都不插（账本里 hash 没变就跳过）；
 *   2. 状态文件被删后必须先重建索引，不能把已有行全部重插一遍；
 *   3. `99991672`（应用缺权限）必须折成「点一下就到」的授权链接 + 补救卡；
 *   4. 引导卡必须诚实：没实现的指令写「下一版」，不许骗用户。
 *
 * 跑法：
 *   node_modules/.bin/esbuild tools/feishu_provision_check.ts --bundle \
 *     --platform=node --format=esm --outfile=tools/_feishu_provision_check.mjs \
 *     && node tools/_feishu_provision_check.mjs
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BitableSync,
  cliOptionOf,
  historySessionToFields,
  type BitableRestClient,
  type BitableApiResponse
} from '../electron/feishu/bitable'
import {
  provisionFeishuWorkspace,
  feishuPermissionUrl,
  buildWelcomeCard,
  summarizeProvision,
  type FeishuProvisionDeps
} from '../electron/feishu/provision'
import type { BridgeHistorySession } from '../shared/bridge-protocol'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    pass += 1
    console.log(`  \u2714 ${name}`)
  } else {
    fail += 1
    console.log(`  \u2716 ${name}${extra ? ` \u2014 ${extra}` : ''}`)
  }
}

// ------------------------------------------------------------------ 会话样本

function makeSession(overrides: Partial<BridgeHistorySession> = {}): BridgeHistorySession {
  return {
    agent: 'grok',
    sessionId: 'ses-1',
    title: '造书成剧 · 首页改版',
    workspace: 'D:/wx/造书成剧',
    updatedAt: '2026-09-30T10:00:00.000Z',
    messageCount: 42,
    resumable: true,
    ...overrides
  }
}

// ------------------------------------------------------------------ 假客户端

interface FakeRow {
  recordId: string
  fields: Record<string, unknown>
}

class FakeBitable implements BitableRestClient {
  appToken = 'app_fake_token'
  url = 'https://example.feishu.cn/base/fake'
  /** app.create 返回的错误码；0 表示正常。 */
  createCode = 0
  /** 为 true 时 app.create 按 axios 的抛法扔异常（HTTP 层失败，错误码藏在 response.data.code）。 */
  createThrowsAxios = false
  createCalls = 0
  tableCreateCalls = 0
  batchCreateCalls = 0
  batchCreateRows = 0
  batchUpdateCalls = 0
  batchDeleteCalls = 0
  fieldUpdateCalls = 0
  /** tableId -> {name, rows}，用 Map 保序。 */
  tables = new Map<string, { name: string; rows: Map<string, FakeRow> }>()
  /** tableId -> 字段元数据（syncCliOptions 的 list/update 就作用在这上面）。 */
  tableFields = new Map<
    string,
    Array<{
      field_id: string
      field_name: string
      type: number
      property?: { options?: Array<{ name: string }> }
    }>
  >()
  private tableSeq = 0
  private rowSeq = 0

  private ok(data: NonNullable<BitableApiResponse['data']>): BitableApiResponse {
    return { code: 0, data }
  }

  private err(code: number): BitableApiResponse {
    return { code, msg: `mock error ${code}` }
  }

  /** 造一条「表里本来就有」的行，测 rebuildLedger 用。 */
  seedRecord(fields: Record<string, unknown>): string {
    const [tableId] = this.tables.keys()
    if (!tableId) throw new Error('seedRecord 需要先有一张表')
    const rid = `rec_seed_${(this.rowSeq += 1)}`
    this.tables.get(tableId)!.rows.set(rid, { recordId: rid, fields })
    return rid
  }

  bitable = {
    app: {
      create: async (): Promise<BitableApiResponse> => {
        this.createCalls += 1
        if (this.createThrowsAxios) {
          // 复刻 axios 的形态：feishuErrorCodeOf 必须能从这里面挖出错误码。
          const err = new Error('Request failed with status code 400') as Error & {
            response?: { status: number; data: { code: number; msg: string } }
          }
          err.response = { status: 400, data: { code: this.createCode, msg: 'mock' } }
          throw err
        }
        if (this.createCode !== 0) return this.err(this.createCode)
        return this.ok({ app: { app_token: this.appToken, url: this.url } })
      }
    },
    appTable: {
      list: async (): Promise<BitableApiResponse> =>
        this.ok({
          items: [...this.tables.entries()].map(([tableId, table]) => ({
            table_id: tableId,
            name: table.name
          }))
        }),
      create: async (args: {
        data: { table: { name: string; fields: unknown[] } }
      }): Promise<BitableApiResponse> => {
        this.tableCreateCalls += 1
        const tableId = `tbl_${(this.tableSeq += 1)}`
        this.tables.set(tableId, { name: args.data.table.name, rows: new Map() })
        // 真实飞书建表会把 fields 变成字段元数据（带 field_id），这里照抄这个行为，
        // 否则 syncCliOptions 的 list 就没东西可列 —— fake 必须镜像真实接口形状。
        this.tableFields.set(
          tableId,
          args.data.table.fields.map((field, index) => {
            const spec = field as {
              field_name: string
              type: number
              property?: { options: Array<{ name: string }> }
            }
            return {
              field_id: `fld_${tableId}_${index}`,
              field_name: spec.field_name,
              type: spec.type,
              property: spec.property
                ? JSON.parse(JSON.stringify(spec.property))
                : undefined
            }
          })
        )
        return this.ok({ table_id: tableId })
      }
    },
    appTableField: {
      list: async (args: {
        path: { table_id: string }
      }): Promise<BitableApiResponse> => {
        const fields = this.tableFields.get(args.path.table_id)
        if (!fields) return this.err(1254001)
        return this.ok({ items: fields })
      },
      update: async (args: {
        path: { table_id: string; field_id: string }
        data: { field_name: string; type: number; property?: { options: Array<{ name: string }> } }
      }): Promise<BitableApiResponse> => {
        this.fieldUpdateCalls += 1
        const fields = this.tableFields.get(args.path.table_id)
        if (!fields) return this.err(1254001)
        const field = fields.find((f) => f.field_id === args.path.field_id)
        if (!field) return this.err(1254002)
        field.property = args.data.property
          ? JSON.parse(JSON.stringify(args.data.property))
          : undefined
        return this.ok({
          field: { field_id: field.field_id, field_name: field.field_name }
        })
      }
    },
    appTableRecord: {
      list: async (args: {
        path: { table_id: string }
      }): Promise<BitableApiResponse> => {
        const table = this.tables.get(args.path.table_id)
        if (!table) return this.err(1254001)
        return this.ok({
          items: [...table.rows.values()].map((row) => ({
            record_id: row.recordId,
            fields: row.fields
          })),
          has_more: false
        })
      },
      batchCreate: async (args: {
        path: { table_id: string }
        data: { records: Array<{ fields: Record<string, unknown> }> }
      }): Promise<BitableApiResponse> => {
        this.batchCreateCalls += 1
        this.batchCreateRows += args.data.records.length
        const table = this.tables.get(args.path.table_id)
        if (!table) return this.err(1254001)
        const created = args.data.records.map((record) => {
          const rid = `rec_${(this.rowSeq += 1)}`
          table.rows.set(rid, { recordId: rid, fields: record.fields })
          return { record_id: rid }
        })
        return this.ok({ records: created })
      },
      batchUpdate: async (args: {
        path: { table_id: string }
        data: { records: Array<{ record_id: string; fields: Record<string, unknown> }> }
      }): Promise<BitableApiResponse> => {
        this.batchUpdateCalls += 1
        const table = this.tables.get(args.path.table_id)
        if (!table) return this.err(1254001)
        for (const record of args.data.records) {
          const row = table.rows.get(record.record_id)
          if (row) row.fields = record.fields
        }
        return this.ok({})
      },
      batchDelete: async (args: {
        path: { table_id: string }
        data: { records: string[] }
      }): Promise<BitableApiResponse> => {
        this.batchDeleteCalls += 1
        const table = this.tables.get(args.path.table_id)
        if (!table) return this.err(1254001)
        for (const rid of args.data.records) table.rows.delete(rid)
        return this.ok({})
      }
    }
  }
}

interface SentCard {
  openId: string
  card: Record<string, unknown>
}

function makeDeps(
  fake: FakeBitable,
  statePath: string,
  sessions: BridgeHistorySession[],
  sent: SentCard[],
  overrides: Partial<FeishuProvisionDeps> = {}
): FeishuProvisionDeps {
  return {
    appId: 'cli_test_app',
    client: fake,
    history: async () => sessions,
    pairedOpenIds: ['ou_user_a', 'ou_user_b'],
    sendCard: async (openId, card) => {
      sent.push({ openId, card })
      return { error: null, code: null }
    },
    statePath,
    ...overrides
  }
}

// ------------------------------------------------------------------ 用例

const dir = mkdtempSync(join(tmpdir(), 'gbc-provision-'))
const statePath = join(dir, 'feishu-bitable.json')

const sessionsA = [
  makeSession({ sessionId: 'ses-1' }),
  makeSession({
    sessionId: 'ses-2',
    agent: 'codex',
    title: 'hrack 桌面版排查',
    updatedAt: undefined,
    messageCount: 0
  })
]

// --- 1~5. 一条会话生命周期：首轮建表 → 幂等 → 变化 → 删除
//
// 注意这几轮**必须共用同一个假客户端**：账本里缓存了 appToken/tableId，
// 之后每轮都会跳过建表直接读写已有表 —— 换新客户端表就不存在了。
{
  const fake = new FakeBitable()
  const sent: SentCard[] = []
  const tableIdOf = () => {
    const first = fake.tables.keys().next()
    return first.done ? null : first.value
  }
  const rowCount = () => (tableIdOf() ? fake.tables.get(tableIdOf())!.rows.size : 0)

  // 第 1 轮：建 Base + 建表 + 同步 + 引导卡
  const outcome = await provisionFeishuWorkspace(makeDeps(fake, statePath, sessionsA, sent))

  check('首轮成功（state=done）', outcome.state === 'done')
  check('返回多维表格链接', outcome.bitableUrl === fake.url, String(outcome.bitableUrl))
  check('同步数=2', outcome.synced === 2, String(outcome.synced))
  check('没有错误', outcome.error === null && outcome.welcomeError === null)
  check('Base 只建了一次', fake.createCalls === 1, String(fake.createCalls))
  check('数据表只建了一张', fake.tableCreateCalls === 1, String(fake.tableCreateCalls))
  check('插入了 2 行', fake.batchCreateRows === 2, String(fake.batchCreateRows))
  check('表里确实有 2 行', rowCount() === 2, String(rowCount()))
  check('每个授权用户各收到一张卡', sent.length === 2, String(sent.length))
  check('日期字段是毫秒（13 位）', (() => {
    const row = [...fake.tables.get(tableIdOf()!)!.rows.values()][0]
    const ts = row.fields['最后活动'] as number
    return ts === Date.parse('2026-09-30T10:00:00.000Z')
  })())
  check('新建表 CLI 选项已齐全（零次补写）', fake.fieldUpdateCalls === 0, String(fake.fieldUpdateCalls))

  // 1b. 旧表的 CLI 单选缺新 agent 选项 → syncCliOptions 必须补齐（appTableField.update）
  {
    const stale = fake.tableFields.get(tableIdOf()!)!
    const cli = stale.find((f) => f.field_name === 'CLI')!
    cli.property = { options: cli.property!.options!.slice(0, 2) }
    const before = cli.property.options!.length
    const sync = new BitableSync(fake, { records: {} })
    await sync.ensureTable(fake.appToken)
    check('CLI 选项被裁掉后 ensureTable 补写一次', fake.fieldUpdateCalls === 1, String(fake.fieldUpdateCalls))
    check('补写后选项数恢复', cli.property!.options!.length > before, String(cli.property!.options!.length))
  }

  const card = sent[0]?.card as {
    header?: { template?: string; title?: { content?: string } }
    elements?: Array<{ tag?: string; actions?: Array<{ url?: string }> }>
  }
  check('引导卡是绿色头', card.header?.template === 'green')
  check('卡里有「打开多维表格」按钮且指向表格', (() => {
    const actions = card.elements?.flatMap((el) => el.actions ?? []) ?? []
    return actions.some((action) => action.url === fake.url)
  })())
  check('卡片诚实：写了「下一版」', JSON.stringify(card).includes('下一版'))
  check(
    '卡片没有撒谎（没承诺发指令）',
    !JSON.stringify(card).includes('发「列表」')
  )

  // --- 状态文件落盘
  check('账本已落盘', existsSync(statePath))
  const stored = JSON.parse(readFileSync(statePath, 'utf8')) as {
    appId?: string
    records: Record<string, unknown>
  }
  check('账本记录了两场', Object.keys(stored.records).length === 2)
  check('账本记了应用 id', stored.appId === 'cli_test_app')

  // --- 第 2 轮：幂等（零新建、零更新、零删除）
  sent.length = 0
  const outcome2 = await provisionFeishuWorkspace(makeDeps(fake, statePath, sessionsA, sent))
  check('二轮也是 done', outcome2.state === 'done')
  check('幂等：第二轮没有新建', fake.createCalls === 1, String(fake.createCalls))
  check('幂等：没有新插行', fake.batchCreateRows === 2, String(fake.batchCreateRows))
  check('幂等：没有更新', fake.batchUpdateCalls === 0, String(fake.batchUpdateCalls))
  check('幂等：没有删除', fake.batchDeleteCalls === 0, String(fake.batchDeleteCalls))
  check('幂等：卡还是发的（每轮连接都该有下文）', sent.length === 2)

  // --- 第 3 轮：变化行只更新那一条
  const changed = [
    makeSession({ sessionId: 'ses-1', title: '造书成剧 · 改名了' }),
    makeSession({
      sessionId: 'ses-2',
      agent: 'codex',
      title: 'hrack 桌面版排查',
      updatedAt: undefined,
      messageCount: 0
    })
  ]
  await provisionFeishuWorkspace(makeDeps(fake, statePath, changed, sent))
  check('变化轮：1 次批量更新', fake.batchUpdateCalls === 1, String(fake.batchUpdateCalls))
  check('变化轮：没有新建', fake.batchCreateRows === 2, String(fake.batchCreateRows))
  const changedRow = [...fake.tables.get(tableIdOf()!)!.rows.values()].find(
    (item) => item.fields['会话ID'] === 'ses-1'
  )
  check(
    '表里的标题真的变了',
    changedRow?.fields['标题'] === '造书成剧 · 改名了',
    String(changedRow?.fields['标题'])
  )

  // --- 第 4 轮：消失的会话要删行
  await provisionFeishuWorkspace(makeDeps(fake, statePath, [sessionsA[0]], sent))
  check('删除轮：1 次批量删除', fake.batchDeleteCalls === 1, String(fake.batchDeleteCalls))
  check('表里只剩 1 行', rowCount() === 1, String(rowCount()))
}

// --- 6. 状态文件丢了：先重建索引，绝不重插
{
  const fake = new FakeBitable()
  const sent: SentCard[] = []
  // 预置：表已存在、里面已有 ses-1/ses-2 两行（本地账本被删掉的现场）。
  await (async () => {
    const sync = new BitableSync(fake, { records: {} })
    const tableId = await sync.ensureTable(fake.appToken)
    fake.seedRecord({ 会话ID: 'ses-1', CLI: 'Grok Build' })
    fake.seedRecord({ 会话ID: 'ses-2', CLI: 'Codex' })
    void tableId
  })()
  const emptyPath = join(dir, 'feishu-bitable-lost.json')
  const outcome = await provisionFeishuWorkspace(makeDeps(fake, emptyPath, sessionsA, sent))
  check('账本丢失也能走完（done）', outcome.state === 'done')
  check('账本丢失：没有重插任何行', fake.batchCreateRows === 0, String(fake.batchCreateRows))
  const lostTableId = (() => {
    const first = fake.tables.keys().next()
    return first.done ? null : first.value
  })() as string
  check('账本丢失：表里还是 2 行（没有双份）', fake.tables.get(lostTableId)!.rows.size === 2)
  check(
    '账本丢失：已有行被推了新内容（更新而非插入）',
    fake.batchUpdateCalls >= 1,
    String(fake.batchUpdateCalls)
  )
}

// --- 7. 缺权限（99991672）：授权链接 + 补救卡
{
  const fake = new FakeBitable()
  fake.createCode = 99991672
  const sent: SentCard[] = []
  const freshPath = join(dir, 'feishu-bitable-noperm.json')
  const outcome = await provisionFeishuWorkspace(makeDeps(fake, freshPath, sessionsA, sent))
  check('缺权限：state=failed', outcome.state === 'failed')
  check('缺权限：给了授权链接', outcome.permissionUrl === feishuPermissionUrl('cli_test_app'))
  check(
    '授权链接形状正确（直达 bitable:app）',
    outcome.permissionUrl?.includes('/auth?q=bitable%3Aapp&token_type=tenant') === true,
    String(outcome.permissionUrl)
  )
  check('缺权限：补救卡也发出去了', sent.length === 2)
  const card = sent[0]?.card as {
    header?: { template?: string; title?: { content?: string } }
    elements?: Array<{ tag?: string; actions?: Array<{ url?: string }> }>
  }
  check('补救卡是橙色头', card.header?.template === 'orange')
  check(
    '补救卡里有「去补授权」按钮',
    (() => {
      const actions = card.elements?.flatMap((el) => el.actions ?? []) ?? []
      return actions.some((action) => action.url === outcome.permissionUrl)
    })()
  )
}

// --- 8. 缺权限的另一种抛法：SDK 在 HTTP 层直接扔 axios 异常
{
  const fake = new FakeBitable()
  fake.createCode = 99991672
  fake.createThrowsAxios = true
  const sent: SentCard[] = []
  const freshPath = join(dir, 'feishu-bitable-axios-perm.json')
  const outcome = await provisionFeishuWorkspace(makeDeps(fake, freshPath, sessionsA, sent))
  check('axios 形态：state=failed', outcome.state === 'failed')
  check(
    'axios 形态：照样挖出授权链接',
    outcome.permissionUrl === feishuPermissionUrl('cli_test_app'),
    String(outcome.permissionUrl)
  )
  check(
    'axios 形态：错误换成人话（不再是 400 原文）',
    outcome.error?.includes('99991672') === true &&
      !outcome.error?.includes('status code 400'),
    String(outcome.error)
  )
  check('axios 形态：补救卡发出去了', sent.length === 2, String(sent.length))
}

// --- 8b. 其他飞书错误码：至少把码带进错误信息，方便排查
{
  const fake = new FakeBitable()
  fake.createCode = 99991663
  fake.createThrowsAxios = true
  const sent: SentCard[] = []
  const outcome = await provisionFeishuWorkspace(
    makeDeps(fake, join(dir, 'feishu-bitable-axios-other.json'), sessionsA, sent)
  )
  check('其他错误码：state=failed', outcome.state === 'failed')
  check('其他错误码：不给授权链接', outcome.permissionUrl === null)
  check(
    '其他错误码：错误里带飞书码',
    outcome.error?.includes('99991663') === true,
    String(outcome.error)
  )
  check('其他错误码：不发补救卡', sent.length === 0, String(sent.length))
}

// --- 9. 没人配对：直接放弃，不打 API
{
  const fake = new FakeBitable()
  const sent: SentCard[] = []
  const outcome = await provisionFeishuWorkspace(
    makeDeps(fake, join(dir, 'feishu-bitable-nopair.json'), sessionsA, sent, {
      pairedOpenIds: []
    })
  )
  check('没人可发：state=failed', outcome.state === 'failed')
  check('没人可发：不建表', fake.createCalls === 0, String(fake.createCalls))
  check('没人可发：不发卡', sent.length === 0, String(sent.length))
}

// --- 9. 引导卡发送失败不影响表格
{
  const fake = new FakeBitable()
  const sent: SentCard[] = []
  const outcome = await provisionFeishuWorkspace(
    makeDeps(fake, join(dir, 'feishu-bitable-cardfail.json'), sessionsA, sent, {
      sendCard: async () => ({ error: 'mock card failure', code: null })
    })
  )
  check('卡发失败：表格仍然 done', outcome.state === 'done')
  check(
    '卡发失败：错误单独记在 welcomeError',
    outcome.welcomeError?.includes('mock card failure') === true,
    String(outcome.welcomeError)
  )
  check('卡发失败：bitableUrl 照常返回', outcome.bitableUrl === fake.url)
}

// --- 10. dryRun：只算账不动表
{
  const fake = new FakeBitable()
  const sync = new BitableSync(fake, { records: {} })
  const tableId = await sync.ensureTable(fake.appToken)
  const stats = await sync.sync(fake.appToken, tableId, sessionsA, true)
  check('dryRun：算出 2 条待建', stats.create === 2, JSON.stringify(stats))
  check('dryRun：没有真的插行', fake.batchCreateRows === 0, String(fake.batchCreateRows))
  const stats2 = await sync.sync(fake.appToken, tableId, sessionsA, true)
  check('dryRun 不改账本：再算还是 2 条', stats2.create === 2)
}

// --- 11. 单元：CLI 归类
check('cliOptionOf(grok) = Grok Build', cliOptionOf('grok') === 'Grok Build')
check('cliOptionOf(未知) 落「其他」', cliOptionOf('mystery-cli') === '其他')
check('cliOptionOf 大小写不敏感', cliOptionOf('CODEX') === 'Codex')

// --- 12. 单元：字段映射
{
  const fields = historySessionToFields(
    makeSession({ title: '  ', resumable: false, blockedReason: '该 CLI 未安装' })
  )
  check('空标题落「(未命名)」', fields['标题'] === '(未命名)', String(fields['标题']))
  check('不可恢复落 checkbox=false', fields['可恢复'] === false)
  check('不能恢复原因带出来', fields['不能恢复原因'] === '该 CLI 未安装')
  const noDate = historySessionToFields(makeSession({ updatedAt: undefined }))
  check('没有时间就不写日期字段（不会变成 1970）', !('最后活动' in noDate))
}

// --- 13. summarizeProvision
{
  const done = summarizeProvision({
    state: 'done',
    bitableUrl: 'https://x',
    synced: 7,
    error: null,
    permissionUrl: null,
    welcomeError: null,
    ranAt: 0
  })
  check('总结：done 显示同步数', done.includes('7'))
  const perm = summarizeProvision({
    state: 'failed',
    bitableUrl: null,
    synced: null,
    error: 'x',
    permissionUrl: 'https://auth',
    welcomeError: null,
    ranAt: 0
  })
  check('总结：缺权限指向授权', perm.includes('授权'))
}

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // 临时目录清理失败不影响判卷结论
}

console.log(`\n通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
