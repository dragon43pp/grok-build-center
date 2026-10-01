# -*- coding: utf-8 -*-
"""盯着进程表，看某个名字什么时候出现、什么时候消失。

为什么不用 `tasklist /FI "IMAGENAME eq X"`：本机实测它**没有**数到正在运行的 grok
（14:42:04 那次 grok 明明在跑，同期的 `tasklist` 轮询一直报 0），于是「没复现」这个
结论根本立不住。用 CreateToolhelp32Snapshot 直接枚举，不依赖外部命令、不受输出格式
和本地化影响。

    python tools/watch_grok.py <秒数> [进程名关键字...]
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import sys
import time

TH32CS_SNAPPROCESS = 0x00000002
MAX_PATH = 260


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("cntUsage", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_char * MAX_PATH),
    ]


def snapshot() -> dict[int, tuple[str, int]]:
    """pid -> (exe 名, 父 pid)。"""
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
    k32.Process32First.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
    k32.Process32Next.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
    k32.CloseHandle.argtypes = [wt.HANDLE]

    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    out: dict[int, tuple[str, int]] = {}
    if snap == wt.HANDLE(-1).value or not snap:
        return out
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
    try:
        ok = k32.Process32First(snap, ctypes.byref(entry))
        while ok:
            name = entry.szExeFile.decode("utf-8", "replace")
            out[int(entry.th32ProcessID)] = (name, int(entry.th32ParentProcessID))
            ok = k32.Process32Next(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return out


def main() -> int:
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    needles = [a.lower() for a in sys.argv[2:]] or ["grok"]
    print(f"观察 {seconds}s，关键字 {needles}")
    seen: dict[int, str] = {}
    deadline = time.time() + seconds
    while time.time() < deadline:
        procs = snapshot()
        for pid, (name, parent) in procs.items():
            low = name.lower()
            if not any(nd in low for nd in needles):
                continue
            if pid in seen:
                continue
            parent_name = procs.get(parent, ("?", 0))[0]
            seen[pid] = name
            print(
                f"  {time.strftime('%H:%M:%S')} 出现 {name} pid={pid} 父进程={parent}({parent_name})"
            )
        for pid in list(seen):
            if pid not in procs:
                print(f"  {time.strftime('%H:%M:%S')} 退出 {seen[pid]} pid={pid}")
                del seen[pid]
        time.sleep(1)
    print(f"结束 · 本轮共见到 {len(seen)} 个仍在运行的匹配进程")
    return 0


if __name__ == "__main__":
    sys.exit(main())
