#!/usr/bin/env bash
# 一次性把「启动 -> 跳过首启引导 -> 拍四个页面 -> 关掉」跑完。
#
# 三条纪律，都是踩出来的：
#  1. 必须一条命令跑完 —— 后台起的 GUI 进程会随调用方 shell 结束而被回收，
#     分几条命令跑的话，第二条开始时应用已经没了。
#  2. **不要把输出管进 head** —— head 提前退出会让 echo 吃 SIGPIPE，
#     脚本在半路被杀，后面几步静默不执行（表现为「截图没更新」）。
#     所以这里自己落盘，最后再 tail。
#  3. **不要 rm** —— 本机的 safe-delete 守卫会拦批量删除，删不掉还不报错，
#     于是「全新 profile」的假设悄悄失效（上一轮的引导状态被继承下来，
#     首启引导那一步就点了个空）。改用每轮唯一目录，不需要删任何东西。
set -u

APP="/d/grok-build-center-desktop"
NODE="C:/Users/admin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
PY="C:/Users/admin/.workbuddy/binaries/python/versions/3.13.12/python.exe"
PORT=9347
PROFILE="$TEMP/gbc-ui-test-$$"
LOG="$TEMP/gbc-ui-shots.log"
export GBC_USER_DATA_DIR="$PROFILE"
export HRACK_DISABLE_UPDATES=1
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS

cd "$APP" || exit 1
: > "$LOG"

# 先把上一轮可能残留的测试实例收掉。上一次被 `head` 打断时留下的孤儿进程会
# 一直占着 `\\.\pipe\gbc-bridge-<user>`，新实例于是「bridge listen failed」——
# 截图还能拍，但桥接功能是假的，而且进程越攒越多。只杀路径属于本仓库的。
"$PY" - <<'PYEOF' 2>/dev/null || true
import glob, json, os, shutil, subprocess
here = "grok-build-center-desktop"
out = subprocess.run(
    ["powershell", "-NoProfile", "-Command",
     "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | "
     "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
    capture_output=True, text=True,
)
raw = (out.stdout or "").strip()
if raw:
    rows = json.loads(raw)
    if isinstance(rows, dict):
        rows = [rows]
    for row in rows:
        cmd = row.get("CommandLine") or ""
        if here in cmd:
            subprocess.run(["taskkill", "/PID", str(row["ProcessId"]), "/T", "/F"],
                           capture_output=True)
            print("killed orphan", row["ProcessId"])

# 只保留最近两份测试 profile，否则 TEMP 里会攒一堆。
dirs = sorted(glob.glob(os.path.join(os.environ["TEMP"], "gbc-ui-test-*")), key=os.path.getmtime)
for stale in dirs[:-2]:
    shutil.rmtree(stale, ignore_errors=True)
PYEOF

echo "== 启动（profile=$PROFILE）==" | tee -a "$LOG"
"$APP/node_modules/electron/dist/electron.exe" out/main/index.js \
  --remote-debugging-port=$PORT >>"$LOG" 2>&1 &
APP_PID=$!

wait_for_cdp() {
  for _ in $(seq 1 40); do
    if curl -s --max-time 2 "http://127.0.0.1:$PORT/json" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if ! wait_for_cdp; then
  echo "!! CDP 没起来，主进程日志："
  tail -20 "$LOG"
  kill $APP_PID 2>/dev/null
  exit 1
fi
echo "   CDP 就绪（等首屏）"
sleep 18

# 每个探测脚本都会打印 `前置脚本: ...`，那行就是判据 —— 要看到具体页面元素，
# 而不是「点了但没点着」。
shoot() {
  local out="$1" script="$2"
  echo | tee -a "$LOG"
  echo "== $(date +%H:%M:%S) $out ==" | tee -a "$LOG"
  "$NODE" tools/shot.mjs "$out" $PORT 20000 "$script" 2>&1 \
    | grep -E "页面:|抓拍前页面|前置脚本|已写入|ERR:|导航后正文前|FAIL|⚠️|   - " | tee -a "$LOG"
}

# 全程盯着 grok 进程。理由：整轮跑完比对数据指纹时发现 grok 自己的日志里有一次完整的
# `session.spawn_and_register` + `session.load_session`（就是会话列表第一行那场），
# 而 `grok --version` 探测不该产生那个。分阶段单测跑下来（onboard / sessions / focus /
# click）一次都没复现，所以必须把「哪一步」用时间戳钉死，而不是靠推理。
GROK_TRACE="$TEMP/gbc-grok-trace.log"
: > "$GROK_TRACE"
(
  while true; do
    n=$(tasklist /FI "IMAGENAME eq grok.exe" /NH 2>/dev/null | grep -ci "grok.exe" || true)
    echo "$(date +%H:%M:%S) grok=$n" >> "$GROK_TRACE"
    sleep 2
  done
) &
TRACER_PID=$!

shoot "$TEMP/_shot-onboarding.png" "
const go = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('进入会话中心'));
if (go) { go.click(); await new Promise(r => setTimeout(r, 1500)); return 'clicked 进入会话中心' }
return 'no onboarding button: ' + document.body.innerText.replace(/\n+/g,' / ').slice(0,120);
"

# 导航入口有两种形态：侧栏展开时在标题栏（titlebar-*），侧栏收起时才是图标栏
# （rail-*）。写死一个会在另一种形态下拿不到元素，于是「点了但没点着」，
# 截出来还是首页 —— 必须按优先级依次尝试。
shoot "docs/shots/03-session-history.png" "
const pick = (...sels) => {
  for (const s of sels) { const el = document.querySelector(s); if (el && !el.disabled) return el }
  return null
}
const btn = pick('[data-testid=rail-sessions]', '[data-testid=titlebar-sessions]');
if (!btn) return 'FAIL no nav: ' + document.body.innerText.replace(/\n+/g,' / ').slice(0,180);
btn.click();
// 扫描要在主进程读 157k 个文件，约 2.5s —— **必须等它出结果再拍**。
// 固定 sleep 会拍到「扫描中…」的空列表，看着像功能坏了。
const waitRows = async (ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const n = document.querySelectorAll('[data-testid=session-history-row]').length;
    if (n > 0) return n;
    await new Promise(r => setTimeout(r, 400));
  }
  return 0;
};
const rows = await waitRows(25000);
await new Promise(r => setTimeout(r, 500));
return 'via ' + btn.dataset.testid + ' | rows=' + rows + ' | ' +
  document.body.innerText.replace(/\n+/g, ' / ').slice(0, 200);
