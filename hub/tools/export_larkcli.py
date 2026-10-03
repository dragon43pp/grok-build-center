#!/usr/bin/env python3
"""把本机会话快照导出成 lark-cli 能直接吃的批量写入 JSON。

为什么要走 lark-cli 而不是直接用 lark-oapi：
自建应用需要在开发者后台单独配 `bitable:app` 权限，而 lark-cli 走的是
**用户身份 OAuth**，`base:*` 一整套已经授权过了，拿来即用。

用法：
    python tools/export_larkcli.py --out out-bitable
    # 产出 out-bitable/batch-01.json ... 每批 <=200 条（飞书上限）

然后用 lark-cli 推：
    lark-cli base +record-batch-create --as user \\
      --base-token <token> --table-id <tbl> --json @out-bitable/batch-01.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from feishu_hub.state import STATUS_LABEL, build_snapshot  # noqa: E402

# 飞书 batch_create 上限就是 200，写死避免有人改大
BATCH = 200

# CLI 标签 -> 表里已建的选项名。表是照 CLI_META 的 label 建的，
# 但 opencode 的 label 是小写，而选项名统一成了 OpenCode，这里对齐一下。
CLI_OPTION = {
    "Codex": "Codex",
    "Claude Code": "Claude Code",
    "Grok Build": "Grok Build",
    "opencode": "OpenCode",
    "OpenCode": "OpenCode",
}


def fmt_dt(ts: float | None) -> str | None:
    """飞书 datetime 单元格收的是 `YYYY-MM-DD HH:MM` 字符串，不是毫秒时间戳。

    这点和直接用 bitable v1 REST API 不一样 —— 那边要 13 位毫秒。
    用 lark-cli 就交给它转换，传字符串。
    """
    if not ts:
        return None
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def to_fields(s) -> dict:
    """Session -> 飞书记录字段映射。

    CellValue 规则（来自 lark-cli 的 help）：
      text     -> "字符串"
      number   -> 数字
      select   -> ["选项名"]     单选也必须是数组
      datetime -> "YYYY-MM-DD HH:MM"
      checkbox -> true / false
    """
    label = CLI_OPTION.get(s.cli_label or "", "其他")

    fields: dict = {
        "标题": s.title or "(未命名)",
        "会话ID": s.sid or "",
        "CLI": [label],
        "状态": [STATUS_LABEL.get(s.status, s.status)],
        "项目": s.project or "",
        "项目目录": s.cwd or "",
        "消息数": int(s.msgs or 0),
        "工具调用": int(s.tools or 0),
        "Token": int(s.tokens or 0),
        "可恢复": bool(s.resumable),
        "恢复命令": s.cmd or "",
        "备注": s.hook_note or "",
    }

    last = fmt_dt(s.last_ts)
    if last:
        fields["最后活动"] = last
    start = fmt_dt(s.start_ts)
    if start:
        fields["开始时间"] = start

    return fields


def main() -> int:
    ap = argparse.ArgumentParser(description="导出会话快照为 lark-cli 批量写入 JSON")
    ap.add_argument("--out", default="out-bitable", help="输出目录")
    ap.add_argument("--limit", type=int, default=0, help="只导前 N 条（0=全部）")
    args = ap.parse_args()

    snap = build_snapshot()
    sessions = [s for s in snap.sessions if s.sid]
    if args.limit:
        sessions = sessions[: args.limit]

    os.makedirs(args.out, exist_ok=True)
    for old in os.listdir(args.out):
        if old.startswith("batch-") and old.endswith(".json"):
            os.remove(os.path.join(args.out, old))

    total = 0
    for i in range(0, len(sessions), BATCH):
        chunk = sessions[i : i + BATCH]
        payload = {"create_records": [to_fields(s) for s in chunk]}
        path = os.path.join(args.out, f"batch-{i // BATCH + 1:02d}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        total += len(chunk)
        print(f"  {path}  {len(chunk)} 条  {os.path.getsize(path)} 字节")

    print(f"\n共 {total} 条 · {len(range(0, max(len(sessions), 1), BATCH))} 批")
    print(f"按 CLI: {snap.counts_by_cli}")
    print("按状态: " + str({STATUS_LABEL.get(k, k): v for k, v in snap.counts_by_status.items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
