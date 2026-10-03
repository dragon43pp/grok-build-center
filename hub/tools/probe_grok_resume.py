#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
查清楚 grok 的无头续跑到底卡在哪。

背景：`grok --cwd <dir> -r <sid> -p "<prompt>"` 会**零输出挂死**，
而不带 `-r` 时 5 秒就返回。挂死的是 grok 还是我们调用姿势不对，得测出来。

测法：同一件事换不同参数各跑一遍，带超时，记录「耗时 / 退出码 / 有没有输出」。
关键是**分大小会话对照** —— 如果只有大会话挂，那问题就是「恢复太慢」，
不是「不支持」，处理方式完全不同。
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

GROK = "grok"
TIMEOUT = 75

# 小会话（56 KB）和大会话（1.5 MB）。只有大会话挂 → 说明是加载慢，不是不支持。
CASES = [
    ("A 基线 无-r 小目录", ["--cwd", r"D:\grok", "-p", "只回复两个字：收到"]),
    ("B 小会话 -r", ["--cwd", r"D:\grok", "-r", "01a09fbd-a663-7580-8baa-f218b89908e3",
                    "-p", "只回复两个字：收到"]),
    ("C 大会话 -r", ["--cwd", r"D:\yanjiu", "-r", "01a0c74c-a76a-7b42-93f2-2509a3de6d61",
                    "-p", "只回复两个字：收到"]),
    ("D 小会话 -r --no-alt-screen", ["--cwd", r"D:\grok", "-r", "01a09fbd-a663-7580-8baa-f218b89908e3",
                                     "-p", "只回复两个字：收到", "--no-alt-screen"]),
    ("E 小会话 -r --fork-session", ["--cwd", r"D:\grok", "-r", "01a09fbd-a663-7580-8baa-f218b89908e3",
                                    "-p", "只回复两个字：收到", "--fork-session"]),
    ("F 小目录 -c（最近一场）", ["--cwd", r"D:\grok", "-c", "-p", "只回复两个字：收到"]),
]


def run(label: str, args: list[str]) -> None:
    print("=" * 70)
    print(f"[{label}]")
    print("  argv:", " ".join([GROK] + args))
    t0 = time.time()
    try:
        p = subprocess.run(
            [GROK] + args,
            capture_output=True, timeout=TIMEOUT, check=False,
            # stdin 一定要给个关闭的管道。不给的话子进程可能**等键盘输入**，
            # 表现就是「零输出挂死」—— 这正是要排查的头号嫌疑。
            stdin=subprocess.DEVNULL,
            env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"},
        )
        dur = time.time() - t0
        out = p.stdout.decode("utf-8", "replace").strip()
        err = p.stderr.decode("utf-8", "replace").strip()
        print(f"  rc={p.returncode}  用时 {dur:.1f}s")
        print(f"  stdout({len(out)} 字): {out[:300]!r}")
        if err:
            print(f"  stderr({len(err)} 字): {err[:300]!r}")
    except subprocess.TimeoutExpired as e:
        dur = time.time() - t0
        out = (e.stdout or b"").decode("utf-8", "replace").strip()
        err = (e.stderr or b"").decode("utf-8", "replace").strip()
        print(f"  **超时** {dur:.1f}s")
        print(f"  超时前 stdout({len(out)} 字): {out[:300]!r}")
        if err:
            print(f"  超时前 stderr({len(err)} 字): {err[:300]!r}")
    sys.stdout.flush()


if __name__ == "__main__":
    only = sys.argv[1:] or None
    for label, args in CASES:
        if only and label[0] not in only:
            continue
        run(label, args)
    print("=" * 70)
    print("跑完了")
