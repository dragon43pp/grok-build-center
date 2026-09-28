#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Grok Build Center · 飞书面板

一句话：把本机 4 家 AI 编程 CLI 的 340+ 场会话状态，做成飞书里一张**原地刷新**的常驻卡片，
在手机上就能看到全部会话的状态，点「打开」直接回到那场会话。

架构：
    会话库(scan.py) ─┐
    存活进程(procs.py)├─> 统一快照(state.py) ──> 卡片(cards.py) ──> 飞书长连接(feishu.py)
    CLI hook 上报 ────┘                                              ↑
                                                          原地 PATCH 同一张卡

免公网服务器：长连接同时收事件和卡片回调，两端都是出站连接。

用法：
    python -m feishu_hub.hub --print          # 不开飞书，先看本机状态
    python -m feishu_hub.hub --card-preview   # 打印卡片 JSON 与体积，不发送
    python -m feishu_hub.hub                  # 正式跑（需要 config.json）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import lark_oapi as lark

from . import cards, feed, launch, paths, procs, remote
from .bitable import BitableError, BitableSync
from .feishu import FeishuClient, FeishuError, build_dispatcher, run_ws
from .feed import ControlError, FeedLink, FeedState
from .state import STATUS_LABEL, HookStore, Session, Snapshot, build_snapshot

HERE = os.path.dirname(os.path.abspath(__file__))
# 可写状态（config.json / panel.json / bitable-state.json）放哪。
# 打包成 exe 之后这里**不是**包内目录，而是 exe 旁边 —— 见 paths.py。
# 别改回 os.path.dirname(HERE)：那样用户改不到 config.json。
ROOT = paths.data_root()

# 同一个会话多久内不重复推「有会话在等你」（秒）
ATTENTION_COOLDOWN = 5 * 60


# --------------------------------------------------------------------- 配置

@dataclass
class Config:
    app_id: str = ""
    app_secret: str = ""
    receive_id: str = ""                     # open_id 或 chat_id
    receive_id_type: str = "open_id"         # open_id | chat_id | user_id | email
    domain: str = "https://open.feishu.cn"   # 海外版用 https://open.larksuite.com
    refresh_secs: int = 60
    hook_port: int = 8799
    push_on_needs_you: bool = True
    panel_state: str = field(default_factory=lambda: os.path.join(ROOT, "panel.json"))

    # 多维表格（可选，但强烈建议开 —— 卡片一页只有 10 条，翻 35 页很痛苦）
    bitable_app_token: str = ""
    bitable_table_id: str = ""
    bitable_table_name: str = "AI 会话"
    bitable_sync: bool = True
    bitable_state: str = field(default_factory=lambda: os.path.join(ROOT, "bitable-state.json"))

    # 远程续跑：从飞书发一句话 → 本机无头续跑那场会话 → 结果回传
    # auto_approve 默认关：开着等于让飞书那头能在本机跑任意工具，想清楚再开。
    remote_ask: bool = True
    remote_auto_approve: bool = False
    remote_timeout: int = 900

    # 外部事件流通道（可选，**默认关**）：读一个外部会话管理器自己写的
    # append-only 事件流水，外加一条可选的控制管道（能反向放行 / 回答 / 投喂）。
    # 仓库里刻意不写死任何路径 —— 读什么完全由这几个配置决定，
    # 不填就整段空转，一次系统调用都不发，面板上也不会多出一行。
    #
    # 这条路的用处：对端自己已经在记「哪场卡住了」，所以它拉起的会话
    # **不用给任何 CLI 配 hook** 也能有橙色的「等你确认」。
    feed_enabled: bool = False
    feed_events: str = ""            # 事件流水 JSONL 的路径（空 = 不接）
    feed_pipe: str = ""              # 控制管道路径（空 = 不做反向操作）
    feed_token: str = ""             # 控制管道 token 文件（空 = 同上）
    feed_stats: str = ""             # 可选的统计 JSON，只给历史页面用
    feed_poll_secs: int = 5          # 事件流水是增量读，很便宜，可以勤一点
    feed_control: bool = True        # 允许走控制管道（路径没填也照样是关的）
    # 允许从飞书批准待确认项。开着 = 手机上一点就能让本机继续执行工具，
    # 和 remote_auto_approve 一样是信任问题，默认关。
    feed_approve: bool = False

    @classmethod
    def load(cls, path: str | None = None) -> "Config":
        path = path or os.path.join(ROOT, "config.json")
        data: dict = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        # 下划线开头的键是模板里的注释，不当配置读
        cfg = cls(**{k: v for k, v in data.items()
                     if k in cls.__dataclass_fields__ and not k.startswith("_")})
        # 环境变量优先，方便临时覆盖而不改文件
        cfg.app_id = os.environ.get("FEISHU_APP_ID", cfg.app_id)
        cfg.app_secret = os.environ.get("FEISHU_APP_SECRET", cfg.app_secret)
        cfg.receive_id = os.environ.get("FEISHU_RECEIVE_ID", cfg.receive_id)
        cfg.bitable_app_token = os.environ.get("FEISHU_BITABLE_TOKEN", cfg.bitable_app_token)
        return cfg

    def validate(self) -> list[str]:
        missing = []
        if not self.app_id:
            missing.append("app_id")
        if not self.app_secret:
            missing.append("app_secret")
        if not self.receive_id:
            missing.append("receive_id")
        return missing

    @property
    def bitable_enabled(self) -> bool:
        return bool(self.bitable_sync and self.bitable_app_token)


