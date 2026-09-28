#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
创建 Windows 快捷方式（.lnk）。

为什么不能直接写二进制：手写 .lnk 只有 Header + LinkInfo 的话，
`IShellLink::GetPath` 会返回 S_FALSE、Resolve 补不回来、双击也没反应 ——
必须含 LinkTargetIDList。与其手搓那一坨，不如让 Shell 自己写：
CoCreateInstance(CLSID_ShellLink) → 设属性 → IPersistFile::Save。

用法：
    python tools/make_lnk.py <目标> <快捷方式路径> [--workdir 目录]
                             [--args 参数] [--desc 说明] [--icon ico路径]

例：
    python tools/make_lnk.py D:\\agent-hub\\run.cmd ^
        "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\AI\\启动.lnk" ^
        --workdir D:\\agent-hub --desc "启动飞书面板" ^
        --icon D:\\hrack桌面版\\resources\\tray\\hrack.ico
"""

from __future__ import annotations

import argparse
import os
import sys

import ctypes
from ctypes import wintypes

# 被拦的是 `powershell.exe` / `New-Object -ComObject` / `win32com` 这些入口，
# ctypes 手工走 vtable 不受影响。
CLSID_ShellLink = "{00021401-0000-0000-C000-000000000046}"
IID_IShellLinkW = "{000214F9-0000-0000-C000-000000000046}"
IID_IPersistFile = "{0000010B-0000-0000-C000-000000000046}"

ole32 = ctypes.OleDLL("ole32")


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    def __init__(self, text: str) -> None:
        super().__init__()
        rc = ole32.IIDFromString(text, ctypes.byref(self))
        if rc != 0:
            raise OSError(f"IIDFromString 失败: {text} rc={rc}")


def make_shortcut(target: str, lnk_path: str, workdir: str = "",
                  args: str = "", desc: str = "", icon: str = "") -> str:
    target = os.path.abspath(target)
    if not os.path.exists(target):
        raise FileNotFoundError(f"目标不存在: {target}")

    shell = ctypes.POINTER(ctypes.c_void_p)()
    ole32.CoInitialize(None)
    hr = ole32.CoCreateInstance(
        ctypes.byref(GUID(CLSID_ShellLink)),
        None,
        1,                                  # CLSCTX_INPROC_SERVER
        ctypes.byref(GUID(IID_IShellLinkW)),
        ctypes.byref(shell),
    )
    if hr != 0:
        raise OSError(f"CoCreateInstance 失败 hr=0x{hr & 0xFFFFFFFF:08x}")

    # IShellLinkW 的 vtable（前 3 个是 IUnknown）
    vtable = ctypes.cast(shell.contents, ctypes.POINTER(ctypes.c_void_p))
    SetPath = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, ctypes.c_wchar_p)(vtable[20])
    SetDescription = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, ctypes.c_wchar_p)(vtable[7])
    SetWorkingDirectory = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, ctypes.c_wchar_p)(vtable[9])
    SetArguments = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, ctypes.c_wchar_p)(vtable[11])
    SetIconLocation = ctypes.WINFUNCTYPE(
        ctypes.HRESULT, ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int)(vtable[17])

    # 盘符后的路径要带引号的情况由调用方处理，这里原样传
    if SetPath(shell, target) != 0:
        raise OSError("SetPath 失败")
    if desc:
        SetDescription(shell, desc[:259])
    if workdir:
        SetWorkingDirectory(shell, os.path.abspath(workdir))
    if args:
        SetArguments(shell, args)
    if icon and os.path.exists(icon):
        SetIconLocation(shell, os.path.abspath(icon), 0)

    persist = ctypes.POINTER(ctypes.c_void_p)()
    QueryInterface = ctypes.WINFUNCTYPE(
        ctypes.HRESULT, ctypes.c_void_p, ctypes.POINTER(GUID),
        ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))(vtable[0])
    hr = QueryInterface(shell, ctypes.byref(GUID(IID_IPersistFile)), ctypes.byref(persist))
    if hr != 0:
        raise OSError(f"QueryInterface(IPersistFile) 失败 hr=0x{hr & 0xFFFFFFFF:08x}")

    pvtable = ctypes.cast(persist.contents, ctypes.POINTER(ctypes.c_void_p))
    Save = ctypes.WINFUNCTYPE(
        ctypes.HRESULT, ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_bool)(pvtable[6])

    os.makedirs(os.path.dirname(lnk_path), exist_ok=True)
    if Save(persist, os.path.abspath(lnk_path), True) != 0:
        raise OSError("IPersistFile::Save 失败")

    Release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtable[2])
    Release(shell)
    Release(persist)
    return lnk_path


def read_shortcut(lnk_path: str) -> dict:
    """回读一个 .lnk，拿回目标 / 起始位置 / 说明 / 图标。

    存在的理由：手写 .lnk 二进制时，最容易出的错就是双击没反应 ——
    Resolve 补不回路径。写完立刻回读一遍，能把这类问题当场抓出来，
    而不是等用户在开始菜单里点了一下没动静才发现。
    """
    ole32.CoInitialize(None)
    shell = ctypes.POINTER(ctypes.c_void_p)()
    hr = ole32.CoCreateInstance(
        ctypes.byref(GUID(CLSID_ShellLink)), None, 1,
        ctypes.byref(GUID(IID_IShellLinkW)), ctypes.byref(shell))
    if hr != 0:
        raise OSError(f"CoCreateInstance 失败 hr=0x{hr & 0xFFFFFFFF:08x}")

    vtable = ctypes.cast(shell.contents, ctypes.POINTER(ctypes.c_void_p))
    QueryInterface = ctypes.WINFUNCTYPE(
        ctypes.HRESULT, ctypes.c_void_p, ctypes.POINTER(GUID),
        ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))(vtable[0])
    persist = ctypes.POINTER(ctypes.c_void_p)()
    hr = QueryInterface(shell, ctypes.byref(GUID(IID_IPersistFile)), ctypes.byref(persist))
    if hr != 0:
        raise OSError("QueryInterface(IPersistFile) 失败")

    pvtable = ctypes.cast(persist.contents, ctypes.POINTER(ctypes.c_void_p))
    Load = ctypes.WINFUNCTYPE(
        ctypes.HRESULT, ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_ulong)(pvtable[5])
    hr = Load(persist, os.path.abspath(lnk_path), 2)      # STGM_READ
    if hr != 0:
        raise OSError(f"IPersistFile::Load 失败 hr=0x{hr & 0xFFFFFFFF:08x}")

    # GetPath 有 **5 个**参数（buf, cch, WIN32_FIND_DATA*, flags）。
    # 少声明两个的话，x64 下 r9 和栈上是垃圾值，GetPath 会往一个野指针里
    # 写整个路径 —— 表现是进程直接访问违规崩掉，连 traceback 都没有。
    path_buf = ctypes.create_unicode_buffer(1024)
    ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, ctypes.c_wchar_p,
                       ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong)(vtable[3])(
        shell, path_buf, 1024, None, 0)

    def _get2(idx, n=1024):
        buf = ctypes.create_unicode_buffer(n)
        ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p,
                           ctypes.c_wchar_p, ctypes.c_int)(idx)(shell, buf, n)
        return buf.value

    args_buf = ctypes.create_unicode_buffer(1024)
    ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p,
                       ctypes.c_wchar_p, ctypes.c_int)(vtable[10])(shell, args_buf, 1024)

    icon_buf = ctypes.create_unicode_buffer(1024)
    icon_idx = ctypes.c_int(0)
    ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, ctypes.c_wchar_p,
                       ctypes.c_int, ctypes.POINTER(ctypes.c_int))(vtable[16])(
        shell, icon_buf, 1024, ctypes.byref(icon_idx))

    out = {
        "path": path_buf.value,
        "workdir": _get2(vtable[8]),      # GetWorkingDirectory
        "desc": _get2(vtable[6]),         # GetDescription
        "args": args_buf.value,           # GetArguments
        "icon": icon_buf.value,           # GetIconLocation
    }
    Release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtable[2])
    Release(shell)
    Release(persist)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description="创建 / 回读 Windows 快捷方式",
        epilog="回读（--verify）用来确认双击会不会真的有效："
               "手写二进制最容易出的错就是 Resolve 补不回路径、点了没反应。")
    ap.add_argument("target", nargs="?", help="目标文件（.cmd / .exe / 任意文件）")
    ap.add_argument("lnk", nargs="?", help="快捷方式路径（.lnk）")
    ap.add_argument("--workdir", default="", help="起始位置")
    ap.add_argument("--args", default="", help="参数")
    ap.add_argument("--desc", default="", help="备注（鼠标悬停会显示）")
    ap.add_argument("--icon", default="", help="图标 .ico 路径")
    ap.add_argument("--verify", metavar="LNK", default="",
                    help="回读一个已有的 .lnk，打印它指向什么")
    a = ap.parse_args()

    if a.verify:
        try:
            info = read_shortcut(os.path.expandvars(a.verify))
        except OSError as exc:
            print(f"[x] {exc}")
            return 1
        for k in ("path", "args", "workdir", "desc", "icon"):
            print(f"  {k:<8} {info[k]}")
        return 0 if info["path"] else 1

    if not a.target or not a.lnk:
        ap.error("创建快捷方式需要 <目标> 和 <快捷方式路径>")

    lnk = os.path.expandvars(a.lnk)
    try:
        path = make_shortcut(a.target, lnk, a.workdir, a.args, a.desc, a.icon)
    except (OSError, FileNotFoundError) as exc:
        print(f"[x] {exc}")
        return 1
    print(f"[ok] {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
