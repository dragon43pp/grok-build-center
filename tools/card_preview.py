#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把真实的飞书卡片 JSON 渲染成一个可点的 HTML 预览。

为什么要这个东西：飞书应用要开发者后台点一堆配置才能看到效果，中间任何一步错了
都只能看到「卡片加载失败」。这里用同一份 `cards.build_panel()` 的真实输出渲染成
HTML，按钮也能真的点（筛选 / 翻页 / 刷新都是本地换页），先确认「长什么样、点了对不对」，
再去连真飞书。这样出问题时能确定是后台配置的锅，不是代码的锅。

渲染的是真卡片 JSON，不是照着截图重画的 —— 所以这里的 HTML 一旦和飞书里长得不一样，
就是渲染器的差距，能直接定位。

跑法：
    python tools/card_preview.py                 # 生成 card-preview.html
    python tools/card_preview.py --out x.html
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from feishu_hub import cards  # noqa: E402
from feishu_hub.state import build_snapshot, filter_sessions  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ------------------------------------------------------------------ 行内 markdown

_PLACEHOLDER = "\x00ESC{}\x00"


def render_md(text: str) -> str:
    """飞书 lark_md 的最小子集：**粗**、`代码`、<font color=..>..</font>、\\* 转义、换行。"""
    if not text:
        return ""
    stash: list[str] = []

    def keep(s: str) -> str:
        stash.append(s)
        return _PLACEHOLDER.format(len(stash) - 1)

    # 1. 先处理反斜杠转义（cards._md 就是这么转的），否则 ** 会被误当语法
    out = re.sub(r"\\([*_`~\\])", lambda m: keep(html.escape(m.group(1))), text)

    # 2. <font color='grey'>..</font> —— 飞书允许的内联颜色
    def font_sub(m: re.Match) -> str:
        color = m.group(1).strip().strip("'\"")
        css = {"grey": "var(--muted)", "gray": "var(--muted)",
               "red": "#d83931", "green": "#2ea121", "blue": "#3370ff"}.get(color, color)
        return keep(f'<span style="color:{css}">{html.escape(m.group(2))}</span>')

    out = re.sub(r"<font\s+color=['\"]([^'\"]+)['\"]\s*>(.*?)</font>",
                 font_sub, out, flags=re.S)

    # 3. 普通文本转义（先把已有的占位符和 <br> 保护起来）
    out = html.escape(out)
    out = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", out, flags=re.S)
    out = re.sub(r"`([^`]+?)`", r"<code>\1</code>", out)
    out = out.replace("\n", "<br>")

    # 4. 还原占位符
    def restore(m: re.Match) -> str:
        return stash[int(m.group(1))]

    return re.sub(r"\x00ESC(\d+)\x00", restore, out)


# ------------------------------------------------------------------ 卡片渲染

def render_element(el: dict) -> str:
    tag = el.get("tag")

    if tag == "markdown":
        style = ""
        margin = el.get("margin")
        if margin:
            style = f' style="margin:{margin}"'      # 别去空格：`2px 0px` 去掉就成非法值了
        return f'<div class="md"{style}>{render_md(el.get("content", ""))}</div>'

    if tag == "hr":
        m = el.get("margin", "12px 0px")
        return f'<hr style="margin:{m}">'

    if tag == "button":
        t = el.get("type", "default")
        size = el.get("size", "medium")
        label = html.escape((el.get("text") or {}).get("content", ""))
        val = {}
        for beh in el.get("behaviors", []):
            if beh.get("type") == "callback":
                val = beh.get("value") or {}
        disabled = " disabled" if el.get("disabled") else ""
        # data-* 给下面的 JS 用，点了真的换页
        attrs = " ".join(
            f'data-{k}="{html.escape(str(v))}"' for k, v in val.items()
        )
        return (f'<button class="btn btn-{t} btn-{size}"{disabled} {attrs}>'
                f'{label}</button>')

    if tag == "column_set":
        cols = el.get("columns", [])
        flex = el.get("flex_mode", "flow")
        cls = "colset flow" if flex == "flow" else "colset"
        inner = "".join(render_column(c) for c in cols)
        return f'<div class="{cls}">{inner}</div>'

    if tag == "div":
        return f'<div class="div">{"".join(render_element(e) for e in el.get("elements", []))}</div>'

    if tag == "note":
        return f'<div class="note">{"".join(render_element(e) for e in el.get("elements", []))}</div>'

    return f'<div class="unknown">[未支持的组件: {html.escape(str(tag))}]</div>'


