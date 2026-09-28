#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
会话命令行 —— Grok Build 会话的管理 / 继承 / 恢复。

    python tools/sessions.py                       # 最近 20 场（跨全部项目）
    python tools/sessions.py list -n 50 --project 小程序
    python tools/sessions.py search 云函数 部署
    python tools/sessions.py show Jev             # id 前缀 / 标题都认
    python tools/sessions.py recover Jev          # 恢复前体检：能不能跑、要等多久、代码变没变
    python tools/sessions.py resume Jev           # 恢复（交互式 TUI）
    python tools/sessions.py fork Jev             # 分叉：新 id，原会话不动
    python tools/sessions.py handoff Jev --ask "把登录云函数补完"
    python tools/sessions.py restore-code Jev     # 连代码快照一起恢复（自动挂新 worktree）
    python tools/sessions.py drift                # 全量代码漂移巡检
    python tools/sessions.py html -o sessions.html

**默认什么都只打印不执行**，真开终端要显式加 `--go`。
所有会开进程的子命令都支持 `--dry` 先看 argv。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from feishu_hub import groksessions as gs  # noqa: E402


# ---------------------------------------------------------------- 辅助

def pick_one(rows: list[gs.GrokSession], token: str) -> gs.GrokSession | None:
    """认一场会话；认不出来时把「撞上了哪几场」打出来，而不是干说一句找不到。"""
    s = gs.resolve(rows, token)
    if s:
        return s
    near = gs.ambiguous(rows, token)
    if near:
        print(f"「{token}」不唯一，撞上 {len(near)} 场。请用更长的 id 前缀：")
        for n in near[:12]:
            print(f"  {n.sid8}  {n.title[:46]}  @ {n.project}")
    else:
        print(f"找不到「{token}」。用 `list` 看看有哪些，或 `search <关键词>`。")
    return None


def launch_terminal(argv: list[str], cwd: str) -> tuple[bool, str]:
    """开一个终端窗口跑 argv —— 因为 grok 不带 `-p` 时是**交互式 TUI**，
    必须在真终端里跑。用 `cmd /k` 让窗口在命令结束后不立刻消失。

    Windows Terminal 优先（能复用同一窗口开标签）；没有就退回 `cmd /c start`。
    """
    cmdline = subprocess.list2cmdline(argv)
    wt = shutil.which("wt")
    try:
        if wt:
            # wt 的 `;` 必须是独立 argv 元素，不能拼进字符串里
            subprocess.Popen([wt, "-d", cwd, "cmd", "/k", cmdline])
        else:
            subprocess.Popen(["cmd", "/c", "start", "", "cmd", "/k", cmdline], cwd=cwd)
    except OSError as exc:
        return False, f"开终端失败：{exc}"
    return True, f"已在 {cwd} 打开终端"


