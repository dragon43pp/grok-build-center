#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Grok Build Center · 安装程序
============================

为什么自己写而不用 Inno Setup / NSIS：本机两个都没装，引一个进来还要占
一份构建依赖；而这个安装器要做的事只有四件 —— 拷文件、建快捷方式、
写卸载登记、留一个能删干净自己的卸载器。本仓库连 PNG/ICO 编码器都是手写的，
没道理在这里引一整个打包框架。

装到哪：

    %LOCALAPPDATA%\\Programs\\Grok Build Center      ← 默认，**不需要管理员**

刻意不往 Program Files 装：那要 UAC 提权，而这个工具是给单个用户用的，
`config.json` 就在程序目录里，放用户目录下也更好改。

卸载登记写在 HKCU，所以「设置 → 应用」里看得到、卸得掉，且全程不要管理员。

命令行：

    GrokBuildCenter-Setup.exe                    交互安装
    GrokBuildCenter-Setup.exe --silent           静默装到默认目录
    GrokBuildCenter-Setup.exe --silent --dir D:\\x
    GrokBuildCenter-Setup.exe --silent --no-shortcuts
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time

APP_NAME = "Grok Build Center"
APP_ID = "GrokBuildCenter"
EXE_NAME = "GrokBuildCenter.exe"
CLI_EXE_NAME = "GrokBuildCenter-cli.exe"
UNINST_EXE = "uninstall.exe"
PUBLISHER = "dragon43pp"
HOMEPAGE = "https://github.com/dragon43pp/grok-build-center"


def _version() -> str:
    """版本号只有一处定义（feishu_hub/__init__.py）。

    安装包自己写一份的后果很具体：装完之后 `version` 打印的是新版，
    而「添加或删除程序」里还挂着旧版号 —— 用户会以为没装上。
    """
    try:
        from feishu_hub import __version__
        return __version__
    except Exception:
        return "0.0.0"


VERSION = _version()

UNINST_KEY = ("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"
              + APP_ID)


# ------------------------------------------------------------------ 路径

def local_appdata() -> str:
    v = os.environ.get("LOCALAPPDATA")
    if v:
        return v
    return os.path.join(os.path.expanduser("~"), "AppData", "Local")


def default_dir() -> str:
    return os.path.join(local_appdata(), "Programs", APP_NAME)


def start_menu_dir() -> str:
    v = os.environ.get("APPDATA")
    base = v or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    return os.path.join(base, "Microsoft", "Windows", "Start Menu", "Programs")


def desktop_dir() -> str:
    return os.path.join(os.path.expanduser("~"), "Desktop")


def payload_dir() -> str:
    """打进包里的那份程序本体。onefile 时在 sys._MEIPASS/payload。"""
    if getattr(sys, "frozen", False):
        return os.path.join(getattr(sys, "_MEIPASS", ""), "payload")
    # 开发时直接拿 dist/ 里那份
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(here, "dist", "GrokBuildCenter")


# ------------------------------------------------------------------ 步骤

def copy_payload(src: str, dst: str) -> int:
    os.makedirs(dst, exist_ok=True)
    n = 0
    for dirpath, _dirnames, filenames in os.walk(src):
        rel = os.path.relpath(dirpath, src)
        target = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(target, exist_ok=True)
        for fn in filenames:
            s = os.path.join(dirpath, fn)
            d = os.path.join(target, fn)
            # 覆盖，但**不动**用户自己的 config.json / panel.json
            if fn in ("config.json", "panel.json", "bitable-state.json") and os.path.exists(d):
                continue
            shutil.copy2(s, d)
            n += 1
    return n


def _find_under(root: str, rel: str) -> str:
    """在 root 和 root/_internal 里找一个文件。

    为什么要有 `_internal`：PyInstaller 的 onedir 会把 `--add-data` 的东西
    全放进 `_internal/`，不在 exe 旁边。不知道这点就会「文件明明在包里，
    却一个都找不到」。
    """
    for base in (root, os.path.join(root, "_internal")):
        p = os.path.join(base, *rel.split("/"))
        if os.path.exists(p):
            return p
    return ""


