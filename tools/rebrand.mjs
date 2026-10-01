#!/usr/bin/env node
/**
 * 品牌改版：把上游 HRack 改成 Grok Build Center。
 *
 * 为什么用脚本而不是手改：这套改动要跟着上游 rebase 反复重放，手改必然漏。
 *
 * 两条硬规矩：
 *  1. 每处替换都必须**真的匹配上**，匹配不到就抛错 —— 上游一改名，这里立刻炸，
 *     而不是静默留下一个 hrack 字样。
 *  2. 只动「身份」「品牌」「隔离」三层。
 *     2026-10-01 用户指令升级：HRack 痕迹清零。原先刻意保留的「互操作层」——
 *     hook 文件名 `hrack-observer.json`、HRACK_* 环境变量、`--hrack-cli` 开关、
 *     调试桥名 —— 全部改掉（见第 13 节清扫）。唯一例外：`HRACK_USER_DATA_DIR`
 *     作为**只读的旧名兼容**保留在 main.ts / gbcCli.ts 两个读取点
 *     （agent-hub 的飞书侧车还在用它指路）。
 *
 * 幂等：这个脚本要能在上游 rebase 之后原样再跑一遍，所以「from 不在、to 在」
 * 记成「已是目标值」而不是失败。
 *
 * 用法：
 *   node tools/rebrand.mjs            # 应用
 *   node tools/rebrand.mjs --check    # 只报告不写盘
 *
 * 图标是另一条产线：跑完本脚本还要 `python tools/make_brand_icons.py`
 * 才会生成 resources/tray/gbc-*（本脚本结尾会检查它跑没跑）。
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  renameSync,
  statSync
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = process.argv.includes('--check')

export const PRODUCT = {
  /** npm 包名 —— 决定 %APPDATA% 下的数据目录，是最关键的隔离点 */
  name: 'grok-build-center',
  productName: 'Grok Build Center',
  /** 中文里产品名（品牌规范 docs/brand.md：「Grok Build Center —— 会话中心」） */
  productNameZh: '会话中心',
  productNameZhTw: '工作階段中心',
  version: '1.0.0',
  appId: 'com.grokbuildcenter.app',
  /** 界面字标。用户要求不叫 center，改用「gbc」（紧凑、rail 48px 也能塞、子集 3 字形）。
   *  全名 Grok Build Center 留给窗口标题/托盘/包装；字标视觉统一用 gbc。 */
  wordmark: 'gbc',
  /** CSS font-family 名 */
  wordmarkFont: 'GBC Brand',
  /** Ammonite 子集产物文件名（vite 会输出成 gbc-brand-<hash>.woff2） */
  brandFontFile: 'gbc-brand.woff2',
  /** 图标文件名前缀，与 gbc-bridge / GBC_USER_DATA_DIR 同一套命名 */
  iconPrefix: 'gbc',
  /** 命名管道前缀。和已装的 HRack 必须不同，否则两边抢同一根管道 */
  pipePrefix: 'gbc-bridge',
  userDataDir: 'Grok Build Center',
  userDataDirDev: 'Grok Build Center Dev',
  /** bridge 协议里读的那个「HRACK_*」环境变量保留兼容，但优先读我们的 */
  envUserData: 'GBC_USER_DATA_DIR',
  envUserDataLegacy: 'HRACK_USER_DATA_DIR',
  /** CSS 自定义属性前缀，由 shared/theme-schema.ts 一处生成 */
  cssTokenPrefix: 'gbc',
  /**
   * 发布目标。**不能留空**：上游的 scripts/assert-packaged-update-config.cjs
   * 认定 app-update.yml 必须存在，而它只在配了 publish 时才生成。
   * 更要紧的是 —— 指向上游就等于「自动更新会把我们覆盖成 HRack」。
   */
  repo: { provider: 'github', owner: 'dragon43pp', name: 'grok-build-center' },
  /** 出问题时要还原成上游值的地方，集中放这里方便回看 */
  upstreamRepo: { owner: 'UniRound-Tec', name: 'hrack' }
}

const changes = []
const failures = []

function report(what, file) {
  changes.push(`${file}  ${what}`)
}

/** 断言式替换：没匹配到就记失败，绝不静默跳过。
 *
 *  幂等：已经改过的行（from 不在、to 在）算「已改」而不是失败 —— 这个脚本要能
 *  在 rebase 上游之后原样再跑一遍，不能要求树是「干净的上游」。
 *
 *  换行：这棵树是从 app.asar 里抽出来的，**源码是 CRLF**。多行锚点如果只写 \n
 *  会一条都匹配不上（而单行锚点全都正常），所以这里两种换行都试一遍，写回时
 *  保持文件原本的换行风格。
 *
 *  ⚠️ 幂等判断必须**先看 to 再看 from**：有些规则的 to 里原样保留了 from
 *  （比如「优先读 GBC_USER_DATA_DIR，其次 HRACK_USER_DATA_DIR」），
 *  先看 from 的话每跑一次就会多插一行 —— 曾经真的把 hrackCli.ts 插成 6 行。
 */
const toCrlf = (s) => s.replace(/\n/g, '\r\n')

function swap(file, from, to, label) {
  const abs = join(ROOT, file)
  const src = readFileSync(abs, 'utf8')
  const variants = [{ from, to }]
  if (!from.includes('\r\n')) variants.push({ from: toCrlf(from), to: toCrlf(to) })

  for (const v of variants) {
    if (src.includes(v.to)) {
      report(`${label} (已是目标值)`, file)
      return
    }
  }
  for (const v of variants) {
    if (src.includes(v.from)) {
      if (!CHECK) writeFileSync(abs, src.split(v.from).join(v.to), 'utf8')
      report(label, file)
      return
    }
  }
  failures.push(`${file}: 找不到 ${label}  ->  ${JSON.stringify(from.slice(0, 70))}`)
}

