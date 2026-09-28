#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打包后的统一入口 —— `start.cmd` 的等价物，但不需要机器上装 Python。

为什么要有它：`.cmd` 那套（`tools/banner.py` + 4 个独立进程）在开发机上没问题，
装成 exe 之后没有 `.cmd` 可调，也不能靠 `sys.executable` 去跑别的 `.py`。
所以这里把体检的每一步改成**同进程内的函数调用**。

子命令：

    GrokBuildCenter.exe                自动判断：没配飞书 → 体检；配好了 → 面板
    GrokBuildCenter.exe check          体检（离线，不需要任何配置）
    GrokBuildCenter.exe panel          启动飞书面板
    GrokBuildCenter.exe history        生成可搜索的历史会话网页并打开
    GrokBuildCenter.exe sessions ...   会话管理（list / search / recover / resume / handoff / drift / html）
    GrokBuildCenter.exe doctor         离线自检
    GrokBuildCenter.exe version

打包后 config.json / panel.json / 产物都在 **exe 旁边**，不在包内部 ——
见 `feishu_hub/paths.py`。想整体挪走就设环境变量 GROKBUILD_HOME。
"""

from __future__ import annotations

import argparse
import os
import sys

VERSION = "1.0.0"


def _base_dir() -> str:
    """开发时是仓库根；打包后是 exe 所在目录（用来挂 sys.path）。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


BASE = _base_dir()
if BASE not in sys.path:
    sys.path.insert(0, BASE)