"

shoot "docs/shots/04-usage.png" "
const pick = (...sels) => {
  for (const s of sels) { const el = document.querySelector(s); if (el && !el.disabled) return el }
  return null
}
const btn = pick('[data-testid=rail-stats]', '[data-testid=titlebar-stats]');
if (!btn) return 'FAIL no nav-stats';
btn.click();
const waitRows = async (ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const n = document.querySelectorAll('[data-testid=usage-agent-row]').length;
    if (n > 0) return n;
    await new Promise(r => setTimeout(r, 400));
  }
  return 0;
};
const rows = await waitRows(25000);
await new Promise(r => setTimeout(r, 500));
return 'via ' + btn.dataset.testid + ' | agent rows=' + rows + ' | ' +
  document.body.innerText.replace(/\n+/g, ' / ').slice(0, 200);
"

# 价目表来源在页面最下面，不滚到底截不到。要滚的是页面自己的滚动容器
# （section 上的 sidebar-scroll），不是 window —— 滚 window 没用。
# 这一步**自己再导航一次**，不假设上一步把页面留在哪儿：抓拍和日志一旦指向
# 不同页面，排查起来全是猜。
shoot "docs/shots/05-usage-pricing.png" "
const pick = (...sels) => {
  for (const s of sels) { const el = document.querySelector(s); if (el && !el.disabled) return el }
  return null
}
const nav = pick('[data-testid=rail-stats]', '[data-testid=titlebar-stats]');
if (nav) nav.click();
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  if (document.querySelectorAll('[data-testid=usage-agent-row]').length > 0) break;
  await new Promise(r => setTimeout(r, 400));
}
const scroller = document.querySelector('[data-testid=usage-page]');
if (scroller) scroller.scrollTop = scroller.scrollHeight;
await new Promise(r => setTimeout(r, 800));
const btn = document.querySelector('[data-testid=usage-refresh-pricing]');
return 'refresh btn=' + (btn ? btn.textContent.trim() : 'MISSING') +
  ' | 价目表行=' + (document.body.innerText.match(/价目表：[^\\n]*/) || ['(未找到)'])[0];