/** 删除上游资产。已经删过也算成功（幂等）。 */
function remove(file, label) {
  const abs = join(ROOT, file)
  if (!existsSync(abs)) {
    report(`${label} (已删除)`, file)
    return
  }
  if (!CHECK) rmSync(abs, { force: true, recursive: true })
  report(label, file)
}

/** 目录改名。目标已存在算「已改名」，不重复搬。 */
function moveDir(from, to, label) {
  const a = join(ROOT, from)
  const b = join(ROOT, to)
  if (!existsSync(a)) {
    if (existsSync(b)) {
      report(`${label} (已改名)`, from)
      return
    }
    failures.push(`${from}: 找不到 ${label}`)
    return
  }
  if (!CHECK) {
    mkdirSync(dirname(b), { recursive: true })
    rmSync(b, { force: true, recursive: true })
    renameSync(a, b)
  }
  report(label, from)
}

/** 内容文件（文档/注释）里「有就换、没有就跳过」的替换。
 *
 *  skill 正文这类文件里 hrack 的出现是**不均匀**的：有的通篇大写产品名，
 *  有的只有小写的 CLI 命令名。硬套 swap() 会把「本来就不该有」当成失败，
 *  所以这里给一个不报错的版本 —— 但仍然不会静默地把该改的漏掉：
 *  该文件里出现过的形态都会被换掉。
 */
function swapOptional(file, from, to, label) {
  const abs = join(ROOT, file)
  const src = readFileSync(abs, 'utf8')
  if (src.includes(to) && !src.includes(from)) {
    report(`${label} (已是目标值)`, file)
    return
  }
  if (!src.includes(from)) {
    report(`${label} (不适用，跳过)`, file)
    return
  }
  if (!CHECK) writeFileSync(abs, src.split(from).join(to), 'utf8')
  report(label, file)
}

// ───────────────────────── 1. package.json：产品身份 ─────────────────────────
const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

pkg.name = PRODUCT.name
pkg.version = PRODUCT.version
pkg.description =
  'Session center for every AI coding CLI on your machine — browse, resume, total up and export'
pkg.license = 'Apache-2.0'
pkg.author = ''
pkg.build.appId = PRODUCT.appId
pkg.build.productName = PRODUCT.productName
pkg.build.artifactName = 'GrokBuildCenter-Setup-${version}.${ext}'
pkg.build.win.icon = `resources/tray/${PRODUCT.iconPrefix}-app.ico`
// 指向我们自己的仓库，并且 release 脚本里带 --publish never：
// 构建产物永远不会出现在别人（或我们自己）的 Release 里
pkg.build.publish = [{ ...PRODUCT.repo }]
pkg.build.nsis.shortcutName = PRODUCT.productName
if (pkg.build.dmg) pkg.build.dmg.title = `${PRODUCT.productName} \${version}`
if (pkg.build.mac) {
  pkg.build.mac.artifactName = `GrokBuildCenter-\${version}-macos-\${arch}.\${ext}`
}
if (pkg.build.linux) {
  pkg.build.linux.executableName = PRODUCT.name
  pkg.build.linux.vendor = PRODUCT.productName
  pkg.build.linux.maintainer = PRODUCT.productName
  pkg.build.linux.artifactName = `GrokBuildCenter-\${version}-linux-\${arch}.\${ext}`
}
// 图标由我们自己的零依赖生成器产出（见 tools/make_brand_icons.py）
pkg.scripts['generate:icons'] = 'python tools/make_brand_icons.py'
// 这个脚本名跟着 **CLI 命令名**走：内置 skill 文档里写的就是
// `npm run gbc -- --gbc-cli <subcommand>`。2026-10-01 起命令名也去 hrack 化，
// 不再保留 `hrack` 别名（见第 13 节清扫）。
pkg.scripts.gbc = 'electron ./out/main/index.js'
// 上游源码拷贝（210MB 的 resources/app/）与纯文档不该进安装包 —— files 是 **/* 全收
if (!pkg.build.files.includes('!resources/app{,/**/*}')) {
  pkg.build.files.push('!resources/app{,/**/*}')
}
for (const excl of ['!docs{,/**/*}', '!README.md{,/**/*}', '!README.zh-CN.md{,/**/*}', '!CHANGELOG.md{,/**/*}']) {
  if (!pkg.build.files.includes(excl)) pkg.build.files.push(excl)
}
if (!CHECK) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
report(`身份: ${PRODUCT.name} / ${PRODUCT.productName} / ${PRODUCT.appId}`, 'package.json')

// 13b 前置：文件改名必须先于按文件路径写的锚点规则（第 5 节按新路径找）。
// moveFile 定义在第 13 节，函数声明提升，这里可以提前调用。
moveFile('electron/cli/hrackCli.ts', 'electron/cli/gbcCli.ts', 'CLI 入口文件名 -> gbcCli.ts')
moveFile('electron/cli/parseHrackCli.ts', 'electron/cli/parseGbcCli.ts', 'CLI 参数解析文件名 -> parseGbcCli.ts')
moveFile('scripts/hrack-bridge-client.mjs', 'scripts/gbc-bridge-client.mjs', '桥接客户端脚本名 -> gbc-bridge-client.mjs')

// ───────────────────────── 2. 数据隔离：userData 目录 ─────────────────────────
// 这是「不用动用户正在用的会话」的技术保证：新目录名 = 新 userData。
swap(
  'electron/app-paths.ts',
  'export function resolveHrackUserDataDir(',
  'export function resolveAppUserDataDir(',
  'app-paths: 函数改名'
)
swap(
  'electron/app-paths.ts',
  `return join(appDataDir, isPackaged ? 'HRack' : 'HRack Dev')`,
  `return join(appDataDir, isPackaged ? '${PRODUCT.userDataDir}' : '${PRODUCT.userDataDirDev}')`,
  `app-paths: userData -> ${PRODUCT.userDataDir}`
)

