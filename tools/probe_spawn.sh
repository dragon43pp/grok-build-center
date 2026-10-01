#!/usr/bin/env bash
# 按阶段推进，定位是**哪一步**把 CLI 拉起来了。
#
# 背景：「幽灵启动」排查。已知事实：
#   · `sessions`（只导航到会话历史页）0 次 spawn；`click` 阶段 0 次（但它走的是
#     「原目录已失效 → 让你选目录」分支，根本到不了 launchCli，不算反证）；
#   · `focus` 阶段 7 次里有 4 次 spawn，且带追踪的三次里 `launchCli` 的 session id
#     **正好等于**被 `.focus()` 的那个按钮的 id；
#   · 而 `SessionRow` 只在**双击整行**和**点击按钮**时恢复，`.focus()` 不该产生点击。
#
# 所以本轮加了三个东西：
#   1. watch_proc.py 轮询进程表（tasklist 在本机数不到正在跑的 grok，「首次grok=从未」
#      那列本来就是瞎的，不能当证据）；
#   2. 页面内**捕获阶段**的事件监听，把 mousedown/click/dblclick/focusin 全记下来 ——
#      如果真有点击，日志里必然看得到，反过来也就能排除「我没采到」。
#   3. 对照组：`wait` 阶段与 `focus` 阶段**时长完全一致**但不聚焦。若对照组也 spawn，
#      那肇事者是「渲染完成后的延迟副作用」，不是 focus。
#
#   用法：bash tools/probe_spawn.sh none|onboard|sessions|focus|focuslog|wait|dbl|stats|click
#
# 三条老纪律：一条命令跑完、不把输出管进 head、不 rm。
set -u

STAGE="${1:-none}"
APP="/d/grok-build-center-desktop"
NODE="C:/Users/admin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
PY="C:/Users/admin/.workbuddy/binaries/python/versions/3.13.12/python.exe"
STAMP="$(date +%H%M%S)"
PORT=$(( 9351 + ${2:-0} ))
PROFILE="$TEMP/gbc-spawn-$STAGE-$STAMP"
# 每轮**独立**日志：老版本 `: > "$LOG"` 会把上一轮的结果截掉，
# 回头只看到最后一行，白跑。
LOG="$TEMP/gbc-spawn-$STAGE-$STAMP.log"
WATCH="$TEMP/gbc-watch-$STAGE-$STAMP.log"
SHOT="$TEMP/_probe-$STAGE-$STAMP.png"
export GBC_USER_DATA_DIR="$PROFILE"
export HRACK_DISABLE_UPDATES=1
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS

cd "$APP" || exit 1

echo "== stage=$STAGE port=$PORT profile=$PROFILE ==" | tee -a "$LOG"

# 进程观察：整轮盯着，比 tasklist 可靠。
"$PY" tools/watch_proc.py 150 grok codex > "$WATCH" 2>&1 &
WATCH_PID=$!

"$APP/node_modules/electron/dist/electron.exe" out/main/index.js \
  --remote-debugging-port=$PORT >>"$LOG" 2>&1 &
APP_PID=$!
echo "== electron pid=$APP_PID ==" | tee -a "$LOG"

# 等 CDP
for _ in $(seq 1 40); do
  curl -s --max-time 2 "http://127.0.0.1:$PORT/json" >/dev/null 2>&1 && break
  sleep 1
done
sleep 18

# ⚠️ 三段脚本自己都不带 return，**唯一**那个 return 拼在最末尾 ——
# `Runtime.evaluate` 取的是这个 async IIFE 的返回值，而函数体里的表达式语句
# 不会成为返回值（不像直接 eval 的完成值）。第一版在引导那段写了
# `return 'onboarded'`，于是整个 IIFE 当场退出、后面的导航**一次都没跑**，
# 表现是「阶段测试没复现」，差点据此得出错误结论。
# 同理外层 grep 不能把 `ERR:` 滤掉，否则脚本抛错也看不见。
SLEEP="const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));"

# 捕获阶段监听：谁点的、点的哪个元素、当时谁有焦点。少了这个就只能靠猜。
# 关键区分：**真实**物理点击会带 mousedown→mouseup→click 成对出现，且带坐标；
# 合成的 `dispatchEvent(new MouseEvent('dblclick'))` 只产生孤零零一行 dblclick。
# round 3 抓到的就是前者 —— 说明事件来自窗口外部，不是 App 自己。
SPY="window.__gbcProbe=[];for(const ty of ['mousedown','mouseup','click','dblclick','focusin','keydown']){document.addEventListener(ty,(e)=>{const t=e.target;const d=(t&&t.dataset)?(t.dataset.testid||t.dataset.session||t.tagName):String(t);const a=(document.activeElement&&document.activeElement.dataset&&document.activeElement.dataset.testid)||document.activeElement?.tagName||'-';const xy=(e.clientX!==undefined)?('@'+e.clientX+','+e.clientY):'';const line=ty+' on '+d+' active='+a+xy+' hasFocus='+document.hasFocus();window.__gbcProbe.push(line);console.info('[gbc-probe] '+line);},true);}"

