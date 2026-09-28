#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
拿到你自己的 open_id（填进 config.json 的那个 receive_id）。

两种办法，推荐第一种：

  1) 监听模式（推荐）—— 不需要额外权限
       python tools/whoami.py
     然后在飞书里给机器人随便发一条消息，脚本会把 sender 的 open_id 和 chat_id 打出来。
     用的是 im.message.receive_v1 事件，跟面板本身要的权限是同一套，不用多申请。

  2) 邮箱查询 —— 需要额外申请 contact:user.id:readonly 权限
       python tools/whoami.py --email you@company.com

拿到之后填 config.json：
    "receive_id": "ou_...",
    "receive_id_type": "open_id"
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lark_oapi as lark  # noqa: E402

from feishu_hub.feishu import build_dispatcher, run_ws  # noqa: E402
from feishu_hub.hub import Config  # noqa: E402


def listen(cfg: Config) -> int:
    print("=" * 64)
    print("在飞书里给机器人发一条消息（单聊或群里 @ 它都行），我会打印 id。")
    print("拿到后 Ctrl+C 退出。")
    print("=" * 64)

    def on_message(data) -> None:
        ev = data.event
        sender = ev.sender.sender_id.open_id if ev.sender and ev.sender.sender_id else "?"
        chat = ev.message.chat_id
        chat_type = ev.message.chat_type
        print()
        print(f"  sender open_id : {sender}")
        print(f"  chat_id        : {chat}")
        print(f"  chat_type      : {chat_type}")
        print()
        if chat_type == "p2p":
            print("  单聊 —— config.json 这样填：")
            print(f'      "receive_id": "{sender}",')
            print('      "receive_id_type": "open_id"')
        else:
            print("  群聊 —— config.json 这样填（想发到群里就抄这个）：")
            print(f'      "receive_id": "{chat}",')
            print('      "receive_id_type": "chat_id"')
        print()

    handler = build_dispatcher(on_message, lambda d: None)
    run_ws(cfg.app_id, cfg.app_secret, handler, cfg.domain)
    return 0


def by_email(cfg: Config, email: str) -> int:
    from lark_oapi.api.contact.v3 import (
        BatchGetIdUserRequest,
        BatchGetIdUserRequestBody,
    )

    client = lark.Client.builder().app_id(cfg.app_id).app_secret(cfg.app_secret) \
        .domain(cfg.domain).build()
    body = BatchGetIdUserRequestBody.builder().emails([email]).build()
    req = BatchGetIdUserRequest.builder().user_id_type("open_id").request_body(body).build()
    resp = client.contact.v3.user.batch_get_id(req)
    if not resp.success():
        print(f"[x] 查询失败 code={resp.code} msg={resp.msg}")
        print("    多半是没申请 contact:user.id:readonly 权限，或者这个邮箱不在企业里。")
        print("    那就改用监听模式：python tools/whoami.py")
        return 1
    users = (resp.data.user_list or [])
    for u in users:
        print(f"  {u.email or email} → open_id = {u.user_id}")
    if not users:
        print("[x] 没查到。确认邮箱是企业内的邮箱，且应用有通讯录权限。")
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="拿 open_id / chat_id")
    ap.add_argument("--email", default=None, help="用邮箱查（需要通讯录权限）")
    ap.add_argument("--config", default=None)
    args = ap.parse_args()

    cfg = Config.load(args.config)
    if not cfg.app_id or not cfg.app_secret:
        print("[x] 先建好飞书应用，把 app_id / app_secret 填进 config.json（见 README.md）")
        return 2

    if args.email:
        return by_email(cfg, args.email)
    return listen(cfg)


if __name__ == "__main__":
    sys.exit(main())
