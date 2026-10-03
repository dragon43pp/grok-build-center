#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
飞书客户端封装：发卡片 / 原地更新卡片 / 长连接。

设计要点（都有官方依据）：
  - **长连接同时收事件和卡片回调**，所以不需要公网 IP、不需要开端口。
    开发者后台两处都要选「使用长连接接收事件」：事件配置 + 回调配置。
  - `interactive` 消息的 `content` 必须是**卡片 JSON 序列化后的字符串**，不是对象。
  - 更新卡片用 `PATCH /im/v1/messages/{message_id}`，只有 `content` 一个字段。
    限制：更新前后 `update_multi` 都得是 true；发送后 14 天内可更新；单消息 5 QPS。
"""

from __future__ import annotations

import json
import time

import lark_oapi as lark
from lark_oapi.api.im.v1 import (
    CreateMessageRequest,
    CreateMessageRequestBody,
    PatchMessageRequest,
    PatchMessageRequestBody,
)


class FeishuError(RuntimeError):
    pass


class FeishuClient:
    def __init__(self, app_id: str, app_secret: str, domain: str | None = None) -> None:
        builder = lark.Client.builder().app_id(app_id).app_secret(app_secret)
        if domain:
            builder = builder.domain(domain)
        self._client = builder.build()
        self.app_id = app_id

    @property
    def raw(self) -> lark.Client:
        """底层 SDK 客户端。多维表格那些接口直接用这个。"""
        return self._client

    # ---------------------------------------------------------------- 发消息

    def send_card(self, receive_id: str, card: dict, receive_id_type: str = "open_id") -> str:
        """发一张卡片，返回 message_id（后面要靠它做原地更新）。"""
        body = (
            CreateMessageRequestBody.builder()
            .receive_id(receive_id)
            .msg_type("interactive")
            .content(json.dumps(card, ensure_ascii=False))
            .build()
        )
        req = (
            CreateMessageRequest.builder()
            .receive_id_type(receive_id_type)
            .request_body(body)
            .build()
        )
        resp = self._client.im.v1.message.create(req)
        if not resp.success():
            raise FeishuError(
                f"发送卡片失败 code={resp.code} msg={resp.msg} log_id={resp.get_log_id()}"
            )
        return resp.data.message_id

    def send_text(self, receive_id: str, text: str, receive_id_type: str = "open_id") -> str:
        body = (
            CreateMessageRequestBody.builder()
            .receive_id(receive_id)
            .msg_type("text")
            .content(json.dumps({"text": text}, ensure_ascii=False))
            .build()
        )
        req = (
            CreateMessageRequest.builder()
            .receive_id_type(receive_id_type)
            .request_body(body)
            .build()
        )
        resp = self._client.im.v1.message.create(req)
        if not resp.success():
            raise FeishuError(f"发送文本失败 code={resp.code} msg={resp.msg}")
        return resp.data.message_id

    # ---------------------------------------------------------------- 更新卡片

    def patch_card(self, message_id: str, card: dict) -> None:
        """原地更新同一张卡片。失败不抛，只记录 —— 面板刷新不该把主循环搞崩。"""
        body = (
            PatchMessageRequestBody.builder()
            .content(json.dumps(card, ensure_ascii=False))
            .build()
        )
        req = (
            PatchMessageRequest.builder()
            .message_id(message_id)
            .request_body(body)
            .build()
        )
        resp = self._client.im.v1.message.patch(req)
        if not resp.success():
            raise FeishuError(
                f"更新卡片失败 code={resp.code} msg={resp.msg} "
                f"（message_id={message_id}，常见原因：卡片不是本应用发的 / 超过 14 天 / "
                f"update_multi 不是 true）"
            )

    def patch_card_quiet(self, message_id: str, card: dict) -> bool:
        try:
            self.patch_card(message_id, card)
            return True
        except FeishuError as exc:
            print(f"[warn] {exc}")
            return False

    # ---------------------------------------------------------------- 置顶

    def pin(self, message_id: str) -> bool:
        """把面板卡置顶，手机上更好找。失败不致命。"""
        try:
            from lark_oapi.api.im.v1 import (
                CreatePinRequest,
                CreatePinRequestBody,
            )

            body = CreatePinRequestBody.builder().message_id(message_id).build()
            req = CreatePinRequest.builder().request_body(body).build()
            resp = self._client.im.v1.pin.create(req)
            if not resp.success():
                print(f"[warn] 置顶失败 code={resp.code} msg={resp.msg}")
                return False
            return True
        except Exception as exc:                      # noqa: BLE001
            print(f"[warn] 置顶异常: {exc}")
            return False


def build_dispatcher(on_message, on_card_action):
    """构造长连接用的分发器。

    注意 `builder("", "")` 两个参数必须传空串 —— 长连接模式不走 verification
    token / encrypt key 那条路，传了别的值反而会校验失败。
    """
    return (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(on_message)
        .register_p2_card_action_trigger(on_card_action)
        .build()
    )


def run_ws(app_id: str, app_secret: str, handler, domain: str | None = None, log_level=None):
    """启动长连接（阻塞）。"""
    kwargs = dict(
        app_id=app_id,
        app_secret=app_secret,
        event_handler=handler,
        log_level=log_level or lark.LogLevel.INFO,
        auto_reconnect=True,
    )
    if domain:
        kwargs["domain"] = domain
    client = lark.ws.Client(**kwargs)
    client.start()
    return client


if __name__ == "__main__":
    print("FeishuClient 模块。需要 app_id / app_secret 才能真正连上。")
    print("lark version:", getattr(lark, "__version__", "unknown"))
    print("ws.Client:", lark.ws.Client)
    print("时间:", time.strftime("%Y-%m-%d %H:%M:%S"))
