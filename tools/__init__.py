#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/ —— 命令行工具集。

为什么要这个 `__init__.py`（这些原本是直接 `python tools/xxx.py` 跑的脚本）：
打包成 exe 时 `tools/app.py` 要在**同一个进程里**调 `tools.sessions` /
`tools.smoke_test`，没有它 PyInstaller 就只按「脚本目录」处理，模块收不全。
开发机的用法一点没变，还是 `python tools/sessions.py ...`。
"""
