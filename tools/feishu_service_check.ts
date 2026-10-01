/**
 * 飞书渠道服务层的判卷脚本。
 *
 * 跑的是**完整的那条链**：扫码 begin → 轮询 waiting → 轮询 success → 凭据落盘
 * → 建长连接 → 状态广播 → 解绑清理。但全程**一个包都不发**：
 * `fetchImpl` 和 `channelFactory` 都注了假的，所以这个脚本离线可跑、可重复。
 *
 * 三条不变量在这里被钉死（改坏了会红）：
 *   1. **App Secret 不出主进程** —— 所有广播出去的快照里都不许出现明文 secret；
 *   2. **扫码人自动进准入名单** —— 否则机器人装好了却不理任何人；
 *   3. **解绑要清干净** —— 凭据文件读回来必须是 null，不是「还在但没人用」。
 *
 * 跑法（先打包再执行，因为源码里有不带扩展名的 TS import）：
 *   node_modules/.bin/esbuild tools/feishu_service_check.ts --bundle \
 *     --platform=node --format=esm --outfile=tools/_feishu_service_check.mjs
 *   node tools/_feishu_service_check.mjs
 */

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeishuService } from '../electron/feishu/service'
import { FeishuStore, isFeishuAppId, maskAppId } from '../electron/feishu/store'
import type { FeishuStatus } from '../shared/ipc-contract'

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

function section(title: string): void {
  console.log(`\n${title}`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true
    await sleep(40)
  }
  return false
}

const SCANNER_OPEN_ID = 'ou_scanner_0001'
const FAKE_APP_ID = 'cli_0123456789abcdef'
const FAKE_APP_SECRET = 'fake-secret-must-never-leak-1234567890'

/** 只实现 `requestRegistration` 用到的那两个成员：`status` 和 `json()`。 */
function fakeResponse(payload: unknown, status = 200): unknown {
  return { status, json: async () => payload }
}

