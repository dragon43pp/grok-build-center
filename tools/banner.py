#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给 .cmd 打印中文横幅。

为什么需要这么个东西：`.cmd` 里的中文**怎么存都会出问题** ——
  存 UTF-8 → cmd 按 GBK 解析，中文变乱码（ACP 936 机器上必踩）
  存 GBK  → 脚本开头 `chcp 65001` 一执行，echo 出来的 GBK 字节在 UTF-8
            控制台上又是乱码
两头堵死。所以 .cmd 一律只写 ASCII，中文全部交给 Python 打 ——
Python 那边 `chcp 65001` + `PYTHONIOENCODING=utf-8` 是稳的。

用法：
    python tools/banner.py check      # 「没配飞书，先看本机」
    python tools/banner.py panel      # 「已就绪，启动飞书面板」
    python tools/banner.py step 1     # 体检的三段小标题
"""

from __future__ import annotations

import sys

BANNERS = {
    "check": (
        "飞书还没配好，先看本机状态（这一步不需要任何配置）\n"
        "配好之后，再点这个入口就会自动变成「启动飞书面板」"
    ),
    "panel": (
        "配置已就绪，启动飞书面板。\n"
        "这个窗口别关 —— 关了面板就不更新了。"
    ),
}

STEPS = {
    1: "1/4  HRack 通道",
    2: "2/4  本机会话快照",
    3: "3/4  自检",
    4: "4/4  历史会话网页（生成完自动用浏览器打开）",
}


def main() -> int:
    args = sys.argv[1:]
    if not args:
        return 0
    head = args[0]
    if head == "step" and len(args) > 1:
        try:
            print(f"\n================ {STEPS[int(args[1])]} ================")
        except (ValueError, KeyError):
            pass
        return 0
    text = BANNERS.get(head)
    if text:
        print()
        print("-" * 56)
        for line in text.split("\n"):
            print(" ", line)
        print("-" * 56)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
