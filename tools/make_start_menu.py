#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 Grok Build Pager 装进开始菜单。

**只有一个入口**，不放一排图标让人挑 —— 用户点开就该直接干活，
「该走哪条路」是 `start.cmd` + `tools/config_ready.py` 自己判断的事：
    config.json 没配好 → 体检（离线，不需要任何配置）
    config.json 配好了 → 启动飞书面板

跑法：
    python tools/make_start_menu.py            装
    python tools/make_start_menu.py --remove   卸（删掉那个 .lnk）
"""

from __future__ import annotations

import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_lnk import make_shortcut  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MENU = os.path.expandvars(r"%APPDATA%\Microsoft\Windows\Start Menu\Programs")
LNK = os.path.join(MENU, "Grok Build Pager.lnk")

# 自己的图标，不借别人的 —— tools/make_icon.py 生成
ICON = os.path.join(ROOT, "assets", "icon", "pager.ico")

# 老版本用过这两个名字，卸载时一并清掉，避免开始菜单里留孤儿
LEGACY_NAMES = ("Grok Build Pager", "HRack 会话中心", "SessionDeck", "AI 会话中心")

TARGET = os.path.join(ROOT, "start.cmd")
DESC = "看本机 Grok Build 会话状态 / 卡住了在手机上放行（没配飞书时自动走离线体检）"


def main() -> int:
    if "--remove" in sys.argv:
        removed = False
        for name in LEGACY_NAMES:
            legacy = os.path.join(MENU, name)
            if os.path.isdir(legacy):
                shutil.rmtree(legacy)
                print(f"[ok] 已删除旧文件夹 {legacy}")
                removed = True
            old_lnk = os.path.join(MENU, f"{name}.lnk")
            if os.path.exists(old_lnk):
                os.remove(old_lnk)
                print(f"[ok] 已删除 {old_lnk}")
                removed = True
        if not removed:
            print(f"[.] 本来就没有 {LNK}")
        return 0

    if not os.path.exists(ICON):
        print(f"[warn] 图标不存在，先跑 python tools/make_icon.py")
        print(f"[warn] 改用默认图标: {ICON}")
        icon = ""
    else:
        icon = ICON

    if not os.path.exists(TARGET):
        print(f"[x] 入口不存在: {TARGET}")
        return 1

    make_shortcut(TARGET, LNK, workdir=ROOT, desc=DESC, icon=icon)
    print(f"[ok] {LNK}")

    # 回读一遍确认双击真的有效（手写 .lnk 最容易出的错就是点了没反应）
    from make_lnk import read_shortcut

    info = read_shortcut(LNK)
    print(f"     目标 {info['path']}")
    print(f"     起始 {info['workdir']}")
    print(f"     图标 {info['icon']}")
    if not info["path"]:
        print("[x] 回读不到目标路径，这个快捷方式点了不会有反应")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
