#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
外部事件流通道（可选）
======================

可选的**被动通道**：读一个外部会话管理器自己写的 append-only 事件流水，
外加一条可选的控制管道（能反向放行 / 回答 / 投喂）。两条路互不依赖，
**任何一条拿不到都静默降级** —— 面板该怎么样还怎么样。

设计上刻意做成「不配置就是哑巴」：这个仓库里**不写死任何具体路径**，
读什么完全由 `config.json` 决定。没有配置时本模块一次系统调用都不发，
面板上也不会多出任何一行。

路 1：事件流水（adapter 无关）
------------------------------
一个 append-only 的 JSONL 文件，一行一个 JSON，`kind` 有六种：

    session_start  detail = 工作目录，title = adapter 显示名
    tool_call      正在干活
    blocked        **卡在等你确认**（要批准工具 / 要回答问题）
    approved       放行了
    completed      一轮结束
    session_exit   进程退了，detail = "exit code 0"

这条路的**价值就在 `blocked` 上**：会话管理器自己已经在记「哪场在等你」，
所以只要是它拉起的会话，**不用给任何 CLI 配 hook** 也能有橙色的「等你确认」。

坑：这个文件可能被压缩重写（比如只留最新 N 条），所以**不能假设偏移单调
递增** —— 文件比上次记录的偏移还小时要整个重读。

路 2：控制管道（能力按对端给的为准）
------------------------------------
一条命名管道，换行分隔的 JSON-RPC，token 从一个文件读。
本端只用到这几个方法，对端实现哪些就用哪些：

    sessions.list      → 活着的会话（权威状态 + 模型 + 待确认数）
    session.approve    → 批准一个待确认
    session.deny       → 拒绝
    session.questions  → 列出待回答的问题
    session.answer     → 回答
    session.send       → 往**活着的**那一场再投一句话

这是唯一能**反向操作**的路：从飞书直接放行 / 回答 / 投喂，而不是像
`remote.py` 那样另起一个无头进程（那样 TUI 里那场根本看不到）。

对端可能只放行部分 adapter 的会话（比如只暴露 opencode），
拿不到别的不是 bug —— 上层按「这一条路覆盖不全」处理即可。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from dataclasses import dataclass, field

# 事件 kind → 本项目的状态
EVENT_STATUS = {
    "blocked": "needs-you",
    "approved": "running",
    "tool_call": "running",
    "completed": "done",
    "session_start": "running",
    "session_exit": "ended",
}

# 多久没动静算 idle（秒）。tool_call 很密，5 分钟足够宽松。
IDLE_AFTER = 5 * 60

# adapterId → 本项目内部的 cli 名。两边叫法不一样，不映射就认不出来。
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


def norm_ws(path: str) -> str:
    if not path:
        return ""
    return os.path.normcase(os.path.normpath(str(path).strip().rstrip("\\/")))


# --------------------------------------------------------------------------
# Run：一次被外部拉起的会话
# --------------------------------------------------------------------------

