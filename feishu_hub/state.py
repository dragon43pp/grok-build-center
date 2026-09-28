#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
状态合并层：把「历史会话库」+「存活进程」+「CLI 主动上报的事件」合成一张统一快照。

三种状态来源，可信度从高到低：
  1. **hook 上报**（needs-you / error / done）—— CLI 自己说的，最准。需要各家 CLI 配 hook
     打到本机的 /hook 端点。没配就没有这类状态。
  2. **进程存活**（running / idle）—— 进程表说的。能确定「在跑」，但不知道它在等什么。
  3. **最后活动时间**（ended）—— 会话文件说的。

诚实地讲：**不配 hook 就没有「等你确认」**。别假装能从文件 mtime 猜出来。
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import procs
from .feed import FeedState
from .scan import build_records

# hook 上报的事件多久算过期（秒）。CLI 那边一次确认交互不会超过这么久。
HOOK_TTL = 30 * 60

# 进程活着但多久没活动算 idle（秒）
IDLE_AFTER = 5 * 60

# 外部事件流水里的「最后活动」多久之内还值得信（秒）。
# 对端退出后 events.jsonl 不会清空，那些 run 会一直躺在文件里 ——
# 拿 41 小时前的一条 tool_call 去覆盖「已结束」的判断，会把面板搞成
# 「一堆永远在跑的僵尸会话」。所以超过这个窗口就当它不存在。
FEED_FRESH = 6 * 3600

STATUS_ORDER = {
    "needs-you": 0,
    "error": 1,
    "running": 2,
    "idle": 3,
    "done": 4,
    "ended": 5,
}

STATUS_LABEL = {
    "needs-you": "等你确认",
    "error": "报错",
    "running": "在跑",
    "idle": "空闲",
    "done": "已完成",
    "ended": "已结束",
}

# 飞书卡片里 options 组件支持的色板
STATUS_COLOR = {
    "needs-you": "orange",
    "error": "red",
    "running": "green",
    "idle": "grey",
    "done": "blue",
    "ended": "grey",
}

STATUS_DOT = {
    "needs-you": "🟠",
    "error": "🔴",
    "running": "🟢",
    "idle": "⚪",
    "done": "🔵",
    "ended": "·",
}

# 合成行（只有 hook 上报、没有会话文件）用得上
CLI_LABEL = {
    "grok": "Grok Build",
    "codex": "Codex",
    "claude": "Claude Code",
    "opencode": "OpenCode",
    "gemini": "Gemini CLI",
    "cursor": "Cursor Agent",
    "qwen": "Qwen Code",
    "kimi": "Kimi CLI",
    "amp": "Amp",
    "cline": "Cline",
    # 外部管理器侧的 adapter 补齐：这两个 scan/procs/launch 三处原来都漏了，
    # 结果它在跑得好好的会话，在面板上连名字都显示不对。
    "pi": "Pi",
    "droid": "Droid",
}


@dataclass
class Session:
    cli: str
    cli_label: str
    sid: str
    title: str
    cwd: str
    last_ts: float
    start_ts: float
    msgs: int
    tools: int
    tokens: int
    resumable: bool
    cmd: str
    archived: bool
    status: str = "ended"
    live_pids: list[int] = field(default_factory=list)
    hook_note: str = ""

    # 外部事件流带来的：权威状态说明 + 可反向操作的会话 id
    feed_note: str = ""
    bridge_id: str = ""
    controllable: bool = False

    @property
    def key(self) -> str:
        return f"{self.cli}|{self.sid}"

    @property
    def last_str(self) -> str:
        return _rel(self.last_ts)

    @property
    def project(self) -> str:
        """只取目录最后一段，卡片上省地方。"""
        cwd = self.cwd.rstrip("\\/")
        return os.path.basename(cwd) or cwd or "(未知目录)"