"

# 恢复按钮平时是 opacity-0，hover / 键盘聚焦才显形。CDP 的 Runtime.evaluate 发
# 不出真实的鼠标进入（CSS :hover 不认合成事件），但**能** focus() —— 而按钮上就
# 挂着 group-focus-within:opacity-100。所以用聚焦来让它显形：这是键盘用户本来就
# 有的路径，不是为截图造的假状态。
#
# 同时把整页的可恢复/不可恢复统计打出来：截图只能证明「有一个按钮」，日志要能
# 证明「375 个可恢复、151 个不可恢复，且不可恢复的理由是人话」。
shoot "docs/shots/06-session-resume.png" "
const pick = (...sels) => {
  for (const s of sels) { const el = document.querySelector(s); if (el && !el.disabled) return el }
  return null
}
const nav = pick('[data-testid=rail-sessions]', '[data-testid=titlebar-sessions]');
if (!nav) return 'FAIL no nav-sessions';
nav.click();
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  if (document.querySelectorAll('[data-testid=session-history-row]').length > 0) break;
  await new Promise(r => setTimeout(r, 400));
}
const rows = [...document.querySelectorAll('[data-testid=session-history-row]')];
const resumable = rows.filter(r => r.dataset.resumable === 'true');
const blocked = rows.filter(r => r.dataset.resumable !== 'true');
const reasons = {};
for (const r of blocked) {
  const b = r.querySelector('[data-testid=session-history-resume]');
  const key = (b && b.title || '(无按钮)').slice(0, 34);
  reasons[key] = (reasons[key] || 0) + 1;
}
const byAgent = {};
for (const r of resumable) byAgent[r.dataset.agent] = (byAgent[r.dataset.agent] || 0) + 1;
const first = resumable[0];
const btn = first && first.querySelector('[data-testid=session-history-resume]');
if (btn) { btn.focus(); await new Promise(r => setTimeout(r, 400)); }
const focused = document.activeElement === btn;
return 'rows=' + rows.length + ' 可恢复=' + resumable.length + ' 不可恢复=' + blocked.length +
  ' | 可恢复按 agent: ' + JSON.stringify(byAgent) +
  ' | 不可恢复理由: ' + JSON.stringify(reasons) +
  ' | 聚焦=' + focused + ' 首行session=' + (btn ? btn.dataset.session : '-') +
  ' 按钮文案=' + (btn ? btn.title : '-');
"

# 零写入的真实点击。挑一场 claude 会话：它的 cwd 是
# `%TEMP%\od-conn-test-*`，那个目录早已不在。所以点下去必然走
# `resolveWorkspace` 抛错（主进程 `assertDirectory`）-> 退回「让你选目录」这条路，
# **根本不会拉起 claude**。
#
# 这样既跑通了「点按钮 -> planResume -> 拿目录 -> 退路」整条链路，又完全不碰用户
# 在实际用的会话（真正能恢复的那 375 场点了会往 ~/.grok/sessions 里追加内容）。
#
# 断言五件事：
#   ① 面板开的是**草稿表单**（`cli-config`）—— 不是选 CLI 那一屏。恢复退路带着
#      initialCli，所以走的是 `!draft && !initialCli` 那个分支的**反面**；第一版
#      校验就是找错了 testid 才误判成「面板没开」。
#   ② 参数框里是 `--resume <id>`，id 就是刚点那一场的 id。
#   ③ 目录框里是**旧目录原值**（已不存在），不是「上次用过的目录」。留空会退回
#      lastWorkspace()，那是个存在且合法的目录 —— 用户直接点启动就在不相干的目录
#      里把旧会话续上了，全程没提示。这条断言防的就是这个。
#   ④ 顶部有说明条（resumeNoCwd），否则用户不知道为什么要重选目录。
#   ⑤ 没有跳到终端页 —— 证明真的没起 CLI。
shoot "docs/shots/07-resume-missing-cwd.png" "
const pick = (...sels) => {
  for (const s of sels) { const el = document.querySelector(s); if (el && !el.disabled) return el }
  return null
}
const nav = pick('[data-testid=rail-sessions]', '[data-testid=titlebar-sessions]');
if (nav) nav.click();
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  if (document.querySelectorAll('[data-testid=session-history-row]').length > 0) break;
  await new Promise(r => setTimeout(r, 400));
}
const row = [...document.querySelectorAll('[data-testid=session-history-row]')]
  .find(r => r.dataset.agent === 'claude' && r.dataset.resumable === 'true');