// ───────────────────────── 3. 命名管道：别和已装 HRack 抢 ─────────────────────────
swap(
  'electron/bridge/paths.ts',
  '`\\\\\\\\.\\\\pipe\\\\hrack-bridge-${sanitizePipeUser(userInfo().username)}`',
  '`\\\\\\\\.\\\\pipe\\\\' + PRODUCT.pipePrefix + '-${sanitizePipeUser(userInfo().username)}`',
  `bridge: 管道前缀 -> ${PRODUCT.pipePrefix}`
)
swap(
  'electron/bridge/paths.ts',
  `join(runtime, 'hrack', 'bridge.sock')`,
  `join(runtime, '${PRODUCT.name}', 'bridge.sock')`,
  'bridge: Unix socket 目录'
)

// ───────────────────────── 4. 主进程引用与日志标识 ─────────────────────────
swap('electron/main.ts', 'resolveHrackUserDataDir', 'resolveAppUserDataDir', 'main: 跟随函数改名')
swap(
  'electron/main.ts',
  `const userDataOverride = process.env['HRACK_USER_DATA_DIR']`,
  `const userDataOverride =\n  process.env['${PRODUCT.envUserData}'] || process.env['${PRODUCT.envUserDataLegacy}']`,
  `main: 支持 ${PRODUCT.envUserData}`
)
swap('electron/main.ts', "'[hrack] ", "'[gbc] ", 'main: 日志前缀')
// 桥接不可用时抛给调用方的错误文案（会出现在 CLI / 其他 harness 的输出里）
swap('electron/main.ts', `'HRack window is not available'`, `'${PRODUCT.productName} window is not available'`, 'main: 桥接错误文案')
swap('electron/main.ts', `'Open the HRack window first`, `'Open the ${PRODUCT.productName} window first`, 'main: 桥接提示文案')
swap('electron/main.ts', 'hrack-bridge-<user>', `${PRODUCT.pipePrefix}-<user>`, 'main: 修正管道名注释')

// 自动更新：上游的更新源是 UniRound-Tec/hrack，开着就等于「自己把自己换成 HRack」。
// 我们还没有可用的发布渠道，先关掉；要开的时候把这里改成读我们自己的 app-update.yml。
swap(
  'electron/main.ts',
  `enabled: app.isPackaged && process.env['HRACK_DISABLE_UPDATES'] !== '1'`,
  `enabled: false`,
  'main: 关闭自动更新（上游更新源会覆盖我们）'
)

// ───────────────────────── 5. CLI 入口 ─────────────────────────
// userData 查找顺序：我们的环境变量优先，然后兼容上游那个名字。
// 回退目录也必须是**我们自己的** —— 指到 HRack 去读 token 就跨过了隔离边界。
swap(
  'electron/cli/gbcCli.ts',
  `if (process.env.${PRODUCT.envUserDataLegacy}) return [process.env.${PRODUCT.envUserDataLegacy}]`,
  `if (process.env.${PRODUCT.envUserData}) return [process.env.${PRODUCT.envUserData}]\n  if (process.env.${PRODUCT.envUserDataLegacy}) return [process.env.${PRODUCT.envUserDataLegacy}]`,
  'cli: 环境变量'
)
swap(
  'electron/cli/gbcCli.ts',
  `return [join(appData, 'HRack Dev'), join(appData, 'HRack')]`,
  `return [join(appData, '${PRODUCT.userDataDirDev}'), join(appData, '${PRODUCT.userDataDir}')]`,
  'cli: 回退 userData 目录'
)
swap(
  'electron/cli/gbcCli.ts',
  `'HRack is not running. Open HRack first, then retry this command.'`,
  `'${PRODUCT.productName} is not running. Open ${PRODUCT.productName} first, then retry this command.'`,
  'cli: 未运行提示'
)
// usage 文本里的 `hrack <subcommand>` 是**命令名**，不动
swap(
  'electron/cli/gbcCli.ts',
  `'Invalid response from HRack'`,
  `'Invalid response from ${PRODUCT.productName}'`,
  'cli: 无效响应文案'
)
swap(
  'electron/cli/gbcCli.ts',
  `'HRack closed the bridge connection`,
  `'${PRODUCT.productName} closed the bridge connection`,
  'cli: 连接关闭文案'
)

// ───────────────────────── 6. 可见品牌文案 ─────────────────────────
// 窗口标题（Electron 拿 index.html 的 <title> 当 BrowserWindow 标题）
swap(
  'index.html',
  '<title>HRack Terminal</title>',
  `<title>${PRODUCT.productName}</title>`,
  '窗口标题'
)

// 三处字标：首启页 / 首页空态 / 侧栏。用的都是 font-brand（Ammonite 子集）
for (const file of [
  'src/app/FirstRunOnboarding.tsx',
  'src/app/HomePage.tsx',
  'src/app/Sidebar.tsx'
]) {
  // 字标可能处于三种态：hrack（上游原态）/ center（首代改版）/ gbc（当前目标）。
  // swapOptional 不报错，三态都能收敛到目标。
  swapOptional(file, 'text="hrack"', `text="${PRODUCT.wordmark}"`, `字标(hrack→${PRODUCT.wordmark})`)
  swapOptional(file, 'text="center"', `text="${PRODUCT.wordmark}"`, `字标(center→${PRODUCT.wordmark})`)
}

// 托盘悬停提示
swap(
  'electron/tray.ts',
  `tray.setToolTip('HRack')`,
  `tray.setToolTip('${PRODUCT.productName}')`,
  '托盘悬停提示'
)