def _rel(ts: float) -> str:
    if not ts:
        return "—"
    delta = max(0, time.time() - ts)
    if delta < 60:
        return "刚刚"
    if delta < 3600:
        return f"{int(delta // 60)} 分钟前"
    if delta < 86400:
        return f"{int(delta // 3600)} 小时前"
    days = int(delta // 86400)
    if days < 30:
        return f"{days} 天前"
    return datetime.fromtimestamp(ts).strftime("%m-%d")


def _parse_local(text: str) -> float:
    """scan.py 给的是本地时间字符串 'YYYY-MM-DD HH:MM:SS'。"""
    if not text:
        return 0.0
    try:
        return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").timestamp()
    except ValueError:
        return 0.0


class HookStore:
    """CLI hook 上报的事件暂存。进程内存即可，重启就没了 —— 这是有意的。"""

    def __init__(self) -> None:
        self._events: dict[str, dict] = {}

    @staticmethod
    def key_of(cli: str, sid: str, cwd: str) -> str:
        """有 sid 就按 sid 认；没有就退化成按目录认（CLI 未必知道自己的会话 id）。"""
        return f"{cli}|{sid}" if sid else f"{cli}|cwd:{procs.norm_cwd(cwd)}"

    def push(self, cli: str, sid: str, status: str, note: str = "", cwd: str = "") -> None:
        key = self.key_of(cli, sid, cwd)
        self._events[key] = {
            "key": key,
            "cli": cli,
            "sid": sid,
            "cwd": cwd,
            "status": status,
            "note": note,
            "at": time.time(),
        }

    def get(self, cli: str, sid: str, cwd: str) -> dict | None:
        now = time.time()
        for key in (self.key_of(cli, sid, cwd),
                    f"{cli}|cwd:{procs.norm_cwd(cwd)}"):
            ev = self._events.get(key)
            if ev and now - ev["at"] <= HOOK_TTL:
                return ev
        return None

    def prune(self) -> None:
        now = time.time()
        for key in [k for k, v in self._events.items() if now - v["at"] > HOOK_TTL]:
            self._events.pop(key, None)

    def orphans(self, matched: set[str]) -> list[dict]:
        """上报了、但在会话库里找不到对应会话的事件。

        不能直接丢掉：CLI 可能刚开会话还没落盘，或者那个目录根本不在扫描范围里。
        丢掉就等于「有会话在等你」这条最高优先级的信息被静默吃了 —— 那正是用户
        最需要看到的东西。
        """
        now = time.time()
        return [ev for k, ev in self._events.items()
                if k not in matched and now - ev["at"] <= HOOK_TTL]


@dataclass
class Snapshot:
    sessions: list[Session]
    generated_at: float
    counts_by_cli: dict[str, int]
    counts_by_status: dict[str, int]
    live_procs: int

    @property
    def total(self) -> int:
        return len(self.sessions)


def build_snapshot(hooks: HookStore | None = None,
                   feed: FeedState | None = None) -> Snapshot:
    """合成统一快照。

    状态优先级：**hook > 外部事件流 > 进程 > 文件时间**。

    事件流排在进程前面，是因为它比进程表知道得多 —— 进程表只能说「活着」，
    而 `blocked` 事件能说「活着并且卡在等你批准」。
    反过来事件流不知道的（比如你在系统终端里手动开的 codex），进程表还能兜住。
    """
    records, _stats = build_records()
    live = procs.scan_live()
    hooks = hooks or HookStore()
    feed = feed or FeedState()

    # 事件流会话索引：(cli, 规范化目录) → Run。过老的丢掉（对端退出后
    # events.jsonl 不清空，那些 run 会一直躺着变成僵尸）。
    now = time.time()
    hby_key: dict[tuple[str, str], object] = {}
    for key, run in feed.runs.items():
        if not run.exited and (now - run.last_at) <= FEED_FRESH:
            hby_key[key] = run
    # Bridge（OpenCode）按工作目录再建一层索引，用来给会话挂「可反向操作」标记
    bby_key: dict[tuple[str, str], object] = {}
    for bs in feed.bridge.values():
        bby_key[bs.key] = bs

    sessions: list[Session] = []
    matched: set[str] = set()
    matched_feed: set[tuple[str, str]] = set()
    for r in records:
        # 空 id 的占位行是噪音（对端启动过但没留下会话文件），直接滤掉
        if not r.get("id"):
            continue

        last_ts = _parse_local(r.get("last") or "")
        start_ts = _parse_local(r.get("start") or "")
        ckey = (r["cli"], procs.norm_cwd(r["cwd"]))
        pids = [p.pid for p in live.by_cli_cwd.get(ckey, [])]
        bridge = bby_key.get(ckey)

        s = Session(
            cli=r["cli"],
            cli_label=r.get("cliLabel") or r["cli"],
            sid=r["id"],
            title=r.get("title") or "(未命名)",
            cwd=r.get("cwd") or "",
            last_ts=last_ts,
            start_ts=start_ts,
            msgs=int(r.get("msgs") or 0),
            tools=int(r.get("tools") or 0),
            tokens=int(r.get("tokens") or 0),
            resumable=bool(r.get("resumable")),
            cmd=r.get("cmd") or "",
            archived=bool(r.get("archived")),
            live_pids=pids,
            bridge_id=(bridge.session_id if bridge else ""),
            controllable=bool(bridge),
        )

        # 状态判定：hook > 事件流 > 进程 > 时间
        ev = hooks.get(s.cli, s.sid, s.cwd)
        run = hby_key.get(ckey)
        if ev:
            matched.add(ev["key"])
            s.status = ev["status"]
            s.hook_note = ev.get("note") or ""
        elif run is not None:
            matched_feed.add(ckey)
            s.status = run.effective_status()
            s.feed_note = run.note
            # 事件流说在跑，那 last_ts 就该跟着它走 ——
            # 会话文件可能很久没落盘，但会话明明是活的。
            s.last_ts = max(s.last_ts, run.last_at)
        elif pids:
            age = time.time() - (last_ts or 0)
            s.status = "idle" if age > IDLE_AFTER else "running"
        else:
            s.status = "ended"

        sessions.append(s)

    # 事件流里有、但会话库里没有的：多半是刚开还没落盘，或者是对端自己
    # 拉起而 CLI 没写会话文件的场次。宁可多一行，不能漏掉「等你确认」。
    for ckey, run in hby_key.items():
        if ckey in matched_feed:
            continue
        cli, cwd = ckey
        bridge = bby_key.get(ckey)
        sessions.append(
            Session(
                cli=cli,
                cli_label=CLI_LABEL.get(cli, cli),
                sid="",
                title=run.note or f"(外部拉起 · {os.path.basename(cwd) or cwd})",
                cwd=cwd,
                last_ts=run.last_at,
                start_ts=run.started_at,
                msgs=0,
                tools=run.tool_calls,
                tokens=0,
                resumable=False,
                cmd="",
                archived=False,
                status=run.effective_status(),
                feed_note=run.note,
                bridge_id=(bridge.session_id if bridge else ""),
                controllable=bool(bridge),
            )
        )

    # 上报了但会话库里没有的 hook 事件，补成一条合成行
    for ev in hooks.orphans(matched):
        last_ts = ev["at"]
        sessions.append(
            Session(
                cli=ev["cli"],
                cli_label=CLI_LABEL.get(ev["cli"], ev["cli"]),
                sid=ev.get("sid") or "",
                title=ev.get("note") or "(新会话，还没落盘)",
                cwd=ev.get("cwd") or "",
                last_ts=last_ts,
                start_ts=last_ts,
                msgs=0,
                tools=0,
                tokens=0,
                # 会话文件还没写出来，但 CLI 自己报了 id —— 它自己认得，就让它能恢复
                resumable=bool(ev.get("sid")),
                cmd="",
                archived=False,
                status=ev["status"],
                hook_note=ev.get("note") or "",
            )
        )

    sessions.sort(key=lambda s: (STATUS_ORDER.get(s.status, 9), -s.last_ts))

    counts_by_cli: dict[str, int] = {}
    counts_by_status: dict[str, int] = {}
    for s in sessions:
        counts_by_cli[s.cli] = counts_by_cli.get(s.cli, 0) + 1
        counts_by_status[s.status] = counts_by_status.get(s.status, 0) + 1

    return Snapshot(
        sessions=sessions,
        generated_at=time.time(),
        counts_by_cli=counts_by_cli,
        counts_by_status=counts_by_status,
        live_procs=live.total(),
    )


# ------------------------------------------------------------------ 筛选

def filter_sessions(snap: Snapshot, key: str) -> list[Session]:
    """key: 'all' | 'active' | 'needs-you' | 'error' | 'codex' | 'claude' ..."""
    if key in ("all", "", None):
        return snap.sessions
    if key == "active":
        return [s for s in snap.sessions if s.status in ("needs-you", "error", "running", "idle")]
    if key in ("needs-you", "error"):
        return [s for s in snap.sessions if s.status == key]
    return [s for s in snap.sessions if s.cli == key]


if __name__ == "__main__":
    snap = build_snapshot()
    print(f"共 {snap.total} 场会话（过滤掉空 id 占位行后）· 存活进程 {snap.live_procs}")
    print("按 CLI:", snap.counts_by_cli)
    print("按状态:", {STATUS_LABEL.get(k, k): v for k, v in snap.counts_by_status.items()})
    print()
    print(f"{'状态':<10} {'CLI':<10} {'项目':<28} {'标题':<34} 最后")
    print("-" * 110)
    for s in snap.sessions[:15]:
        print(f"{STATUS_LABEL[s.status]:<10} {s.cli:<10} {s.project[:27]:<28} {s.title[:33]:<34} {s.last_str}")
