#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线 HTML 报告 —— 把整个会话库摊开成一页。

设计约束（见 docs/brand.md）：
  - **一张图里只有一颗灯是亮的**。珊瑚色 `#FF6B4A` 只给「正在跑」用，
    其余一切（包括代码漂移这种警示）都走中性灰 + 细边线，不抢那颗灯。
  - 零外部依赖：不引 CDN、不引字体。断网、离线、丢进邮件附件里都能看。
  - 跟随系统深浅色（`prefers-color-scheme`）。

为什么不直接用飞书卡片：卡片的 30 KB 上限塞不下 50 场会话，
而「管理」这个动作天然需要**全局视角**。卡片适合「现在哪场在等你」，
HTML 适合「我这两个月在哪些项目上干了什么」。
"""

from __future__ import annotations

import html
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from feishu_hub import groksessions as gs  # noqa: E402

CORAL = "#FF6B4A"

CSS = """
*{box-sizing:border-box}
:root{
  --bg:#F5F6F8; --panel:#FFFFFF; --line:#E3E6EB; --line-soft:#EDF0F4;
  --fg:#151A22; --fg-dim:#5C6672; --fg-faint:#8B95A3;
  --coral:#FF6B4A; --coral-dim:#FFF1ED; --coral-line:#FFD5C9;
  --warn:#B4741A; --warn-bg:#FFF8EC; --warn-line:#F0DCB4;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0B0E13; --panel:#141922; --line:#242B37; --line-soft:#1C222C;
    --fg:#E8ECF2; --fg-dim:#9AA5B4; --fg-faint:#6B7684;
    --coral:#FF6B4A; --coral-dim:#2A1A16; --coral-line:#5A2E24;
    --warn:#E0A958; --warn-bg:#231C11; --warn-line:#4A3A1E;
  }
}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg)}
body{
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",
       "Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1120px;margin:0 auto;padding:40px 24px 80px}

/* ---- 铭牌 ---- */
.plate{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding-bottom:20px;border-bottom:1px solid var(--line)}
.mark{width:44px;height:44px;flex:0 0 auto}
.plate .name{display:flex;flex-direction:column;gap:2px}
.plate .kicker{font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:.22em;color:var(--fg-faint);text-transform:uppercase}
.plate h1{margin:0;font-size:23px;font-weight:650;letter-spacing:-.3px}
.plate .sub{margin-left:auto;font-size:12.5px;color:var(--fg-faint);
  text-align:right;line-height:1.5}

/* ---- 统计 ---- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));
  gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;
  overflow:hidden;margin:24px 0}
.stat{background:var(--panel);padding:14px 16px}
.stat b{display:block;font-size:22px;font-weight:650;letter-spacing:-.5px;
  font-variant-numeric:tabular-nums}
.stat span{font-size:11.5px;color:var(--fg-faint);letter-spacing:.04em}
.stat.lit b{color:var(--coral)}

/* ---- 检索 ---- */
.tools{display:flex;gap:10px;margin:0 0 26px;align-items:center}
#q{flex:1;padding:9px 13px;border:1px solid var(--line);border-radius:8px;
  background:var(--panel);color:var(--fg);font-size:13.5px;outline:none}
#q:focus{border-color:var(--coral);box-shadow:0 0 0 3px var(--coral-dim)}
#q::placeholder{color:var(--fg-faint)}
.count{font-size:12px;color:var(--fg-faint);white-space:nowrap;
  font-variant-numeric:tabular-nums}

/* ---- 项目分组 ---- */
.proj{margin:0 0 30px}
.proj>h2{margin:0 0 10px;font-size:12.5px;font-weight:600;color:var(--fg-dim);
  display:flex;align-items:center;gap:9px;letter-spacing:.02em}
.proj>h2 .path{font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--fg-faint);font-weight:400;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.proj>h2 .n{flex:0 0 auto;font:11px ui-monospace,Menlo,monospace;
  color:var(--fg-faint);background:var(--line-soft);
  border-radius:20px;padding:1px 8px}

/* ---- 会话卡 ---- */
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:13px 15px;margin-bottom:8px;border-left:3px solid transparent}
.card.live{border-left-color:var(--coral)}
.card.hidden{display:none}
.row1{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.lamp{flex:0 0 auto;width:8px;height:8px;border-radius:50%;
  background:var(--line);margin-right:1px}
.card.live .lamp{background:var(--coral);
  box-shadow:0 0 0 3px var(--coral-dim)}
.card .title{font-size:14.5px;font-weight:600;letter-spacing:-.1px}
.card .sid{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--fg-faint)}
.card .when{margin-left:auto;font-size:12px;color:var(--fg-faint);
  white-space:nowrap}
.meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:7px}
.tag{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--fg-dim);background:var(--line-soft);border-radius:5px;
  padding:1.5px 7px}
.tag.live{color:var(--coral);background:var(--coral-dim)}
.tag.big{color:var(--warn);background:var(--warn-bg)}
.recap{margin-top:9px;font-size:13px;color:var(--fg-dim);line-height:1.62}
.recap b{color:var(--fg-dim);font-weight:600}
.recap p{margin:3px 0 0}
.warn{margin-top:9px;font-size:12.5px;color:var(--warn);
  background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:7px;
  padding:7px 10px;line-height:1.55}
.cmd{margin-top:9px;display:flex;align-items:center;gap:8px}
.cmd code{flex:1;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--fg-dim);background:var(--bg);border:1px solid var(--line-soft);
  border-radius:6px;padding:5px 9px;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.cmd button{flex:0 0 auto;font-size:11.5px;padding:5px 11px;border-radius:6px;
  border:1px solid var(--line);background:var(--panel);color:var(--fg-dim);
  cursor:pointer}
.cmd button:hover{border-color:var(--coral);color:var(--coral)}
.empty{color:var(--fg-faint);font-size:13px;padding:30px 0;text-align:center}

footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);
  font-size:11.5px;color:var(--fg-faint);display:flex;gap:14px;flex-wrap:wrap}