// 内置主题名（主题选择器里看得见；其余内置主题是 Catppuccin / Dracula 等第三方名，不动）
swapOptional('src/themes/dark.json', '"name": "HRack Dark"', '"name": "GBC Dark"', '主题名(hrack)')
swapOptional('src/themes/dark.json', '"name": "Center Dark"', '"name": "GBC Dark"', '主题名(center)')
swapOptional('src/themes/light.json', '"name": "HRack Light"', '"name": "GBC Light"', '主题名(hrack)')
swapOptional('src/themes/light.json', '"name": "Center Light"', '"name": "GBC Light"', '主题名(center)')
swapOptional(
  'src/app/themeRuntime.ts',
  `name: 'HRack Light (safe mode)'`,
  `name: 'GBC Light (safe mode)'`,
  '安全模式主题名(hrack)'
)
swapOptional(
  'src/app/themeRuntime.ts',
  `name: 'Center Light (safe mode)'`,
  `name: 'GBC Light (safe mode)'`,
  '安全模式主题名(center)'
)

// 用户新建自定义主题时看到的那份模板
swapOptional('src/app/SettingsPage.tsx', `name: 'HRack Custom'`, `name: 'GBC Custom'`, '自定义主题模板名(hrack)')
swapOptional('src/app/SettingsPage.tsx', `name: 'Center Custom'`, `name: 'GBC Custom'`, '自定义主题模板名(center)')

// 设置页里的外链：上游指向 hrack.dev（他们自己的站点），我们没有那个服务。
// 先落到我们自己的仓库；远程配对本身依赖上游服务，是否保留整个区块待定。
const REPO_URL = `https://github.com/${PRODUCT.repo.owner}/${PRODUCT.repo.name}`
swap('src/app/RemoteSettingsSection.tsx', 'https://hrack.dev/', REPO_URL, '设置页外链 -> 我们的仓库')
swap('src/app/RemoteSettingsSection.tsx', `hrack.dev`, `GitHub`, '设置页外链文案')

// ── 随包内置的 skill 文档：设置页会把全文渲染给用户看，所以也算「可见层」──
// 目录先改名，后面的内容替换按新路径走（顺序反了第二次跑就会找不到文件）
const SKILL_RENAMES = [
  ['resources/skills/create-hrack-floating-renderer', 'resources/skills/create-gbc-floating-renderer'],
  ['resources/skills/create-hrack-theme', 'resources/skills/create-gbc-theme'],
  ['resources/skills/hrack-opencode-bridge', 'resources/skills/gbc-opencode-bridge']
]
for (const [from, to] of SKILL_RENAMES) {
  moveDir(from, to, `skill 目录 -> ${to.split('/').pop()}`)
}

const SKILL_FILES = [
  'resources/skills/create-gbc-floating-renderer/SKILL.md',
  'resources/skills/create-gbc-floating-renderer/agents/openai.yaml',
  'resources/skills/create-gbc-theme/SKILL.md',
  'resources/skills/create-gbc-theme/validate-theme.cjs',
  'resources/skills/gbc-opencode-bridge/SKILL.md'
]
for (const file of SKILL_FILES) {
  // 只换大写 HRack（产品名）。小写 hrack 是**CLI 命令名**，是对外契约，保持不动 ——
  // 设置页里给用户复制的那串命令必须还是 hrack。
  swapOptional(file, 'HRack', PRODUCT.productName, 'skill 正文产品名')
  swapOptional(file, 'create-hrack-floating-renderer', 'create-gbc-floating-renderer', 'skill 自引用路径')
  swapOptional(file, 'create-hrack-theme', 'create-gbc-theme', 'skill 自引用路径')
  swapOptional(file, 'hrack-opencode-bridge', 'gbc-opencode-bridge', 'skill 自引用标识')
}
// 设置页 import 的那三条路径跟着改
for (const [from, to] of SKILL_RENAMES) {
  swapOptional('src/app/SettingsPage.tsx', from, to, 'skill import 路径')
}

// i18n：中文里产品名不留半角空格（「进入 会话中心」不对），所以中文逐句给，拉丁语系整体换名
swap('src/app/i18n/zh-CN.ts', '确定要让 HRack 不再关注', `确定要让${PRODUCT.productNameZh}不再关注`, 'zh-CN: 取消关注确认')
swap('src/app/i18n/zh-CN.ts', '只影响 HRack 内的 DSH 页面', `只影响${PRODUCT.productNameZh}内的 DSH 页面`, 'zh-CN: DSH 缩放说明')
swap('src/app/i18n/zh-CN.ts', '进入 HRack', `进入${PRODUCT.productNameZh}`, 'zh-CN: 首启按钮')
swap('src/app/i18n/zh-TW.ts', '確定要讓 HRack 不再關注', `確定要讓${PRODUCT.productNameZhTw}不再關注`, 'zh-TW: 取消關注確認')
swap('src/app/i18n/zh-TW.ts', '只影響 HRack 內的 DSH 頁面', `只影響${PRODUCT.productNameZhTw}內的 DSH 頁面`, 'zh-TW: DSH 縮放說明')
swap('src/app/i18n/zh-TW.ts', '進入 HRack', `進入${PRODUCT.productNameZhTw}`, 'zh-TW: 首啟按鈕')
// en / ja / ko：「in HRack?」「HRack で」「HRack 시작」这类接续直接换成拉丁名都成立
for (const locale of ['en', 'ja', 'ko']) {
  swap(`src/app/i18n/${locale}.ts`, 'HRack', PRODUCT.productName, `${locale}: 产品名`)
}

