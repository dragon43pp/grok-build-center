# -*- coding: utf-8 -*-
"""codex 的 token 字段关系：`input_tokens` 到底含不含 `cached_input_tokens`。

grok 的账单已经证明它是「并列」（input 不含 cachedRead）。codex 是 OpenAI 系，
API 文档里 `prompt_tokens_details.cached_tokens` 是 `prompt_tokens` 的子集 ——
但这是另一家的字段，不能靠类比下结论，所以统计一下本机 rollout。
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DB = r"D:\codex-home\state_5.sqlite"
PREFIX = "\\\\?\\"


def strip_extended(path: str) -> str:
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if path.startswith(PREFIX):
        return path[4:]
    return path


def main() -> int:
    db = sqlite3.connect(f"file:{DB.replace(os.sep, '/')}?mode=ro", uri=True)
    rows = db.execute(
        "select id, rollout_path from threads where tokens_used > 1000"
        " order by tokens_used desc limit 400"
    ).fetchall()

    total = agree = cr_le_i = r_le_o = 0
    ratios = []
    for _tid, raw in rows:
        path = strip_extended(raw)
        if not os.path.exists(path):
            continue
        last = None
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if "total_token_usage" in line:
                    try:
                        last = json.loads(line)
                    except Exception:
                        pass
        if not last:
            continue
        usage = (last.get("payload") or {}).get("info", {}).get("total_token_usage") or {}
        i = usage.get("input_tokens") or 0
        o = usage.get("output_tokens") or 0
        cr = usage.get("cached_input_tokens") or 0
        r = usage.get("reasoning_output_tokens") or 0
        t = usage.get("total_tokens") or 0
        if not i:
            continue
        total += 1
        if t and i + o == t:
            agree += 1
        if cr <= i:
            cr_le_i += 1
        if r <= o:
            r_le_o += 1
        ratios.append(i / max(r, 1))

    def pct(n: int) -> str:
        return f"{n * 100 // max(total, 1)}%"

    print(f"examined rollouts            : {total}")
    print(f"total == input + output      : {agree} ({pct(agree)})")
    print(f"cached_input <= input        : {cr_le_i} ({pct(cr_le_i)})")
    print(f"reasoning_output <= output   : {r_le_o} ({pct(r_le_o)})")
    if ratios:
        ratios.sort()
        print(f"input/reasoning ratio median : {ratios[len(ratios) // 2]:.0f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
