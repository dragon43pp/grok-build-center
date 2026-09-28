#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HRack 实时通道
==============

把 HRack（桌面上那个多 CLI 会话管理器）正在发生的事情接进来。两条路，
互不依赖，**任何一条拿不到都静默降级** —— 面板该怎么样还怎么样。

路 1：事件流水（adapter 无关）
------------------------------
``%APPDATA%\\HRack\\events\\events.jsonl``，append-only，一行一个 JSON。
kind 有六种：

    session_start  detail = 工作目录，title = adapter 显示名
    tool_call      正在干活
    blocked        **卡在等你确认**（要批准工具 / 要回答问题）
    approved       你（或 HRack）放行了
    completed      一轮结束
    session_exit   进程退了，detail = "exit code 0"

这条路的**价值就在 `blocked` 上**：HRack 自己已经在记「哪场在等你」了，
所以只要是 HRack 拉起的会话，**不用给任何 CLI 配 hook** 也能有橙色的
「等你确认」。README 里那句「不配 hook 就永远没有橙色」只适用于**没走
HRack** 的会话。

坑：这个文件会被 HRack 压缩重写（超过 5000 条只留最新 5000），
所以**不能假设偏移单调递增** —— 文件比上次记录的偏移还小时要整个重读。

路 2：Bridge 命名管道（只有 OpenCode 会话）
------------------------------------------
``\\\\.\\pipe\\hrack-bridge-<用户名>``，换行分隔的 JSON-RPC，token 在
``%APPDATA%\\HRack\\bridge.token``。

    sessions.list      → 活着的 OpenCode 会话（权威状态 + 模型 + 待确认数）
    session.approve    → 批准一个待确认
    session.deny       → 拒绝
    session.questions  → 列出待回答的问题
    session.answer     → 回答
    session.send       → 往**活着的**那一场再投一句话

这是唯一能**反向操作**的路：从飞书直接放行 / 回答 / 投喂，而不是像
`remote.py` 那样另起一个无头进程（那样 TUI 里那场根本看不到）。

注意 `sessions.list` 在 HRack 那边是**按 adapterId == 'opencode' 过滤**的，
所以 grok/codex/claude 的会话拿不到 —— 这不是 bug，是 HRack 当前的边界。
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from dataclasses import dataclass, field

APP_NAME = "HRack"

# HRack 事件 kind → 本项目的状态
EVENT_STATUS = {
    "blocked": "needs-you",
    "approved": "running",
    "tool_call": "running",
    "completed": "done",
    "session_start": "running",
    "session_exit": "ended",
}

# 多久没动静算 idle（秒）。HRack 的 tool_call 很密，5 分钟足够宽松。
IDLE_AFTER = 5 * 60

# adapterId → 本项目内部的 cli 名。HRack 用的是 adapterId，两边名字不一样。
ADAPTER_TO_CLI = {
    "grok": "grok",
    "grok-build": "grok",
    "codex": "codex",
    "claude": "claude",
    "claude-code": "claude",
    "opencode": "opencode",
    "kimi": "kimi",
    "pi": "pi",
    "gemini": "gemini",
}

TOKEN_RE = re.compile(r"^[a-f0-9]{64}$")


def user_data_dir() -> str:
    """HRack 的 userData。HRACK_USER_DATA_DIR 可以覆盖（HRack Dev 用得上）。"""
    override = os.environ.get("HRACK_USER_DATA_DIR", "").strip()
    if override:
        return override
    appdata = os.environ.get("APPDATA")
    if not appdata:
        appdata = os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    return os.path.join(appdata, APP_NAME)


def events_path() -> str:
    return os.path.join(user_data_dir(), "events", "events.jsonl")


def norm_ws(path: str) -> str:
    if not path:
        return ""
    return os.path.normcase(os.path.normpath(str(path).strip().rstrip("\\/")))


# --------------------------------------------------------------------------
# Run：一次 HRack 启动的会话
# --------------------------------------------------------------------------

@dataclass
class Run:
    """HRack 拉起的一场会话。events.jsonl 里没有 sessionId，只能按
    (adapter, 工作目录) 认 —— 跟 hook 上报的退化规则是一样的。"""

    cli: str
    workspace: str
    started_at: float = 0.0
    last_at: float = 0.0
    status: str = "running"
    note: str = ""
    tool_calls: int = 0
    exited: bool = False

    @property
    def key(self) -> tuple[str, str]:
        return (self.cli, norm_ws(self.workspace))

    @property
    def idle(self) -> bool:
        return (time.time() - self.last_at) > IDLE_AFTER

    def effective_status(self) -> str:
        """blocked 不会因为超时掉回 idle —— 「等你确认」只会越等越急。"""
        if self.status == "needs-you":
            return "needs-you"
        if self.exited:
            return "ended"
        if self.idle:
            return "idle" if self.status != "done" else "done"
        return self.status


