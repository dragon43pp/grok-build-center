#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图形前台 —— 双击 exe 之后看到的那一屏。

为什么要它：exe 以前是**控制台程序**。双击开始菜单的图标，出来一个黑窗口，
滚一屏字，最后停在「按回车关闭…」。开发者无所谓，拿到安装包的人会以为坏了。

所以给一个前台：起一个只监听 127.0.0.1 的小服务，用默认浏览器打开一个控制面板，
上面一个大按钮「开始扫描」。扫完自动把网页打开，文件也留在原地可以另存。

为什么不是 tkinter：这台机器上打包用的 Python（3.13.12，托管版）**没有 _tkinter**，
PyInstaller 只能打包运行解释器里有的东西 —— tkinter 这条路直接走不通。
而这个产品本来就是 HTML/CSS 的，用浏览器当界面既零依赖又跟品牌一致。
（标准库 http.server + 手写页面，一个新依赖都没加。）

只在回环地址上监听，并且校验 Host —— 否则 DNS rebinding 能把本地面板暴露出去。

接口：
    GET  /               控制面板
    GET  /api/state      扫描状态（页面轮询它）
    GET  /api/ping       单实例探测（另一个进程用它认亲）
    POST /api/scan       开扫
    POST /api/quit       退出
    GET  /api/open       ?what=folder|history|output 交给系统打开
    GET  /history        直接看生成好的网页（同源，躲开 file:// 的限制）
    GET  /download       另存为
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import flow, paths
from . import __version__ as VERSION

APP_TAG = "grok-build-center"          # 单实例认亲用
DEFAULT_PORT = 8770
IDLE_EXIT = 30 * 60.0                  # 页面关掉后，服务最多再活半小时
OUTPUT_NAME = "session-history.html"


# --------------------------------------------------------------------------
# 扫描任务
# --------------------------------------------------------------------------