footer a{color:var(--fg-dim)}
"""

JS = """
const box = document.getElementById('q');
const cards = [...document.querySelectorAll('.card')];
const projs = [...document.querySelectorAll('.proj')];
const count = document.getElementById('count');
box.addEventListener('input', () => {
  const q = box.value.trim().toLowerCase();
  let shown = 0;
  cards.forEach(c => {
    const hit = !q || c.dataset.hay.includes(q);
    c.classList.toggle('hidden', !hit);
    if (hit) shown++;
  });
  projs.forEach(p => {
    const any = [...p.querySelectorAll('.card')].some(c => !c.classList.contains('hidden'));
    p.classList.toggle('hidden', !any);
  });
  count.textContent = q ? `${shown} / ${cards.length}` : `${cards.length} 场`;
});
document.querySelectorAll('.cmd button').forEach(b => {
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.cmd); b.textContent = '已复制'; }
    catch (e) { b.textContent = '复制失败'; }
    setTimeout(() => b.textContent = '复制', 1200);
  });
});
"""

MARK_SVG = (
    '<svg class="mark" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">'
    '<rect x="3" y="3" width="42" height="42" rx="11" fill="#1B2230"/>'
    '<rect x="13" y="30" width="22" height="5" rx="2.5" fill="#4A5568"/>'
    '<rect x="13" y="22" width="14" height="5" rx="2.5" fill="#4A5568"/>'
    f'<circle cx="33.5" cy="15.5" r="4.5" fill="{CORAL}"/>'
    f'<circle cx="33.5" cy="15.5" r="9" fill="{CORAL}" opacity="0.22"/>'
    "</svg>"
)


def _e(text: str) -> str:
    return html.escape(text or "", quote=True)


def _hay(s: gs.GrokSession) -> str:
    return _e("\n".join([s.title, s.recap, s.last_turn, s.cwd, s.model, s.agent,
                         " ".join(s.git_remotes), s.sid]).lower())


def _card(s: gs.GrokSession) -> str:
    d = gs.drift(s)
    tags: list[str] = []
    if s.live:
        tags.append(f'<span class="tag live">🟠 在跑 · pid {s.live_pid}</span>')
    if s.model:
        tags.append(f'<span class="tag">{_e(s.model)}</span>')
    if s.agent:
        tags.append(f'<span class="tag">{_e(s.agent)}</span>')
    tags.append(f'<span class="tag{" big" if s.weight != "light" else ""}">'
                f'{s.size_label} · {s.num_chat_messages} 轮</span>')
    if s.body_bytes == 0:
        tags.append('<span class="tag">空会话</span>')
    if s.head_branch or s.head_commit:
        tags.append(f'<span class="tag">{_e(s.head_branch or "?")} @ '
                    f'{_e(s.head_commit[:8] or "?")}</span>')

    body: list[str] = []
    if s.last_turn:
        body.append(f"<p><b>上次做到哪</b>　{_e(s.last_turn)}</p>")
    if s.recap:
        body.append(f"<p><b>会话回顾</b>　{_e(s.recap)}</p>")
    recap = f'<div class="recap">{"".join(body)}</div>' if body else ""

    warn = ""
    if d.state == "moved":
        warn = f'<div class="warn">⚠️ {_e(d.note)}</div>'
    elif d.state == "missing-repo":
        warn = f'<div class="warn">⚠️ {_e(d.note)}</div>'
    elif s.resume_cost:
        warn = f'<div class="warn">⚠️ {_e(s.resume_cost)}</div>'

    cmd = f'grok --cwd "{s.cwd}" -r {s.sid}'
    cmd_html = (
        '<div class="cmd"><code>' + _e(cmd) + '</code>'
        f'<button data-cmd="{_e(cmd)}">复制</button></div>'
    )

    return (
        f'<div class="card{" live" if s.live else ""}" data-hay="{_hay(s)}">'
        '<div class="row1">'
        '<span class="lamp"></span>'
        f'<span class="title">{_e(s.title)}</span>'
        f'<span class="sid">{_e(s.sid8)}</span>'
        f'<span class="when">{_e(s.active_str)}</span>'
        "</div>"
        f'<div class="meta">{"".join(tags)}</div>'
        f"{recap}{warn}{cmd_html}"
        "</div>"
    )


def render(rows: list[gs.GrokSession], *, title: str = "Grok Build 会话管理台") -> str:
    rows = sorted(rows, key=lambda s: (not s.live, -(s.active_ts or 0)))
    now = datetime.now(timezone.utc).astimezone()
    live = [s for s in rows if s.live]
    projects = gs.group_by_project(rows)
    non_empty = [s for s in rows if s.body_bytes > 0]
    drifted = [s for s in non_empty if gs.drift(s).state == "moved"]

    stats = [
        (len(rows), "场会话", False),
        (len(projects), "个项目", False),
        (len(live), "场正在跑", True),
        (len(drifted), "场代码已变动", False),
    ]
    stat_html = "".join(
        f'<div class="stat{" lit" if lit else ""}"><b>{n}</b><span>{label}</span></div>'
        for n, label, lit in stats
    )

    groups: list[str] = []
    for cwd, items in projects.items():
        name = os.path.basename(cwd.rstrip("\\/")) or cwd
        cards = "".join(_card(s) for s in items)
        groups.append(
            '<section class="proj">'
            f'<h2><span>{_e(name)}</span>'
            f'<span class="path">{_e(cwd)}</span>'
            f'<span class="n">{len(items)}</span></h2>'
            f"{cards}</section>"
        )

    parts = [
        "<!DOCTYPE html>",
        '<html lang="zh-CN"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        f"<title>{_e(title)}</title>",
        f"<style>{CSS}</style>",
        "</head><body><div class='wrap'>",
        '<header class="plate">',
        MARK_SVG,
        '<div class="name"><span class="kicker">Grok Build</span>',
        "<h1>会话面板</h1></div>",
        f'<div class="sub">共 {len(rows)} 场 · 覆盖 {len(projects)} 个项目<br>'
        f'生成于 {now.strftime("%Y-%m-%d %H:%M")}</div>',
        "</header>",
        f'<div class="stats">{stat_html}</div>',
        '<div class="tools">'
        '<input id="q" placeholder="搜标题 / 回顾 / 目录 / 模型 / 仓库…" autocomplete="off">'
        f'<span class="count" id="count">{len(rows)} 场</span>'
        "</div>",
        *groups,
        f'<footer><span>{_e(title)}</span>'
        "<span>数据来自 <code>~/.grok/sessions</code>，只读</span>"
        "<span>珊瑚色只属于正在运行的那一场</span>"
        "<span>要搜对话正文（跨 4 家 CLI）用 "
        "<code>feishu_hub.scan --out session-history.html</code></span></footer>",
        "</div>",
        f"<script>{JS}</script>",
        "</body></html>",
    ]
    return "\n".join(parts)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "sessions.html"
    data = gs.load_all()
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(render(data))
    print(f"已写出 {out}：{len(data)} 场会话，{len(gs.group_by_project(data))} 个项目")