# --------------------------------------------------------------------------
# 路 1：事件流水
# --------------------------------------------------------------------------

class EventWatcher:
    """增量读 events.jsonl，维护「当前有哪些 HRack 会话、各自什么状态」。

    为什么增量读：一次全量重扫要遍历 1.2 GB 的 codex 库，已经够慢了，
    不能再每次都把 5000 行事件也解析一遍。但文件会被压缩重写，
    所以变小 / inode 变了就得整个重读 —— 这个判断不能省。
    """

    MAX_SCAN_BYTES = 8 * 1024 * 1024      # 单文件最多读 8 MB，防异常膨胀

    def __init__(self, path: str | None = None) -> None:
        self.path = path or events_path()
        self._offset = 0
        self._size = 0
        self.runs: dict[tuple[str, str], Run] = {}
        self.ok = False
        self.last_error = ""

    # -- 读增量 ---------------------------------------------------------

    def _reset_if_rewritten(self) -> bool:
        """文件被压缩重写（变小）或第一次读 → 从头来。返回是否重置过。"""
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return False
        if size < self._size or self._size == 0:
            self._offset = 0
            self.runs = {}
            self._size = size
            return True
        self._size = size
        return False

    def poll(self) -> bool:
        """读一次增量。返回是否有新事件。读不到文件就静默返回 False。"""
        if not os.path.exists(self.path):
            self.ok = False
            return False
        try:
            rewritten = self._reset_if_rewritten()
            size = os.path.getsize(self.path)
            if size > self.MAX_SCAN_BYTES:
                # 异常大的文件：只从尾部读，别把内存吃干
                start = max(0, size - self.MAX_SCAN_BYTES)
            else:
                start = 0 if rewritten else min(self._offset, size)

            with open(self.path, "r", encoding="utf-8", errors="replace") as fh:
                fh.seek(start)
                chunk = fh.read()
                new_offset = fh.tell()
        except OSError as exc:
            self.ok = False
            self.last_error = str(exc)
            return False

        got = False
        for line in chunk.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue      # 断电截断的坏行：跳过，跟 HRack 自己一样处理
            if self._apply(event):
                got = True

        self._offset = new_offset
        self.ok = True
        return got

    # -- 状态机 ---------------------------------------------------------

    def _apply(self, event: dict) -> bool:
        if not isinstance(event, dict):
            return False
        kind = event.get("kind")
        if kind not in EVENT_STATUS:
            return False

        cli = ADAPTER_TO_CLI.get(str(event.get("adapterId") or "").lower(),
                                str(event.get("adapterId") or "").lower())
        if not cli:
            return False

        ts = event.get("occurredAt")
        # HRack 写的是毫秒 epoch；万一给成秒（<10^12）就按秒算
        try:
            when = float(ts)
        except (TypeError, ValueError):
            when = time.time()
        if when > 1e12:
            when /= 1000.0

        if kind == "session_start":
            ws = norm_ws(event.get("detail") or "")
            run = Run(cli=cli, workspace=ws, started_at=when, last_at=when,
                      status="running", note=str(event.get("title") or ""))
            self.runs[run.key] = run
            return True

        # 其余事件要挂到某场会话上。events.jsonl **没有 sessionId**，
        # 所以按 (cli, 工作目录) 找；找不到就归属到同 cli 最近的那一场
        # —— 大多数时候一台机器上一个 adapter 同时只跑一场。
        ws = norm_ws(event.get("detail") or "") if kind == "session_exit" else ""
        run = self.runs.get((cli, ws)) if ws else None
        if run is None:
            candidates = [r for r in self.runs.values()
                          if r.cli == cli and not r.exited]
            if not candidates:
                return False
            run = max(candidates, key=lambda r: r.last_at)

        run.last_at = max(run.last_at, when)

        if kind == "tool_call":
            run.tool_calls += 1
            run.status = "running"
        elif kind == "blocked":
            run.status = "needs-you"
            run.note = str(event.get("title") or event.get("detail") or "等你确认")
        elif kind == "approved":
            run.status = "running"
            run.note = ""
        elif kind == "completed":
            if run.status != "needs-you":
                run.status = "done"
            run.note = ""
        elif kind == "session_exit":
            run.exited = True
            run.status = "ended"
            run.note = str(event.get("detail") or "")
        return True

    # -- 对外 -----------------------------------------------------------

    def live(self) -> dict[tuple[str, str], Run]:
        """当前有效的 HRack 会话。已结束的留着，让上层决定要不要显示。"""
        return dict(self.runs)

    def active(self) -> dict[tuple[str, str], Run]:
        return {k: r for k, r in self.runs.items() if not r.exited}


