# -*- coding: utf-8 -*-
"""给「跑一次 UI 测试会不会动用户数据」留证据。

比 `verify_readonly.py` 更粗一层：那个证明的是纯读路径（`discoverSessions()`），
这个证明的是一次**完整的应用启动 + 点击**期间用户数据的变化。

为什么不能用「逐字节未变」当判据：启动扫描要探每个 CLI（跑 `--version` 之类），
被探的 CLI 会自己写自己的家目录（本机实测 grok 会写 `memtrace/*.jsonl` 和
`active_sessions.json`）。那是 CLI 自己的行为、由**探测**引起，不是我们改了它。

所以正确的判据是两条，脚本两条都判：
  1. **不许出现新的会话**。`.grok/sessions` / `.claude/projects` / codex 的
     `sessions/` 下面新增任何文件都是问题 —— 那说明真的把 CLI 跑起来了。
  2. 变化要能解释。把改动/新增逐条列出来，由人确认它们都是 CLI 自写。

用法：
    python tools/fp.py snapshot <状态文件>
    <跑被测的东西>
    python tools/fp.py compare  <状态文件>
"""

from __future__ import annotations

import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOME = os.path.expanduser("~")
APPDATA = os.environ.get("APPDATA", "")

ROOTS = [
    os.path.join(HOME, ".grok"),
    os.path.join(HOME, ".claude"),
    os.path.join(HOME, ".codex"),
    r"D:\codex-home",
    os.path.join(HOME, ".local", "share", "opencode"),
    os.path.join(HOME, ".kimi-code"),
    os.path.join(HOME, ".pi", "agent"),
    os.path.join(HOME, ".gemini", "antigravity"),
    os.path.join(HOME, ".gemini", "antigravity-cli"),
    os.path.join(APPDATA, "HRack"),
]

# 这些子路径下面**新增任何文件**都视为「真的把 CLI 跑起来了」，直接算失败。
SESSION_SPOOR = [
    os.path.join(HOME, ".grok", "sessions"),
    os.path.join(HOME, ".claude", "projects"),
    os.path.join(HOME, ".codex", "sessions"),
]


def snapshot() -> dict[str, list]:
    out: dict[str, list] = {}
    for root in ROOTS:
        root = os.path.realpath(root)
        if not os.path.isdir(root):
            continue
        for base, _dirs, files in os.walk(root, followlinks=True):
            for name in files:
                path = os.path.join(base, name)
                try:
                    info = os.stat(path)
                except OSError:
                    continue  # 有进程正在写，跳过
                out[path] = [info.st_size, info.st_mtime_ns]
    return out


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("snapshot", "compare"):
        print(__doc__)
        return 2
    mode, state = sys.argv[1], sys.argv[2]

    if mode == "snapshot":
        data = snapshot()
        with open(state, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        print(f"已记录 {len(data)} 个文件的指纹 -> {state}")

        # 提示当前有多少「会话」文件，跑完再比一次就知道有没有多出来。
        for spoor in SESSION_SPOOR:
            print(f"  会话文件 {sum(1 for p in data if p.startswith(os.path.realpath(spoor))):>6}  {spoor}")
        return 0

    before = json.load(open(state, encoding="utf-8"))
    after = snapshot()

    added = sorted(p for p in after if p not in before)
    removed = sorted(p for p in before if p not in after)
    changed = sorted(p for p in after if p in before and after[p] != before[p])

    print(f"新增 {len(added)} · 消失 {len(removed)} · 改动 {len(changed)}")
    for label, items in (("+", added), ("-", removed), ("~", changed)):
        for path in items[:30]:
            print(f"  {label} {path}")
        if len(items) > 30:
            print(f"  {label} … 另有 {len(items) - 30} 项")

    leaks = [p for p in added if any(p.startswith(os.path.realpath(s)) for s in SESSION_SPOOR)]
    print()
    if leaks:
        print(f"FAIL  会话目录里多出 {len(leaks)} 个文件 —— 说明真的把 CLI 跑起来了：")
        for path in leaks[:10]:
            print(f"        {path}")
        return 1
    print("结论：没有新增任何会话文件。上面那些变化若是 CLI 自写（探测引起）即为可接受。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