// ───────────────────────── 7. 品牌字体（字标专用的字形子集）─────────────────────────
// 字标三态收敛：hrack（上游）→ center（首代）→ gbc（当前）。swapOptional 不报错。
swapOptional('src/index.css', 'HRack Brand', PRODUCT.wordmarkFont, '字体族名(hrack)')
swapOptional('src/index.css', 'Center Brand', PRODUCT.wordmarkFont, '字体族名(center)')
swapOptional('src/index.css', 'HRack-brand.woff2', PRODUCT.brandFontFile, '字体文件名(hrack)')
swapOptional('src/index.css', 'center-brand.woff2', PRODUCT.brandFontFile, '字体文件名(center)')
swapOptional('scripts/subset-fonts.mjs', 'HRack-brand.woff2', PRODUCT.brandFontFile, '子集输出名(hrack)')
swapOptional('scripts/subset-fonts.mjs', 'center-brand.woff2', PRODUCT.brandFontFile, '子集输出名(center)')
swapOptional('scripts/subset-fonts.mjs', `'hrack'`, `'${PRODUCT.wordmark}'`, '子集字形集(hrack)')
swapOptional('scripts/subset-fonts.mjs', `'center'`, `'${PRODUCT.wordmark}'`, '子集字形集(center)')
swapOptional(
  'scripts/assert-font-size.mjs',
  '/^HRack-brand-.*\\.woff2$/i',
  `/^${PRODUCT.brandFontFile.replace('.woff2', '')}-.*\\.woff2$/i`,
  '字体门禁正则(hrack)'
)
swapOptional(
  'scripts/assert-font-size.mjs',
  '/^center-brand-.*\\.woff2$/i',
  `/^${PRODUCT.brandFontFile.replace('.woff2', '')}-.*\\.woff2$/i`,
  '字体门禁正则(center)'
)
swapOptional('src/assets/fonts/ammonite/NOTICE.md', '`hrack`', `\`${PRODUCT.wordmark}\``, '字体 NOTICE：字标(hrack)')
swapOptional('src/assets/fonts/ammonite/NOTICE.md', '`center`', `\`${PRODUCT.wordmark}\``, '字体 NOTICE：字标(center)')
swapOptional('src/assets/fonts/ammonite/NOTICE.md', 'HRack-brand.woff2', PRODUCT.brandFontFile, '字体 NOTICE：文件名(hrack)')
swapOptional('src/assets/fonts/ammonite/NOTICE.md', 'center-brand.woff2', PRODUCT.brandFontFile, '字体 NOTICE：文件名(center)')
swapOptional('src/themes/NOTICE.md', 'HRack', PRODUCT.productName, '主题 NOTICE：产品名')

// ───────────────────────── 8. 设计令牌前缀 ─────────────────────────
// --hrack-* 是主题系统生成的 CSS 自定义属性，全部由 theme-schema.ts 一处生成。
//
// ⚠️ 绝不能连 electron/ 一起扫：那里的 --hrack-cli / --hrack-known-paths-- /
//    --hrack-dsh-locale= 是**命令行开关**不是 CSS 变量，其中 --hrack-cli 还是
//    对外 CLI 入口的约定，改了就是破坏兼容。
const TOKEN_FILES = [
  'src/index.css',
  'src/app/AppShell.tsx',
  'src/app/DshPage.tsx',
  'src/app/FirstRunOnboarding.tsx',
  'src/app/HomePage.tsx',
  'src/app/SettingsPage.tsx',
  'src/app/Sidebar.tsx',
  'src/app/SidebarTint.tsx',
  'src/workspace-reader/ReadOnlyCodeView.tsx'
]
swap('shared/theme-schema.ts', '--hrack-', `--${PRODUCT.cssTokenPrefix}-`, 'theme-schema: 令牌前缀')
for (const file of TOKEN_FILES) {
  swap(file, '--hrack-', `--${PRODUCT.cssTokenPrefix}-`, '设计令牌前缀')
}
// 根节点 id
swap('index.html', 'id="hrack-root"', `id="${PRODUCT.cssTokenPrefix}-root"`, '根节点 id')
swap('src/index.css', '#hrack-root', `#${PRODUCT.cssTokenPrefix}-root`, '根节点 id')
swap(
  'src/main.tsx',
  `getElementById('hrack-root')`,
  `getElementById('${PRODUCT.cssTokenPrefix}-root')`,
  '根节点 id'
)

// ───────────────────────── 9. 图标命名（运行时真的会去读这些文件名）─────────────────────────
// 上游 resources/tray/ 里是 hrack-*，我们换成 gbc-*。
swap(
  'electron/icon-theme.ts',
  `): 'hrack' | 'hrack-white' | 'hrackTemplate' {`,
  `): '${PRODUCT.iconPrefix}' | '${PRODUCT.iconPrefix}-white' | '${PRODUCT.iconPrefix}Template' {`,
  'icon-theme: 变体联合类型'
)
swap(
  'electron/icon-theme.ts',
  `if (platform === 'darwin') return 'hrackTemplate'`,
  `if (platform === 'darwin') return '${PRODUCT.iconPrefix}Template'`,
  'icon-theme: macOS 模板图'
)
swap(
  'electron/icon-theme.ts',
  `return shouldUseDarkColors ? 'hrack-white' : 'hrack'`,
  `return shouldUseDarkColors ? '${PRODUCT.iconPrefix}-white' : '${PRODUCT.iconPrefix}'`,
  'icon-theme: 明暗变体选择'
)
swap(
  'electron/icon-theme.ts',
  `'hrack-app.ico'`,
  `'${PRODUCT.iconPrefix}-app.ico'`,
  'icon-theme: Windows 图标文件名'
)
swap(
  'electron/icon-theme.ts',
  'hrackWindowsIconFile',
  'centerWindowsIconFile',
  'icon-theme: Windows 图标函数名'
)
swap('electron/icon-theme.ts', 'hrackIconBasename', 'centerIconBasename', 'icon-theme: 函数名')

