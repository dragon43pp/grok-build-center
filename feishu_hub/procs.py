#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
进程存活检测：本机现在有哪些 AI CLI 在跑，跑在哪个目录。

为什么要这个：会话库里躺着 346 场历史会话，但「哪几场现在活着」只有进程表知道。
历史库里每场都记着 cwd，所以按 (cli, cwd) 就能把「进程」和「会话」对上。

坑：
- Windows 上 `psutil.Process.cwd()` 对部分进程会抛 AccessDenied，要吞掉。
- CLI 的真实进程名千奇百怪：grok 是原生 exe，codex/opencode/gemini 是 npm 包
  （真实进程是 node.exe），claude 在 `~/.local/bin`。所以不能只按进程名匹配，
  要退一步看 cmdline。
- 同一个 cwd 下可能有多个进程（比如 grok 同时开两个），所以值是列表不是单个。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

try:
    import psutil
except ImportError:                       # 没装就降级成「全都算已结束」
    psutil = None  # type: ignore


# 每个 CLI 用来识别的特征：进程名（小写）+ cmdline 关键词
CLI_SIGNATURES: dict[str, dict[str, tuple[str, ...]]] = {
    "grok": {
        "names": ("grok", "grok.exe"),
        "cmdline": ("\\.grok\\bin\\grok", "/.grok/bin/grok", "grok build"),
    },
    "codex": {
        "names": ("codex", "codex.exe"),
        "cmdline": ("npm/codex", "npm\\codex", "@openai/codex", "codex.js"),
    },
    "claude": {
        "names": ("claude", "claude.exe"),
        "cmdline": ("\\.local\\bin\\claude", "/.local/bin/claude", "@anthropic-ai/claude-code"),
    },
    "opencode": {
        "names": ("opencode", "opencode.exe"),
        "cmdline": ("npm/opencode", "npm\\opencode", "opencode-ai"),
    },
    "gemini": {
        "names": ("gemini", "gemini.exe"),
        "cmdline": ("npm/gemini", "npm\\gemini", "@google/gemini-cli"),
    },
    "cline": {
        "names": ("cline", "cline.exe"),
        "cmdline": ("npm/cline", "npm\\cline"),
    },
    # HRack 支持这两个，原来只在 HRack 里能看见，这边的进程扫描认不出来
    "kimi": {
        "names": ("kimi", "kimi.exe"),
        "cmdline": ("npm/kimi", "npm\\kimi", "@moonshot", "kimi-code", "kimi-cli"),
    },
    "pi": {
        "names": ("pi", "pi.exe"),
        "cmdline": ("npm/pi", "npm\\pi", "@pi/agent", "pi-agent"),
    },
}


@dataclass
class LiveProc:
    cli: str
    pid: int
    cwd: str
    name: str
    created: float


@dataclass
class LiveIndex:
    """按 (cli, cwd) 索引的存活进程。cwd 统一小写 + 反斜杠，方便比对。"""

    by_cli_cwd: dict[tuple[str, str], list[LiveProc]] = field(default_factory=dict)
    by_cwd: dict[str, list[LiveProc]] = field(default_factory=dict)

    def count(self, cli: str, cwd: str) -> int:
        return len(self.by_cli_cwd.get((cli, norm_cwd(cwd)), []))

    def count_any_cli(self, cwd: str) -> int:
        return len(self.by_cwd.get(norm_cwd(cwd), []))

    def total(self) -> int:
        return sum(len(v) for v in self.by_cwd.values())


def norm_cwd(path: str | None) -> str:
    if not path:
        return ""
    return os.path.normcase(os.path.normpath(path)).replace("/", "\\")


def _match_cli(name: str, cmdline: str) -> str | None:
    low_name = name.lower()
    low_cmd = cmdline.lower()
    for cli, sig in CLI_SIGNATURES.items():
        if low_name in sig["names"]:
            return cli
        if any(k.lower() in low_cmd for k in sig["cmdline"]):
            return cli
    return None


def scan_live() -> LiveIndex:
    """遍历进程表，找出所有在跑的 AI CLI。"""
    idx = LiveIndex()
    if psutil is None:
        return idx

    me = os.getpid()
    for proc in psutil.process_iter(["pid", "name", "cmdline", "create_time"]):
        try:
            info = proc.info
            pid = info.get("pid")
            if pid == me:
                continue
            name = info.get("name") or ""
            raw = info.get("cmdline") or []
            cmdline = " ".join(raw)

            cli = _match_cli(name, cmdline)
            if cli is None:
                continue

            try:
                cwd = proc.cwd()
            except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
                cwd = ""
            if not cwd:
                continue

            lp = LiveProc(
                cli=cli,
                pid=pid,
                cwd=cwd,
                name=name,
                created=float(info.get("create_time") or 0),
            )
            idx.by_cli_cwd.setdefault((cli, norm_cwd(cwd)), []).append(lp)
            idx.by_cwd.setdefault(norm_cwd(cwd), []).append(lp)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
    return idx


if __name__ == "__main__":
    live = scan_live()
    print(f"存活进程 {live.total()} 个")
    for (cli, cwd), procs in sorted(live.by_cli_cwd.items()):
        print(f"  {cli:<10} x{len(procs)}  {cwd}")
