#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把项目打成 Windows 可执行文件 + 安装包。

产出（都在 dist/ 下）：

    dist/GrokBuildCenter/            免安装版（整个目录拷走就能用）
      GrokBuildCenter.exe            主程序：体检 / 面板 / 历史网页 / 会话管理
    dist/GrokBuildCenter-Setup.exe   安装包（单文件，双击就装）
    dist/GrokBuildCenter-portable.zip  上面那个免安装目录的压缩包

跑法：

    python tools/build_exe.py                 # 全打（主程序 + 安装包 + zip）
    python tools/build_exe.py --app           # 只打主程序，调 UI 时够用
    python tools/build_exe.py --skip-clean    # 复用上次的 build/（快一点，但脏）

为什么一定要用项目自带的 .venv：
PyInstaller 会把**当前解释器里装的东西**一起打进去。用系统的 python 打出来
的包会缺 lark-oapi（面板要它），装到别人机器上第一句 import 就崩。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIST = os.path.join(ROOT, "dist")
BUILD = os.path.join(ROOT, "build")
APP_NAME = "GrokBuildCenter"
ICON = os.path.join(ROOT, "assets", "icon", "center.ico")


def venv_python() -> str:
    p = os.path.join(ROOT, ".venv", "Scripts", "python.exe")
    if os.path.exists(p):
        return p
    print("[!] 没找到 .venv，用当前解释器打 —— 打出来的包可能缺依赖。")
    print("    先跑：python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt")
    print("    离线装：.venv\\Scripts\\pip install --no-index --find-links tools\\wheels -r requirements.txt")
    return sys.executable


def run(cmd: list[str], **kw) -> None:
    print("  $ " + " ".join('"%s"' % c if " " in c else c for c in cmd))
    r = subprocess.run(cmd, cwd=ROOT, **kw)
    if r.returncode != 0:
        raise SystemExit("[x] 失败（退出码 %d）：%s" % (r.returncode, cmd[0]))


def pyinstaller(*args: str) -> None:
    run([venv_python(), "-m", "PyInstaller", *args])


# ---------------------------------------------------------------- 主程序

def build_app(clean: bool) -> str:
    print("\n[1/4] 主程序 " + APP_NAME + ".exe")
    args = [
        "--noconfirm",
        "--onedir",                       # 目录式：启动快，且安装包直接拷目录
        "--console",                      # 它是命令行工具，不是 GUI
        "--name", APP_NAME,
        "--distpath", DIST,
        "--workpath", BUILD,
        "--specpath", BUILD,
        "--paths", ROOT,
        # 可写状态（config.json 等）在 exe 旁边，不埋进包里 —— 见 feishu_hub/paths.py
        "--hidden-import", "tools.sessions",
        "--hidden-import", "tools.sessions_html",
        "--hidden-import", "tools.smoke_test",
        "--hidden-import", "tools.config_ready",
        "--hidden-import", "tools.make_lnk",
        # lark-oapi 的 event 模型是动态 import 的，静态分析收不全
        "--collect-submodules", "lark_oapi",
        "--collect-submodules", "feishu_hub",
        "--exclude-module", "PyInstaller",
        "--exclude-module", "tkinter",
        "--exclude-module", "unittest",
    ]
    if clean:
        args.append("--clean")
    if os.path.exists(ICON):
        args += ["--icon", ICON]
    else:
        print("  [!] 没有图标 %s，先用默认的。生成：python tools/make_icon.py" % ICON)
    # 品牌资产带上，体积可忽略；改了 SVG 不用重新打包也能看到
    assets = os.path.join(ROOT, "assets")
    if os.path.isdir(assets):
        args += ["--add-data", assets + os.pathsep + "assets"]
    example = os.path.join(ROOT, "config.json.example")
    if os.path.exists(example):
        args += ["--add-data", example + os.pathsep + "."]
    args.append(os.path.join(HERE, "app.py"))
    pyinstaller(*args)

    exe = os.path.join(DIST, APP_NAME, APP_NAME + ".exe")
    if not os.path.exists(exe):
        raise SystemExit("[x] 没打出 " + exe)
    return exe


# ---------------------------------------------------------------- 安装包

# 运行时才产生的文件。**不能进安装包**：一是在别人机器上没意义，
# 二是 config.json 里可能有你的飞书凭证（这个是真会出事的）。
RUNTIME_JUNK = (
    "session-history.html", "sessions.html", "sessions-board.html",
    "card-preview.html", "bitable-preview.html",
    "config.json", "panel.json", "bitable-state.json",
)


def clean_payload() -> list[str]:
    """把 dist/<APP> 里运行时留下的东西清掉。

    为什么会有：调试打包产物时直接在 dist 里跑了一次 exe，于是
    `data_root()`（= exe 旁边）就落了 session-history.html。
    不清掉的话，它会被原样打进安装包发出去。
    """
    app_dir = os.path.join(DIST, APP_NAME)
    gone = []
    for name in RUNTIME_JUNK:
        p = os.path.join(app_dir, name)
        if os.path.exists(p):
            os.remove(p)
            gone.append(name)
    return gone


def stage_extras() -> str:
    """把 `config.json.example` 也放一份到 exe 旁边。

    `--add-data` 只会把它塞进 `_internal\\`，免安装版的人翻不到那儿。
    放根目录一份，装完/解压完一眼就能看见「哦，要复制成 config.json」。
    """
    src = os.path.join(ROOT, "config.json.example")
    dst = os.path.join(DIST, APP_NAME, "config.json.example")
    if os.path.exists(src):
        shutil.copy2(src, dst)
        return dst
    return ""