swap('electron/app-icons.ts', `'hrack-app-16.png'`, `'${PRODUCT.iconPrefix}-app-16.png'`, 'app-icons: 16px 应用图标')
swap('electron/app-icons.ts', `'hrack-app-32.png'`, `'${PRODUCT.iconPrefix}-app-32.png'`, 'app-icons: 32px 应用图标')
// ⚠️ `to` 必须自带引号：这里换的是字符串字面量，漏掉引号会产出
// `: com.grokbuildcenter.app` —— esbuild 不查类型，能过构建，运行时才炸。
swap('electron/app-icons.ts', `'com.hrack.app'`, `'${PRODUCT.appId}'`, 'app-icons: appId 回退值')
swap('electron/app-icons.ts', 'hrackIconBasename', 'centerIconBasename', 'app-icons: 跟随函数改名')
swap('electron/app-icons.ts', 'hrackWindowsIconFile', 'centerWindowsIconFile', 'app-icons: 跟随函数改名')
swap('electron/app-icons.ts', 'createThemedHrackIcon', 'createThemedCenterIcon', 'app-icons: 函数名')
swap('electron/app-icons.ts', 'createHrackAppIcon', 'createCenterAppIcon', 'app-icons: 函数名')
swap('electron/app-icons.ts', 'createHrackTrayIcon', 'createCenterTrayIcon', 'app-icons: 函数名')
swap('electron/app-icons.ts', 'applyHrackWindowIcon', 'applyCenterWindowIcon', 'app-icons: 函数名')
// 三个调用点各自只用到其中一部分函数名，所以逐个点名，不要写成对两个文件跑同一组替换
swap('electron/tray.ts', 'createHrackTrayIcon', 'createCenterTrayIcon', 'tray.ts: 跟随函数改名')
swap('electron/window.ts', 'applyHrackWindowIcon', 'applyCenterWindowIcon', 'window.ts: 跟随函数改名')
swap('electron/window.ts', 'createHrackAppIcon', 'createCenterAppIcon', 'window.ts: 跟随函数改名')

// 构建门禁：required 列表换成我们的文件名，并把应用图标也纳进来 ——
// 上游不检查 gbc-app-*，所以漏打包是**静默**的（之前就是这样漏了 HRack 的图标）。
const trayGate = 'scripts/assert-packaged-tray-assets.cjs'
const P = PRODUCT.iconPrefix
swap(
  trayGate,
  `const REQUIRED_TRAY_ASSETS = [
  'hrack-16.png',
  'hrack-32.png',
  'hrack-256.png',
  'hrack-white-16.png',
  'hrack-white-32.png',
  'hrack-white-256.png',
  'hrackTemplate-16.png',
  'hrackTemplate-32.png',
  'hrack.ico',
  'hrack-white.ico'
]`,
  `const REQUIRED_TRAY_ASSETS = [
  '${P}-16.png',
  '${P}-32.png',
  '${P}-256.png',
  '${P}-white-16.png',
  '${P}-white-32.png',
  '${P}-white-256.png',
  '${P}Template-16.png',
  '${P}Template-32.png',
  '${P}.ico',
  '${P}-white.ico',
  '${P}-app-16.png',
  '${P}-app-32.png',
  '${P}-app.ico'
]`,
  '门禁: 托盘资产清单'
)

// ───────────────────────── 10. 发布配置里的上游痕迹 ─────────────────────────
swap(
  'scripts/assert-packaged-update-config.cjs',
  `config.owner !== '${PRODUCT.upstreamRepo.owner}' ||\n  config.repo !== '${PRODUCT.upstreamRepo.name}'`,
  `config.owner !== '${PRODUCT.repo.owner}' ||\n  config.repo !== '${PRODUCT.repo.name}'`,
  '更新源校验: 改成我们自己的仓库'
)
swap('scripts/release-win.ps1', 'hrack-release-$version-', 'gbc-release-$version-', 'release: 临时目录名')
swap('scripts/release-win.ps1', 'HRack-Setup-$version.exe', 'GrokBuildCenter-Setup-$version.exe', 'release: 安装包名')
swap('scripts/release-win.ps1', `'win-unpacked\\HRack.exe'`, `'win-unpacked\\Grok Build Center.exe'`, 'release: 解包后 exe 名')

// ───────────────────────── 11. 清理上游资产 ─────────────────────────
// 上游 HRack 的完整源码拷贝（当初从 app.asar 抽出来当分叉底稿的），210MB、
// 零引用、还会被 files:**/* 打进安装包 —— 用户明确要求清掉（2026-10-01）。
remove('resources/app', '删除上游 HRack 源码拷贝（210MB 死重，零引用）')
// mac/linux 用的打包图标还是上游那个 H 标
const buildIcon = join(ROOT, 'build/icon.png')
const brandIcon = join(ROOT, 'brand/icon/center-256.png')
if (existsSync(brandIcon)) {
  if (!CHECK) copyFileSync(brandIcon, buildIcon)
  report('build/icon.png -> brand/icon/center-256.png', 'build/')
} else {
  failures.push('缺少 brand/icon/center-256.png —— 先跑 tools/make_icon.py')
}

// 上游 CI 会往 UniRound-Tec/hrack 发 Release，fork 里留着是纯粹的隐患
remove('.github/workflows/release.yml', '删除上游发布工作流')
// 上游那两个 submodule 指向 hrack-remote-app/server，我们的副本没有 remotes/
remove('.gitmodules', '删除上游 submodule 声明')
// 这三个脚本是为上游的 hrack 母版图 + hrack-app.svg 写的，我们已换成
// tools/make_brand_icons.py；留着只会误导人重新生成出旧品牌图标
remove('scripts/gen-tray-icons.mjs', '删除上游托盘图标生成器')
remove('scripts/generate-brand-icons.mjs', '删除上游品牌图标生成器')
remove('scripts/write-tray-icos.mjs', '删除上游 ico 打包器')