def write_example_config(install_dir: str) -> str:
    """在**程序根目录**放一份 config.json.example，用户复制一下就能填。

    刻意不自动生成 config.json：没有飞书凭证时生成一个空文件，
    只会让人以为「已经配好了」，然后对着面板一脸问号。
    """
    dst = os.path.join(install_dir, "config.json.example")
    if os.path.exists(dst):
        return dst
    src = ""
    for cand in (
        _find_under(install_dir, "config.json.example"),
        _find_under(payload_dir(), "config.json.example"),
        os.path.join(getattr(sys, "_MEIPASS", ""), "config.json.example"),
    ):
        if cand and os.path.exists(cand):
            src = cand
            break
    if not src:
        return ""
    shutil.copy2(src, dst)
    return dst


def make_shortcuts(install_dir: str, with_desktop: bool) -> list[str]:
    """建快捷方式。复用 tools/make_lnk.py —— 手写 .lnk 二进制是踩过的坑。"""
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from tools.make_lnk import make_shortcut

    target = os.path.join(install_dir, EXE_NAME)
    # 图标在 _internal 里（见 _find_under 的说明），找不到就拿 exe 自己当图标
    icon = _find_under(install_dir, "assets/icon/center.ico") or target
    desc = "Grok Build 会话管理中心 —— 卡住了它主动找你"

    made: list[str] = []
    lnk = os.path.join(start_menu_dir(), APP_NAME + ".lnk")
    make_shortcut(target, lnk, workdir=install_dir, desc=desc, icon=icon)
    made.append(lnk)

    if with_desktop:
        d = os.path.join(desktop_dir(), APP_NAME + ".lnk")
        make_shortcut(target, d, workdir=install_dir, desc=desc, icon=icon)
        made.append(d)
    return made


def build_uninstaller(install_dir: str) -> str:
    """把打包时带上的 uninstall.exe 放过去。没有就跳过（不假装成功）。"""
    for cand in (
        os.path.join(payload_dir(), UNINST_EXE),
        os.path.join(getattr(sys, "_MEIPASS", ""), UNINST_EXE),
    ):
        if os.path.exists(cand):
            dst = os.path.join(install_dir, UNINST_EXE)
            shutil.copy2(cand, dst)
            return dst
    return ""


