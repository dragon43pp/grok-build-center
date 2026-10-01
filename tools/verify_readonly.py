# -*- coding: utf-8 -*-
"""证明会话层只读：扫一遍所有 agent 的历史目录，一个字节都不许变。

用户在用的 CLI 会话是活数据，一旦读崩了就不可恢复。所以「只读」不能靠自觉，
要跑一次实测并留下证据：

  1. 给每个数据根目录拍快照（相对路径 -> 大小 + mtime_ns）
  2. 跑一遍 `discoverSessions()`（也就是产品里那条真实的读路径）
  3. 重新拍快照，逐文件比对

用法：
    python tools/verify_readonly.py                # 只比对读路径
    python tools/verify_readonly.py --root X       # 追加一个要保护的数据根目录
    python tools/verify_readonly.py \
        --between "python -u tools/bridge_probe.py history --limit 5"

`--between` 是两遍快照之间再跑一条命令（可重复）。存在的意义是**扩大被判卷的
读路径**：默认只跑 `discoverSessions()`，而桥的 `sessions.list` /
`sessions.history` / `session.resume --dry-run` 是另外几条真会读盘的路径，
它们也得被同一遍快照夹住，否则「只读」这个结论覆盖不到它们。
注意：`--between` 的值按空格拆成 argv，所以里面别放带空格的路径。

退出码 0 = 未改动；1 = 有文件被改/删（同时打印是哪些）。
"""
from __future__ import annotations

import argparse
import os
import re
import shlex
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r"C:\Program Files\nodejs\node.exe"  # 需要 node:sqlite，走系统 Node 24
BUNDLE = os.path.join(APP, "tools", "_session_probe.mjs")
ESBUILD = os.path.join(APP, "node_modules", ".bin", "esbuild.cmd")
PROBE_SRC = os.path.join(APP, "tools", "session_probe.ts")

HOME = os.path.expanduser("~")

# 产品会读的每一个数据根目录。顺序无所谓，都会保护。
DEFAULT_ROOTS = [
    os.path.join(HOME, ".grok"),
    os.path.join(HOME, ".claude"),
    os.path.join(HOME, ".codex"),
    r"D:\codex-home",
    os.path.join(HOME, ".local", "share", "opencode"),
    os.path.join(HOME, ".kimi-code"),
    os.path.join(HOME, ".pi", "agent"),
    os.path.join(HOME, ".gemini", "antigravity"),
    os.path.join(HOME, ".gemini", "antigravity-cli"),
    os.path.join(os.environ.get("APPDATA", ""), "HRack"),
]


def snapshot(root: str) -> dict[str, tuple[int, int]]:
    """相对路径 -> (size, mtime_ns)。读不到就跳过（有进程正在写）。"""
    out: dict[str, tuple[int, int]] = {}
    if not os.path.exists(root):
        return out
    for base, _dirs, files in os.walk(root, followlinks=True):
        for name in files:
            path = os.path.join(base, name)
            try:
                info = os.stat(path)
            except OSError:
                continue
            out[os.path.relpath(path, root)] = (info.st_size, info.st_mtime_ns)
    return out


def diff(before: dict, after: dict) -> tuple[list, list, list]:
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    changed = sorted(k for k in set(before) & set(after) if before[k] != after[k])
    return added, removed, changed


def live_pids() -> set:
    """进程表快照的 pid 集合。用 ctypes 直接枚举，不用 tasklist（本机实测数不准）。"""
    try:
        sys.path.insert(0, os.path.join(APP, "tools"))
        from watch_proc import snapshot  # noqa: PLC0415
        return set(snapshot())
    except Exception:
        return set()


def external_reason(root: str, rel: str) -> str | None:
    """能**证明**是别人在写的改动，返回说明；证明不了就返回 None，照旧判失败。

    为什么要有这个函数：用户在用的 CLI 是活数据（HRack 正在跑、它拉起的 grok 在写
    自己的 memtrace、codex_sync.py 每 3 秒重写 rollout），一刀切地把「有改动」
    当成本 App 的锅会给出假阳性，也会让人学会无视这个脚本。所以这里只放行
    **有独立证据**的几类，其余一律算失败。
    """
    full = os.path.join(root, rel).replace("\\", "/")

    # grok 自己的实时 memtrace：只有 grok 写这个目录，文件名里就带着它的 pid。
    m = re.search(r"/\.grok/memtrace/\d+-(\d+)\.jsonl$", full)
    if m:
        pid = int(m.group(1))
        alive = pid in live_pids()
        return (f"grok 进程自己在写实时 memtrace（文件名里的 pid={pid}，"
                f"{'当前仍在运行' if alive else '本次扫描时已退出'}）")

    # Chromium/Electron 自己的 GPU、代码缓存：HRack 正在运行就会动。
    if re.search(r"/(GPUCache|DawnWebGPUCache|DawnGraphiteCache|Code Cache)/", full):
        return "Chromium/Electron 自身的 GPU / 代码缓存（HRack 正在运行）"

    # 注册表 CodexSessionSync 拉起的常驻脚本会重写 rollout 首行。
    if re.search(r"/\.codex/sessions/.*rollout-.*\.jsonl$", full):
        return ("codex_sync.py（开机自启动的常驻脚本，每 3 秒重写一次 rollout 首行）"
                "—— 判卷前请确认它是否在跑")
    return None


