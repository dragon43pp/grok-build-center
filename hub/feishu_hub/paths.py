#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
两个「根目录」的区别 —— 打包成 exe 之后这俩不是一个地方。

开发时两者是同一个（项目根），所以以前直接写 `ROOT` 没事。
打包后必须分开：

    data_root()    配 config.json、panel.json、产出的 HTML 放哪
                   → exe 所在目录。用户得能拿记事本改它，不能埋进包里。

    bundle_root()  只读资源（assets/、模板）在哪
                   → PyInstaller 解包目录（sys._MEIPASS）。只读，不用管。

环境变量 GROKBUILD_HOME 可以整体改掉 data_root（测试 / 便携模式用）。
"""

from __future__ import annotations

import os
import sys

ENV_HOME = "GROKBUILD_HOME"


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def data_root() -> str:
    override = os.environ.get(ENV_HOME, "").strip()
    if override:
        return os.path.abspath(os.path.expanduser(override))
    if frozen():
        # 打包后：exe 自己所在的那个目录
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def bundle_root() -> str:
    if frozen():
        return getattr(sys, "_MEIPASS", "") or data_root()
    return data_root()


def find(name: str) -> str:
    """找一个只读资源：先看 exe 旁边（用户可能自己换过），再看包里。

    开发时两个根一样，等价于直接拼路径。
    """
    for root in (data_root(), bundle_root()):
        p = os.path.join(root, name)
        if os.path.exists(p):
            return p
    return os.path.join(bundle_root(), name)
