#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打包后的统一入口 —— `start.cmd` 的等价物，但不需要机器上装 Python。

为什么要有它：`.cmd` 那套（`tools/banner.py` + 4 个独立进程）在开发机上没问题，
装成 exe 之后没有 `.cmd` 可调，也不能靠 `sys.executable` 去跑别的 `.py`。
所以这里把体检的每一步改成**同进程内的函数调用**（那些函数在 `feishu_hub/flow.py`）。

一个入口，两个 exe（同一次打包产出，共用 `_internal`）：

    GrokBuildCenter.exe       GUI 子系统。双击 = 图形前台，全程没有黑窗口。
    GrokBuildCenter-cli.exe   控制台子系统。README 里那一串命令用它。

图形版收到子命令会**转交**给命令行版（见 `_relaunch_cli`）——
GUI 程序没有控制台，自己跑等于让输出掉进黑洞。

子命令：

    GrokBuildCenter-cli.exe check     体检（离线，不需要任何配置）
    GrokBuildCenter-cli.exe ui        图形前台（起本地控制台 + 开浏览器）
    GrokBuildCenter-cli.exe panel     启动飞书面板
    GrokBuildCenter-cli.exe history   生成可搜索的历史会话网页并打开
    GrokBuildCenter-cli.exe sessions ...  会话管理（list / search / recover / resume / handoff / drift / html）
    GrokBuildCenter-cli.exe doctor    离线自检
    GrokBuildCenter-cli.exe version

打包后 config.json / panel.json / 产物都在 **exe 旁边**，不在包内部 ——
见 `feishu_hub/paths.py`。想整体挪走就设环境变量 GROKBUILD_HOME。
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

def _base_dir() -> str:
    """开发时是仓库根；打包后是 exe 所在目录（用来挂 sys.path）。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


BASE = _base_dir()
if BASE not in sys.path:
    sys.path.insert(0, BASE)


def _version() -> str:
    """版本号只有一处定义（feishu_hub/__init__.py）。

    这里再写一份的话，装完之后 `version` 和「添加或删除程序」里迟早对不上。
    """
    try:
        from feishu_hub import __version__
        return __version__
    except Exception:
        return "0.0.0"


VERSION = _version()


def force_utf8() -> None:
    """Windows 控制台默认 GBK，中文会炸。跟 tools/sessions.py 同一套做法。

    图形版 exe 里 `sys.stdout` 是 **None**（PyInstaller 的无控制台模式会把它
    摘掉），任何一句 print 都会 AttributeError 炸掉整个流程。所以先试着从
    fd 1 把流接回来 —— 从 cmd 里跑、或者输出被重定向到文件时，fd 1 是好的；
    真接不回来就扔进垃圾桶，宁可没有输出也不能崩。
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            stream = _reopen_stream(name)
            setattr(sys, name, stream)
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError, OSError):
            pass


def _reopen_stream(name: str):
    fd = 1 if name == "stdout" else 2
    try:
        return open(fd, "w", encoding="utf-8", errors="replace", buffering=1)
    except OSError:
        return open(os.devnull, "w", encoding="utf-8")


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
    print(f"  想要图形界面（一个按钮搞定，没有黑窗口）：{_exe()} ui")
    print("  想让它「卡住了主动找你」→ 照 README 配好飞书，再跑一次这个 exe。")
    return 0


def cmd_ui(args) -> int:
    """图形前台：起本地控制台 + 开浏览器。双击 exe 走的就是这条。"""
    from feishu_hub import ui
    argv = []
    if args.config:
        argv += ["--config", args.config]
    if getattr(args, "out", None):
        argv += ["--out", args.out]
    if getattr(args, "port", None):
        argv += ["--port", str(args.port)]
    if getattr(args, "idle", None):
        argv += ["--idle", str(args.idle)]
    if getattr(args, "no_open", False):
        argv.append("--no-open")
    return ui.main(argv)


