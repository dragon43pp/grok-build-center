#!/usr/bin/env python3
"""把 out-bitable/*.json 渲染成本地 HTML 预览，方便不登录飞书就核对数据。"""

from __future__ import annotations

import argparse
import glob
import html
import json
import os

COLS = ["状态", "CLI", "项目", "标题", "最后活动", "消息数", "工具调用", "Token", "可恢复", "恢复命令"]
WIDE = {"标题": "280px", "恢复命令": "320px", "项目": "140px"}


def cell(v) -> str:
    if isinstance(v, list):
        v = " / ".join(str(x) for x in v)
    if isinstance(v, bool):
        return "是" if v else ""
    return html.escape(str(v))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="out-bitable")
    ap.add_argument("--out", default="bitable-preview.html")
    ap.add_argument("--base-url", default="")
    args = ap.parse_args()

    rows: list[dict] = []
    for path in sorted(glob.glob(os.path.join(args.dir, "batch-*.json"))):
        with open(path, encoding="utf-8") as fh:
            rows.extend(json.load(fh)["create_records"])

    # 最近活动的排前面
    rows.sort(key=lambda r: r.get("最后活动", ""), reverse=True)

    by_status: dict[str, int] = {}
    by_cli: dict[str, int] = {}
    for r in rows:
        s = (r.get("状态") or ["?"])[0]
        c = (r.get("CLI") or ["?"])[0]
        by_status[s] = by_status.get(s, 0) + 1
        by_cli[c] = by_cli.get(c, 0) + 1

    th = "".join(
        f'<th style="width:{WIDE.get(c, "auto")}">{html.escape(c)}</th>' for c in COLS
    )
    body = []
    for r in rows:
        tds = "".join(f"<td>{cell(r.get(c, ''))}</td>" for c in COLS)
        body.append(f"<tr>{tds}</tr>")

    link = (
        f'<p class="link">飞书多维表格：<a href="{html.escape(args.base_url)}">'
        f"{html.escape(args.base_url)}</a></p>"
        if args.base_url
        else ""
    )

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Grok Build Center · 本地预览</title>
<style>
  body{{font:13px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;margin:0;padding:24px;
       background:#f7f7f5;color:#2c2c2a}}
  h1{{font-size:18px;font-weight:500;margin:0 0 4px}}
  .meta{{color:#5f5e5a;margin-bottom:14px}}
  .link{{margin:0 0 14px}} .link a{{color:#185fa5}}
  table{{border-collapse:collapse;background:#fff;width:100%;
         box-shadow:0 1px 2px rgba(0,0,0,.06)}}
  th{{position:sticky;top:0;background:#f1efe8;text-align:left;font-weight:500;
      padding:8px 10px;border-bottom:1px solid #d3d1c7;white-space:nowrap;font-size:12px}}
  td{{padding:7px 10px;border-bottom:1px solid #ecebe6;vertical-align:top;
      font-size:12px;word-break:break-word}}
  tr:hover td{{background:#faf9f6}}
  code{{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#444441}}
</style></head><body>
<h1>Grok Build Center · 本地预览</h1>
<div class="meta">共 <b>{len(rows)}</b> 场会话 ·
  按状态 {html.escape(str(by_status))} · 按 CLI {html.escape(str(by_cli))}</div>
{link}
<table><thead><tr>{th}</tr></thead><tbody>
{"".join(body)}
</tbody></table>
</body></html>"""

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(doc)
    print(f"已生成 {args.out} · {len(rows)} 行 · {os.path.getsize(args.out)} 字节")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
