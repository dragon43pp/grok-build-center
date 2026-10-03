/**
 * 国内 WorkBuddy 深链的离线判卷。不读库、不调用 shell.openExternal、不启动 WorkBuddy。
 *
 * 跑法：
 *   node_modules/.bin/esbuild tools/workbuddy_open_check.ts --bundle \
 *     --platform=node --format=esm --outfile=tools/_workbuddy_open_check.mjs \
 *     && node tools/_workbuddy_open_check.mjs
 */
import { pickLatestWorkbuddy, workbuddyChatUrl } from '../shared/workbuddy-open'

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

const id = '28f99488-2dd5-4634-af94-3ec2d40b8bef'

check('uuid → workbuddy://chat/<id>', workbuddyChatUrl(id) === `workbuddy://chat/${id}`)
check('两侧空白去掉', workbuddyChatUrl(`  ${id}  `) === `workbuddy://chat/${id}`)
check('大写 uuid 保留原样', workbuddyChatUrl(id.toUpperCase()) === `workbuddy://chat/${id.toUpperCase()}`)

for (const bad of ['', '   ', '../etc', `${id}/extra`, `${id}?x=1`, `workbuddy-ai://chat/${id}`, 'not-a-uuid', `${id}&calc`]) {
  check(`拒绝 ${JSON.stringify(bad)}`, workbuddyChatUrl(bad) === null)
}

check('国际 scheme 不会被拼出来', workbuddyChatUrl(id)?.startsWith('workbuddy://chat/') === true)

const older = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: '旧的', updatedAt: '2026-10-01T00:00:00.000Z' }
const newer = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', title: '新的', updatedAt: '2026-10-03T00:00:00.000Z' }
const byCreated = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  title: '只有创建时间',
  createdAt: '2026-10-04T00:00:00.000Z'
}
check('updatedAt 新的胜出', pickLatestWorkbuddy([older, newer])?.id === newer.id)
check('createdAt 也能当活动时间', pickLatestWorkbuddy([newer, byCreated])?.id === byCreated.id)
check('updatedAt 优先于自己的 createdAt', pickLatestWorkbuddy([
  { id: older.id, title: '甲', createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
  newer
])?.id === newer.id)
check('时间相同按标题', pickLatestWorkbuddy([
  { id: older.id, title: '乙', updatedAt: '2026-10-03T00:00:00.000Z' },
  { id: newer.id, title: '甲', updatedAt: '2026-10-03T00:00:00.000Z' }
])?.title === '甲')
check('空列表', pickLatestWorkbuddy([]) === null)

console.log(`\n通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