ONBOARD="$SPY const go=[...document.querySelectorAll('button')].find(b=>(b.textContent||'').includes('进入会话中心')); const onboarded=!!go; if(go){go.click(); await sleep(1500);}"
NAV="const navBtn=(()=>{for(const s of ['[data-testid=rail-sessions]','[data-testid=titlebar-sessions]']){const e=document.querySelector(s);if(e&&!e.disabled)return e}return null})(); if(navBtn)navBtn.click(); const navDeadline=Date.now()+25000; while(Date.now()<navDeadline){if(document.querySelectorAll('[data-testid=session-history-row]').length>0)break; await sleep(400);} const rowCount=document.querySelectorAll('[data-testid=session-history-row]').length;"
FOCUS="const focusRow=[...document.querySelectorAll('[data-testid=session-history-row]')].find(x=>x.dataset.resumable==='true'); const focusBtn=focusRow&&focusRow.querySelector('[data-testid=session-history-resume]'); if(focusBtn){focusBtn.focus(); await sleep(800);} const focusId=focusBtn?focusBtn.dataset.session:'-'; const focusOk=document.activeElement===focusBtn;"
# 对照组：与 FOCUS 等长，但只等，不碰任何元素。
WAITONLY="await sleep(800); const focusOk='n/a'; const focusId='-';"
# 正对照：真双击整行（唯一被设计成「恢复」的手势）。
DBL="const dblRow=[...document.querySelectorAll('[data-testid=session-history-row]')].find(x=>x.dataset.resumable==='true'); const dblId=dblRow?dblRow.querySelector('[data-testid=session-history-resume]')?.dataset.session:'-'; if(dblRow){dblRow.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); await sleep(800);} const focusOk='n/a'; const focusId=dblId;"
PROBEOUT="const probe=window.__gbcProbe||[]; const probeText=probe.length?probe.join(' ; '):'(无事件)';"

STATS="const statsBtn=(()=>{for(const s of ['[data-testid=rail-stats]','[data-testid=titlebar-stats]']){const e=document.querySelector(s);if(e&&!e.disabled)return e}return null})(); if(statsBtn)statsBtn.click(); const statsDeadline=Date.now()+25000; while(Date.now()<statsDeadline){if(document.querySelectorAll('[data-testid=usage-agent-row]').length>0)break; await sleep(400);} const scroller=document.querySelector('[data-testid=usage-page]'); if(scroller)scroller.scrollTop=scroller.scrollHeight;"
CLICK="const claudeRow=[...document.querySelectorAll('[data-testid=session-history-row]')].find(x=>x.dataset.agent==='claude'&&x.dataset.resumable==='true'); const claudeBtn=claudeRow&&claudeRow.querySelector('[data-testid=session-history-resume]'); const clickedId=claudeBtn?claudeBtn.dataset.session:'-'; if(claudeBtn)claudeBtn.click(); await sleep(1500); const draftOpen=!!document.querySelector('[data-testid=cli-config]');"

case "$STAGE" in
  none)     SCRIPT="" ;;
  onboard)  SCRIPT="$ONBOARD return 'onboarded='+onboarded" ;;
  sessions) SCRIPT="$ONBOARD $NAV return 'onboarded='+onboarded+' rows='+rowCount" ;;
  focus)    SCRIPT="$ONBOARD $NAV $FOCUS return 'onboarded='+onboarded+' rows='+rowCount+' focused='+focusOk+' session='+focusId" ;;
  focuslog) SCRIPT="$ONBOARD $NAV $FOCUS await sleep(5000); $PROBEOUT return 'onboarded='+onboarded+' rows='+rowCount+' focused='+focusOk+' session='+focusId+' EVENTS['+probeText+']'" ;;
  wait)     SCRIPT="$ONBOARD $NAV $WAITONLY await sleep(5000); $PROBEOUT return 'onboarded='+onboarded+' rows='+rowCount+' waited=5000 EVENTS['+probeText+']'" ;;
  dbl)      SCRIPT="$ONBOARD $NAV $DBL await sleep(5000); $PROBEOUT return 'onboarded='+onboarded+' rows='+rowCount+' dbl='+focusId+' EVENTS['+probeText+']'" ;;
  stats)    SCRIPT="$ONBOARD $STATS return 'onboarded='+onboarded" ;;
  click)    SCRIPT="$ONBOARD $NAV $CLICK return 'onboarded='+onboarded+' rows='+rowCount+' clicked='+clickedId+' draft='+draftOpen" ;;
  *) echo "未知阶段 $STAGE"; kill $APP_PID 2>/dev/null; exit 2 ;;
esac

if [ -n "$SCRIPT" ]; then
  # ⚠️ `sleep` 这个辅助函数**必须**统一拼在最前面。重写脚本时我把它从各段里删掉了，
  # 三段于是在第一句 `await sleep(1500)` 抛 `ReferenceError: sleep is not defined`。
  # 注意：那行错误**是**打出来了的（外层 grep 没滤 ERR:），是读日志时扫了一眼
  # 「有输出」就当跑过了 —— 前置脚本抛错时，那一次运行的结论一律作废。
  SCRIPT="$SLEEP $SCRIPT"
  echo "== 执行阶段脚本 ==" | tee -a "$LOG"
  # 这里不能滤 ERR: —— 脚本抛错时那行是唯一的线索。
  "$NODE" tools/shot.mjs "$SHOT" "$PORT" 20000 "$SCRIPT" 2>&1 \
    | grep -E "前置脚本|已写入|ERR:|FAIL|⚠️" | tee -a "$LOG"
fi

# 每个阶段之后再观察 40 秒。
echo "== 观察 40s（进程表由 watch_proc.py 轮询，不用 tasklist）==" | tee -a "$LOG"
sleep 40

kill $APP_PID 2>/dev/null
sleep 3
kill -9 $APP_PID 2>/dev/null
sleep 2

echo "== 结果 stage=$STAGE ==" | tee -a "$LOG"
echo "--- 进程观察 ---" | tee -a "$LOG"
# 等观察器自然收尾（它自己会休眠，最多 150s，这里限时等）
for _ in $(seq 1 5); do kill -0 $WATCH_PID 2>/dev/null || break; sleep 1; done
kill $WATCH_PID 2>/dev/null
cat "$WATCH" | tee -a "$LOG" || true
echo "== 日志: $LOG / 观察: $WATCH =="