def force_utf8() -> None:
    """Windows 控制台默认 GBK，中文会炸。跟 tools/sessions.py 同一套做法。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


def data_root() -> str:
    from feishu_hub import paths
    return paths.data_root()


def config_path(arg: str | None = None) -> str:
    return os.path.abspath(arg) if arg else os.path.join(data_root(), "config.json")


def configured(cfg: str) -> bool:
    from tools.config_ready import missing
    return not missing(cfg)


def hr(char: str = "=") -> None:
    print(char * 68)


def step(header: str) -> None:
    print(f"\n================ {header} ================")


# ---------------------------------------------------------------- 各子命令

def cmd_check(args) -> int:
    """离线体检：4 步，全都不联网、不需要任何配置。"""
    from feishu_hub import feed, groksessions as gs, scan

    cfg = config_path(args.config)
    hr()
    print("  飞书那套还没配，先看本机状态（这一步不需要任何配置）")
    print("  配好之后，再跑这个 exe 就会自动变成「启动飞书面板」")
    print("  以下 4 步跑完，本机几百场 grok 会话就已经可查、可接续、可导出了")
    hr()

    # ---- 1/4 会话库：这是主角，放最前面 ----
    step("1/4  Grok 会话库（管理 · 继承 · 恢复）")
    rows = gs.load_all()
    if not rows:
        print(f"  没扫到 grok 会话。看一眼 {gs.sessions_root()} 是不是空的。")
    else:
        print(gs.render_list(rows, limit=15, total=len(rows)))
    print()
    for line in (
        "上面只列了最近 15 场。这几条都不用联网、不需要配置：",
        "  %s sessions list -n 50          按活跃时间列全部会话" % _exe(),
        "  %s sessions search 造书成剧     跨项目搜标题 / 摘要 / 目录" % _exe(),
        "  %s sessions recover <关键词>    恢复前体检：目录在不在、代码漂没漂" % _exe(),
        "  %s sessions resume <关键词>     真接着跑（默认只打印命令，加 --go 才开窗）" % _exe(),
        "  %s sessions handoff <关键词>    大会话接续：把结论喂给新会话，秒开" % _exe(),
        "  %s sessions drift              只看代码漂移（哪些会话的 HEAD 变了）" % _exe(),
        "  %s sessions html -o board.html 生成离线看板（单文件、可搜索）" % _exe(),
    ):
        print("  " + line)

    # ---- 2/4 外部事件流（可选）----
    step("2/4  外部事件流（可选，默认关）")
    feed.main(["--config", cfg] if os.path.exists(cfg) else [])

    # ---- 3/4 本机快照 ----
    step("3/4  本机会话快照（面板上会长什么样）")
    from feishu_hub import hub as hub_mod
    hub_mod.main(["--print", "--config", cfg])

    # ---- 4/4 历史网页 ----
    step("4/4  历史会话网页（生成完自动用浏览器打开）")
    out = os.path.join(data_root(), "session-history.html")
    scan.main(["--out", out, "--open"])

    print()
    print("  本机几百场会话已经可查、可接续、可导出了。")
    print("  想让它「卡住了主动找你」→ 照 README 配好飞书，再跑一次这个 exe。")
    return 0


def cmd_panel(args) -> int:
    from feishu_hub import hub as hub_mod
    cfg = config_path(args.config)
    if not configured(cfg):
        print("[x] 飞书还没配好，先跑体检看看本机状态：GrokBuildCenter.exe check")
        return 1
    hub_mod.main(["--config", cfg])
    return 0


def cmd_history(args) -> int:
    from feishu_hub import scan
    out = args.out or os.path.join(data_root(), "session-history.html")
    argv = ["--out", out]
    if args.open:
        argv.append("--open")
    if args.search:
        argv += ["--search", args.search]
    return scan.main(argv)


def cmd_sessions(args) -> int:
    from tools import sessions as sessions_mod
    return sessions_mod.main(args.rest)


def cmd_doctor(args) -> int:
    from tools import smoke_test
    return smoke_test.main()


def cmd_version(_args) -> int:
    from feishu_hub import paths
    print(f"Grok Build Center {VERSION}")
    print(f"  程序目录   {BASE}")
    print(f"  数据目录   {paths.data_root()}")
    print(f"  资源目录   {paths.bundle_root()}")
    print(f"  冻结打包   {paths.frozen()}")
    print(f"  Python     {sys.version.split()[0]}")
    return 0


def _exe() -> str:
    return os.path.basename(sys.executable) if getattr(sys, "frozen", False) \
        else "python tools\\sessions.py"


# ---------------------------------------------------------------- 入口

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="GrokBuildCenter",
        description="Grok Build 会话管理中心 —— 卡住了它主动找你，"
                    "几百场旧会话也找得回、接得上。")
    ap.add_argument("--config", default=None, help="config.json 路径")
    ap.add_argument("--no-pause", action="store_true",
                    help="跑完不按「按任意键继续」（脚本里用）")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("check", help="离线体检（不需要任何配置）")
    p.set_defaults(fn=cmd_check)
    p = sub.add_parser("panel", help="启动飞书面板")
    p.set_defaults(fn=cmd_panel)
    p = sub.add_parser("history", help="生成历史会话网页")
    p.add_argument("-o", "--out", default=None)
    p.add_argument("--open", action="store_true", help="生成后打开浏览器")
    p.add_argument("--search", default=None, help="在终端全文搜索")
    p.set_defaults(fn=cmd_history)
    p = sub.add_parser("doctor", help="离线自检（不联网、不建飞书应用）")
    p.set_defaults(fn=cmd_doctor)
    p = sub.add_parser("version", help="打印版本与目录")
    p.set_defaults(fn=cmd_version)

    # sessions 后面那一串原样透传，别在这里重写一遍它的参数
    p = sub.add_parser("sessions", help="会话管理（list / search / recover / resume / handoff / drift / html）")
    p.add_argument("rest", nargs=argparse.REMAINDER)
    p.set_defaults(fn=cmd_sessions)
    return ap


def main(argv: list[str] | None = None) -> int:
    force_utf8()
    ap = build_parser()
    if argv is None:
        argv = sys.argv[1:]
    # 全局开关放前面，任何位置都能给
    no_pause = "--no-pause" in argv
    argv = [a for a in argv if a != "--no-pause"]
    args = ap.parse_args(argv)

    if not args.cmd:
        # 双击进来的默认行为：跟 start.cmd 一样自己判断走哪条路。
        # 「配没配」是能从 config.json 读出来的事实，不该拿去问用户。
        args.fn = cmd_panel if configured(config_path(args.config)) else cmd_check

    try:
        rc = args.fn(args)
    except KeyboardInterrupt:
        print("\n[.] 被中断")
        rc = 130

    # 双击进来的窗口不该一闪就没（跟 .cmd 的 pause 同一个理由）
    if not no_pause and rc is not None and _is_double_click():
        try:
            input("\n按回车关闭…")
        except (EOFError, KeyboardInterrupt):
            pass
    return rc or 0


def _is_double_click() -> bool:
    """只有 exe 才需要；开发时敲命令的窗口本来就不会关。"""
    return getattr(sys, "frozen", False)


if __name__ == "__main__":
    sys.exit(main())