def render_column(col: dict) -> str:
    els = col.get("elements", [])
    # 只放按钮的列不参与伸展，否则「打开」按钮会被拉得很宽
    only_buttons = bool(els) and all(e.get("tag") == "button" for e in els)
    weight = col.get("weight", 1)
    style = "flex:0 0 auto" if only_buttons else f"flex:{weight} 1 0;min-width:0"
    return f'<div class="col" style="{style}">{"".join(render_element(e) for e in els)}</div>'


def render_card(card: dict) -> str:
    hdr = card.get("header") or {}
    title = html.escape((hdr.get("title") or {}).get("content", ""))
    sub = html.escape((hdr.get("subtitle") or {}).get("content", ""))
    tmpl = hdr.get("template", "blue")
    sub_html = f'<div class="hdr-sub">{sub}</div>' if sub else ""
    body = "".join(render_element(e) for e in (card.get("body") or {}).get("elements", []))
    return (f'<div class="card"><div class="hdr hdr-{tmpl}">{title}{sub_html}</div>'
            f'<div class="body">{body}</div></div>')


# ------------------------------------------------------------------ 生成

CSS = """
:root{
  --bg:#f2f3f5; --card:#ffffff; --text:#1f2329; --muted:#8f959e;
  --line:#e5e6eb; --primary:#3370ff; --danger:#f54a45;
  --code-bg:#f5f6f7; --shadow:0 1px 3px rgba(0,0,0,.06);
}
*{box-sizing:border-box}
body{
  margin:0; padding:28px 16px 60px; background:var(--bg); color:var(--text);
  font:14px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
}
.wrap{max-width:1180px;margin:0 auto;display:flex;gap:28px;align-items:flex-start}
.left{flex:1;min-width:0}
.right{width:420px;flex:0 0 420px;position:sticky;top:28px}
h1{font-size:19px;margin:0 0 4px}
.lede{color:var(--muted);font-size:13px;margin:0 0 20px}
h2{font-size:13px;color:var(--muted);font-weight:600;letter-spacing:.06em;
   text-transform:uppercase;margin:22px 0 10px}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:8px;
      overflow:hidden;box-shadow:var(--shadow);font-size:13px}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line)}
th{background:#fafafa;color:var(--muted);font-weight:600;font-size:12px}
tr:last-child td{border-bottom:none}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:1px 7px;border-radius:9px;font-size:11px;
      background:#eef0f3;color:#5f6672}
.pill.you{background:#fff3e0;color:#b25e00}
.pill.err{background:#ffece8;color:#c92a2a}
.pill.run{background:#e6f4ea;color:#1a7f37}

/* 手机外壳，尽量贴近飞书移动端的观感 */
.phone{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.10);
       overflow:hidden;border:1px solid var(--line)}
.phone-bar{background:#fafafa;border-bottom:1px solid var(--line);padding:9px 14px;
           font-size:12px;color:var(--muted);display:flex;justify-content:space-between}
.phone-bar b{color:var(--text);font-weight:600}

.card{background:var(--card)}
.hdr{padding:13px 16px;color:#fff;font-size:16px;font-weight:600;line-height:1.35}
.hdr-sub{font-size:12px;font-weight:400;opacity:.85;margin-top:3px}
.hdr-blue{background:linear-gradient(135deg,#3370ff,#245bdb)}
.hdr-orange{background:linear-gradient(135deg,#ff8800,#e06f00)}
.hdr-red{background:linear-gradient(135deg,#f54a45,#d92c26)}
.hdr-green{background:linear-gradient(135deg,#2ea121,#1f7a15)}
.hdr-grey{background:linear-gradient(135deg,#8f959e,#6f757d)}
.body{padding:12px 14px 16px}
.md{font-size:13.5px;line-height:1.6;word-break:break-word}
.md code{background:var(--code-bg);border-radius:3px;padding:1px 5px;
         font:12px/1.4 "Cascadia Mono",Consolas,monospace}
.md b{font-weight:600}
hr{border:none;border-top:1px solid var(--line);margin:12px 0}
.colset{display:flex;gap:8px;align-items:center}
.colset.flow{flex-wrap:wrap;margin:-3px 0}
.col{display:flex;gap:6px;align-items:center;min-width:0}
.col > .md{flex:1;min-width:0}
.div{padding:2px 0}
.note{font-size:12px;color:var(--muted)}
.unknown{color:var(--danger);font-size:12px;font-family:monospace}
.btn{border:1px solid var(--line);background:#fff;color:var(--text);cursor:pointer;
     border-radius:5px;padding:5px 11px;font-size:12.5px;line-height:1.2;
     font-family:inherit;white-space:nowrap;transition:background .12s}
.btn:hover:not(:disabled){background:#f5f6f7}
.btn:disabled{opacity:.42;cursor:not-allowed}
.btn-tiny{padding:3px 9px;font-size:11.5px}
.btn-small{padding:5px 11px}
.btn-large{padding:8px 16px;font-size:14px}
.btn-primary{background:var(--primary);border-color:var(--primary);color:#fff}
.btn-primary:hover:not(:disabled){background:#245bdb}
.btn-danger{background:var(--danger);border-color:var(--danger);color:#fff}
.btn-text,.btn-primary_text,.btn-danger_text{background:none;border-color:transparent;color:var(--primary)}
.btn-primary_text{color:var(--primary)}
.btn-danger_text{color:var(--danger)}
.btn-primary_filled{background:#e1eaff;border-color:#e1eaff;color:var(--primary)}
.btn-danger_filled{background:#ffece8;border-color:#ffece8;color:var(--danger)}
.btn-laser{background:linear-gradient(135deg,#7b61ff,#3370ff);border:none;color:#fff}
.raw{background:#1f2329;color:#d6dae0;border-radius:8px;padding:14px;overflow:auto;
     max-height:520px;font:12px/1.5 "Cascadia Mono",Consolas,monospace;margin-top:10px}
.warn{background:#fff8e6;border:1px solid #ffe1a8;border-radius:8px;padding:11px 13px;
      font-size:13px;margin-bottom:18px}
.warn b{color:#b25e00}
"""

