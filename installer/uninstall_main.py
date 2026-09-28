#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Grok Build Center · 卸载程序

被安装到程序目录里，从「设置 → 应用」或直接双击调用。

为什么要单独一个 exe：Windows 不允许一个正在运行的 exe 删掉自己所在的目录。
所以这里的做法是 —— 先把自己该做的（快捷方式、注册表、用户数据问一遍）做完，
再往 %TEMP% 写一个两行的 .cmd，让它**等我们退出之后**去 rmdir。
那个 .cmd 必须是 ASCII + CRLF，否则 cmd 会把行切碎（本仓库踩过的坑）。

默认**保留**用户的 config.json / panel.json：里面是飞书凭证和面板状态，
重装还要用。要一起清掉就加 --purge。
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

APP_NAME = "Grok Build Center"
APP_ID = "GrokBuildCenter"
UNINST_KEY = ("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"
              + APP_ID)

# 用户的，不是程序的 —— 默认留着
USER_FILES = ("config.json", "panel.json", "bitable-state.json")


def start_menu_dir() -> str:
    v = os.environ.get("APPDATA")
    base = v or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    return os.path.join(base, "Microsoft", "Windows", "Start Menu", "Programs")


def install_dir() -> str:
    return os.path.dirname(os.path.abspath(sys.executable))


def kill_running() -> int:
    """把本程序的进程收掉，不然文件被占着删不掉。

    两个都要收：`GrokBuildCenter.exe` 是图形前台（双击那个），
    `GrokBuildCenter-cli.exe` 是命令行那个。前台还开着的时候卸载，
    最容易「卸了一半」——目录删不掉，但快捷方式和注册表已经没了。
    """
    me = os.getpid()
    killed = 0
    for image in ("GrokBuildCenter.exe", "GrokBuildCenter-cli.exe"):
        out = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {image}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, errors="replace")
        for line in out.stdout.splitlines():
            parts = [p.strip('"') for p in line.split('","')]
            if len(parts) < 2 or parts[0] != image:
                continue
            try:
                pid = int(parts[1])
            except ValueError:
                continue
            if pid == me:
                continue
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
            killed += 1
    return killed


def remove_shortcuts() -> list[str]:
    gone = []
    for p in (os.path.join(start_menu_dir(), APP_NAME + ".lnk"),
              os.path.join(os.path.expanduser("~"), "Desktop", APP_NAME + ".lnk")):
        try:
            if os.path.exists(p):
                os.remove(p)
                gone.append(p)
        except OSError:
            pass
    return gone


def remove_registry() -> bool:
    """删掉「应用和功能」里那条登记。

    用 DeleteKey 而不是 DeleteKeyEx：DeleteKeyEx 的第三个位置参数是
    KEY_WOW64_* 视图标志（不是权限），随手传 KEY_WRITE 会走到错误的视图上，
    结果是「删除成功」的假象 + 键还在。装的时候两个进程都是 64 位，
    视图本来就一致，DeleteKey 足够。
    """
    import winreg
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, UNINST_KEY)
        return True
    except FileNotFoundError:
        return True
    except OSError as exc:
        print("        %s" % exc)
        return False


def write_selfdestruct_cmd(target_dir: str) -> str:
    """写一个 ASCII + CRLF 的 .cmd：等一会儿 → 反复 rmdir → 删自己。

    为什么要交给外部脚本：Windows 不允许一个正在运行的 exe 删掉自己所在的
    目录，所以只能用「先退出，再让别人删」这一招。

    为什么先 `cd /d %TEMP%`：如果调用方的当前目录正好在目标目录里
    （比如用户是 `cd` 进去之后双击卸载的），rmdir 会因为「目录在使用中」
    直接失败 —— 这个坑实测踩过。

    为什么循环 12 次：刚退出的进程、杀毒软件、资源管理器都可能短暂占着文件，
    一次删不掉就放弃会留下半个目录。

    这个文件里**一个字的中文都不能有**：.cmd 存 UTF-8 会被 cmd 按 GBK 解析，
    存 GBK 又和 chcp 打架。所以标题、提示全部由 Python 打印。
    """
    import tempfile
    body = (
        "@echo off\r\n"
        'cd /d "%TEMP%"\r\n'
        "for /l %%i in (1,1,12) do (\r\n"
        '  if exist "' + target_dir + '" (\r\n'
        "    ping -n 2 127.0.0.1 >nul\r\n"
        '    rmdir /s /q "' + target_dir + '" 2>nul\r\n'
        "  )\r\n"
        ")\r\n"
        'del "%~f0"\r\n'
    )
    path = os.path.join(tempfile.gettempdir(),
                        "gbc-uninstall-%d.cmd" % os.getpid())
    with open(path, "wb") as fh:
        fh.write(body.encode("ascii"))
    return path


def main() -> int:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description=APP_NAME + " 卸载程序")
    ap.add_argument("--silent", action="store_true", help="不问任何问题")
    ap.add_argument("--purge", action="store_true",
                    help="连 config.json 一起删（飞书凭证 / 面板状态）")
    ap.add_argument("--keep", action="store_true",
                    help="连程序目录都不删，只清快捷方式和注册表")
    a = ap.parse_args()

    d = install_dir()
    print()
    print("=" * 66)
    print("  %s  ·  卸载" % APP_NAME)
    print("=" * 66)
    print("  程序目录  %s" % d)

    keep = [f for f in USER_FILES if os.path.exists(os.path.join(d, f))]
    if keep and not a.purge:
        print("  会保留    %s" % "、".join(keep))
        print("            （里面有你的飞书凭证和面板状态，重装还要用）")
    elif keep:
        print("  会删掉    %s   ← --purge" % "、".join(keep))

    if not a.silent:
        try:
            ans = input("\n  确认卸载？(y/N) ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            ans = ""
        if not ans.startswith("y"):
            print("  已取消。")
            return 1

    n = kill_running()
    if n:
        print("  收掉了 %d 个还在跑的窗口 / 进程" % n)

    gone = remove_shortcuts()
    print("  快捷方式  删了 %d 个" % len(gone))
    print("  注册表    %s" % ("已清" if remove_registry() else "清理失败（可手删）"))

    if a.keep:
        print("\n  按你的要求保留了程序目录。")
        return 0

    # 不该被 .cmd 删掉的东西，先自己弄走
    if not a.purge:
        stash = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"),
                             APP_NAME)
        os.makedirs(stash, exist_ok=True)
        for f in keep:
            src = os.path.join(d, f)
            dst = os.path.join(stash, f)
            try:
                os.replace(src, dst)
                print("  搬走      %s → %s" % (f, stash))
            except OSError as exc:
                print("  [!] 搬 %s 失败：%s" % (f, exc))

    script = write_selfdestruct_cmd(d)
    subprocess.Popen(["cmd", "/c", script],
                     creationflags=0x00000008 | 0x00000200,   # DETACHED | NEW_GROUP
                     close_fds=True)
    print("\n  程序目录会在几秒内删掉（正在跑的卸载器删不掉自己，交给它了）。")
    if not a.purge and keep:
        print("  你的配置已搬到：%s" % os.path.join(
            os.environ.get("APPDATA") or os.path.expanduser("~"), APP_NAME))
    print("=" * 66)
    return 0


if __name__ == "__main__":
    sys.exit(main())