// ───────────────────────── 12. 图标产物检查 ─────────────────────────
const TRAY_REQUIRED = [
  'gbc-16.png',
  'gbc-32.png',
  'gbc-256.png',
  'gbc-white-16.png',
  'gbc-white-32.png',
  'gbc-white-256.png',
  'gbcTemplate-16.png',
  'gbcTemplate-32.png',
  'gbc.ico',
  'gbc-white.ico',
  'gbc-app-16.png',
  'gbc-app-32.png',
  'gbc-app.ico'
]
const trayDir = join(ROOT, 'resources/tray')
const missingIcons = TRAY_REQUIRED.filter((f) => !existsSync(join(trayDir, f)))
if (missingIcons.length) {
  failures.push(
    `resources/tray/ 缺 ${missingIcons.length} 个图标（${missingIcons.join(', ')}）` +
      `\n      跑：python tools/make_brand_icons.py`
  )
} else {
  report(`${TRAY_REQUIRED.length} 个 gbc-* 图标就位`, 'resources/tray/')
}
// 托盘目录只允许存在上面那份清单里的文件：extraResources 会把整个目录的 *.png/*.ico
// 打进安装包，多一个文件就多一份别人的（或过期的）logo 进产品。
if (existsSync(trayDir)) {
  for (const name of readdirSync(trayDir).filter((n) => !TRAY_REQUIRED.includes(n))) {
    remove(`resources/tray/${name}`, '删除多余托盘资产')
  }
}

// ───────────────────────── 13. 运行时标识清扫（HRack 痕迹清零，2026-10-01）─────────────────────────
//
// 前 12 节是「锚点替换」：锚不到就报错，保证上游改名会被发现。这一节相反，
// 是「token 清扫」：对全部源码/文档做大小写分级的 replace，自愈式 ——
// 上游 rebase 带回一个 HRACK_XXX，下一次跑本脚本就把它洗掉。
//
// 保护顺序：先把 HRACK_USER_DATA_DIR（唯一合法残留）换成占位符，再扫，
// 最后还原。HRack 本体（D:/hrack桌面版）还在用这个名字写它自己的配置，
// 我们读它只为兼容 agent-hub 的指路环境变量，不是留着当品牌。
//
// 三档映射（顺序执行，每档都建立在前一档的结果上）：
//   HRACK（全大写，环境变量/调试桥全局名）  -> GBC
//   HRack（驼峰，标识符/错误文案）          -> GBC（代码）/ Grok Build Center（文档）
//   hrack（小写，文件名/开关/命令名/路径）  -> gbc
const LEGACY_SENTINEL = '\u0000GBC_LEGACY_UDID\u0000'
const SWEEP_PAIRS_CODE = [
  ['HRACK', 'GBC'],
  ['HRack', 'GBC'],
  ['Hrack', 'Gbc'],
  ['hrack', 'gbc']
]
const SWEEP_PAIRS_DOCS = [
  ['HRACK', 'GBC'],
  ['HRack', `${PRODUCT.productName}`],
  ['Hrack', `${PRODUCT.productName}`],
  ['hrack', 'gbc']
]
const SWEEP_CODE_ROOTS = [
  'src',
  'electron',
  'shared',
  'preload',
  'scripts',
  'e2e',
  'examples',
  'prototype',
  'resources/floating-renderers'
]
const SWEEP_DOCS_ROOTS = ['resources/skills', 'docs', 'README.md', 'README.zh-CN.md']
const SWEEP_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.md', '.json', '.html', '.css', '.ps1'])

function sweepFile(abs, pairs) {
  let src
  try {
    src = readFileSync(abs, 'utf8')
  } catch {
    return 0
  }
  let out = src.split('HRACK_USER_DATA_DIR').join(LEGACY_SENTINEL)
  let count = 0
  for (const [from, to] of pairs) {
    const n = out.split(from).length - 1
    if (n > 0) {
      count += n
      out = out.split(from).join(to)
    }
  }
  out = out.split(LEGACY_SENTINEL).join('HRACK_USER_DATA_DIR')
  if (count > 0 && !CHECK) writeFileSync(abs, out, 'utf8')
  return count
}

function sweepTree(root, pairs) {
  const absRoot = join(ROOT, root)
  if (!existsSync(absRoot)) return { files: 0, hits: 0 }
  let files = 0
  let hits = 0
  const walkFile = (p) => {
    const n = sweepFile(p, pairs)
    if (n > 0) {
      files += 1
      hits += n
    }
  }
  if (statSync(absRoot).isFile()) {
    walkFile(absRoot)
    return { files, hits }
  }
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        walk(p)
      } else if (SWEEP_EXTS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
        const n = sweepFile(p, pairs)
        if (n > 0) {
          files += 1
          hits += n
        }
      }
    }
  }
  walk(absRoot)
  return { files, hits }
}

let sweepFiles = 0
let sweepHits = 0
for (const root of SWEEP_CODE_ROOTS) {
  const r = sweepTree(root, SWEEP_PAIRS_CODE)
  sweepFiles += r.files
  sweepHits += r.hits
}
for (const root of SWEEP_DOCS_ROOTS) {
  const r = sweepTree(root, SWEEP_PAIRS_DOCS)
  sweepFiles += r.files
  sweepHits += r.hits
}
report(
  `运行时标识清扫：${sweepHits} 处 / ${sweepFiles} 个文件（HRACK->GBC 三档）`,
  'src+electron+shared+preload+scripts+e2e+docs+skills'
)