def cmd_panel(args) -> int:
    from feishu_hub import hub as hub_mod
    cfg = config_path(args.config)
    if not configured(cfg):
        print(f"[x] 飞书还没配好，先跑体检看看本机状态：{_exe()} check")
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
    ap.add_argument("--no-open", action="store_true",
                    help="图形前台不自动开浏览器（无头跑的时候用）")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("check", help="离线体检（不需要任何配置）")
    p.set_defaults(fn=cmd_check)
    p = sub.add_parser("ui", help="打开图形前台（双击 exe 走的就是它）")
    # default=SUPPRESS：不给的话，子解析器会把它自己的默认值（False）
    # 盖回全局那个 --no-open 上，`--no-open ui` 就成了摆设
    p.add_argument("--no-open", action="store_true", default=argparse.SUPPRESS,
                   help="不自动开浏览器")
    p.add_argument("--port", type=int, default=0, help="面板端口（默认 8770，占了会自动换）")
    p.add_argument("--out", default=None, help="产物 HTML 路径")
    p.add_argument("--idle", type=float, default=0.0,
                   help="页面关掉后多久自动退出，秒（默认 1800）")
    p.set_defaults(fn=cmd_ui)
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
    argv = list(sys.argv[1:] if argv is None else argv)
    # 「是不是图形版 exe」必须在 force_utf8 之前判断 —— 那之后 stdout 就被
    # 补成 devnull 了，看不出区别（PyInstaller 无控制台模式把 stdout 置为 None）。
    windowed = getattr(sys, "frozen", False) and sys.stdout is None

    # 图形版收到**别人的**子命令 → 转交命令行版。GUI 子系统没有控制台，
    # 直接跑的话用户敲了命令却一个字都看不到，会以为坏了。
    # `ui` 例外：那是图形版自己的活，而且是常驻进程 ——
    # 转交出去等于凭空多开一个一直不关的控制台窗口。
    if windowed and argv and _first_word(argv) != "ui":
        rc = _relaunch_cli(argv)
        if rc is not None:
            return rc

    force_utf8()
    ap = build_parser()
    # 全局开关放前面，任何位置都能给
    no_pause = "--no-pause" in argv
    argv = [a for a in argv if a != "--no-pause"]
    args = ap.parse_args(argv)

    if not args.cmd:
        # 双击进来的默认行为，按「进来的门」分：
        #   图形版 exe —— 直接开图形前台，一个黑框都不会有
        #   命令行/开发 —— 跟 start.cmd 一样自己判断走哪条路
        #     （「配没配」是能从 config.json 读出来的事实，不该拿去问用户）
        if windowed:
            args.fn = cmd_ui
        else:
            args.fn = cmd_panel if configured(config_path(args.config)) else cmd_check

    try:
        rc = args.fn(args)
    except KeyboardInterrupt:
        print("\n[.] 被中断")
        rc = 130

    # 双击进来的窗口不该一闪就没（跟 .cmd 的 pause 同一个理由）。
    # 但**从终端里跑的不能停** —— 敲完命令还等人按回车，那叫添堵。
    # 判据不是「有没有控制台」，而是「这个控制台是不是我自己开的」：
    # 双击时只有自己挂在上面，从 cmd 里跑则连 cmd 一起挂在上头。
    # 图形版压根没有控制台，没什么可停的。
    if not no_pause and not windowed and rc is not None and _owns_console():
        try:
            input("\n按回车关闭…")
        except (EOFError, KeyboardInterrupt):
            pass
    return rc or 0


CLI_EXE = "GrokBuildCenter-cli.exe"


def _owns_console() -> bool:
    """这个控制台是这个进程自己开的吗（= 被双击，而不是从 shell 里跑）。

    GetConsoleProcessList 返回挂在当前控制台上的进程数：只有 1 个（自己）
    说明控制台是双击时由系统新开的；大于 1 说明旁边还站着 cmd / PowerShell，
    跑完就该把控制权还给人家。没有控制台（输出被重定向）时返回 0，也当不用停。
    """
    import ctypes

    try:
        kernel32 = ctypes.windll.kernel32          # type: ignore[attr-defined]
        buf = (ctypes.c_uint * 8)()
        count = kernel32.GetConsoleProcessList(buf, 8)
        return count == 1
    except Exception:
        return False


def _first_word(argv: list[str]) -> str:
    """argv 里第一个不像开关的词 —— 大概就是个子命令。"""
    for arg in argv:
        if not arg.startswith("-"):
            return arg
    return ""


def _relaunch_cli(argv: list[str]) -> int | None:
    """把子命令转交给同目录的 GrokBuildCenter-cli.exe。

    为什么需要：图形版是 **GUI 子系统**的程序，压根没有控制台，print 出去没人接。
    而同一个 exe 又要能当命令行用（README 里那一串命令），所以装了两个：
    双击用图形版，敲命令用命令行版。这里就是那道分诊台。

    返回 None 表示「转不了」（比如有人只拷了一个 exe 出来），
    那就按原样继续跑 —— 输出可能是空的，但至少不会崩。
    """
    if not getattr(sys, "frozen", False):
        return None
    here = os.path.dirname(os.path.abspath(sys.executable))
    cli = os.path.join(here, CLI_EXE)
    if not os.path.exists(cli):
        return None
    try:
        return subprocess.call([cli, *argv])
    except OSError:
        return None


if __name__ == "__main__":
    sys.exit(main())