JS = """
const CARDS = %(cards)s;
const META  = %(meta)s;
let state = {filter:"active", page:0};

function paint(){
  const key = state.filter + "|" + state.page;
  const c = CARDS[key] || CARDS[state.filter + "|0"];
  if(!c){ return; }
  document.getElementById("screen").innerHTML = c;
  document.getElementById("nowfilter").textContent = state.filter;
  document.getElementById("nowpage").textContent = state.page;
}

document.addEventListener("click", (ev)=>{
  const b = ev.target.closest("button[data-cmd]");
  if(!b || b.disabled) return;
  const cmd = b.dataset.cmd;
  if(cmd === "filter"){ state.filter = b.dataset.key || "active"; state.page = 0; }
  else if(cmd === "page"){ state.page = Math.max(0, parseInt(b.dataset.page||"0",10)); }
  else if(cmd === "refresh"){ flash("飞书里这里会真的重扫；预览里是本地重画"); }
  else if(cmd === "open"){
    flash("真机上是：Windows Terminal 打开 " + (b.dataset.cli||"") + " 会话 " + (b.dataset.sid||""));
  }
  paint();
});

function flash(msg){
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(window._tt);
  window._tt = setTimeout(()=>t.classList.remove("show"), 2600);
}

paint();
"""


def build(out_path: str) -> str:
    snap = build_snapshot()
    print(f"扫到 {snap.total} 场会话 · 存活进程 {snap.live_procs}")

    # 把每个 (筛选, 页) 组合都预渲染好，预览里点按钮就是本地换页，不用起服务
    all_keys = [k for k, _ in cards.FILTERS]
    payload: dict[str, str] = {}
    meta: dict[str, dict] = {}

    for key in all_keys:
        rows = filter_sessions(snap, key)
        pages = max(1, (len(rows) + cards.PAGE_SIZE - 1) // cards.PAGE_SIZE)
        meta[key] = {"rows": len(rows), "pages": pages}
        for p in range(pages):
            card = cards.build_panel(snap, key, p)
            payload[f"{key}|{p}"] = render_card(card)

    size_kb = cards.card_size_kb(cards.build_panel(snap, "all", 0))

    # 概览表
    rows_html = []
    for key, label in cards.FILTERS:
        m = meta[key]
        rows_html.append(
            f"<tr><td>{html.escape(label)}</td><td><code>{key}</code></td>"
            f"<td class='num'>{m['rows']}</td><td class='num'>{m['pages']}</td></tr>"
        )
    by_cli = " ".join(
        f"<span class='pill'>{html.escape(k)} {v}</span>"
        for k, v in sorted(snap.counts_by_cli.items(), key=lambda x: -x[1])
    )
    status_html = []
    for st in ("needs-you", "error", "running", "idle", "done", "ended"):
        n = snap.counts_by_status.get(st, 0)
        if not n:
            continue
        cls = {"needs-you": "you", "error": "err", "running": "run"}.get(st, "")
        status_html.append(f"<span class='pill {cls}'>{st} {n}</span>")

    raw = json.dumps(cards.build_panel(snap, "active", 0), ensure_ascii=False, indent=1)

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grok Build Pager · 飞书卡片预览</title>
<style>{CSS}</style></head>
<body><div class="wrap">

<div class="left">
  <h1>Grok Build Pager · 飞书卡片预览</h1>
  <p class="lede">右侧是 <code>cards.build_panel()</code> 真实输出的渲染，按钮可以点。</p>

  <div class="warn">
    <b>这是本地预览，没有连飞书。</b>目的是先把「长什么样、点了对不对」确认掉，
    再去配开发者后台。这样一旦真机上出问题，就能确定是后台配置的锅，不是代码的锅。
  </div>

  <h2>本机现状</h2>
  <table>
    <tr><th>维度</th><th>值</th></tr>
    <tr><td>会话总数</td><td><b>{snap.total}</b></td></tr>
    <tr><td>按 CLI</td><td>{by_cli}</td></tr>
    <tr><td>按状态</td><td>{" ".join(status_html)}</td></tr>
    <tr><td>存活进程</td><td>{snap.live_procs}</td></tr>
    <tr><td>卡片体积</td><td>{size_kb:.2f} KB <span class="pill">上限 30 KB</span></td></tr>
  </table>

  <h2>筛选与分页</h2>
  <table>
    <tr><th>筛选</th><th>key</th><th class="num">会话数</th><th class="num">页数</th></tr>
    {"".join(rows_html)}
  </table>

  <h2>当前卡片 JSON（筛选 active · 第 1 页）</h2>
  <pre class="raw">{html.escape(raw)}</pre>
</div>

<div class="right">
  <div class="phone">
    <div class="phone-bar">
      <span>Grok Build Pager</span>
      <span>筛选 <b id="nowfilter">active</b> · 第 <b id="nowpage">0</b> 页</span>
    </div>
    <div id="screen"></div>
  </div>
  <div id="toast" class="phone-bar" style="margin-top:10px;border:1px solid var(--line);
       border-radius:8px;opacity:0;transition:opacity .2s;justify-content:center"></div>
</div>

</div>
<style>
#toast.show{{opacity:1}}
#toast{{font-size:12px;color:var(--text);text-align:center}}
</style>
<script>{JS % {"cards": json.dumps(payload, ensure_ascii=False), "meta": json.dumps(meta, ensure_ascii=False)}}</script>
</body></html>
"""

    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(doc)
    kb = os.path.getsize(out_path) / 1024
    print(f"已生成 {out_path}（{kb:.0f} KB，{len(payload)} 个页面组合）")
    return out_path


def main() -> int:
    ap = argparse.ArgumentParser(description="渲染飞书卡片为可点的 HTML 预览")
    ap.add_argument("--out", default=os.path.join(ROOT, "card-preview.html"))
    args = ap.parse_args()
    build(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