@dataclass
class Run:
    """外部拉起的一场会话。事件流水里没有 sessionId，只能按
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
    """增量读事件流水，维护「当前有哪些会话、各自什么状态」。

    为什么增量读：一次全量重扫要遍历 1 GB 级的 codex 库，已经够慢了，
    不能再每次都把几千行事件也解析一遍。但文件可能被压缩重写，
    所以变小了就得整个重读 —— 这个判断不能省。

    `path` 为空 = 未配置，poll() 直接返回 False，不做任何 IO。
    """

    MAX_SCAN_BYTES = 8 * 1024 * 1024      # 单文件最多读 8 MB，防异常膨胀

    def __init__(self, path: str = "") -> None:
        self.path = path or ""
        self._offset = 0
        self._size = 0
        self.runs: dict[tuple[str, str], Run] = {}
        self.ok = False
        self.last_error = "" if self.path else "未配置事件流水"

    @property
    def configured(self) -> bool:
        return bool(self.path)

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
        """读一次增量。返回是否有新事件。没配置 / 读不到就静默返回 False。"""
        if not self.path:
            self.ok = False
            return False
        if not os.path.exists(self.path):
            self.ok = False
            self.last_error = "流水文件不存在"
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
                continue      # 断电截断的坏行：跳过，跟写的一方一样处理
            if self._apply(event):
                got = True

        self._offset = new_offset
        self.ok = True
        self.last_error = ""
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
        # 常见是毫秒 epoch；万一给成秒（<10^12）就按秒算
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

        # 其余事件要挂到某场会话上。流水里**没有 sessionId**，
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
        """当前有效的会话。已结束的留着，让上层决定要不要显示。"""
        return dict(self.runs)

    def active(self) -> dict[tuple[str, str], Run]:
        return {k: r for k, r in self.runs.items() if not r.exited}


# --------------------------------------------------------------------------
# 路 2：控制管道
# --------------------------------------------------------------------------

class ControlError(RuntimeError):
    pass


@dataclass
class ControlSession:
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
    def cli(self) -> str:
        return ADAPTER_TO_CLI.get(self.agent.lower(), self.agent.lower() or "opencode")

    @property
    def key(self) -> tuple[str, str]:
        return (self.cli, norm_ws(self.workspace))


def read_control_token(path: str) -> str:
    """从文件读 token。空路径 / 读不到 / 格式不对 → 返回空串（调用方据此禁用）。"""
    if not path:
        return ""
    try:
        with open(path, encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError:
        return ""
    return token if TOKEN_RE.match(token) else ""


class ControlPipe:
    """控制管道客户端。没配置 / 对端没开 / 管道不存在 → `available` 为 False，
    所有调用抛 ControlError，上层按降级处理。"""

    def __init__(self, pipe: str = "", token_path: str = "",
                 timeout: float = 5.0) -> None:
        self.timeout = timeout
        self.available = False
        self.last_error = ""
        if not pipe:
            self.last_error = "未配置控制管道"
        self._token = read_control_token(token_path)
        self._path = pipe or ""

    @property
    def configured(self) -> bool:
        return bool(self._path and self._token)

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
        """发一条请求，返回结果 dict。出错抛 ControlError。"""
        if not self._path:
            raise ControlError("未配置控制管道")
        if not self._token:
            raise ControlError("读不到控制管道 token")
        request = {
            "id": f"hub-{int(time.time() * 1000)}",
            "token": self._token,
            "method": method,
            "params": params or {},
        }
        try:
            # Windows 命名管道：open() 走 CreateFile，没有服务端会立刻
            # 抛 FileNotFoundError —— 这正是我们判断「对端没开」的方式。
            fh = open(self._path, "r+b", buffering=0)
        except FileNotFoundError:
            self.available = False
            self.last_error = "管道不存在（对端没运行？）"
            raise ControlError(self.last_error)
        except OSError as exc:
            self.available = False
            self.last_error = f"打不开管道: {exc}"
            raise ControlError(self.last_error)

        try:
            fh.write((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
            fh.flush()
            raw = self._read_line(fh, timeout or self.timeout)
        except ControlError:
            raise
        except OSError as exc:
            self.available = False
            self.last_error = f"管道读写失败: {exc}"
            raise ControlError(self.last_error)
        finally:
            try:
                fh.close()
            except OSError:
                pass

        if raw is None:
            self.available = False
            self.last_error = f"{method} 超时（{timeout or self.timeout}s）"
            raise ControlError(self.last_error)
        raw = raw.strip()
        if not raw:
            self.available = False
            self.last_error = "管道被对端关闭"
            raise ControlError(self.last_error)

        try:
            message = json.loads(raw)
        except ValueError:
            raise ControlError(f"回包不是 JSON: {raw[:120]}")

        self.available = True
        if message.get("ok"):
            return message.get("result") or {}
        body = message.get("error") or {}
        code = body.get("code", "")
        msg = body.get("message", "")
        if code == "unauthorized":
            self.last_error = "token 不对（对端重启后 token 会换？）"
        raise ControlError(f"{code or 'error'}: {msg}")

    # -- 业务方法 -------------------------------------------------------

    def sessions(self) -> list[ControlSession]:
        raw = self.call("sessions.list")
        items = raw if isinstance(raw, list) else (raw.get("sessions") or [])
        out: list[ControlSession] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            out.append(ControlSession(
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
class FeedState:
    runs: dict[tuple[str, str], Run] = field(default_factory=dict)
    control: dict[str, ControlSession] = field(default_factory=dict)
    control_ok: bool = False
    events_ok: bool = False
    note: str = ""

    # 老名字留一个只读别名，省得调用方一次改到位时漏掉某处
    @property
    def bridge(self) -> dict[str, ControlSession]:
        return self.control


class FeedLink:
    """两条路的合体。没配置 / 对端没装 / 没开都不影响调用方。"""

    def __init__(self, events_path: str = "", pipe: str = "", token: str = "",
                 pipe_timeout: float = 5.0) -> None:
        self.watcher = EventWatcher(events_path)
        self.control = ControlPipe(pipe, token, pipe_timeout)
        self._last_probe = 0.0
        self._probe_every = 3.0        # 管道探测别太勤，每次都是一次 CreateFile

    # 兼容旧调用点
    @property
    def bridge(self) -> ControlPipe:
        return self.control

    @property
    def enabled(self) -> bool:
        return self.watcher.configured or self.control.configured

    def poll(self, use_control: bool = True) -> FeedState:
        state = FeedState()
        if self.watcher.configured:
            self.watcher.poll()
            state.runs = self.watcher.live()
            state.events_ok = self.watcher.ok
        if use_control and self.control.configured:
            try:
                for s in self.control.sessions():
                    if s.session_id:
                        state.control[s.session_id] = s
                state.control_ok = True
            except ControlError as exc:
                state.note = str(exc)
                state.control_ok = False
            self._last_probe = time.time()
        return state

    @property
    def control_status(self) -> str:
        if self.control.available:
            return "已连接"
        return self.control.last_error or "未连接"


# --------------------------------------------------------------------------
# 命令行自检
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m feishu_hub.feed",
        description="外部事件流通道自检（不传参数 = 未配置，什么都不读）")
    ap.add_argument("--events", default="", help="事件流水文件路径（JSONL）")
    ap.add_argument("--pipe", default="", help="控制管道路径")
    ap.add_argument("--token", default="", help="控制管道 token 文件路径")
    ap.add_argument("--config", default="", help="从 config.json 读 feed_* 配置")
    a = ap.parse_args(argv)

    events, pipe, token = a.events, a.pipe, a.token
    if a.config:
        try:
            with open(a.config, encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, ValueError) as exc:
            print(f"[x] 读不了配置 {a.config}: {exc}")
            return 2
        events = events or str(raw.get("feed_events") or "")
        pipe = pipe or str(raw.get("feed_pipe") or "")
        token = token or str(raw.get("feed_token") or "")

    if not (events or pipe):
        print("这条通道是可选的，默认关闭，所以现在什么都没配。")
        print()
        print("想接自己的会话管理器，在 config.json 里写：")
        print('    "feed_enabled": true,')
        print('    "feed_events": "<它的 append-only 事件流水 JSONL 路径>",')
        print('    "feed_pipe":   "<可选的命名管道，做反向操作>",')
        print('    "feed_token":  "<管道 token 文件>"')
        return 0

    link = FeedLink(events_path=events, pipe=pipe, token=token)
    state = link.poll()
    print(f"事件流水: {'OK' if state.events_ok else '不可用'}  {events or '(未配置)'}")
    print(f"控制管道: {link.control_status}  {pipe or '(未配置)'}")
    if not state.runs and not state.control:
        print("\n（当前没有会话）")
        return 0
    print(f"\n事件流水里的会话 {len(state.runs)} 场：")
    for (cli, ws), run in sorted(state.runs.items(),
                                 key=lambda kv: -kv[1].last_at):
        age = time.time() - run.last_at
        print(f"  {run.effective_status():<10} {cli:<9} "
              f"{os.path.basename(ws) or ws:<24} tools={run.tool_calls:<4} "
              f"{age / 60:.0f} 分钟前")
    if state.control:
        print(f"\n控制管道里的会话 {len(state.control)} 场：")
        for s in state.control.values():
            print(f"  {s.status:<10} {s.name or '(未命名)':<30} {s.model} "
                  f"待确认={s.pending}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
