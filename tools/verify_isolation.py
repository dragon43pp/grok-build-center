# -*- coding: utf-8 -*-
"""验证我们的改版构建和用户在用的 HRack 完全隔离。

做三件事：
  1. 启动前给 %APPDATA%\\HRack 拍快照（路径+大小+mtime）
  2. 用独立的 GBC_USER_DATA_DIR 启动我们的构建，等它起来再关掉
  3. 启动后重新拍快照，比对 —— 一处都不许变

这是「改版不许动我在用的会话」这条要求的可执行证明。
"""
from __future__ import annotations

import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

APP = r"D:\grok-build-center-desktop"
ELECTRON = os.path.join(APP, "node_modules", "electron", "dist", "electron.exe")
MAIN = os.path.join(APP, "out", "main", "index.js")
USER_HRACK = os.path.join(os.environ["APPDATA"], "HRack")
ISOLATED = os.path.join(os.environ["TEMP"], "gbc-isolation-test")
NODE = r"C:\Users\admin\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
SHOT = os.path.join(APP, "tools", "shot.mjs")


def snapshot(root: str) -> dict:
    """路径 -> (size, mtime_ns)。取不到就跳过（有文件正在被写）。"""
    out: dict[str, tuple[int, int]] = {}
    if not os.path.isdir(root):
        return out
    for base, _dirs, files in os.walk(root):
        for name in files:
            p = os.path.join(base, name)
            try:
                st = os.stat(p)
                out[os.path.relpath(p, root)] = (st.st_size, st.st_mtime_ns)
            except OSError:
                pass
    return out


def main() -> int:
    args = sys.argv[1:]
    cdp_port = None
    shot_path = None
    if "--cdp" in args:
        cdp_port = int(args[args.index("--cdp") + 1])
    if "--shot" in args:
        shot_path = args[args.index("--shot") + 1]

    print("=" * 72)
    print("第 1 步：启动前快照 %s" % USER_HRACK)
    before = snapshot(USER_HRACK)
    print("      文件数 %d" % len(before))

    import shutil
    shutil.rmtree(ISOLATED, ignore_errors=True)

    # 必须清掉：WorkBuddy 自己是 Electron 应用，会把这个变量遗传给子进程，
    # 带上它 Electron 会以纯 Node 模式跑，主进程根本不会启动。
    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env.pop("NODE_OPTIONS", None)
    env["GBC_USER_DATA_DIR"] = ISOLATED
    env["HRACK_DISABLE_UPDATES"] = "1"

    cmd = [ELECTRON, MAIN]
    if cdp_port:
        cmd.append("--remote-debugging-port=%d" % cdp_port)

    print()
    print("第 2 步：以独立 userData 启动我们的构建")
    print("      GBC_USER_DATA_DIR = %s" % ISOLATED)
    proc = subprocess.Popen(
        cmd,
        cwd=APP,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    time.sleep(22)

    alive = proc.poll() is None
    print("      进程存活: %s" % alive)

    if alive and cdp_port:
        if shot_path:
            print("      通过 CDP 截图 -> %s" % shot_path)
            rc = subprocess.call(
                [NODE, SHOT, shot_path, str(cdp_port), "20000"],
                cwd=APP,
                env=env,
            )
            if rc != 0:
                print("      ✗ 截图失败，退出码 %s" % rc)

    out = b""
    try:
        proc.terminate()
        out = proc.communicate(timeout=15)[0] or b""
    except subprocess.TimeoutExpired:
        proc.kill()
    text = out.decode("utf-8", "replace")
    key = [ln for ln in text.splitlines() if "[gbc]" in ln or "[hrack]" in ln or "Error" in ln or "error" in ln]
    print("      ---- 主进程日志（关键行）----")
    for ln in key[:14]:
        print("        " + ln.strip()[:150])

    print()
    print("第 3 步：检查隔离结果")
    after = snapshot(USER_HRACK)
    print("      %s 文件数 %d -> %d" % (USER_HRACK, len(before), len(after)))

    changed = []
    for k, v in after.items():
        if k not in before:
            changed.append("新增 " + k)
        elif before[k] != v:
            changed.append("改动 " + k)
    for k in before:
        if k not in after:
            changed.append("删除 " + k)

    if changed:
        print("      ✗ 用户数据被动过！%d 处：" % len(changed))
        for c in changed[:20]:
            print("         " + c)
    else:
        print("      ✓ 用户数据零改动")

    iso = snapshot(ISOLATED)
    print()
    print("      独立目录 %s: %d 个文件" % (ISOLATED, len(iso)))
    for k in sorted(iso)[:12]:
        print("         " + k)

    ok = (not changed) and len(iso) > 0
    print()
    print("结论：%s" % ("✓ 隔离成立，改版可以安全运行" if ok else "✗ 隔离失败，需要排查"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