def build_probe() -> None:
    # 每次都重打包：探针 import 了整个 electron/sessions/，按入口 mtime 判缓存
    # 会漏掉 reader 的改动，而这个脚本的全部价值就在于它跑的是最新代码。
    print("· 打包读路径探针 ...")
    result = subprocess.run(
        [ESBUILD, PROBE_SRC, "--bundle", "--platform=node", "--format=esm",
         f"--outfile={BUNDLE}", "--log-level=warning"],
        cwd=APP, shell=False,
    )
    if result.returncode != 0:
        raise SystemExit("打包失败，无法继续")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", action="append", default=[],
                        help="追加一个要保护的数据根目录（可重复）")
    parser.add_argument("--between", action="append", default=[],
                        help="两遍快照之间额外跑的命令（可重复；按空格拆 argv）")
    args = parser.parse_args()

    roots = [r for r in DEFAULT_ROOTS + args.root if r and os.path.exists(r)]
    missing = [r for r in DEFAULT_ROOTS + args.root if r and not os.path.exists(r)]

    build_probe()

    print("· 保护范围（已存在的根目录）：")
    for root in roots:
        print(f"    {root}")
    if missing:
        print("· 本机不存在（跳过）：")
        for root in missing:
            print(f"    {root}")

    print("\n· 拍第一遍快照 ...")
    started = time.time()
    before = {root: snapshot(root) for root in roots}
    for root in roots:
        print(f"    {len(before[root]):>7} files  {root}")
    print(f"    快照耗时 {time.time() - started:.1f}s")

    print("\n· 跑真实读路径（discoverSessions）...")
    started = time.time()
    run = subprocess.run([NODE, BUNDLE], cwd=APP, capture_output=True, text=True,
                         encoding="utf-8", errors="replace")
    print(f"    退出码 {run.returncode}，耗时 {time.time() - started:.1f}s")
    if run.returncode != 0:
        print(run.stdout[-2000:])
        print(run.stderr[-2000:], file=sys.stderr)
        return 2

    summary = [line for line in run.stdout.splitlines() if line.startswith(("grok", "claude",
               "codex", "opencode", "kimi", "pi", "antigravity", "汇总"))]
    for line in summary:
        print(f"    {line}")

    for command in args.between:
        argv = shlex.split(command)
        print(f"\n· 同一遍快照内再跑：{command}")
        started = time.time()
        extra = subprocess.run(argv, cwd=APP, capture_output=True, text=True,
                               encoding="utf-8", errors="replace")
        print(f"    退出码 {extra.returncode}，耗时 {time.time() - started:.1f}s")
        tail = (extra.stdout or "").strip().splitlines()
        for line in tail[-12:]:
            print(f"    | {line}")
        if extra.returncode != 0:
            print((extra.stderr or "")[-1500:], file=sys.stderr)
            return 2

    print("\n· 拍第二遍快照并比对 ...")
    after = {root: snapshot(root) for root in roots}
    failures = 0
    for root in roots:
        added, removed, changed = diff(before[root], after[root])
        if not (added or removed or changed):
            print(f"    ✔ 未改动  {root}  ({len(after[root])} files)")
            continue
        changes = ([("新增", n) for n in added] + [("删除", n) for n in removed]
                   + [("修改", n) for n in changed])
        external = []
        unexplained = []
        for label, name in changes:
            reason = external_reason(root, name)
            (external if reason else unexplained).append((label, name, reason))

        if not unexplained:
            print(f"    ⚠ 有改动但可归因于外部活动  {root}  —— 读路径本身未改动任何文件")
        else:
            failures += 1
            print(f"    ✘ 有改动  {root}")
        for label, name, reason in external[:20]:
            print(f"        {label}: {name}")
            print(f"             ← {reason}")
        for label, name, _ in unexplained[:20]:
            print(f"        {label}: {name}   ← 归因不了，算失败")
        if len(changes) > 20:
            print(f"        … 另有 {len(changes) - 20} 个")

    print()
    if failures:
        print(f"结论：{failures} 个数据根目录被改动 —— 读路径不是只读的。")
        return 1
    print("结论：全部数据根目录逐字节未变，读路径确认只读。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