def register(install_dir: str) -> None:
    """写「应用和功能」里的那条登记（HKCU，不要管理员）。"""
    import winreg

    exe = os.path.join(install_dir, EXE_NAME)
    icon = os.path.join(install_dir, "assets", "icon", "center.ico")
    uninst = os.path.join(install_dir, UNINST_EXE)
    uninst_cmd = ('"%s"' % uninst) if os.path.exists(uninst) \
        else ('"%s" --uninstall' % exe)

    key = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, UNINST_KEY, 0,
                             winreg.KEY_WRITE)
    with key:
        vals = [
            ("DisplayName", APP_NAME),
            ("DisplayVersion", VERSION),
            ("Publisher", PUBLISHER),
            ("InstallLocation", install_dir),
            ("DisplayIcon", icon if os.path.exists(icon) else exe),
            ("UninstallString", uninst_cmd),
            ("QuietUninstallString", uninst_cmd + " --silent"),
            ("URLInfoAbout", HOMEPAGE),
            ("NoModify", 1),
            ("NoRepair", 1),
        ]
        for name, val in vals:
            winreg.SetValueEx(key, name, 0,
                              winreg.REG_DWORD if isinstance(val, int) else winreg.REG_SZ,
                              val)
        # 体积（KB），让「应用和功能」里不显示空白
        size = 0
        for dirpath, _dn, fns in os.walk(install_dir):
            for fn in fns:
                try:
                    size += os.path.getsize(os.path.join(dirpath, fn))
                except OSError:
                    pass
        winreg.SetValueEx(key, "EstimatedSize", 0, winreg.REG_DWORD,
                          max(1, size // 1024))


# ------------------------------------------------------------------ 入口

def banner() -> None:
    print()
    print("=" * 66)
    print("  %s  ·  安装程序  v%s" % (APP_NAME, VERSION))
    print("=" * 66)


def main() -> int:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description=APP_NAME + " 安装程序")
    ap.add_argument("--silent", action="store_true", help="不问任何问题")
    ap.add_argument("--dir", default=None, help="安装目录")
    ap.add_argument("--no-shortcuts", action="store_true",
                    help="不建开始菜单 / 桌面快捷方式")
    ap.add_argument("--no-desktop", action="store_true", help="不建桌面快捷方式")
    a = ap.parse_args()

    banner()
    src = payload_dir()
    if not os.path.isdir(src) or not os.path.exists(os.path.join(src, EXE_NAME)):
        print("[x] 安装包里的程序本体不完整（缺 %s）。" % os.path.join(src, EXE_NAME))
        print("    这个文件是打包产物，别单独拷出去用。")
        return 2

    install_dir = os.path.abspath(a.dir) if a.dir else default_dir()

    if not a.silent:
        print("  将安装到：")
        print("    %s" % install_dir)
        print("  不写系统目录、不要管理员权限；卸载在「设置 → 应用」里。")
        print()
        try:
            ans = input("  回车开始安装，输 n 取消：").strip().lower()
        except (EOFError, KeyboardInterrupt):
            ans = "n"
        if ans.startswith("n"):
            print("  已取消。")
            return 1

    t0 = time.time()
    print("\n  [1/5] 拷贝文件到 %s" % install_dir)
    n = copy_payload(src, install_dir)
    print("        %d 个文件" % n)

    print("  [2/5] 放一份 config.json.example")
    ex = write_example_config(install_dir)
    print("        " + ex if ex else "        跳过（包里没有，这个包不完整）")

    print("  [3/5] 卸载器")
    u = build_uninstaller(install_dir)
    print("        " + (u if u else "跳过（包里没有 uninstall.exe）"))

    print("  [4/5] 快捷方式")
    if a.no_shortcuts:
        print("        按你的要求跳过")
    else:
        try:
            for p in make_shortcuts(install_dir, with_desktop=not a.no_desktop):
                print("        " + p)
        except Exception as exc:                       # noqa: BLE001
            print("        [!] 建快捷方式失败：%s" % exc)
            print("            不影响主程序，手动跑 %s 也一样。"
                  % os.path.join(install_dir, EXE_NAME))

    print("  [5/5] 写卸载登记（HKCU，不要管理员）")
    try:
        register(install_dir)
        print("        好了，能在「设置 → 应用」里看到并卸载")
    except OSError as exc:
        print("        [!] 写注册表失败：%s" % exc)

    exe = os.path.join(install_dir, EXE_NAME)
    print("\n" + "=" * 66)
    print("  装好了，用了 %.1f 秒" % (time.time() - t0))
    print()
    print("  现在就能用（没配飞书也跑得了，走离线体检）：")
    print("    \"%s\"" % exe)
    print("  或者从开始菜单点「%s」。" % APP_NAME)
    print()
    print("  想让会话卡住时在手机上收到并放行 → 照按 README 配好飞书，")
    print("  然后把 config.json 放到：%s" % install_dir)
    print("=" * 66)

    if not a.silent:
        try:
            ans = input("\n  现在打开看看？(Y/n) ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            ans = "n"
        if not ans.startswith("n"):
            import subprocess
            # 用新窗口跑，免得它一退出连安装窗口一起没了
            subprocess.Popen(
                ["cmd", "/c", "start", "", "cmd", "/k", exe, "check"],
                cwd=install_dir, close_fds=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