def build_uninstaller() -> str:
    """卸载器要被放进程序目录里，所以必须在打安装包**之前**就位。"""
    print("\n[2/4] 卸载器 uninstall.exe")
    args = [
        "--noconfirm",
        "--onefile",
        "--console",
        "--name", "uninstall",
        "--distpath", DIST,
        "--workpath", os.path.join(BUILD, "uninstall"),
        "--specpath", BUILD,
        "--exclude-module", "PyInstaller",
        "--exclude-module", "tkinter",
    ]
    if os.path.exists(ICON):
        args += ["--icon", ICON]
    args.append(os.path.join(ROOT, "installer", "uninstall_main.py"))
    pyinstaller(*args)

    src = os.path.join(DIST, "uninstall.exe")
    if not os.path.exists(src):
        raise SystemExit("[x] 没打出 " + src)
    # 放进程序目录：安装包和 zip 都会带上它
    dst = os.path.join(DIST, APP_NAME, "uninstall.exe")
    shutil.copy2(src, dst)
    os.remove(src)
    return dst


def build_setup() -> str:
    print("\n[3/4] 安装包 " + APP_NAME + "-Setup.exe")
    payload = os.path.join(DIST, APP_NAME)
    if not os.path.isdir(payload):
        raise SystemExit("[x] 先打主程序（缺 %s）" % payload)
    args = [
        "--noconfirm",
        "--onefile",                      # 安装包就该是单文件，方便传
        "--console",
        "--name", APP_NAME + "-Setup",
        "--distpath", DIST,
        "--workpath", os.path.join(BUILD, "setup"),
        "--specpath", BUILD,
        "--paths", ROOT,
        "--hidden-import", "tools.make_lnk",   # 建快捷方式要它（ctypes/COM）
        "--exclude-module", "PyInstaller",
        "--exclude-module", "tkinter",
        "--add-data", payload + os.pathsep + "payload",
    ]
    if os.path.exists(ICON):
        args += ["--icon", ICON]
    args.append(os.path.join(ROOT, "installer", "setup_main.py"))
    pyinstaller(*args)

    exe = os.path.join(DIST, APP_NAME + "-Setup.exe")
    if not os.path.exists(exe):
        raise SystemExit("[x] 没打出 " + exe)
    return exe


def build_zip() -> str:
    print("\n[4/4] 免安装 zip")
    src = os.path.join(DIST, APP_NAME)
    out = os.path.join(DIST, APP_NAME + "-portable.zip")
    if os.path.exists(out):
        os.remove(out)
    n = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dirpath, _dirnames, filenames in os.walk(src):
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, os.path.dirname(src))
                z.write(full, rel)
                n += 1
    print("  打进 %d 个文件，%.1f MB" % (n, os.path.getsize(out) / 1024 / 1024))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="打 Windows exe + 安装包")
    ap.add_argument("--app", action="store_true", help="只打主程序，不做安装包")
    ap.add_argument("--setup-only", action="store_true",
                    help="只重打安装包 + zip（改 installer/ 之后用这个，省两分钟）")
    ap.add_argument("--skip-clean", action="store_true", help="复用 build/，快但脏")
    a = ap.parse_args()

    t0 = time.time()
    print("=" * 68)
    print("  Grok Build Center · 打包")
    print("  Python  %s" % venv_python())
    print("=" * 68)

    if a.setup_only:
        if not os.path.isdir(os.path.join(DIST, APP_NAME)):
            raise SystemExit("[x] 还没有主程序，先跑一次完整打包")
        # 卸载器也在 installer/ 里，改过它必须跟着重打 ——
        # 否则装出来的包会带着上一次编进去的旧卸载逻辑（踩过）
        shutil.rmtree(os.path.join(BUILD, "uninstall"), ignore_errors=True)
        u = build_uninstaller()
        print("  [ok] %s" % u)
        junk = clean_payload()
        if junk:
            print("  [ok] 清掉运行时残留：%s" % "、".join(junk))
        stage_extras()
        setup = build_setup()
        print("  [ok] %s  (%.1f MB)" % (setup, os.path.getsize(setup) / 1024 / 1024))
        z = build_zip()
        print("  [ok] %s" % z)
        print("\n耗时 %.0f 秒" % (time.time() - t0))
        return 0

    if not a.skip_clean:
        for d in (BUILD,):
            if os.path.isdir(d):
                shutil.rmtree(d, ignore_errors=True)

    exe = build_app(clean=not a.skip_clean)
    print("  [ok] %s  (%.1f MB)" % (exe, os.path.getsize(exe) / 1024 / 1024))
    stage_extras()

    if a.app:
        print("\n耗时 %.0f 秒" % (time.time() - t0))
        return 0

    u = build_uninstaller()
    print("  [ok] %s" % u)

    junk = clean_payload()
    if junk:
        print("  [ok] 清掉运行时残留：%s" % "、".join(junk))

    setup = build_setup()
    print("  [ok] %s  (%.1f MB)" % (setup, os.path.getsize(setup) / 1024 / 1024))
    z = build_zip()
    print("  [ok] %s" % z)

    print("\n" + "=" * 68)
    print("  完成，耗时 %.0f 秒" % (time.time() - t0))
    print("    免安装  %s" % os.path.join(DIST, APP_NAME))
    print("    安装包  %s" % setup)
    print("    zip     %s" % z)
    print("=" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())
