/**
 * 飞书扫码创建应用 —— 状态机实测（不依赖用户扫码）。
 *
 * 跑法（Node 22+ 自带 TS 类型擦除，不需要额外依赖）：
 *
 *     node tools/feishu_registration_check.mjs
 *
 * 它会真的打飞书线上接口，验证四件事：
 *   1. begin 能不能拿到 device_code 和验证链接；
 *   2. 验证链接是不是官方域名（钓鱼白名单真的在拦）；
 *   3. 没扫码时 poll 会不会老老实实回 waiting；
 *   4. 不存在的 sessionKey 会不会回 not_started。
 *
 * 全程不会创建任何应用 —— 应用只在你扫码确认的那一刻才被创建。
 */

import {
  beginFeishuRegistration,
  pollFeishuRegistration,
  cancelFeishuRegistration,
  assertFeishuVerificationUrl,
  encodeFeishuAddons,
  FEISHU_REQUIRED_SCOPES,
  FEISHU_REQUIRED_EVENTS,
  FEISHU_REQUIRED_CALLBACKS
} from '../electron/feishu/registration.ts'

let failed = 0
function ok(label, extra = '') {
  console.log(`  [OK]   ${label}${extra ? '  ' + extra : ''}`)
}
function bad(label, extra = '') {
  failed += 1
  console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`)
}

console.log('\n[1] addons 编码形状（gzip → base64 → urlsafe → 去 =）')
const encoded = encodeFeishuAddons({ preset: false, scopes: { tenant: [...FEISHU_REQUIRED_SCOPES] } })
if (/^[A-Za-z0-9_-]+$/.test(encoded) && !encoded.includes('=')) ok('编码是 URL-safe 且无填充', encoded.slice(0, 24) + '…')
else bad('编码形状不对', encoded)

console.log('\n[2] 验证链接白名单真的在拦')
for (const [label, url] of [
  ['官方域名放行', 'https://open.feishu.cn/page/launcher?user_code=AAAA-BBBB'],
  ['http 拒绝', 'http://open.feishu.cn/page/launcher'],
  ['外部域名拒绝', 'https://evil.example.com/page/launcher'],
  ['带凭证拒绝', 'https://user:pass@open.feishu.cn/page/launcher']
]) {
  let threw = false
  try {
    assertFeishuVerificationUrl(url)
  } catch {
    threw = true
  }
  const shouldThrow = label !== '官方域名放行'
  if (threw === shouldThrow) ok(label)
  else bad(label, `threw=${threw}`)
}

console.log('\n[3] 打到飞书线上：begin')
const begun = await beginFeishuRegistration({ appName: 'Grok Build Center 机器人' })
ok('拿到 sessionKey', begun.sessionKey.slice(0, 8) + '…')
ok('二维码链接', begun.verificationUri.slice(0, 96))
ok('有效期 / 轮询间隔', `${begun.expiresInSeconds}s / ${begun.intervalSeconds}s`)

const uri = new URL(begun.verificationUri)
const checks = [
  ['user_code 在里面', uri.searchParams.has('user_code')],
  ['createOnly=true（只新建，不碰已有应用）', uri.searchParams.get('createOnly') === 'true'],
  ['addons 已带上', (uri.searchParams.get('addons') || '').length > 20],
  ['source 标识正确', uri.searchParams.get('source') === 'grok-build-center']
]
for (const [label, pass] of checks) (pass ? ok : bad)(label)

console.log('\n[4] 线上 poll（用户还没扫 → 必须是 waiting）')
const first = await pollFeishuRegistration({ sessionKey: begun.sessionKey })
if (first.status === 'waiting') ok('状态 waiting', `interval=${first.intervalSeconds}s`)
else bad('期望 waiting', JSON.stringify(first))

console.log('\n[5] 不存在的 sessionKey')
const ghost = await pollFeishuRegistration({ sessionKey: 'no-such-session' })
if (ghost.status === 'not_started') ok('状态 not_started')
else bad('期望 not_started', JSON.stringify(ghost))

console.log('\n[6] 取消后立刻失效')
cancelFeishuRegistration(begun.sessionKey)
const cancelled = await pollFeishuRegistration({ sessionKey: begun.sessionKey })
if (cancelled.status === 'not_started') ok('取消后回 not_started')
else bad('取消没生效', JSON.stringify(cancelled))

console.log(
  '\n本次申请到的权限/事件/回调：\n' +
    `  scopes    : ${FEISHU_REQUIRED_SCOPES.join(', ')}\n` +
    `  events    : ${FEISHU_REQUIRED_EVENTS.join(', ')}\n` +
    `  callbacks : ${FEISHU_REQUIRED_CALLBACKS.join(', ')}\n`
)
console.log(failed === 0 ? '全部通过。' : `${failed} 项失败。`)
process.exit(failed === 0 ? 0 : 1)