class Job:
    """一次扫描的全部状态。页面每隔几百毫秒把它整份读走。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = False
        self._reset()

    def _reset(self) -> None:
        now = time.time()
        self.started_at = 0.0
        self.finished_at = 0.0
        self.steps: list[dict] = [
            {"key": s["key"], "short": s["short"], "index": i, "total": flow.TOTAL,
             "state": "idle", "note": ""}
            for i, s in enumerate(flow.STEPS, start=1)
        ]
        self.head = ""
        self.detail = ""          # 「正在扫 Codex…」这类一句话
        self.log: list[str] = []
        self.result: dict | None = None
        self.error = ""
        self.runs = 0
        self._now = now

    # ---------------------------------------------------------------- 对外

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self, cfg_path: str, out_path: str) -> bool:
        with self._lock:
            if self.running:
                return False
            self._reset()
            self.runs += 1
            self.started_at = time.time()
            self._stop = False
            self._thread = threading.Thread(
                target=self._worker, args=(cfg_path, out_path),
                name="scan", daemon=True,
            )
            self._thread.start()
            return True

    def stop(self) -> None:
        with self._lock:
            self._stop = True

    def state(self, out_path: str) -> dict:
        with self._lock:
            elapsed = (self.finished_at or time.time()) - self.started_at \
                if self.started_at else 0.0
            has_out = os.path.exists(out_path)
            snapshot = {
                "running": self.running,
                "startedAt": self.started_at,
                "finishedAt": self.finished_at,
                "elapsed": elapsed,
                "head": self.head,
                "detail": self.detail,
                "steps": [dict(s) for s in self.steps],
                "log": list(self.log),
                "result": self.result,
                "error": self.error,
                "runs": self.runs,
                "hasOutput": has_out,
                "outputPath": out_path,
                "outputSize": os.path.getsize(out_path) if has_out else 0,
                "outputAt": os.path.getmtime(out_path) if has_out else 0.0,
            }
        return snapshot

    # ---------------------------------------------------------------- 内部

    def _worker(self, cfg_path: str, out_path: str) -> None:
        try:
            flow.run_all(cfg_path, out_path, emit=self._emit,
                         should_stop=lambda: self._stop)
        except Exception as exc:                      # noqa: BLE001
            with self._lock:
                self.error = f"{type(exc).__name__}: {exc}"
                self.log.extend(traceback.format_exc().rstrip().splitlines())
        finally:
            with self._lock:
                self.finished_at = time.time()
                self.detail = ""

    def _emit(self, event: dict) -> None:
        kind = event.get("kind")
        with self._lock:
            if kind == "step_start":
                self.head = flow.head_of(event["index"])
                self.detail = "准备中…"
                self.log.append("=" * 14 + f" {self.head} " + "=" * 14)
                self._mark(event["index"], "run")

            elif kind == "progress":
                self.detail = _progress_text(event)

            elif kind == "step_done":
                self._mark(event["index"], "err" if not event.get("ok") else "done")
                self.steps[event["index"] - 1]["note"] = event.get("note", "")
                if event.get("text"):
                    self.log.extend(event["text"].splitlines())
                    self.log.append("")
                if event["key"] == "history":
                    self.result = event.get("data")

            elif kind == "abort":
                self.detail = "已停止"

    def _mark(self, index: int, state: str) -> None:
        """更新第 index 步的灯。

        往后的步骤一律退回 idle —— 重扫时不能留着上一次跑完的绿点，
        那会让人以为这次也已经跑过了。
        """
        for i, step in enumerate(self.steps):
            if i == index - 1:
                step["state"] = state
                if state == "run":
                    step["note"] = ""
            elif i > index - 1:
                step["state"] = "idle"
                step["note"] = ""
        self.detail = ""


def _progress_text(event: dict) -> str:
    """把 scan 内部的通用进度翻译成人话。"""
    stage = event.get("stage")
    if stage == "cli":
        label = event.get("label") or event.get("cli") or ""
        if event.get("phase") == "start":
            return f"正在读 {label} 的会话……"
        return f"{label} 读完，{event.get('found', 0)} 场"
    if stage == "scan":
        return "正在收集会话……"
    if stage == "render":
        return f"正在渲染网页（{event.get('total', 0)} 场）……"
    if stage == "write":
        return "正在写文件……"
    return "处理中……"


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Panel:
    """页面需要的全部上下文。"""

    def __init__(self, cfg_path: str, out_path: str) -> None:
        self.cfg_path = cfg_path
        self.out_path = out_path
        self.job = Job()
        self.last_hit = time.time()

    def info(self) -> dict:
        cfg = os.path.exists(self.cfg_path)
        configured = False
        if cfg:
            try:
                from tools.config_ready import missing
                configured = not missing(self.cfg_path)
            except Exception:
                configured = False
        state = self.job.state(self.out_path)
        state.update({
            "app": APP_TAG,
            "version": VERSION,
            "dataRoot": paths.data_root(),
            "configPath": self.cfg_path,
            "hasConfig": cfg,
            "configured": configured,
        })
        return state


HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grok Build Center</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230B0E13'/><circle cx='16' cy='16' r='5' fill='%23FF6B4A'/></svg>">
<style>
  :root{
    --bg:#0B0E13; --plate:#141922; --screen:#0E1218; --hair:#242C38;
    --ink:#E8EBF0; --dim:#8A93A3; --faint:#5E6675;
    --coral:#FF6B4A; --mint:#3ECF8E; --amber:#F2A93B; --red:#EF4E45; --slate:#6B7484;
    --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Microsoft YaHei UI","PingFang SC",sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
    color-scheme:dark;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:13px;line-height:1.65;
       -webkit-font-smoothing:antialiased}
  .wrap{max-width:820px;margin:0 auto;padding:52px 26px 64px}

  /* 铭牌 */
  .plate{border:1px solid var(--hair);border-radius:18px;background:var(--plate);padding:26px 28px 24px;
         margin-bottom:16px}
  .kicker{font-family:var(--mono);font-size:10.5px;letter-spacing:3.4px;color:var(--faint);
          text-transform:uppercase}
  .brand{font-size:30px;font-weight:650;letter-spacing:-1.6px;line-height:1.15;margin:5px 0 0}
  .rule{height:1px;background:var(--hair);margin:15px 0 13px}
  .claim{color:var(--dim);font-size:12.5px}
  .claim b{color:var(--ink);font-weight:500}

  /* 按钮区 */
  .actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:18px}
  .cta{background:var(--coral);color:#160906;border:0;border-radius:12px;font-family:var(--sans);
       font-size:15px;font-weight:650;padding:14px 32px;cursor:pointer;letter-spacing:.01em;
       box-shadow:0 0 26px 2px rgba(255,107,74,.42);
       transition:transform .12s ease,box-shadow .18s ease,background .18s ease}
  .cta:hover{transform:translateY(-1px);box-shadow:0 0 36px 5px rgba(255,107,74,.55)}
  .cta:active{transform:translateY(0)}
  .cta:disabled{background:#1C2330;color:var(--faint);box-shadow:none;cursor:default;transform:none}
  .cta.quiet{background:transparent;color:var(--dim);border:1px solid var(--hair);box-shadow:none;
             font-size:13px;font-weight:500;padding:12px 18px}
  .cta.quiet:hover{color:var(--ink);border-color:#3A4557;transform:none}

  /* 步骤 */
  .steps{margin-top:18px;border-top:1px solid var(--hair)}
  .step{display:flex;align-items:center;gap:11px;padding:11px 2px;border-bottom:1px solid var(--hair)}
  .lamp{width:9px;height:9px;border-radius:50%;background:var(--slate);flex:0 0 auto}
  .st-run .lamp{background:var(--coral);box-shadow:0 0 0 3px rgba(255,107,74,.16),0 0 13px 3px rgba(255,107,74,.6)}
  .st-done .lamp{background:var(--mint)}
  .st-err .lamp{background:var(--red)}
  .step .nm{font-size:12.5px;color:var(--dim);flex:1 1 auto}
  .st-run .nm{color:var(--ink)}
  .st-done .nm{color:var(--dim)}
  .step .ix{font-family:var(--mono);font-size:10.5px;color:var(--faint);flex:0 0 auto}
  .step .nt{font-family:var(--mono);font-size:11px;color:var(--faint);flex:0 0 auto;text-align:right}
  .st-done .nt{color:var(--dim)}

  .live{display:flex;align-items:baseline;gap:10px;margin-top:14px;min-height:20px}
  .live .sp{font-family:var(--mono);font-size:11.5px;color:var(--coral)}
  .live .tx{font-size:12px;color:var(--dim)}

  /* 结果 */
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:9px;margin-top:16px}
  .cell{background:var(--plate);border:1px solid var(--hair);border-radius:10px;padding:10px 12px}
  .cell .k{font-family:var(--mono);font-size:10px;letter-spacing:.06em;color:var(--faint)}
  .cell .v{font-family:var(--mono);font-size:19px;margin-top:3px}
  .cell.zero .v{color:var(--faint)}

  .out{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px;
       background:var(--plate);border:1px solid var(--hair);border-radius:12px;padding:13px 15px}
  .out .p{font-family:var(--mono);font-size:11px;color:var(--dim);word-break:break-all;flex:1 1 240px}
  .out .m{font-family:var(--mono);font-size:11px;color:var(--faint);flex:0 0 auto}
  .link{color:var(--coral);text-decoration:none;font-size:12px;cursor:pointer;
        border-bottom:1px solid rgba(255,107,74,.35);padding-bottom:1px}
  .link:hover{border-bottom-color:var(--coral)}
  .link.quiet{color:var(--dim);border-bottom-color:var(--hair)}
  .link.quiet:hover{color:var(--ink);border-bottom-color:#3A4557}

  /* 日志 */
  details{margin-top:20px;border:1px solid var(--hair);border-radius:14px;background:var(--plate);overflow:hidden}
  summary{cursor:pointer;padding:12px 16px;font-family:var(--mono);font-size:11px;letter-spacing:.06em;
          color:var(--faint);user-select:none}
  summary:hover{color:var(--dim)}
  pre{margin:0;border-top:1px solid var(--hair);background:var(--screen);color:var(--dim);
      font-family:var(--mono);font-size:11px;line-height:1.6;padding:14px 16px;max-height:330px;overflow:auto;
      white-space:pre-wrap;word-break:break-all}

  .err{margin-top:14px;background:rgba(239,78,69,.09);border:1px solid rgba(239,78,69,.3);color:#FFB4AE;
       border-radius:12px;padding:12px 15px;font-size:12px}

  .foot{margin-top:22px;color:var(--faint);font-size:11px;line-height:2}
  .foot code{font-family:var(--mono);font-size:10.5px;color:var(--dim);background:var(--plate);
             padding:2px 6px;border-radius:5px;border:1px solid var(--hair)}
  .hide{display:none!important}
</style>
</head>
<body>
<div class="wrap">

  <div class="plate">
    <div class="kicker">GROK BUILD</div>
    <h1 class="brand">Center</h1>
    <div class="rule"></div>
    <div class="claim">
      把本机所有 AI CLI 的会话收成<b>一个可搜索的网页</b>。<br>
      不需要任何配置，不联网，扫完就在你眼前。
    </div>

    <div class="actions">
      <button id="cta" class="cta" data-act="scan">开始扫描</button>
      <a id="openLink" class="cta quiet hide" data-act="open">打开网页</a>
      <a id="saveLink" class="cta quiet hide" data-act="save">另存为…</a>
    </div>

    <div class="steps" id="steps"></div>
    <div class="live" id="live"></div>
  </div>

  <div id="resultBox" class="hide">
    <div class="cards" id="cards"></div>
    <div class="out">
      <span class="p" id="outPath"></span>
      <span class="m" id="outSize"></span>
      <a class="link" data-act="folder">打开所在文件夹</a>
    </div>
  </div>

  <div id="errBox" class="err hide"></div>

  <details>
    <summary>原始输出</summary>
    <pre id="log">（还没开始）</pre>
  </details>

  <div class="foot">
    <div id="meta"></div>
    <div>
      这个窗口只在 <code>127.0.0.1</code> 上开着，关掉页面它自己会退。
      <a class="link quiet" data-act="quit">现在退出</a>
      &nbsp;·&nbsp;<a class="link quiet" data-act="docs" id="panelLink"></a>
    </div>
  </div>

</div>

<script>
const $ = (s) => document.querySelector(s);
const LABEL_IDLE = "开始扫描", LABEL_RUN = "扫描中…", LABEL_AGAIN = "重新扫描";
let timer = null, openedOnce = false, busy = false;

async function api(path, method){
  const r = await fetch(path, {method: method || "GET", cache: "no-store"});
  if(!r.ok) throw new Error(path + " -> " + r.status);
  return r.json();
}

function fmtSize(n){
  if(!n) return "";
  return n > 1048576 ? (n/1048576).toFixed(1) + " MB" : Math.round(n/1024) + " KB";
}
function fmtAgo(ts){
  if(!ts) return "";
  const s = Math.max(0, Date.now()/1000 - ts);
  if(s < 60) return Math.round(s) + " 秒前";
  if(s < 3600) return Math.round(s/60) + " 分钟前";
  if(s < 86400) return (s/3600).toFixed(1) + " 小时前";
  return Math.round(s/86400) + " 天前";
}

function renderSteps(st){
  const box = $("#steps");
  const html = st.steps.map(s => {
    const cls = s.state === "run" ? "st-run" : s.state === "done" ? "st-done"
              : s.state === "err" ? "st-err" : "";
    return `<div class="step ${cls}">
      <span class="lamp"></span>
      <span class="ix">${s.index}/${s.total}</span>
      <span class="nm">${s.short}</span>
      <span class="nt">${s.note || ""}</span>
    </div>`;
  }).join("");
  if(box.dataset.sig !== html){ box.innerHTML = html; box.dataset.sig = html; }
}

function renderCards(st){
  const box = $("#resultBox");
  const info = st.result;
  if(!info){ box.classList.add("hide"); return; }
  box.classList.remove("hide");
  const cells = info.order.map(c => {
    const n = info.counts[c] || 0;
    return `<div class="cell ${n ? "" : "zero"}"><div class="k">${info.labels[c]}</div><div class="v">${n}</div></div>`;
  });
  cells.push(`<div class="cell"><div class="k">可搜正文</div><div class="v">${info.searchable}</div></div>`);
  cells.push(`<div class="cell"><div class="k">合计</div><div class="v">${info.total}</div></div>`);
  box.innerHTML = `<div class="cards">${cells.join("")}</div>
    <div class="out">
      <span class="p">${info.path}</span>
      <span class="m">${fmtSize(info.size)} · ${fmtAgo(st.outputAt)}</span>
      <a class="link" data-act="folder">打开所在文件夹</a>
    </div>`;
}

function render(st){
  const cta = $("#cta");
  cta.disabled = st.running;
  cta.textContent = st.running ? LABEL_RUN : (st.result ? LABEL_AGAIN : LABEL_IDLE);

  renderSteps(st);
  renderCards(st);

  const live = $("#live");
  if(st.running){
    live.innerHTML = `<span class="sp">● ${st.elapsed.toFixed(0)}s</span>
      <span class="tx">${st.detail || ""}</span>`;
  } else if(st.error){
    live.innerHTML = "";
  } else if(st.result){
    live.innerHTML = `<span class="sp" style="color:var(--mint)">●</span>
      <span class="tx">扫描完成，用时 ${st.elapsed.toFixed(0)} 秒。网页已生成。</span>`;
  } else if(st.runs === 0){
    live.innerHTML = `<span class="tx">还没扫过。点上面那个按钮开始。</span>`;
  } else {
    live.innerHTML = `<span class="tx">已停止。</span>`;
  }

  const err = $("#errBox");
  if(st.error){
    err.classList.remove("hide");
    err.textContent = "出错了：" + st.error;
  } else { err.classList.add("hide"); }

  const has = !!st.result;
  $("#openLink").classList.toggle("hide", !has);
  $("#saveLink").classList.toggle("hide", !has);

  const log = $("#log");
  const text = st.log.length ? st.log.join("\n") : "（还没开始）";
  if(log.dataset.sig !== text){ log.textContent = text; log.dataset.sig = text; }

  $("#meta").innerHTML =
    `v${st.version} &nbsp;·&nbsp; 产物 <code>${st.outputPath}</code>`
    + (st.hasOutput && !st.result ? `&nbsp;·&nbsp; 已有 ${fmtSize(st.outputSize)}，${fmtAgo(st.outputAt)}` : "")
    + `&nbsp;·&nbsp; 飞书${st.configured ? "已配置" : "未配置"}`;

  const pl = $("#panelLink");
  if(st.configured && !pl.dataset.ready){
    pl.dataset.ready = "1";
    pl.textContent = "启动飞书面板（去命令行跑 panel）";
    pl.dataset.act = "panelhint";
  } else if(!st.configured){
    pl.textContent = "飞书还没配 —— 配好之后卡片就会主动找你";
    pl.dataset.act = "docs";
  }

  if(has && !openedOnce){ openedOnce = true; window.open("/history", "_blank"); }
}

function schedule(st){
  clearTimeout(timer);
  timer = setTimeout(tick, st && st.running ? 600 : 4000);
}

async function tick(){
  let st = null;
  try { st = await api("/api/state"); render(st); }
  catch(e){ /* 服务已经退了，静默 */ }
  schedule(st);
}

async function startScan(){
  if(busy) return;
  busy = true;
  try { await api("/api/scan", "POST"); }
  catch(e){}
  busy = false;
  openedOnce = false;
  await tick();
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if(!el) return;
  const act = el.dataset.act;
  if(el.tagName === "A") e.preventDefault();
  if(act === "scan") startScan();
  else if(act === "open") window.open("/history", "_blank");
  else if(act === "save") window.location.href = "/download";
  else if(act === "folder") await api("/api/open?what=folder");
  else if(act === "panelhint" || act === "docs") await api("/api/open?what=readme");
  else if(act === "quit"){
    try { await fetch("/api/quit", {method:"POST"}); } catch(err){}
    document.body.innerHTML =
      '<div class="wrap"><div class="plate"><div class="kicker">GROK BUILD</div>'
      + '<h1 class="brand">Center</h1><div class="rule"></div>'
      + '<div class="claim">已经退出了。想再打开就再双击一次桌面上的图标。</div>'
      + '</div></div>';
  }
});

tick();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "GrokBuildCenter"
    protocol_version = "HTTP/1.1"

    panel: Panel = None            # 由 create_server 注入

    # 别往 stderr 刷日志：这是图形程序，没有控制台可看
    def log_message(self, *args) -> None:      # noqa: D102
        pass

    # ---------------------------------------------------------------- 工具

    def _json(self, payload: dict, code: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _html(self, text: str, code: int = 200) -> None:
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: str, download: bool) -> None:
        if not os.path.exists(path):
            self._html("<h1>404</h1><p>还没生成。</p>", 404)
            return
        with open(path, "rb") as fh:
            body = fh.read()
        stamp = time.strftime("%Y%m%d", time.localtime(os.path.getmtime(path)))
        name = f"grok-build-sessions-{stamp}.html"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.end_headers()
        self.wfile.write(body)

    def _guard(self) -> bool:
        """只认回环来的请求。

        没有这道闸，DNS rebinding 能让一个网页把你的 127.0.0.1 当成自己的
        同源端点 —— 那就能替你在本机开扫描、读产物。
        """
        host = (self.headers.get("Host") or "").split(":")[0].strip("[]").lower()
        if host not in ("127.0.0.1", "localhost", "::1"):
            self._json({"error": "bad host"}, 403)
            return False
        return True

    def _origin_ok(self) -> bool:
        """改动状态的两个接口只接受同源调用。"""
        origin = self.headers.get("Origin")
        if not origin:
            return True                       # 非浏览器（curl / 本机脚本）
        try:
            host = urlparse(origin).hostname or ""
        except ValueError:
            return False
        return host in ("127.0.0.1", "localhost", "::1")

    # ---------------------------------------------------------------- 路由

    def do_GET(self) -> None:                  # noqa: N802
        if not self._guard():
            return
        self.panel.last_hit = time.time()
        url = urlparse(self.path)
        route = url.path

        if route == "/":
            self._html(HTML)
        elif route == "/api/state":
            self._json(self.panel.info())
        elif route == "/api/ping":
            self._json({"app": APP_TAG, "version": VERSION})
        elif route == "/api/open":
            what = (parse_qs(url.query).get("what") or ["folder"])[0]
            self._json({"ok": _open(what, self.panel)})
        elif route == "/history":
            self._file(self.panel.out_path, download=False)
        elif route == "/download":
            self._file(self.panel.out_path, download=True)
        else:
            self._html("<h1>404</h1>", 404)

    def do_POST(self) -> None:                 # noqa: N802
        if not self._guard():
            return
        if not self._origin_ok():
            self._json({"error": "bad origin"}, 403)
            return
        self.panel.last_hit = time.time()
        route = urlparse(self.path).path

        if route == "/api/scan":
            started = self.panel.job.start(self.panel.cfg_path, self.panel.out_path)
            self._json({"ok": started, "running": self.panel.job.running})
        elif route == "/api/stop":
            self.panel.job.stop()
            self._json({"ok": True})
        elif route == "/api/quit":
            self._json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            self._json({"error": "not found"}, 404)


def _open(what: str, panel: Panel) -> bool:
    """交给系统去打开 —— 只有它知道用什么程序。"""
    if what == "readme":
        # README 可能在 exe 旁边，也可能只在 _internal 里（打包时放进去了）
        target = paths.find("README.md") or paths.data_root()
    else:
        target = {
            "folder": paths.data_root(),
            "output": panel.out_path,
            "history": panel.out_path,
        }.get(what) or paths.data_root()
    if not os.path.exists(target):
        target = paths.data_root()
    try:
        os.startfile(target)               # type: ignore[attr-defined]  # noqa: S606
        return True
    except OSError:
        return False


# --------------------------------------------------------------------------
# 起服务
# --------------------------------------------------------------------------

class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False           # 见下：Windows 上反了，别开

    def handle_error(self, request, client_address) -> None:
        # 浏览器会随手断连接（关标签页），别让它刷一屏 traceback
        pass


def create_server(panel: Panel, port: int) -> Server:
    Handler.panel = panel
    srv = Server(("127.0.0.1", port), Handler)
    return srv


def _someone_home(port: int) -> bool:
    """已经有一个面板在跑吗（双击第二次的时候会发生）。"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4) as sock:
            sock.sendall(b"GET /api/ping HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            return APP_TAG.encode() in sock.recv(512)
    except OSError:
        return False


def _watchdog(srv: Server, panel: Panel, idle: float) -> None:
    while True:
        time.sleep(20)
        if time.time() - panel.last_hit > idle:
            srv.shutdown()
            return


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Grok Build Center · 图形前台")
    ap.add_argument("--config", default=None, help="config.json 路径")
    ap.add_argument("--out", default=None, help="产物 HTML 路径")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-open", action="store_true", help="不自动开浏览器")
    ap.add_argument("--idle", type=float, default=IDLE_EXIT,
                    help="页面关掉后多久自动退出（秒）")
    args = ap.parse_args(argv)

    cfg_path = os.path.abspath(args.config) if args.config \
        else os.path.join(paths.data_root(), "config.json")
    out_path = os.path.abspath(args.out) if args.out \
        else os.path.join(paths.data_root(), OUTPUT_NAME)
    panel = Panel(cfg_path, out_path)

    srv: Server | None = None
    port = args.port
    try:
        srv = create_server(panel, port)
    except OSError:
        # 端口被占：如果占着的是我们自己，就别再开一个 —— 把浏览器叫到那边去
        if _someone_home(port):
            if not args.no_open:
                webbrowser.open(f"http://127.0.0.1:{port}/")
            return 0
        port = 0                          # 别人的端口，随便挑一个空的
        srv = create_server(panel, port)

    port = srv.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    if not args.no_open:
        threading.Timer(0.4, webbrowser.open, args=(url,)).start()

    threading.Thread(target=_watchdog, args=(srv, panel, args.idle), daemon=True).start()
    try:
        srv.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