# --------------------------------------------------------------------------
# 路 2：Bridge 命名管道
# --------------------------------------------------------------------------

class BridgeError(RuntimeError):
    pass


@dataclass
class BridgeSession:
    session_id: str
    terminal_id: str = ""
    name: str = ""
    status: str = ""
    agent: str = ""
    model: str = ""
    workspace: str = ""
    installation_id: str = ""
    pending: int = 0

    @property
    def key(self) -> tuple[str, str]:
        return ("opencode", norm_ws(self.workspace))


def bridge_socket_path() -> str:
    override = os.environ.get("HRACK_BRIDGE_SOCKET", "").strip()
    if override:
        return override
    user = os.environ.get("USERNAME") or os.environ.get("USER") or "user"
    user = re.sub(r"[^A-Za-z0-9._-]+", "_", user)[:64] or "user"
    return r"\\.\pipe\hrack-bridge-" + user


def read_bridge_token() -> str:
    override = os.environ.get("HRACK_BRIDGE_TOKEN", "").strip()
    if override:
        return override
    try:
        with open(os.path.join(user_data_dir(), "bridge.token"), encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError:
        return ""
    return token if TOKEN_RE.match(token) else ""


class Bridge:
    """HRack Bridge 客户端。HRack 没开 / 管道不存在 → `available` 为 False，
    所有调用返回错误但不抛（上层按降级处理）。"""

    def __init__(self, timeout: float = 5.0) -> None:
        self.timeout = timeout
        self.available = False
        self.last_error = ""
        self._token = read_bridge_token()
        self._path = bridge_socket_path()

    # -- 底层 -----------------------------------------------------------

    @staticmethod
    def _read_line(fh, timeout: float):
        """管道读没有超时这一说，只能靠一个 daemon 线程兜底。

        线程读不到就那么挂着（daemon，进程退出时一起没），
        主线程不等它 —— 这是**唯一**能不把 5 秒的面板重扫拖成 30 秒的办法。
        """
        box: dict = {}

        def target() -> None:
            try:
                box["line"] = fh.readline()
            except Exception as exc:                       # noqa: BLE001
                box["error"] = exc

        t = threading.Thread(target=target, daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive():
            return None
        if "error" in box:
            raise box["error"]
        return box.get("line") or ""

    def call(self, method: str, params: dict | None = None,
             timeout: float | None = None) -> dict:
        """发一条请求，返回结果 dict。出错抛 BridgeError。"""
        if not self._token:
            raise BridgeError("读不到 bridge.token（HRack 没开过？）")
        request = {
            "id": f"hub-{int(time.time() * 1000)}",
            "token": self._token,
            "method": method,
            "params": params or {},
        }
        try:
            # Windows 命名管道：open() 走 CreateFile，没有服务端会立刻
            # 抛 FileNotFoundError —— 这正是我们判断「HRack 没开」的方式。
            fh = open(self._path, "r+b", buffering=0)
        except FileNotFoundError:
            self.available = False
            self.last_error = "HRack 未运行（管道不存在）"
            raise BridgeError(self.last_error)
        except OSError as exc:
            self.available = False
            self.last_error = f"打不开管道: {exc}"
            raise BridgeError(self.last_error)

        try:
            fh.write((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
            fh.flush()
            raw = self._read_line(fh, timeout or self.timeout)
        except BridgeError:
            raise
        except OSError as exc:
            self.available = False
            self.last_error = f"管道读写失败: {exc}"
            raise BridgeError(self.last_error)
        finally:
            try:
                fh.close()
            except OSError:
                pass

        if raw is None:
            self.available = False
            self.last_error = f"{method} 超时（{timeout or self.timeout}s）"
            raise BridgeError(self.last_error)
        raw = raw.strip()
        if not raw:
            self.available = False
            self.last_error = "管道被对端关闭"
            raise BridgeError(self.last_error)

        try:
            message = json.loads(raw)
        except ValueError:
            raise BridgeError(f"回包不是 JSON: {raw[:120]}")

        self.available = True
        if message.get("ok"):
            return message.get("result") or {}
        body = message.get("error") or {}
        code = body.get("code", "")
        msg = body.get("message", "")
        if code == "unauthorized":
            self.last_error = "bridge token 不对（HRack 重启后 token 会换？）"
        raise BridgeError(f"{code or 'error'}: {msg}")

    # -- 业务方法 -------------------------------------------------------

    def sessions(self) -> list[BridgeSession]:
        raw = self.call("sessions.list")
        items = raw if isinstance(raw, list) else (raw.get("sessions") or [])
        out: list[BridgeSession] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            out.append(BridgeSession(
                session_id=str(item.get("sessionId") or ""),
                terminal_id=str(item.get("terminalId") or ""),
                name=str(item.get("name") or ""),
                status=str(item.get("status") or ""),
                agent=str(item.get("agent") or ""),
                model=str(item.get("model") or ""),
                workspace=str(item.get("workspace") or ""),
                installation_id=str(item.get("installationId") or ""),
                pending=int(item.get("pendingAttentionCount") or 0),
            ))
        return out

    def approve(self, session_id: str, request_id: str = "",
                remember: bool = False) -> dict:
        params: dict = {"sessionId": session_id}
        if request_id:
            params["requestId"] = request_id
        params["remember"] = bool(remember)
        return self.call("session.approve", params)

    def deny(self, session_id: str, request_id: str = "") -> dict:
        params: dict = {"sessionId": session_id}
        if request_id:
            params["requestId"] = request_id
        return self.call("session.deny", params)

    def questions(self, session_id: str) -> list[dict]:
        raw = self.call("session.questions", {"sessionId": session_id})
        items = raw.get("questions") if isinstance(raw, dict) else raw
        return [q for q in (items or []) if isinstance(q, dict)]

    def answer(self, session_id: str, request_id: str, text: str) -> dict:
        return self.call("session.answer", {
            "sessionId": session_id,
            "requestId": request_id,
            "answers": [text] if text else [],
        })

    def send(self, session_id: str, text: str) -> dict:
        return self.call("session.send", {"sessionId": session_id, "text": text})


# --------------------------------------------------------------------------
# 合体
# --------------------------------------------------------------------------

@dataclass
class HRackState:
    runs: dict[tuple[str, str], Run] = field(default_factory=dict)
    bridge: dict[str, BridgeSession] = field(default_factory=dict)
    bridge_ok: bool = False
    events_ok: bool = False
    note: str = ""


class HRackLink:
    """两条路的合体。HRack 没装 / 没开都不影响调用方。"""

    def __init__(self, bridge_timeout: float = 5.0) -> None:
        self.watcher = EventWatcher()
        self.bridge = Bridge(bridge_timeout)
        self._last_probe = 0.0
        self._probe_every = 3.0        # 管道探测别太勤，每次都是一次 CreateFile

    def poll(self, use_bridge: bool = True) -> HRackState:
        self.watcher.poll()
        state = HRackState(
            runs=self.watcher.live(),
            events_ok=self.watcher.ok,
        )
        if use_bridge:
            now = time.time()
            try:
                for s in self.bridge.sessions():
                    if s.session_id:
                        state.bridge[s.session_id] = s
                state.bridge_ok = True
            except BridgeError as exc:
                state.note = str(exc)
                state.bridge_ok = False
            self._last_probe = now
        return state

    @property
    def bridge_status(self) -> str:
        if self.bridge.available:
            return "已连接"
        return self.bridge.last_error or "未连接"


# --------------------------------------------------------------------------
# 命令行自检
# --------------------------------------------------------------------------

def main() -> int:
    link = HRackLink()
    state = link.poll()
    print(f"事件流水: {'OK' if state.events_ok else '不可用'}  {events_path()}")
    print(f"Bridge   : {link.bridge_status}  {bridge_socket_path()}")
    if not state.runs and not state.bridge:
        print("\n（HRack 当前没有会话）")
        return 0
    print(f"\nHRack 会话 {len(state.runs)} 场：")
    for (cli, ws), run in sorted(state.runs.items(),
                                 key=lambda kv: -kv[1].last_at):
        age = time.time() - run.last_at
        print(f"  {run.effective_status():<10} {cli:<9} {os.path.basename(ws) or ws:<24} "
              f"tools={run.tool_calls:<4} {age / 60:.0f} 分钟前")
    if state.bridge:
        print(f"\nBridge（OpenCode）{len(state.bridge)} 场：")
        for s in state.bridge.values():
            print(f"  {s.status:<10} {s.name or '(未命名)':<30} {s.model} "
                  f"待确认={s.pending}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
