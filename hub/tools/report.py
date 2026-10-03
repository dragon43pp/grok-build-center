#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CLI hook 上报器 —— 让 CLI 主动告诉面板「我在等你确认」。

只用标准库（urllib），任何 Python 都能跑，不需要装 lark-oapi。

为什么需要它：光靠「进程还活着」和「会话文件的时间」只能推出「在跑 / 空闲 / 已结束」，
**推不出「卡在等你点确认」**。那个信息只有 CLI 自己知道。不配这个，面板上就永远
不会出现橙色的「等你确认」—— 别指望从文件 mtime 猜出来。

用法（CLI 的 hook 里调）：
    python tools/report.py --cli codex --status needs-you --note "要删掉 3 个文件，确认？"
    python tools/report.py --cli grok  --status done
    python tools/report.py --cli claude --status error --note "构建失败"

参数：
    --cli     grok | codex | claude | opencode | ...   不给就从环境变量猜
    --status  needs-you | error | running | done | idle   默认 needs-you
    --note    显示在面板上的一句话
    --sid     会话 id。不给就按当前目录匹配（弱一些，但能用）
    --cwd     工作目录，默认当前目录
    --port    面板 hook 端口，默认 8799

**永远退出码 0**：hook 是挂在 CLI 主流程上的，这里报错绝不能把用户的会话搞崩。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# 从环境变量猜是哪家 CLI —— 各家都会往子进程里塞自己的变量
ENV_HINTS: list[tuple[str, tuple[str, ...]]] = [
    ("claude", ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_MODEL")),
    ("codex", ("CODEX_SANDBOX", "CODEX_HOME", "OPENAI_CODEX")),
    ("grok", ("GROK_SESSION_ID", "GROK_HOME")),
    ("opencode", ("OPENCODE_CONFIG", "OPENCODE_HOME")),
    ("gemini", ("GEMINI_CLI", "GOOGLE_GEMINI_CLI")),
]


def guess_cli() -> str:
    for cli, names in ENV_HINTS:
        if any(os.environ.get(n) for n in names):
            return cli
    return ""


def guess_sid(cli: str) -> str:
    for name in (f"{cli.upper()}_SESSION_ID", f"{cli.upper()}_SESSION",
                 "CLAUDE_SESSION_ID", "GROK_SESSION_ID"):
        v = os.environ.get(name)
        if v:
            return v
    return ""


def localhost_opener() -> urllib.request.OpenerDirector:
    """绕开系统代理。

    这台机器上 `http_proxy` 是设着的（Clash 之类），而 urllib 默认会把
    `http://127.0.0.1:8799/hook` 也丢给代理。运气好代理转发成功（多绕一圈），
    运气不好就是 502 Bad Gateway，看起来像「面板挂了」，其实只是被代理拦了。
    本机回环地址永远不该走代理 —— 显式关掉。
    """
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def main() -> int:
    ap = argparse.ArgumentParser(description="向 Grok Build Center 上报一条 hook 事件")
    ap.add_argument("--cli", default="")
    ap.add_argument("--status", default="needs-you",
                    choices=["needs-you", "error", "running", "done", "idle"])
    ap.add_argument("--note", default="")
    ap.add_argument("--sid", default="")
    ap.add_argument("--cwd", default="")
    ap.add_argument("--port", type=int, default=int(os.environ.get("AGENT_HUB_PORT", 8799)))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    cli = args.cli or guess_cli()
    if not cli:
        if not args.quiet:
            print("[report] 不知道是哪个 CLI，用 --cli 指定。没上报，但不影响你。",
                  file=sys.stderr)
        return 0

    payload = {
        "cli": cli,
        "status": args.status,
        "note": args.note,
        "sid": args.sid or guess_sid(cli),
        "cwd": args.cwd or os.getcwd(),
    }

    req = urllib.request.Request(
        f"http://127.0.0.1:{args.port}/hook",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with localhost_opener().open(req, timeout=3) as resp:
            if not args.quiet:
                print(f"[report] {cli} → {args.status} 已上报")
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        # 面板没开着是常态，不是错误。别让 hook 把 CLI 弄脏。
        if not args.quiet:
            print(f"[report] 面板没在跑（{exc}），跳过", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
