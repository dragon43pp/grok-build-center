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
    python tools/banner.py step 1     # 体检的小标题
    python tools/banner.py note sessions   # 体检里那几行「接下来能干嘛」
"""

from __future__ import annotations

import sys

BANNERS = {
    "check": (
        "飞书还没配好，先看本机状态（这一步不需要任何配置）\n"
        "配好之后，再点这个入口就会自动变成「启动飞书面板」\n"
        "以下 5 步跑完，本机几百场 grok 会话就已经可查、可接续、可导出了"
    ),
    "panel": (
        "配置已就绪，启动飞书面板。\n"
        "这个窗口别关 —— 关了面板就不更新了。"
    ),
}

STEPS = {
    1: "1/5  Grok 会话库（管理 · 继承 · 恢复）",
    2: "2/5  外部事件流（可选，默认关）",
    3: "3/5  本机会话快照",
    4: "4/5  自检",
    5: "5/5  历史会话网页（生成完自动用浏览器打开）",
}

# 体检里跟在某一步后面的一小段「接下来能干嘛」。
# 放这儿而不是放 .cmd 里：中文进 .cmd 必乱码，见文件头的说明。
NOTES = {
    # 下面这些空格不是手抖 —— 终端里中日韩字符占 2 格，
    # 按字符数对齐会歪。这里是按**显示宽度**排的（列宽 45）。
    "sessions": (
        "上面只列了最近 15 场。这几条都不用联网、不需要配置：\n"
        "  python tools\\sessions.py list -n 50          按活跃时间列全部会话\n"
        "  python tools\\sessions.py search 造书成剧     跨项目搜标题 / 摘要 / 目录\n"
        "  python tools\\sessions.py show <id前8位>      某一场的全文详情\n"
        "  python tools\\sessions.py drift              只看代码漂移（哪些会话的 HEAD 变了）\n"
        "  python tools\\sessions.py recover <关键词>    恢复前体检：目录在不在、代码漂没漂\n"
        "  python tools\\sessions.py resume <关键词>     真接着跑（默认只打印命令，加 --go 才开窗）\n"
        "  python tools\\sessions.py handoff <关键词>    大会话接续：把结论喂给新会话，秒开\n"
        "  python tools\\sessions.py html -o board.html  生成离线看板（单文件、可搜索）"
    ),
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
    if head == "note" and len(args) > 1:
        text = NOTES.get(args[1])
        if text:
            print()
            for line in text.split("\n"):
                print("  " + line)
            print()
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