# --------------------------------------------------------------------- 面板状态

def load_panel_state(path: str) -> dict:
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, json.JSONDecodeError):
            pass
    return {}


def save_panel_state(path: str, state: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


# --------------------------------------------------------------------- Hub

class Hub:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.hooks = HookStore()
        self._snap: Snapshot | None = None
        self._snap_at = 0.0
        self._lock = threading.Lock()          # 保护 _snap / _snap_at
        self.client: FeishuClient | None = None
        self._panel = load_panel_state(cfg.panel_state)
        self._filter = self._panel.get("filter", "active")
        self._page = int(self._panel.get("page", 0) or 0)

        # 一次全量 rescan 要 ~5 秒（1.2GB 的 codex 库 + 进程表），绝不能让它出现在
        # 「CLI 的 hook 请求」或「飞书卡片回调」这两条热路径上：
        #   - hook 卡 5 秒 → CLI 自己被拖慢
        #   - 卡片回调卡 3 秒 → 飞书判定超时，用户点了没反应
        # 所以两条路径都只做「改状态 + 立刻返回」，真正的重扫交给这个后台线程，
        # 并且用 Event 把突发请求攒成一次。
        self._wake = threading.Event()
        self._stop = False
        self._attn_lock = threading.Lock()     # 单独一把锁，别跟 5 秒的重扫抢
        self._pending_attention: list[dict] = []
        self._last_attention: dict[str, float] = {}

        # 多维表格：卡片一页 10 条，343 场要翻 35 页；Base 才是「看全部」的地方
        self.bitable: BitableSync | None = None
        self._bitable_lock = threading.Lock()
        self.bitable_stats: dict = {}

        # 外部事件流通道。事件流水增量读（几毫秒），管道探测一次 CreateFile，
        # 都不是重活，所以单独起一个高频线程盯着 —— 比 60 秒的刷新循环
        # 快得多，"卡在等你确认"这种事晚 60 秒才知道就没意义了。
        # 没配置时 FeedLink 是空转的，这个线程只是白睡。
        self.link = FeedLink(
            events_path=self.cfg.feed_events,
            pipe=self.cfg.feed_pipe,
            token=self.cfg.feed_token,
        )
        self._feed: FeedState = FeedState()
        self._feed_seen: dict[tuple[str, str], float] = {}
        self._feed_lock = threading.Lock()

    # ---------------------------------------------------------- 快照

    def snapshot(self, force: bool = False, max_age: float = 20.0) -> Snapshot:
        """max_age 内的缓存直接用。热路径传大值，宁可给旧数据也不要卡住。"""
        with self._lock:
            if self._snap is not None and not force:
                if (time.time() - self._snap_at) <= max_age:
                    return self._snap
            if force or self._snap is None:
                self.hooks.prune()
                with self._feed_lock:
                    hr = self._feed
                self._snap = build_snapshot(self.hooks, hr)
                self._snap_at = time.time()
            assert self._snap is not None
            return self._snap

    def panel_card(self, max_age: float = 20.0) -> dict:
        return cards.build_panel(
            self.snapshot(max_age=max_age), self._filter, self._page,
            ask=self.cfg.remote_ask,
            approve=self.cfg.feed_approve,
        )

    # ---------------------------------------------------------- 后台刷新

    def request_refresh(self, attention: dict | None = None) -> None:
        """请求一次后台刷新。同一次突发里的多次请求会被合并成一次重扫。"""
        if attention:
            with self._attn_lock:
                self._pending_attention.append(attention)
        self._wake.set()

    def _refresher(self) -> None:
        while not self._stop:
            self._wake.wait()
            if self._stop:
                return
            time.sleep(0.3)                     # 攒一下，把突发合并
            self._wake.clear()
            try:
                snap = self.snapshot(force=True)
                self.refresh_panel()
                self.sync_bitable(snap)
                with self._attn_lock:
                    pending, self._pending_attention = self._pending_attention, []
                for payload in pending:
                    self.push_attention(payload)
            except Exception as exc:            # noqa: BLE001
                print(f"[warn] 后台刷新失败: {exc}")

    # ---------------------------------------------------------- 多维表格

    def init_bitable(self) -> None:
        """建/复用多维表格并接上同步。没配 app_token 就跳过。"""
        if not self.cfg.bitable_enabled:
            return
        assert self.client is not None
        sync = BitableSync(
            self.client.raw, self.cfg.bitable_app_token,
            self.cfg.bitable_table_id, self.cfg.bitable_state,
        )
        try:
            if not sync.table_id:
                sync.ensure_table(self.cfg.bitable_table_name)
                self.cfg.bitable_table_id = sync.table_id
                print(f"[ok] 多维表格已就绪 table_id={sync.table_id}")
            if not sync._records:
                # 本地没有索引但表里有行 → 先读回来，别把 343 行插成双份
                n = sync.rebuild_index()
                if n:
                    print(f"[ok] 从表里读回 {n} 行已有记录，按原行更新")
        except BitableError as exc:
            print(f"[warn] 多维表格初始化失败，跳过同步：{exc}")
            return
        self.bitable = sync

    def sync_bitable(self, snap: Snapshot | None = None) -> dict:
        """把快照推进多维表格。只推变化过的行。"""
        if not self.bitable:
            return {}
        if not self._bitable_lock.acquire(blocking=False):
            return self.bitable_stats          # 上一轮还没推完，跳过这轮
        try:
            snap = snap or self.snapshot()
            stats = self.bitable.sync(snap.sessions)
            self.bitable_stats = stats
            if stats.get("create") or stats.get("update") or stats.get("delete"):
                print(f"[bitable] 新增 {stats['create']} · 更新 {stats['update']} · "
                      f"删除 {stats['delete']} · 未变 {stats['unchanged']}")
            return stats
        except BitableError as exc:
            print(f"[warn] 多维表格同步失败：{exc}")
            return {}
        finally:
            self._bitable_lock.release()

    def remember_panel(self, message_id: str) -> None:
        self._panel.update({"message_id": message_id, "filter": self._filter, "page": self._page})
        save_panel_state(self.cfg.panel_state, self._panel)

    # ---------------------------------------------------------- 面板发布

    def ensure_panel(self) -> str | None:
        """有历史面板就原地更新，没有就新发一张并置顶。"""
        assert self.client is not None
        message_id = self._panel.get("message_id")

        if message_id:
            try:
                self.client.patch_card(message_id, self.panel_card())
                return message_id
            except FeishuError as exc:
                print(f"[warn] 更新旧面板失败，改为新发一张：{exc}")

        message_id = self.client.send_card(
            self.cfg.receive_id, self.panel_card(), self.cfg.receive_id_type
        )
        self.remember_panel(message_id)
        self.client.pin(message_id)
        print(f"[ok] 面板已发送并置顶 message_id={message_id}")
        return message_id

    def refresh_panel(self) -> None:
        assert self.client is not None
        message_id = self._panel.get("message_id")
        if not message_id:
            self.ensure_panel()
            return
        self.client.patch_card_quiet(message_id, self.panel_card())

    # ---------------------------------------------------------- 回调

    def on_card(self, data) -> "lark.event.callback.model.p2_card_action_trigger.P2CardActionTriggerResponse":
        from lark_oapi.event.callback.model.p2_card_action_trigger import (
            P2CardActionTriggerResponse,
        )

        # 表单提交要**先判**：表单内的按钮带不了 behaviors，也就没有 value，
        # 只回一个 form_value。先判它，否则会被当成未知指令。
        action = data.event.action if (data.event and data.event.action) else None
        form_value = getattr(action, "form_value", None) or {}
        if form_value:
            self._on_ask(form_value)
            return P2CardActionTriggerResponse(
                {"toast": {"type": "info", "content": "已收到，正在本机执行…"}}
            )

        value = (action.value or {}) if action else {}
        cmd = value.get("cmd") or "refresh"
        toast = {"type": "info", "content": "已刷新"}

        if cmd == "filter":
            self._filter = value.get("key") or "active"
            self._page = 0
        elif cmd == "page":
            self._page = max(0, int(value.get("page") or 0))
            self._filter = value.get("key") or self._filter
        elif cmd == "refresh":
            self._filter = value.get("key") or self._filter
            self._page = int(value.get("page") or self._page)
            # 不在回调里同步重扫 —— 那要 5 秒，飞书回调等不了。改成后台扫完再 PATCH 回来。
            self.request_refresh()
            toast = {"type": "info", "content": "正在刷新，几秒后自动更新"}
        elif cmd == "open":
            ok, msg = launch.resume(
                value.get("cli") or "", value.get("sid") or "", self._cwd_of(value)
            )
            toast = {"type": "success" if ok else "error", "content": msg}
            self.request_refresh()
        elif cmd == "folder":
            ok, msg = launch.open_folder(self._cwd_of(value))
            toast = {"type": "success" if ok else "error", "content": msg}
        elif cmd == "approve":
            toast = self._on_decision(value, approve=True)
            self.request_refresh()
        elif cmd == "deny":
            toast = self._on_decision(value, approve=False)
            self.request_refresh()
        elif cmd == "detail":
            # 详情卡**另发一条**，不动面板 —— 面板是常驻的，被详情覆盖了就回不去了。
            ok, msg = self.send_detail_card(value.get("cli") or "", value.get("sid") or "")
            toast = {"type": "success" if ok else "error", "content": msg}
        else:
            toast = {"type": "warning", "content": f"未知指令: {cmd}"}

        self.remember_panel(self._panel.get("message_id", ""))
        # 用缓存出卡，绝不阻塞回调。max_age 放宽到 10 分钟：宁可显示略旧的数据，
        # 也不能让用户点了按钮却没反应。
        card = self.panel_card(max_age=600)
        # 回包里的卡片类型只认 "raw" / "template" —— 官方文档《飞书卡片回调》
        # 明确写了这两个值，写成 "card_json" 会直接渲染失败。
        # 而且 `data` 要的是**卡片 JSON 对象**，不是序列化后的字符串。
        return P2CardActionTriggerResponse(
            {"toast": toast, "card": {"type": "raw", "data": card}}
        )

    def _session_of(self, cli: str, sid: str) -> Session | None:
        """回调只带 cli/sid，其余回查快照 —— 不要把路径之类的东西塞进卡片。"""
        for s in self.snapshot().sessions:
            if s.cli == cli and s.sid == sid:
                return s
        return None

    def _cwd_of(self, value: dict) -> str:
        s = self._session_of(value.get("cli") or "", value.get("sid") or "")
        return s.cwd if s else ""

    # ---------------------------------------------------------- 远程续跑

    def _on_decision(self, value: dict, approve: bool) -> dict:
        """从飞书批准 / 拒绝一场外部会话的待确认项。

        只有 Bridge 够得着的会话（当前是 OpenCode）能这么干，而且
        `feed_approve` 默认 false —— 手机上一点就让本机继续执行工具，
        这是信任问题，不是技术问题，默认不给。
        """
        if not self.cfg.feed_approve:
            return {"type": "warning",
                    "content": "未开启远程批准（config.json 里 feed_approve=true 才允许）"}
        s = self._session_of(value.get("cli") or "", value.get("sid") or "")
        if not s or not s.bridge_id:
            return {"type": "warning", "content": "这场会话不支持远程批准"}
        try:
            if approve:
                self.link.bridge.approve(s.bridge_id)
            else:
                self.link.bridge.deny(s.bridge_id)
        except ControlError as exc:
            return {"type": "error", "content": f"操作失败: {exc}"}
        return {"type": "success",
                "content": ("已批准，它继续跑了" if approve else "已拒绝")}

    def send_detail_card(self, cli: str, sid: str) -> tuple[bool, str]:
        """发一张详情卡（另起一条消息，不动面板）。"""
        assert self.client is not None
        if not self.cfg.remote_ask:
            return False, "远程续跑已关闭（config.json 里 remote_ask=false）"
        s = self._session_of(cli, sid)
        if not s:
            return False, f"快照里找不到这场会话 {cli}/{sid}"
        try:
            turns = remote.read_transcript(cli, sid)
        except Exception as exc:                              # noqa: BLE001
            return False, f"读正文失败: {exc}"
        # 大会话恢复是分钟级的（实测 1.5 MB 的会话 10 分钟没回来），
        # 所以把体量提示写进卡片 —— 用户点按钮之前就该知道要等多久。
        nbytes = remote.session_size(cli, sid)
        hint = remote.size_hint(nbytes)
        try:
            self.client.send_card(
                self.cfg.receive_id,
                cards.build_detail(s, turns, ask=self.cfg.remote_ask, hint=hint),
                self.cfg.receive_id_type,
            )
        except FeishuError as exc:
            return False, f"发详情卡失败: {exc}"
        size = f"，历史 {nbytes / 1024:.0f} KB" if nbytes else ""
        return True, f"详情卡已发出（{len(turns)} 轮对话{size}）"

    def _on_ask(self, form_value: dict) -> None:
        """表单提交：把活扔后台，**立刻回包** —— 续跑动辄几分钟，
        飞书回调预算只有 3 秒，同步跑必然超时。

        两种表单：
          ask  → 无头续跑（remote.py 另起进程）
          send → 投喂到外部管理器里正在跑的那一场（控制管道，同一上下文）
        """
        kind, cli, sid, prompt = cards.parse_form(form_value)
        if not prompt:
            print("[warn] 收到空 prompt 的表单提交")
            return
        if kind == "send":
            self._on_send(sid, prompt)
            return
        if kind != "ask":
            print(f"[warn] 认不出这个表单: {list(form_value)}")
            return
        if not self.cfg.remote_ask:
            print("[warn] remote_ask=false，忽略续跑请求")
            return
        s = self._session_of(cli, sid)
        if not s or not s.cwd:
            print(f"[warn] 找不到会话目录 {cli}/{sid}，忽略")
            return
        threading.Thread(
            target=self._run_ask, args=(cli, sid, s.cwd, prompt, s), daemon=True
        ).start()

    def _on_send(self, bridge_id: str, prompt: str) -> None:
        """投一句话到外部管理器里正在跑的那一场。

        跟无头续跑最大的区别：**不会另起进程**。那场会话的上下文是连续的，
        你在飞书说的这句话，TUI 里能看到。代价是它得是外部管理器里活着的、
        且 Bridge 够得着的会话（当前只有 OpenCode）。
        """
        if not self.cfg.feed_control:
            print("[warn] feed_control=false，忽略投喂")
            return
        if not bridge_id:
            print("[warn] 表单里没有 bridge 会话 id")
            return
        try:
            self.link.bridge.send(bridge_id, prompt)
            print(f"[send] 已投喂 {bridge_id}：{prompt[:60]}")
        except ControlError as exc:
            # 投不进去要让用户知道 —— 静默失败的话他会以为话已经到了。
            print(f"[warn] 投喂失败: {exc}")
            self._notify(f"投喂失败：{exc}")

    def _notify(self, text: str) -> None:
        """发一张最简单的提示卡。失败就只打日志，别把回调搞崩。"""
        if not self.client:
            return
        card = {
            "schema": "2.0",
            "config": {"update_multi": True},
            "header": {"template": "red",
                       "title": {"tag": "plain_text", "content": "操作失败"}},
            "body": {"elements": [{"tag": "markdown", "content": text[:2000]}]},
        }
        try:
            self.client.send_card(self.cfg.receive_id, card, self.cfg.receive_id_type)
        except FeishuError as exc:
            print(f"[warn] 提示卡发送失败: {exc}")

    def _run_ask(self, cli: str, sid: str, cwd: str, prompt: str, s) -> None:
        """后台执行无头续跑，把结果回传飞书。"""
        assert self.client is not None
        print(f"[ask] {cli}/{sid} 开始续跑：{prompt[:60]}")
        t0 = time.time()
        try:
            ok, out = remote.headless_resume(
                cli, sid, cwd, prompt,
                timeout=self.cfg.remote_timeout,
                auto_approve=self.cfg.remote_auto_approve,
            )
        except Exception as exc:                              # noqa: BLE001
            ok, out = False, f"执行异常: {exc}"
        secs = time.time() - t0
        print(f"[ask] {cli}/{sid} 结束 ok={ok} 用时 {secs:.0f}s")
        try:
            self.client.send_card(
                self.cfg.receive_id,
                cards.build_result(s, prompt, ok, out),
                self.cfg.receive_id_type,
            )
        except FeishuError as exc:
            print(f"[warn] 结果卡发送失败: {exc}")

    def on_message(self, data) -> None:
        """用户在单聊里发消息时，把面板回一张过去。简单可用即可。"""
        assert self.client is not None
        try:
            chat_id = data.event.message.chat_id
            self.client.send_card(chat_id, self.panel_card(), "chat_id")
        except Exception as exc:                          # noqa: BLE001
            print(f"[warn] 回复消息失败: {exc}")

    # ---------------------------------------------------------- 后台任务

    def refresh_loop(self) -> None:
        while not self._stop:
            time.sleep(self.cfg.refresh_secs)
            self.request_refresh()

    def feed_loop(self) -> None:
        """高频盯外部事件流：增量读 + 控制管道探测。

        为什么要单独一条：面板刷新是 60 秒一轮，但「会话卡在等你批准」
        这种事晚一分钟才知道就没什么用了。事件流水是 append-only 的，
        增量读一次只解析新增的那几行，几毫秒的事，5 秒一轮毫无压力。

        没配置 / 对端没开 → poll() 立刻返回空，这个循环就是空转。
        """
        while not self._stop:
            time.sleep(max(1, self.cfg.feed_poll_secs))
            try:
                state = self.link.poll(use_control=self.cfg.feed_control)
            except Exception as exc:                          # noqa: BLE001
                print(f"[warn] 外部事件流轮询失败: {exc}")
                continue

            fresh: list[dict] = []
            changed = False
            with self._feed_lock:
                prev = self._feed
                for key, run in state.runs.items():
                    before = prev.runs.get(key)
                    if before is None or before.status != run.status or run.last_at != before.last_at:
                        changed = True
                    # 新冒出来的「等你确认」才推 —— 已经在等的不再重复推
                    if (run.effective_status() == "needs-you"
                            and run.last_at > self._feed_seen.get(key, 0.0)):
                        fresh.append({
                            "cli": run.cli,
                            "sid": "",
                            "cwd": run.workspace,
                            "note": run.note or "外部事件流里这场在等你确认",
                            "status": "needs-you",
                        })
                    self._feed_seen[key] = run.last_at
                if len(prev.bridge) != len(state.bridge):
                    changed = True
                self._feed = state

            if fresh and self.cfg.push_on_needs_you:
                for payload in fresh:
                    self.push_attention(payload)
            if changed or fresh:
                self.request_refresh()

    @staticmethod
    def _hook_port_busy(port: int, timeout: float = 0.4) -> bool:
        """端口上有没有人在听。用「连一下」而不是 bind 试探 —— bind 在 Windows
        上永远会「成功」，试探不出任何东西。连上就说明有服务，连不上就没人。"""
        import socket
        sock = socket.socket()
        sock.settimeout(timeout)
        try:
            sock.connect(("127.0.0.1", int(port)))
            return True
        except OSError:
            return False
        finally:
            sock.close()

    def start_hook_server(self) -> None:
        """本机 hook 接收端点。CLI 的 hook 往这里 POST，就能上报「等你确认」。"""
        hub = self

        # **Windows 上必须先探一下端口。**
        # Python 的 HTTPServer 默认 allow_reuse_address=True（对应 SO_REUSEADDR），
        # 而 Windows 的 SO_REUSEADDR 语义跟 Linux **相反**：它允许两个进程同时绑定
        # **同一个**端口，而不是「等 TIME_WAIT 过去」。后果是第二个实例会安安静静地
        # 「绑定成功」，然后两个进程**抢着接**同一端口的连接 —— 谁接到不确定。
        # 于是 CLI 上报的「等你确认」会被另一个实例吃掉，面板上什么都不显示，
        # 而且**两个实例都认为自己工作正常**。这类问题极难排查（2026-09-28 踩到：
        # 一个残留的测试进程占着 8791，导致新进程的 hook 全部失踪）。
        # 所以这里先连一下：连得上就说明有别人在收，明确告警。
        if self._hook_port_busy(self.cfg.hook_port):
            print(f"[warn] 端口 {self.cfg.hook_port} 上已经有别的进程在收 hook 了。",
                  file=sys.stderr)
            print("[warn] Windows 允许重复绑定同一端口，两边会**抢着接**连接，"
                  "CLI 上报的事件可能被那个进程吃掉，本面板就看不到「等你确认」。",
                  file=sys.stderr)
            print("[warn] 建议先关掉那个进程（另一个面板实例 / 残留的测试进程）再启动。",
                  file=sys.stderr)

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):                 # 静音
                pass

            def _send(self, code: int, payload: dict) -> None:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path.startswith("/health"):
                    self._send(200, {"ok": True, "sessions": hub.snapshot().total})
                else:
                    self._send(404, {"error": "not found"})

            def do_POST(self):
                if not self.path.startswith("/hook"):
                    self._send(404, {"error": "not found"})
                    return
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    payload = json.loads(self.rfile.read(n) or b"{}")
                except (ValueError, json.JSONDecodeError):
                    self._send(400, {"error": "bad json"})
                    return

                cli = str(payload.get("cli") or "")
                status = str(payload.get("status") or "needs-you")
                if not cli:
                    self._send(400, {"error": "cli required"})
                    return
                hub.hooks.push(
                    cli,
                    str(payload.get("sid") or ""),
                    status,
                    str(payload.get("note") or ""),
                    str(payload.get("cwd") or ""),
                )
                # 立刻回 200，重扫和推卡片丢给后台线程。
                # 这里如果同步扫一次，CLI 每次上报都要等 5 秒 —— 上报方是 CLI 自己，
                # 拖慢的是用户正在用的那个终端。
                attention = (
                    payload if status == "needs-you" and hub.cfg.push_on_needs_you else None
                )
                hub.request_refresh(attention=attention)
                self._send(200, {"ok": True})

        srv = ThreadingHTTPServer(("127.0.0.1", self.cfg.hook_port), Handler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        print(f"[ok] hook 端点监听 http://127.0.0.1:{self.cfg.hook_port}/hook")

    def push_attention(self, payload: dict) -> None:
        """有会话在等人确认时，主动推一条。同一个会话 5 分钟内只推一次，免得刷屏。"""
        if not self.client:
            return
        cli = payload.get("cli", "")
        note = payload.get("note") or "需要你确认"
        cwd = str(payload.get("cwd") or "")
        proj = os.path.basename(cwd.rstrip("\\/")) or "?"

        key = f"{cli}|{procs.norm_cwd(cwd)}|{payload.get('sid') or ''}"
        now = time.time()
        with self._attn_lock:
            if now - self._last_attention.get(key, 0) < ATTENTION_COOLDOWN:
                return
            self._last_attention[key] = now

        card = {
            "schema": "2.0",
            "config": {"update_multi": True},
            "header": {"template": "orange",
                       "title": {"tag": "plain_text", "content": "有会话在等你"}},
            "body": {"elements": [
                {"tag": "markdown", "content": f"**{cli}** · `{proj}`\n{note}"},
                {"tag": "button", "type": "primary", "size": "small",
                 "text": {"tag": "plain_text", "content": "查看全部会话"},
                 "behaviors": [{"type": "callback",
                                "value": {"cmd": "filter", "key": "needs-you"}}]},
            ]},
        }
        try:
            self.client.send_card(self.cfg.receive_id, card, self.cfg.receive_id_type)
        except FeishuError as exc:
            print(f"[warn] 推送失败: {exc}")

    # ---------------------------------------------------------- 入口

    def run(self) -> None:
        missing = self.cfg.validate()
        if missing:
            print(f"[x] 缺少配置: {', '.join(missing)}")
            print("    先跑 `python -m feishu_hub.hub --print` 看本机状态；")
            print("    再照 README 建好飞书应用，把 app_id / app_secret / receive_id 填进 config.json")
            sys.exit(2)

        self.client = FeishuClient(self.cfg.app_id, self.cfg.app_secret, self.cfg.domain)
        if self.cfg.feed_enabled and self.link.enabled:
            with self._feed_lock:
                self._feed = self.link.poll(use_control=self.cfg.feed_control)
            print(f"[ok] 外部事件流通道：事件流水 "
                  f"{'已接上' if self._feed.events_ok else '不可用'} · "
                  f"控制管道 {self.link.control_status}")
        snap = self.snapshot(force=True)
        print(f"[ok] 扫到 {snap.total} 场会话，存活进程 {snap.live_procs}")

        self.init_bitable()
        if self.bitable:
            self.sync_bitable(snap)

        self.start_hook_server()
        self.ensure_panel()
        threading.Thread(target=self._refresher, daemon=True).start()
        threading.Thread(target=self.refresh_loop, daemon=True).start()
        if self.cfg.feed_enabled and self.link.enabled:
            threading.Thread(target=self.feed_loop, daemon=True).start()

        handler = build_dispatcher(self.on_message, self.on_card)
        print("[ok] 建立飞书长连接（事件 + 卡片回调都走这里，无需公网 IP）...")
        run_ws(self.cfg.app_id, self.cfg.app_secret, handler, self.cfg.domain)


# --------------------------------------------------------------------- CLI

def print_table(snap: Snapshot) -> None:
    print(f"共 {snap.total} 场会话 · 存活进程 {snap.live_procs}")
    print("按 CLI:", snap.counts_by_cli)
    print("按状态:", {STATUS_LABEL.get(k, k): v for k, v in snap.counts_by_status.items()})
    print()
    print(f"{'状态':<10}{'CLI':<10}{'项目':<26}{'标题':<36}最后")
    print("-" * 112)
    for s in snap.sessions[:25]:
        print(f"{STATUS_LABEL[s.status]:<10}{s.cli:<10}{s.project[:25]:<26}{s.title[:35]:<36}{s.last_str}")
    if snap.total > 25:
        print(f"... 另有 {snap.total - 25} 场")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Grok Build Center · 飞书面板")
    ap.add_argument("--print", action="store_true", help="只打印本机状态，不连飞书")
    ap.add_argument("--card-preview", action="store_true", help="打印卡片 JSON 与体积")
    ap.add_argument("--bitable-preview", action="store_true",
                    help="只看要写进多维表格的行，不联网")
    ap.add_argument("--filter", default="active", help="预览用的筛选 key")
    ap.add_argument("--config", default=None, help="config.json 路径")
    args = ap.parse_args(argv)

    cfg = Config.load(args.config)
    hub = Hub(cfg)

    if args.print:
        print_table(hub.snapshot(force=True))
        return 0

    if args.bitable_preview:
        from . import bitable as bt

        snap = hub.snapshot(force=True)
        print(f"字段定义（{len(bt.TABLE_FIELDS)} 列）：")
        for name, ftype, options in bt.TABLE_FIELDS:
            extra = f"  选项 {len(options)} 个" if options else ""
            print(f"  {name:<10} type={ftype}{extra}")
        rows = [s for s in snap.sessions if s.sid]
        skipped = snap.total - len(rows)
        print(f"\n会写入 {len(rows)} 行" + (f"（跳过 {skipped} 条无 sid 的合成行）" if skipped else ""))
        print(f"按 CLI 分布：{snap.counts_by_cli}")
        print("按状态分布：" + str({STATUS_LABEL.get(k, k): v
                                    for k, v in snap.counts_by_status.items()}))
        for s in rows[:3]:
            f = bt.session_to_fields(s)
            print(f"\n  {f['状态']} · {f['CLI']} · {f['标题'][:30]}")
            print(f"    目录 {f['项目目录']}")
            print(f"    命令 {f['恢复命令'][:78]}")
            print(f"    哈希 {bt.fields_hash(f)}")
        return 0

    if args.card_preview:
        snap = hub.snapshot(force=True)
        for key in ("active", "all", "codex", "claude", "needs-you"):
            card = cards.build_panel(snap, key, 0)
            print(f"  筛选 {key:<10} {cards.card_size_kb(card):.2f} KB")
        card = cards.build_panel(snap, args.filter, 0)
        print()
        print(json.dumps(card, ensure_ascii=False, indent=1))
        return 0

    hub.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