function makeFakeFetch(pollScript: unknown[]): {
  fetchImpl: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  let pollIndex = 0
  const fetchImpl = (async (url: string, init: { body?: string }) => {
    const body = String(init?.body ?? '')
    const action = new URLSearchParams(body).get('action') ?? '?'
    calls.push(`${action}@${url}`)
    if (action === 'begin') {
      return fakeResponse({
        device_code: 'device-code-1',
        verification_uri_complete: 'https://open.feishu.cn/page/launcher?user_code=TEST-0001',
        // 服务端给的 interval 决定轮询节奏；压到 1 秒让脚本跑得快一点。
        expires_in: 3600,
        interval: 1
      })
    }
    const next = pollScript[Math.min(pollIndex, pollScript.length - 1)]
    pollIndex += 1
    return fakeResponse(next)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** 假长连接：不碰网络，直接报告「已连接」。 */

async function main(): Promise<void> {
  console.log('飞书渠道 · 服务层判卷')

  const root = mkdtempSync(join(tmpdir(), 'gbc-feishu-'))
  const storePath = join(root, 'feishu.json')
  const store = new FeishuStore(storePath)

  // ---------------------------------------------------------------- 凭据存储
  section('凭据存储')
  check('文件不存在时读成 null（未绑定）', (await store.read()) === null)

  await store.write({
    appId: FAKE_APP_ID,
    appSecret: FAKE_APP_SECRET,
    domain: 'feishu',
    boundAt: 1_700_000_000_000,
    pairedUsers: [{ openId: SCANNER_OPEN_ID, name: '扫码人', pairedAt: 1_700_000_000_000 }]
  })
  const written = await store.read()
  check('写进去能原样读回来', written?.appId === FAKE_APP_ID && written.appSecret === FAKE_APP_SECRET)
  check('域名保住了', written?.domain === 'feishu')
  check('准入名单保住了', written?.pairedUsers.length === 1)
  check(
    '没有留下 .tmp 残骸（原子写的证据）',
    !readdirSync(root).some((name) => name.endsWith('.tmp')),
    readdirSync(root).join(', ')
  )
  if (process.platform !== 'win32') {
    check('权限是 0600', (statSync(storePath).mode & 0o777) === 0o600)
  } else {
    console.log('  \u25CB 权限位在 Windows 上不由 stat 反映，跳过')
  }

  writeFileSync(storePath, '{"version":1,"binding":{"appId":"cli_')
  check('JSON 半截 → 按未绑定处理（安全方向的降级）', (await store.read()) === null)

  await store.write({
    appId: FAKE_APP_ID,
    appSecret: FAKE_APP_SECRET,
    domain: 'feishu',
    boundAt: 1,
    pairedUsers: []
  })
  await store.pairUser(SCANNER_OPEN_ID, '扫码人')
  await store.pairUser(SCANNER_OPEN_ID, '改个名')
  const paired = await store.read()
  check('重复配对是幂等的', paired?.pairedUsers.length === 1)
  check('重复配对不会把备注清空', paired?.pairedUsers[0].name === '改个名')
  await store.unpairUser(SCANNER_OPEN_ID)
  check('解绑单个用户生效', (await store.read())?.pairedUsers.length === 0)

  section('App ID 判据')
  check('合法 cli_ + 16 位十六进制', isFeishuAppId(FAKE_APP_ID))
  check('大小写都认', isFeishuAppId('cli_0123456789ABCDEF'))
  check('少一位不算', !isFeishuAppId('cli_0123456789abcde'))
  check('非十六进制不算', !isFeishuAppId('cli_zzzzzzzzzzzzzzzz'))
  check('cli_ 前缀不可省', !isFeishuAppId('0123456789abcdef'))
  check('脱敏后不含完整 id', maskAppId(FAKE_APP_ID) === 'cli_0123\u2026cdef')
  check('短串也脱敏', maskAppId('cli_x') === 'cli_\u2026')

  // ---------------------------------------------------------------- 服务状态机
  section('服务状态机（假 fetch + 假长连接）')
  await store.write(null)
  const broadcasts: FeishuStatus[] = []
  const { fetchImpl } = makeFakeFetch([
    { error: 'authorization_pending' },
    { client_id: FAKE_APP_ID, client_secret: FAKE_APP_SECRET, user_info: { open_id: SCANNER_OPEN_ID } }
  ])
  const channelState = { instances: 0, disposed: 0 }
  const service = new FeishuService({
    store,
    broadcast: (status) => broadcasts.push(status),
    fetchImpl,
    channelFactory: () => {
      channelState.instances += 1
      return {
        start: async () => ({ error: null }),
        connectionState: () => 'connected',
        dispose: async () => {
          channelState.disposed += 1
        }
      }
    }
  })

  const initial = await service.initialize()
  check('没绑定时 phase 是 unbound', initial.phase === 'unbound')
  check('没绑定时不下发 appId', initial.appIdMasked === null)

  const scanning = await service.beginScan()
  check('扫码后 phase 是 scanning', scanning.phase === 'scanning', scanning.phase)
  check('拿到了二维码票据', Boolean(scanning.scan?.sessionKey))
  const qr = scanning.scan?.verificationUri ?? ''
  const qrParams = new URL(qr).searchParams
  check('二维码指向飞书官方域名', qr.startsWith('https://open.feishu.cn/page/launcher'), qr.slice(0, 60))
  check('带上 createOnly（绝不绑已有应用）', qrParams.get('createOnly') === 'true')
  check('带上 from=sdk 与 tp=sdk', qrParams.get('from') === 'sdk' && qrParams.get('tp') === 'sdk')
  check('addons 已编码', Boolean(qrParams.get('addons')) && qrParams.get('addons')!.length > 40)
  check('票据带过期时间', (scanning.scan?.expiresAt ?? 0) > Date.now())
  check('扫码中不下发凭据', scanning.appIdMasked === null)
  // 扫码发生在绑定之前。UI 靠这个字段决定「准入名单」那块显不显示，
  // 漏了就会出现「二维码还没扫完，先给你看『已授权 0 个账号』」。
  check('★ 扫码中 bound 是 false（还没凭据）', scanning.bound === false)

  const sawWaiting = await waitFor(() => broadcasts.some((s) => s.phase === 'scanning' && s.scan))
  check('等待扫码期间有状态广播', sawWaiting)

  const connected = await waitFor(
    () => service.getStatus().phase === 'connected',
    12_000
  )
  const final = service.getStatus()
  check('轮询到凭据后进入 connected', connected, final.phase)
  check('下发了脱敏 appId', final.appIdMasked === maskAppId(FAKE_APP_ID), String(final.appIdMasked))
  check('扫码人自动进了准入名单', final.pairedUserCount === 1, String(final.pairedUserCount))
  check('绑上之后 bound 是 true', final.bound === true)
  check('扫码票据已回收', final.scan === null)
  check('长连接被建起来了', channelState.instances === 1, String(channelState.instances))

  const onDisk = await store.read()
  check('凭据落盘了', onDisk?.appId === FAKE_APP_ID)
  check('secret 也落盘了（本地加密之外的唯一副本）', onDisk?.appSecret === FAKE_APP_SECRET)

  // 最重要的一条：广播是走出去的，secret 绝不能在里头。
  const leaked = JSON.stringify(broadcasts).includes(FAKE_APP_SECRET)
  check('★ 所有广播里都不含明文 App Secret', !leaked)
  check('广播了不止一次状态变化', broadcasts.length >= 3, String(broadcasts.length))

  section('解绑与取消')
  const cancelled = await service.cancelScan()
  check('没有扫码时取消是安全的（幂等）', cancelled.scan === null)

  const unbound = await service.unbind()
  check('解绑后回到 unbound', unbound.phase === 'unbound')
  check('解绑后清空了准入名单', unbound.pairedUserCount === 0)
  check('解绑后盘上读不到凭据', (await store.read()) === null)
  check('解绑时把长连接拆了', channelState.disposed >= 1, String(channelState.disposed))

  // 再绑一次（走手工通道），确认换凭据不会报错也不会把 secret 暴露出去。
  const manual = await service.bindManual({
    appId: FAKE_APP_ID,
    appSecret: FAKE_APP_SECRET,
    domain: 'lark'
  })
  check('手工绑定成功', manual.phase === 'connected', manual.phase)
  check('手工绑定记下了域名', manual.domain === 'lark')
  const badAppId = await service.bindManual({ appId: 'nope', appSecret: 'x', domain: 'feishu' })
  // phase 描述的是「连接」，不是「最近一次操作」。已经连上的通道不该因为
  // 一次填错 ID 就被判成 error —— 错误放在 error 字段里，连接照旧。
  check('手工绑定会拦下非法 App ID', Boolean(badAppId.error), String(badAppId.error))
  check('填错 ID 不会把已连上的通道踢掉', badAppId.phase === 'connected', badAppId.phase)
  check('拦下后不会写盘', (await store.read())?.domain === 'lark')

  check(
    '广播全程未泄漏 secret（第二次绑定之后）',
    !JSON.stringify(broadcasts).includes(FAKE_APP_SECRET)
  )

  await service.dispose()
  rmSync(root, { recursive: true, force: true })

  console.log(`\n通过 ${pass} · 失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
