# -*- coding: utf-8 -*-
"""用 chutu2 (gpt-image-2) 批量生成 SessionDeck 的视觉资产。

前置条件：l0veyou.com 已登录（桌面有 chutu2-login 快捷方式，双击登录一次即可）。
没登录时脚本会直接告诉你，不会假装成功。

用法：
    python tools/gen_assets.py                 # 生成 assets/prompts.json 里全部
    python tools/gen_assets.py app-icon        # 只生成一个（按 name 匹配，可多个）
    python tools/gen_assets.py --list
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PROMPTS = os.path.join(ROOT, "assets", "prompts.json")
OUTDIR = os.path.join(ROOT, "assets", "generated")
GEN = r"C:\Users\admin\.workbuddy\skills\chutu2\chutu2_gen.py"
PY = sys.executable


def load():
    with open(PROMPTS, "r", encoding="utf-8") as f:
        return json.load(f)


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("-")]
    flags = {a for a in argv[1:] if a.startswith("-")}

    spec = load()
    style = spec.get("style", "").rstrip()
    items = spec["items"]

    if "--list" in flags:
        for it in items:
            print("%-16s %-5s %s" % (it["name"], it["ratio"], it.get("desc", "")))
        return 0

    if args:
        wanted = set(args)
        items = [i for i in items if i["name"] in wanted]
        if not items:
            print("没匹配到：%s" % ", ".join(sorted(wanted)))
            return 2

    os.makedirs(OUTDIR, exist_ok=True)

    print("=" * 60)
    print("SessionDeck 视觉资产 · gpt-image-2")
    print("输出目录: %s" % OUTDIR)
    print("=" * 60)

    failed = []
    for idx, it in enumerate(items, 1):
        name = it["name"]
        ratio = it["ratio"]
        out = os.path.join(OUTDIR, "%s.png" % name)
        prompt = style + "\n\n" + it["prompt"].strip()

        pf = os.path.join(OUTDIR, "_%s.prompt.txt" % name)
        with open(pf, "w", encoding="utf-8") as f:
            f.write(prompt)

        print("\n[%d/%d] %s  (%s)  %s" % (idx, len(items), name, ratio, it.get("desc", "")))
        cmd = [PY, GEN, "raw", "--prompt-file", pf, "-o", out, "--ratio", ratio]
        r = subprocess.run(cmd, cwd=os.path.dirname(GEN))
        if r.returncode != 0 or not os.path.exists(out):
            print("   FAILED rc=%s" % r.returncode)
            failed.append(name)
        else:
            print("   OK  %s  (%.1f KB)" % (out, os.path.getsize(out) / 1024.0))

    print("\n" + "=" * 60)
    if failed:
        print("失败: %s" % ", ".join(failed))
        print("多半是 l0veyou.com 没登录 —— 双击桌面 chutu2-login 快捷方式登录后重跑。")
        return 1
    print("全部生成完毕 -> %s" % OUTDIR)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