def force_utf8() -> None:
    """Windows 控制台默认 GBK，打印 🟠 / └ 会直接 UnicodeEncodeError 把命令搞崩。
    中文 Windows 上必须显式切到 UTF-8。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


# ---------------------------------------------------------------- 子命令

def cmd_list(rows, a) -> int:
    data = rows
    if a.project:
        needle = a.project.lower()
        data = [s for s in data if needle in (s.cwd or "").lower()
                or needle in (s.title or "").lower()]
    if a.model:
        data = [s for s in data if a.model.lower() in (s.model or "").lower()]
    if a.live:
        data = [s for s in data if s.live]
    if a.since:
        data = [s for s in data if s.active_ts >= a.since]
    if a.empty:
        data = [s for s in data if s.body_bytes == 0]
    if a.not_empty:
        data = [s for s in data if s.body_bytes > 0]
    data.sort(key=lambda s: (not s.live, -(s.active_ts or 0)))
    print(gs.render_list(data, show_recap=a.recap, limit=a.n, total=len(rows)))
    return 0


def cmd_search(rows, a) -> int:
    hits = gs.search(rows, " ".join(a.query), limit=a.n)
    if not hits:
        print(f"没搜到「{' '.join(a.query)}」。")
        print("提示：多个词是「都要命中」，拆开搜或减少词数试试。")
        return 1
    print(gs.render_list(hits, show_recap=True, total=len(rows)))
    return 0


def cmd_show(rows, a) -> int:
    s = pick_one(rows, a.token)
    if not s:
        return 1
    print(gs.render_detail(s))
    return 0


def cmd_recover(rows, a) -> int:
    """恢复前体检。**这是本工具最该被用的一条** —— 在按「继续」之前，
    把「跑不了 / 要等十几分钟 / 代码已经变了」三件事说清楚。"""
    s = pick_one(rows, a.token)
    if not s:
        return 1
    r = gs.preflight(s)
    print(gs.render_detail(s))
    print()
    if not r.runnable:
        print("✗ 现在跑不了：")
        for b in r.blockers:
            print(f"    {b}")
        return 1
    print("✓ 可以恢复")
    if r.cost_note:
        print(f"    {r.cost_note}")
    if r.warnings:
        print("  注意：")
        for w in r.warnings:
            print(f"    {w}")
    print()
    print("  建议：")
    if s.weight == "huge":
        print(f"    这场会话 {s.size_label}，直接 -r 可能要等十几分钟。")
        print(f"    更快的路：python tools/sessions.py handoff {s.sid8} --ask \"...\"")
    if r.drift.state == "moved":
        print(f"    代码已在会话之后变动 —— 想回到当时的代码请用：")
        print(f"      python tools/sessions.py restore-code {s.sid8}")
    if s.live:
        print(f"    会话正开着，想岔开试新方向请用：")
        print(f"      python tools/sessions.py fork {s.sid8}")
    return 0


def _run_or_show(argv: list[str], cwd: str, a) -> int:
    print(f"  目录 {cwd}")
    print(f"  命令 {subprocess.list2cmdline(argv)}")
    if a.dry or not a.go:
        if not a.dry:
            print("  （没有真执行 —— 加 --go 才开终端）")
        return 0
    ok, msg = launch_terminal(argv, cwd)
    print(f"  {'✓' if ok else '✗'} {msg}")
    return 0 if ok else 1


def cmd_resume(rows, a) -> int:
    s = pick_one(rows, a.token)
    if not s:
        return 1
    r = gs.preflight(s)
    if not r.runnable:
        for b in r.blockers:
            print(f"✗ {b}")
        return 1
    argv = gs.resume_argv(s, fork=a.fork, fork_sid=gs.fork_sid() if a.fork else "",
                          auto_approve=a.approve)
    print("恢复对话（交互式）：" if not a.fork else "分叉出一场新会话（原会话不动）：")
    return _run_or_show(argv, s.cwd, a)


def cmd_handoff(rows, a) -> int:
    """**继承**：把旧会话压成一段接续提示词，喂给一场全新会话。

    这条路的真正价值在大会话上 —— `-r` 恢复要重放历史（1.5 MB → 十几分钟），
    新会话吃 recao 是秒开。对 huge 会话，这是唯一实用的恢复姿势。
    """
    s = pick_one(rows, a.token)
    if not s:
        return 1
    prompt = gs.handoff_prompt(s, ask=a.ask or "", include_git=not a.no_git,
                               include_recap=not a.no_recap)
    if a.print_prompt:
        print(prompt)
        return 0
    if not a.ask:
        print("提示：没给 --ask，接续后会先让 AI 复述理解再等你确认（更安全）。")
        print("      想直接布置任务：--ask \"把登录云函数补完\"")
        print()
    argv = gs.new_session_argv(s, prompt, model=a.model, agent=a.agent,
                               auto_approve=a.approve)
    print(f"接续到新会话（对话 {s.num_chat_messages} 轮 → 一段 {len(prompt)} 字提示词）：")
    print(f"  省掉的历史重放：{s.size_label}")
    return _run_or_show(argv, s.cwd, a)


def cmd_restore_code(rows, a) -> int:
    s = pick_one(rows, a.token)
    if not s:
        return 1
    if not s.head_commit:
        print("这场会话没记录 git 状态，没法恢复代码快照。")
        return 1
    d = gs.drift(s)
    print(f"会话记录的提交：{s.head_branch or '?'} @ {s.head_commit[:8]}")
    print(f"现在的仓库：  {d.note}")
    print()
    print("会新开一个 worktree 把当时的代码铺进去 —— **不会动你当前目录**。")
    argv = gs.restore_argv(s)
    return _run_or_show(argv, s.cwd, a)


def cmd_drift(rows, a) -> int:
    """全量代码漂移巡检：哪些会话的记忆已经跟代码对不上了。"""
    checked = [s for s in rows if s.body_bytes > 0]
    buckets: dict[str, list[gs.GrokSession]] = {}
    for s in checked:
        buckets.setdefault(gs.drift(s).state, []).append(s)
    order = [("moved", "代码已变动 —— 恢复前要留个心眼"),
             ("missing-repo", "仓库目录已不存在"),
             ("no-repo", "工作目录还在但已不是 git 仓库"),
             ("clean", "代码没动过"),
             ("unknown", "没有 git 信息")]
    for key, label in order:
        group = buckets.get(key) or []
        if not group:
            continue
        print(f"\n【{label}】{len(group)} 场")
        for s in group[:a.n]:
            note = gs.drift(s).note if key != "clean" else ""
            print(f"  {s.sid8}  {s.title[:40]:<42}@ {s.project}")
            if note:
                print(f"            {note}")
        if len(group) > a.n:
            print(f"  … 另有 {len(group) - a.n} 场")
    total = sum(len(v) for v in buckets.values())
    print(f"\n巡检 {total} 场（跳过 {len(rows) - len(checked)} 场空会话）")
    return 0


def cmd_html(rows, a) -> int:
    from tools import sessions_html  # noqa: WPS433  延迟导入，纯文本用户不必加载
    html = sessions_html.render(rows, title=a.title)
    out = a.output or os.path.join(os.getcwd(), "sessions.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    print(f"已写出 {out}（{len(html) / 1024:.0f} KB，{len(rows)} 场会话）")
    return 0


# ---------------------------------------------------------------- 入口

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="sessions",
        description="Grok Build 会话管理 / 继承 / 恢复",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = ap.add_subparsers(dest="cmd")

    def add_open_flags(p):
        p.add_argument("--go", action="store_true", help="真的开终端（默认只打印）")
        p.add_argument("--dry", action="store_true", help="只打印 argv")

    p = sub.add_parser("list", aliases=["ls"], help="列会话")
    p.add_argument("-n", type=int, default=20)
    p.add_argument("--project", help="按目录/标题子串筛")
    p.add_argument("--model")
    p.add_argument("--live", action="store_true", help="只看正在运行的")
    p.add_argument("--since", type=float, default=0,
                   help="只要这么多秒内活跃过的（如 --since 86400 = 一天内）")
    p.add_argument("--empty", action="store_true", help="只看空会话")
    p.add_argument("--not-empty", action="store_true", help="滤掉空会话")
    p.add_argument("--recap", action="store_true", help="第二行显示接续摘要")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("search", help="全文检索（标题/recap/路径/模型/仓库）")
    p.add_argument("query", nargs="+")
    p.add_argument("-n", type=int, default=40)
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("show", help="看一场会话的详情")
    p.add_argument("token", help="完整 id / id 前缀 / 标题")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("recover", aliases=["check"], help="恢复前体检（推荐先用这个）")
    p.add_argument("token")
    p.set_defaults(fn=cmd_recover)

    p = sub.add_parser("resume", help="恢复会话（开交互式终端）")
    p.add_argument("token")
    p.add_argument("--fork", action="store_true",
                   help="分叉成新会话（新 id，原会话不受影响）")
    p.add_argument("--approve", action="store_true", help="追加 --always-approve")
    add_open_flags(p)
    p.set_defaults(fn=cmd_resume)

    p = sub.add_parser("fork", help="= resume --fork")
    p.add_argument("token")
    p.add_argument("--approve", action="store_true")
    add_open_flags(p)
    p.set_defaults(fn=cmd_resume, fork=True)

    p = sub.add_parser("handoff", help="继承：压成接续提示词，喂给一场新会话")
    p.add_argument("token")
    p.add_argument("--ask", default="", help="接续后要做什么")
    p.add_argument("--model", default="", help="新会话换模型（如 grok-4.7）")
    p.add_argument("--agent", default="")
    p.add_argument("--no-git", action="store_true")
    p.add_argument("--no-recap", action="store_true")
    p.add_argument("--print-prompt", action="store_true", help="只打印提示词")
    p.add_argument("--approve", action="store_true")
    add_open_flags(p)
    p.set_defaults(fn=cmd_handoff)

    p = sub.add_parser("restore-code", help="连代码快照一起恢复（自动挂新 worktree）")
    p.add_argument("token")
    add_open_flags(p)
    p.set_defaults(fn=cmd_restore_code)

    p = sub.add_parser("drift", help="全量代码漂移巡检")
    p.add_argument("-n", type=int, default=8, help="每类最多列几场")
    p.set_defaults(fn=cmd_drift)

    p = sub.add_parser("html", help="导出离线 HTML 报告")
    p.add_argument("-o", "--output")
    p.add_argument("--title", default="Grok Build 会话管理台")
    p.set_defaults(fn=cmd_html)

    return ap


def main() -> int:
    force_utf8()
    ap = build_parser()
    a = ap.parse_args()
    if not a.cmd:
        a = ap.parse_args(["list", "--recap", "-n", "20"])
    if a.cmd in ("list", "ls") and not getattr(a, "recap", False):
        a.recap = False

    rows = gs.load_all()
    if not rows:
        print(f"没扫到任何 grok 会话。看一下 {gs.sessions_root()} 是不是空的。")
        return 1
    return a.fn(rows, a)


if __name__ == "__main__":
    raise SystemExit(main())
