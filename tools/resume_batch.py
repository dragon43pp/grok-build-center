#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量恢复会话：把最近 N 场（或按条件筛出的）一次性拉回终端。

默认开在**同一个 Windows Terminal 的多个标签页**里 —— 5 场会话开 5 个窗口
会把桌面淹掉。想要独立窗口加 `--windows`。

用法：
    python tools/resume_batch.py --recent 5 --dry-run      # 先看会开哪些
    python tools/resume_batch.py --recent 5                # 真开
    python tools/resume_batch.py --project 酒馆 --recent 3
    python tools/resume_batch.py --cli codex --recent 4 --windows

安全设计：
  - 默认最多 10 场，超过要显式 `--yes`（防止手滑开 300 个终端）
  - 硬上限 30，再多也不给开
  - 每场的 cli/sid/cwd 都过 launch.plan_many() 的同一套校验
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from feishu_hub import launch  # noqa: E402
from feishu_hub.state import STATUS_LABEL, build_snapshot  # noqa: E402

DEFAULT_MAX = 10
HARD_CAP = 30


def parse_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [x.strip() for x in raw.replace("，", ",").split(",") if x.strip()]


def pick(snap, args) -> list:
    """按条件筛出要恢复的会话。返回按最近活动倒序的列表。"""
    rows = [s for s in snap.sessions if s.sid and s.resumable]

    clis = parse_list(args.cli)
    if clis:
        rows = [s for s in rows if s.cli in clis or s.cli_label in clis]

    statuses = parse_list(args.status)
    if statuses:
        # 既收英文 key（idle）也收中文标签（空闲）
        rows = [
            s for s in rows
            if s.status in statuses or STATUS_LABEL.get(s.status) in statuses
        ]

    if args.project:
        needle = args.project.lower()
        rows = [
            s for s in rows
            if needle in (s.project or "").lower() or needle in (s.cwd or "").lower()
        ]

    if args.id:
        want = set(parse_list(args.id))
        rows = [s for s in rows if s.sid in want]

    rows.sort(key=lambda s: s.last_ts or 0, reverse=True)

    if args.recent:
        rows = rows[: args.recent]
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description="批量恢复本机会话")
    ap.add_argument("--recent", type=int, default=5, help="取最近 N 场（默认 5）")
    ap.add_argument("--cli", default=None, help="按 CLI 筛，逗号分隔：codex,claude,grok,opencode")
    ap.add_argument("--status", default=None, help="按状态筛：idle,空闲,running,在跑…")
    ap.add_argument("--project", default=None, help="按项目名/路径子串筛（不区分大小写）")
    ap.add_argument("--id", default=None, help="只恢复指定会话 id（逗号分隔）")
    ap.add_argument("--windows", action="store_true", help="每场开独立窗口（默认是同一窗口多标签）")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不真开")
    ap.add_argument("--yes", action="store_true", help=f"超过 {DEFAULT_MAX} 场时确认")
    args = ap.parse_args()

    snap = build_snapshot()
    rows = pick(snap, args)

    if not rows:
        print("没有符合条件的会话。")
        return 1

    print(f"共 {snap.total} 场会话，筛出 {len(rows)} 场：\n")
    print(f"{'状态':<8}{'CLI':<13}{'项目':<22}{'最后活动':<12}标题")
    print("-" * 96)
    for s in rows:
        label = STATUS_LABEL.get(s.status, s.status)
        print(f"{label:<8}{s.cli_label:<13}{(s.project or '')[:21]:<22}"
              f"{s.last_str:<12}{(s.title or '')[:34]}")

    items = [(s.cli, s.sid, s.cwd) for s in rows]
    plan, skipped = launch.plan_many(items)

    if skipped:
        print(f"\n有 {len(skipped)} 场不可恢复：")
        for line in skipped[:10]:
            print(f"  - {line}")
        if len(skipped) > 10:
            print(f"  … 另有 {len(skipped) - 10} 场")

    if not plan:
        print("\n没有可执行的恢复命令。")
        return 1

    if args.dry_run:
        print(f"\n[dry-run] 会执行 {len(plan)} 条：")
        for tail, cwd in plan:
            print(f"  {cwd}")
            print(f"    -> {tail}")
        return 0

    if len(plan) > HARD_CAP:
        print(f"\n一次最多 {HARD_CAP} 场，当前 {len(plan)} 场。请收紧筛选条件。")
        return 1
    if len(plan) > DEFAULT_MAX and not args.yes:
        print(f"\n要开 {len(plan)} 场（默认上限 {DEFAULT_MAX}）。确认无误加 --yes 重跑。")
        return 1

    ok, msg = launch.resume_many(items, tabs=not args.windows)
    print(f"\n{'完成' if ok else '失败'}：{msg}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
