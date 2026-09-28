#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
长连接连通性自检：连 15 秒，看后台的「使用长连接」到底开没开。

为什么需要它：开发者后台那两个开关（事件配置 / 回调配置）是**后台独有的设置**，
没有任何 API 能读、能写、能代开。只能靠「连一下看通不通」来反推。

判据：
  - 打印 `connected to wss://...` 且没掉线 → WS 通道是通的（飞书发了票据）
  - 报 1000040350 / 连接被拒 → 后台没开长连接（或应用没发布版本）
  - 一直卡在 connecting → 多半是网络/代理把 wss 拦了

**但通道通 ≠ 事件登记了。** 连接成功只说明「允许你用长连接」，
事件 `im.message.receive_v1` 和回调 `card.action.trigger` 有没有订阅是另一回事。
要验那个，只能真触发一次：

    python tools\\probe_ws.py --exit-on-event --secs 300
    # 然后在飞书里点卡片上的「打开」，或给机器人发一条消息

**注意**：同一个应用同时只应有一个长连接。跑这个之前先确认 hub 没在跑。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def main() -> int:
    ap = argparse.ArgumentParser(description="飞书长连接连通性自检")
    ap.add_argument("--config", default=os.path.join(ROOT, "config.json"))
    ap.add_argument("--secs", type=int, default=15, help="观察时长")
    ap.add_argument("--exit-on-event", action="store_true",
                    help="收到第一个事件就退出（用来验事件/回调有没有登记）")
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as fh:
        cfg = json.load(fh)

    import lark_oapi as lark

    got = threading.Event()

    def on_message(data):                      # noqa: ANN001
        print(f"  <<< 收到消息事件 im.message.receive_v1：{str(data)[:300]}")
        got.set()
        return None

    def on_card(data):                         # noqa: ANN001
        print(f"  <<< 收到卡片回调 card.action.trigger：{str(data)[:300]}")
        got.set()
        return None

    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(on_message)
        .register_p2_card_action_trigger(on_card)
        .build()
    )

    print(f"应用 {cfg['app_id']}")
    print(f"连接 wss 端点，最多观察 {args.secs} 秒 ...")
    if args.exit_on_event:
        print("现在去飞书里点一下卡片上的「打开」按钮（或给机器人发条消息）")
    print()

    result = {"err": None}

    def run():
        try:
            client = lark.ws.Client(
                app_id=cfg["app_id"],
                app_secret=cfg["app_secret"],
                event_handler=handler,
                domain=cfg.get("domain"),
                log_level=lark.LogLevel.INFO,
                auto_reconnect=False,
            )
            client.start()
        except Exception as exc:               # noqa: BLE001
            result["err"] = exc

    threading.Thread(target=run, daemon=True).start()

    deadline = time.time() + args.secs
    while time.time() < deadline:
        if got.wait(timeout=0.5):
            break

    print()
    print("=" * 60)
    if got.is_set():
        print("[ok] 收到事件 —— 后台的订阅 + 长连接开关都是好的，不用再配了。")
        return 0
    if result["err"] is not None:
        print(f"[x] 连接失败：{type(result['err']).__name__}: {result['err']}")
        return 1
    print(f"[?] {args.secs} 秒内没收到事件（也没报错）。")
    print("    WS 通道是通的（连上过），但事件/回调没送达，可能原因：")
    print("      · 后台「事件配置」没选长连接 / 没加 im.message.receive_v1")
    print("      · 后台「回调配置」没选长连接 / 没加 card.action.trigger")
    print("      · 加了权限但没重新创建版本并发布")
    return 2


if __name__ == "__main__":
    sys.exit(main())
