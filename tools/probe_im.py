#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IM 通道自检：用**应用身份**（app_id / app_secret）真发一条消息出去。

为什么单独做这个：`hub.py` 发卡片走的是应用身份，而应用身份能不能发，取决于
四件事同时成立，任何一件没配好，报错都长得差不多：

  1. app_secret 有效                    → 否则拿不到 tenant_access_token
  2. 应用开了 im 权限                   → 否则 99991672 app_scope_not_applied
  3. 应用的「可用范围」包含该用户        → 否则 230013（看着像权限问题，其实不是）
  4. 用户 open_id 正确且在范围内         → 否则 99992351 invalid open_id

这个脚本一条命令把这四件事一起验掉，报错原文直接打出来，不用猜。

用法：
    python tools/probe_im.py              # 发一条文本
    python tools/probe_im.py --card       # 发真实的会话面板卡（看手机上的实际效果）
    python tools/probe_im.py --dry        # 只验 secret，不发消息
"""

from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from feishu_hub.feishu import FeishuClient, FeishuError  # noqa: E402


def check_token(app_id: str, app_secret: str, domain: str) -> tuple[bool, str]:
    """第 1 步：单独验 secret。失败就没必要往下走了，报错也最干净。"""
    import urllib.error
    import urllib.request

    body = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode()
    req = urllib.request.Request(
        f"{domain}/open-apis/auth/v3/tenant_access_token/internal",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    # 本机设了 http_proxy，回环/飞书都要绕开，否则会被代理拦成 502
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError as exc:
        return False, f"请求失败：{exc}"
    if data.get("code") == 0:
        return True, "tenant_access_token 拿到（secret 有效）"
    return False, f"code={data.get('code')} msg={data.get('msg')}"


def main() -> int:
    ap = argparse.ArgumentParser(description="飞书 IM 通道自检（应用身份）")
    ap.add_argument("--config", default=os.path.join(ROOT, "config.json"))
    ap.add_argument("--card", action="store_true", help="发真实的会话面板卡")
    ap.add_argument("--dry", action="store_true", help="只验 secret，不发消息")
    ap.add_argument("--text", default="【AI 会话中心】通道自检：应用身份发消息成功。"
                                      "收到这条说明 app_secret / im 权限 / 可用范围 全部就绪。")
    args = ap.parse_args()

    if not os.path.exists(args.config):
        print(f"[x] 找不到 {args.config}，先照 README 建飞书应用并填好配置")
        return 2
    with open(args.config, encoding="utf-8") as fh:
        cfg = json.load(fh)

    app_id = cfg.get("app_id", "")
    app_secret = cfg.get("app_secret", "")
    domain = cfg.get("domain", "https://open.feishu.cn")
    receive_id = cfg.get("receive_id", "")
    id_type = cfg.get("receive_id_type", "open_id")

    print(f"app_id     = {app_id}")
    print(f"receive_id = {receive_id} ({id_type})")
    print(f"domain     = {domain}")
    print()

    print("[1/3] 验证 app_secret ...")
    ok, msg = check_token(app_id, app_secret, domain)
    print(f"      {'[ok]' if ok else '[x] '} {msg}")
    if not ok:
        print("\n      → secret 无效就去开发者后台「凭证与基础信息」重新拿一个，"
              "填进 config.json")
        return 1
    if args.dry:
        print("\n--dry 到此为止。")
        return 0

    client = FeishuClient(app_id, app_secret, domain)

    if args.card:
        print("[2/3] 构造真实面板卡 ...")
        from feishu_hub.cards import build_panel, card_size_kb
        from feishu_hub.state import build_snapshot

        snap = build_snapshot()
        card = build_panel(snap, "active", 0)
        print(f"      [ok] {snap.total} 场会话 · 卡片 {card_size_kb(card):.2f} KB / 上限 30 KB")
        print("[3/3] 发送卡片 ...")
        try:
            mid = client.send_card(receive_id, card, id_type)
        except FeishuError as exc:
            print(f"      [x] {exc}")
            return 1
        print(f"      [ok] 已发送 message_id={mid}")
        print("\n去飞书里看这张卡。注意：现在点按钮还不会有反应 ——"
              "那需要开发者后台把「事件配置」和「回调配置」两处的长连接都打开。")
        return 0

    print("[2/3] 发送文本 ...")
    try:
        mid = client.send_text(receive_id, args.text, id_type)
    except FeishuError as exc:
        print(f"      [x] {exc}")
        print("\n      常见原因对照：")
        print("        99991672 app_scope_not_applied → 应用缺 im 权限，去权限管理加")
        print("        230013                        → 可用范围没包含你，去「应用发布-可用范围」加")
        print("        99992351 invalid open_id      → receive_id 填错了")
        return 1
    print(f"      [ok] 已发送 message_id={mid}")
    print("\n通道全通。下一步只差开发者后台两个「使用长连接」开关，卡片按钮就能点了。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