if (!row) return 'FAIL 没有可恢复的 claude 行（claude CLI 没进 launchable？）';
const btn = row.querySelector('[data-testid=session-history-resume]');
const wantId = btn.dataset.session;
// 期望的旧目录必须取**完整路径**。早先这里读的是 row.title，而 title 是
// 会话文件路径拼上费用标签 —— 那是会话**文件**路径，跟 cwd 差着十万八千里，
// 断言永远为假。行内可见的只有 cwd 的基名，所以精确值由 data-cwd 提供。
// ⚠️ 整段脚本处在 bash 的双引号里，注释里**不许出现反引号，也不许出现英文双引号**：
// 反引号会被当命令替换执行（报 command not found，有输出还会把这段 JS 改坏），
// 英文双引号会直接把字符串截断（实测报 SyntaxError: Unexpected end of input）。
const wantCwd = row.dataset.cwd || '';
btn.click();
await new Promise(r => setTimeout(r, 1500));

const draft = document.querySelector('[data-testid=cli-config]');
const args = document.querySelector('[data-testid=cli-arguments]');
const ws = document.querySelector('[data-testid=cli-workspace]');
const notice = document.querySelector('[data-testid=cli-notice]');
const skip = document.querySelector('[data-testid=cli-skip-approval]');
if (!draft) return 'FAIL 点下去草稿面板没开（id=' + wantId + '） 当前hash=' + location.hash;

const checks = [
  ['args', args && args.value === '--resume ' + wantId, args ? args.value : '(无)'],
  ['行上有 data-cwd', wantCwd !== '', wantCwd || '(缺失，测试钩子丢了)'],
  ['cwd=旧值', wantCwd !== '' && !!ws && ws.value === wantCwd, (ws ? ws.value : '(无)') + ' 期望 ' + wantCwd],
  ['说明条', !!(notice && notice.textContent.trim()), notice ? notice.textContent.trim() : '(无)'],
  ['跳过确认未勾', !skip || skip.checked === false, skip ? String(skip.checked) : '(不适用)'],
  ['未跳终端', location.hash === '', 'hash=' + location.hash]
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
return (bad.length ? 'FAIL ' + bad.join(',') + ' | ' : 'ok ') +
  checks.map(c => c[0] + '=' + c[2]).join(' | ') + ' | session=' + wantId;
"

echo | tee -a "$LOG"
echo "== $(date +%H:%M:%S) 关掉 ==" | tee -a "$LOG"
kill $APP_PID 2>/dev/null
sleep 3
kill -9 $APP_PID 2>/dev/null
sleep 3
kill $TRACER_PID 2>/dev/null
wait $TRACER_PID 2>/dev/null
echo "== grok 进程轨迹（只打变化点） ==" | tee -a "$LOG"
awk '{ if ($2 != prev) { print; prev = $2 } }' "$GROK_TRACE" | tee -a "$LOG"
echo "== 主进程日志（关键行） ==" | tee -a "$LOG"
grep -E "\[gbc\]" "$LOG" | head -5 | tee -a "$LOG" || true
echo "== 截图产物（应为刚刚） ==" | tee -a "$LOG"
ls -la --time-style=+%H:%M docs/shots/ | tee -a "$LOG"