// 13b. 文件改名（内容引用已由上面的 hrack->gbc 档改好，改名放最后）
function moveFile(from, to, label) {
  const a = join(ROOT, from)
  const b = join(ROOT, to)
  if (!existsSync(a)) {
    if (existsSync(b)) {
      report(`${label} (已改名)`, from)
      return
    }
    failures.push(`${from}: 找不到 ${label}`)
    return
  }
  if (!CHECK) {
    mkdirSync(dirname(b), { recursive: true })
    rmSync(b, { force: true })
    renameSync(a, b)
  }
  report(label, from)
}
// 13c. 环境变量「设置方」也换成 GBC_（读取方的旧名兼容在 13d 修回）
swap(
  'scripts/verify-packaged-tray.cjs',
  'HRACK_USER_DATA_DIR: mkdtempSync',
  'GBC_USER_DATA_DIR: mkdtempSync',
  '托盘校验: 环境变量设置方'
)
swap(
  'scripts/recording/01-create-cli-sessions.cjs',
  'HRACK_USER_DATA_DIR: userDataDir',
  'GBC_USER_DATA_DIR: userDataDir',
  '录制脚本: 环境变量设置方'
)

// 13d. 读取方的旧名兼容：清扫会把规则 2/5 写进去的 `GBC || HRACK` 双读
// 变成 GBC || GBC（重复读），这里修回成真正的旧名兼容。
swap(
  'electron/main.ts',
  `process.env['${PRODUCT.envUserData}'] || process.env['${PRODUCT.envUserData}']`,
  `process.env['${PRODUCT.envUserData}'] || process.env['${PRODUCT.envUserDataLegacy}']`,
  'main: 恢复旧名环境变量兼容'
)
swap(
  'electron/cli/gbcCli.ts',
  `if (process.env.${PRODUCT.envUserData}) return [process.env.${PRODUCT.envUserData}]\n  if (process.env.${PRODUCT.envUserData}) return [process.env.${PRODUCT.envUserData}]`,
  `if (process.env.${PRODUCT.envUserData}) return [process.env.${PRODUCT.envUserData}]\n  if (process.env.${PRODUCT.envUserDataLegacy}) return [process.env.${PRODUCT.envUserDataLegacy}]`,
  'cli: 恢复旧名环境变量兼容'
)
// 独立桥接客户端同样双读：新名优先，旧名兼容
swap(
  'scripts/gbc-bridge-client.mjs',
  'const userData = process.env.HRACK_USER_DATA_DIR',
  `const userData = process.env.${PRODUCT.envUserData} || process.env.HRACK_USER_DATA_DIR`,
  '桥接客户端: 旧名兼容双读'
)
// e2e 是「设置方」，直接换新名（被测应用先读 GBC_*）
swap(
  'e2e/helpers.ts',
  'HRACK_USER_DATA_DIR: userDataDir,',
  'GBC_USER_DATA_DIR: userDataDir,',
  'e2e helpers: 环境变量设置方'
)
swap(
  'e2e/helpers.ts',
  '临时目录（HRACK_USER_DATA_DIR）',
  '临时目录（GBC_USER_DATA_DIR）',
  'e2e helpers: 注释'
)
swap(
  'e2e/dsh-surface.spec.ts',
  'HRACK_USER_DATA_DIR: userDataDir',
  'GBC_USER_DATA_DIR: userDataDir',
  'e2e dsh-surface: 环境变量设置方'
)
swap(
  'e2e/window-shell.spec.ts',
  'HRACK_USER_DATA_DIR: userDataDir',
  'GBC_USER_DATA_DIR: userDataDir',
  'e2e window-shell: 环境变量设置方'
)

// 13e. 审计：清零检查。白名单之外再出现任何大小写的 hrack 都算失败 ——
// 这是「痕迹清零」的长期保证，上游 rebase 带回来的也会被它拦下。
const AUDIT_LEGACY_OK = new Set(['electron/main.ts', 'electron/cli/gbcCli.ts', 'scripts/gbc-bridge-client.mjs'])
const AUDIT_ROOTS = [...SWEEP_CODE_ROOTS, ...SWEEP_DOCS_ROOTS]
const auditFails = []
function auditOne(p) {
  const relPath = p.slice(ROOT.length + 1).split('\\').join('/')
  let src
  try {
    src = readFileSync(p, 'utf8')
  } catch {
    return
  }
  const matches = src.match(/[hH][rR][aA][cC][kK][A-Za-z_]*/g) || []
  for (const m of matches) {
    if (m === 'HRACK_USER_DATA_DIR' && AUDIT_LEGACY_OK.has(relPath)) continue
    auditFails.push(`${relPath}: ${m}`)
  }
}
function auditTree(root) {
  const absRoot = join(ROOT, root)
  if (!existsSync(absRoot)) return
  if (statSync(absRoot).isFile()) {
    auditOne(absRoot)
    return
  }
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        walk(p)
      } else if (SWEEP_EXTS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
        auditOne(p)
      }
    }
  }
  walk(absRoot)
}
for (const root of AUDIT_ROOTS) auditTree(root)
if (auditFails.length) {
  failures.push(`审计: 还有 ${auditFails.length} 处 hrack 痕迹：\n      ${[...new Set(auditFails)].slice(0, 20).join('\n      ')}`)
} else {
  report('审计: 白名单外 hrack 痕迹 = 0', 'audit')
}

// ───────────────────────── 报告 ─────────────────────────
console.log(`\n品牌改版 ${CHECK ? '(检查模式，未写盘)' : ''}\n${'='.repeat(64)}`)
for (const c of changes) console.log('  ✓ ' + c)
if (failures.length) {
  console.log(`\n✗ 有 ${failures.length} 处没匹配上：`)
  for (const f of failures) console.log('    ' + f)
  process.exit(1)
}
console.log(`\n共 ${changes.length} 处改动，全部匹配成功。`)
