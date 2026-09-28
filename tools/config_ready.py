#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
判断「飞书那套配好了没有」，给 start.cmd 当开关用。

退出码：
    0  配好了 → 可以启动飞书面板
    1  没配   → 老老实实走体检（离线），别让用户对着一堆报错猜

为什么要这个：用户点开始菜单里那一个入口时，不该先被问「你想干啥」。
配没配是能从 config.json 里读出来的事实，直接替他判断掉。

跑法：
    python tools/config_ready.py [config.json 路径]
    python tools/config_ready.py --why       # 额外打印缺什么
"""

from __future__ import annotations

import json
import os
import sys

NEED = ("app_id", "app_secret", "receive_id")

# 模板里的占位值长这样，别把它们当成「填好了」
PLACEHOLDER_MARKS = ("xxx", "xxxx", "xxxxxxxx", "cli_xxx", "你的")


def default_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "config.json")


def missing(path: str) -> list[str]:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return list(NEED)

    out: list[str] = []
    for key in NEED:
        val = str(data.get(key) or "").strip()
        if not val:
            out.append(key)
            continue
        low = val.lower()
        if any(mark in low for mark in PLACEHOLDER_MARKS):
            out.append(key)
    return out


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = os.path.expandvars(args[0]) if args else default_path()

    miss = missing(path)
    if "--why" in sys.argv:
        if miss:
            print(f"没配好，缺：{', '.join(miss)}  （{path}）")
        else:
            print(f"已就绪：{path}")
    return 1 if miss else 0


if __name__ == "__main__":
    sys.exit(main())
