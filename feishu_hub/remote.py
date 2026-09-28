#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
远程续跑：把「看会话正文」和「从飞书继续任务」这两件事做出来。

**为什么不能靠终端**：那五家 CLI 都是全屏 TUI，把 TUI 流到飞书既没法交互也看不清。
但它们**都提供了无头（headless）单轮模式** —— 吃一个 prompt，把结果打到 stdout 就退出。
所以「继续任务」的正确形态是：

    飞书发一句话 → 本机无头续跑那一场会话 → 把结果回传飞书

不是远程控制终端，是**远程投喂一轮**。这个差别很重要：
不碰 PTY，就没有窗口尺寸、转义序列、交互式确认这一堆无底洞。

**各家语法（已实测）**：

    grok      grok --cwd <cwd> -r <sid> -p "<prompt>"
    codex     codex exec resume <sid> "<prompt>" --skip-git-repo-check
    claude    claude -p --resume <sid> "<prompt>"
    opencode  opencode run --session <sid> "<prompt>"
    gemini    gemini -p --resume <sid> "<prompt>"

**调用时有个隐蔽的前提：stdin 一定要关掉**（`stdin=DEVNULL`）。
不关的话 `grok -r ... -p ...` 会继承父进程的 stdin 并**等输入**，
表现为零输出挂死 —— 会被误判成「grok 不支持无头续跑」。见 `headless_resume`。

**安全边界**（prompt 是外部输入，sid/cwd 来自飞书回调）：
  - 一律用 argv 数组，**绝不拼 shell 串** —— prompt 里带引号/分号/管道都不会被解释
  - sid 过白名单正则，cwd 必须真实存在
  - 强制超时，避免卡死的会话把服务吊住
  - **默认不自动批准工具执行**（见 `auto_approve`），要放开得显式配置
"""

from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import sqlite3
import sys
from dataclasses import dataclass

# 单次续跑的最长等待。agent 跑一轮可能好几分钟，给足但要封顶。
DEFAULT_TIMEOUT = 900

# 详情卡里显示最近几轮 / 每轮截断到多少字。
# 卡片整体上限 30 KB，所以这两个值决定卡片会不会爆。
MAX_TURNS = 10
MAX_TURN_CHARS = 900
MAX_PROMPT_CHARS = 4000

SAFE_ID = re.compile(r"^[A-Za-z0-9._\-]{1,128}$")


class RemoteError(RuntimeError):
    pass


@dataclass
class Turn:
    role: str          # user | assistant | system
    text: str
    ts: float = 0.0

    @property
    def label(self) -> str:
        return {"user": "你", "assistant": "AI", "system": "系统"}.get(self.role, self.role)


# ---------------------------------------------------------------- 正文读取

def _home() -> str:
    return os.path.expanduser("~")


def _read_grok(sid: str, limit: int) -> list[Turn]:
    """~/.grok/sessions/<esc-cwd>/<sid>/chat_history.jsonl

    每行是 `{"type": "user|assistant|reasoning|tool_result", "content": "文本"}`。
    只取 user / assistant —— reasoning 和 tool_result 量大且不是「对话」，
    塞进卡片会把真正的上下文挤掉。
    """
    turns: list[Turn] = []
    for path in glob.glob(os.path.join(_home(), ".grok", "sessions", "*", sid, "chat_history.jsonl")):
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    kind = obj.get("type")
                    if kind not in ("user", "assistant"):
                        continue
                    text = obj.get("content")
                    if isinstance(text, str) and text.strip():
                        turns.append(Turn("assistant" if kind == "assistant" else "user", text.strip()))
        except OSError:
            continue
    return turns[-limit:]


def _read_codex(sid: str, limit: int) -> list[Turn]:
    """~/.codex/thread_history_1.sqlite → thread_items

    按 `rollout_ordinal` 排序才是真实对话顺序（`created_at_ms` 会因补写而乱）。
    item_json 形如 `{"type":"userMessage","content":[{"type":"text","text":"..."}]}`。
    """
    db = os.path.join(_home(), ".codex", "thread_history_1.sqlite")
    if not os.path.exists(db):
        return []
    mapping = {"userMessage": "user", "agentMessage": "assistant", "assistant": "assistant"}
    turns: list[Turn] = []
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            # **必须在 SQL 里先按 item_type 过滤，再 limit。**
            # 一场会话动辄两千条 item，绝大多数是 reasoning / 工具调用 ——
            # 如果先 `order by ordinal desc limit N` 再在 Python 里过滤，
            # 拿到的最后 N 条几乎全是 reasoning，过滤完一场会话只剩 0～2 轮。
            rows = conn.execute(
                "select item_json, item_type, created_at_ms from thread_items "
                "where thread_id = ? and item_type in ('userMessage', 'agentMessage') "
                "order by rollout_ordinal desc limit ?",
                (sid, limit),
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return []
    for raw, item_type, ms in reversed(rows):
        role = mapping.get(item_type or "")
        if not role:
            continue
        text = _codex_text(raw)
        if text:
            turns.append(Turn(role, text, (ms or 0) / 1000.0))
    return turns[-limit:]


def _codex_text(raw: str) -> str:
    """codex 的正文有两个地方，按消息类型分：

        userMessage   → content[] 数组，每段 {"type":"text","text":"..."}
        agentMessage  → **顶层 "text" 字符串**，content 是 null

    只看 content 的话，AI 的回复会全部读成空 —— 表现是「只有你说话，AI 从没回过」。
    """
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return ""
    content = obj.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    if isinstance(content, list):
        parts = []
        for seg in content:
            if isinstance(seg, dict):
                txt = seg.get("text")
                if isinstance(txt, str) and txt.strip():
                    parts.append(txt.strip())
        if parts:
            return "\n".join(parts)
    # agentMessage 的正文在这里
    direct = obj.get("text")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    return ""


def _read_claude(sid: str, limit: int) -> list[Turn]:
    """~/.claude/projects/<proj>/<sid>.jsonl

    标准 Anthropic 消息格式，`message.content` 是块数组。
    注意文件里混了大量非对话行（queue-operation / file-history-snapshot / ai-title），
    只认 type 是 user / assistant 的。
    """
    turns: list[Turn] = []
    for path in glob.glob(os.path.join(_home(), ".claude", "projects", "*", f"{sid}.jsonl")):
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    if obj.get("type") not in ("user", "assistant"):
                        continue
                    msg = obj.get("message") or {}
                    text = _claude_text(msg.get("content"))
                    # 工具调用结果也会以 user 身份出现，纯 tool_result 块会被 _claude_text 过滤成空
                    if text:
                        turns.append(Turn(obj["type"], text))
        except OSError:
            continue
    return turns[-limit:]


def _claude_text(content) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = []
    for seg in content:
        if isinstance(seg, dict) and seg.get("type") == "text":
            txt = seg.get("text")
            if isinstance(txt, str) and txt.strip():
                parts.append(txt.strip())
    return "\n".join(parts)


def _read_opencode(sid: str, limit: int) -> list[Turn]:
    """~/.local/share/opencode/opencode.db

    正文在 `part` 表（`data.type == "text"`），角色在 `message` 表（`data.role`）。
    两张表用 message_id 关联。
    """
    db = os.path.join(_home(), ".local", "share", "opencode", "opencode.db")
    if not os.path.exists(db):
        return []
    turns: list[Turn] = []
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            # 和 codex 同一个坑：先 limit 再过滤会拿到一堆被筛掉的行。
            # 角色藏在 data 的 JSON 里，用 json_extract 让 SQL 先滤掉非 user/assistant 的消息。
            try:
                msgs = conn.execute(
                    "select id, data, time_created from message where session_id = ? "
                    "and json_extract(data, '$.role') in ('user', 'assistant') "
                    "order by time_created desc limit ?",
                    (sid, limit),
                ).fetchall()
            except sqlite3.OperationalError:
                # 编译的 SQLite 没开 JSON1 → 退化成多取一些再过滤
                msgs = conn.execute(
                    "select id, data, time_created from message where session_id = ? "
                    "order by time_created desc limit ?",
                    (sid, limit * 10),
                ).fetchall()
            for mid, mdata, mts in reversed(msgs):
                try:
                    role = (json.loads(mdata) or {}).get("role")
                except ValueError:
                    continue
                if role not in ("user", "assistant"):
                    continue
                texts = []
                for (pdata,) in conn.execute(
                    "select data from part where message_id = ? order by time_created", (mid,)
                ):
                    try:
                        p = json.loads(pdata) or {}
                    except ValueError:
                        continue
                    if p.get("type") == "text" and isinstance(p.get("text"), str):
                        texts.append(p["text"].strip())
                blob = "\n".join(t for t in texts if t)
                if blob:
                    turns.append(Turn(role, blob, (mts or 0) / 1000.0))
        finally:
            conn.close()
    except sqlite3.Error:
        return []
    return turns[-limit:]


READERS = {
    "grok": _read_grok,
    "codex": _read_codex,
    "claude": _read_claude,
    "opencode": _read_opencode,
}

# 能走「无头续跑」的 CLI。kimi / pi 不在这里 —— 它们靠 HRack Bridge 投喂，
# 别混进同一条路：这条是另起一个进程，那场活着的会话根本收不到。
HEADLESS_CLIS = ("grok", "codex", "claude", "opencode", "gemini", "kimi", "pi")


def read_transcript(cli: str, sid: str, limit: int = MAX_TURNS) -> list[Turn]:
    """读一场会话最近的对话。读不到就返回空列表（不抛），调用方自己决定怎么提示。"""
    if not SAFE_ID.match(sid or ""):
        return []
    reader = READERS.get(cli)
    if not reader:
        return []
    try:
        return reader(sid, limit)
    except Exception as exc:                                  # noqa: BLE001
        print(f"[warn] 读会话正文失败 {cli}/{sid}: {exc}", file=sys.stderr)
        return []


# ---------------------------------------------------------------- 会话体量提示

# 实测（本机，2026-09-25）：
#     60 KB 的 grok 会话 → 首次续跑 **19 秒**回来
#   1547 KB 的 grok 会话 → **600 秒仍没回来，零输出**
# 恢复过程似乎要重跑一遍历史压缩，成本跟历史长度强相关，而且**不是线性的**：
# 从 60 KB 到 1.5 MB 就是「十几秒」到「十几分钟」的差别。
# 所以点按钮之前就得把预期说清楚，不然用户会以为程序卡死了。
HEAVY_BYTES = 400 * 1024
HUGE_BYTES = 1024 * 1024


def session_size(cli: str, sid: str) -> int:
    """这场会话的正文有多大（字节）。拿不到就返回 0（当作「不知道」，不提示）。"""
    if not SAFE_ID.match(sid or ""):
        return 0
    total = 0
    try:
        if cli == "grok":
            pats = [os.path.join(_home(), ".grok", "sessions", "*", sid, "chat_history.jsonl")]
        elif cli == "codex":
            # codex 的会话正文在 rollout 文件里，文件名形如 rollout-<时间>-<sid>.jsonl
            pats = [os.path.join(_home(), ".codex", "sessions", "**", f"*{sid}*.jsonl")]
        elif cli == "claude":
            pats = [os.path.join(_home(), ".claude", "projects", "*", f"{sid}.jsonl")]
        else:
            return 0
        for pat in pats:
            for p in glob.glob(pat, recursive=True):
                total += os.path.getsize(p)
    except OSError:
        return 0
    return total


def size_hint(nbytes: int) -> str:
    """把体量翻译成「大概要等多久」。返回空串表示不用提示。"""
    if nbytes >= HUGE_BYTES:
        return (f"这场会话历史很大（{nbytes / 1048576:.1f} MB），续跑可能要十几分钟。"
                "提交后不用在这儿等，出结果会自动推回来。")
    if nbytes >= HEAVY_BYTES:
        return f"这场会话历史偏大（{nbytes / 1024:.0f} KB），续跑可能要几分钟。"
    return ""


# ---------------------------------------------------------------- 无头续跑

def _which(name: str) -> str | None:
    """找可执行文件。npm 装的 CLI 在 Windows 上是 .cmd 包装，which 拿得到。"""
    return shutil.which(name)


def build_argv(cli: str, sid: str, cwd: str, prompt: str, auto_approve: bool = False) -> list[str]:
    """拼 argv 数组（**不是** shell 串）。prompt 原样作为一个元素传进去。"""
    if not SAFE_ID.match(sid or ""):
        raise RemoteError(f"会话 id 不合法: {sid!r}")
    if not prompt or not prompt.strip():
        raise RemoteError("prompt 是空的")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise RemoteError(f"prompt 太长（{len(prompt)} > {MAX_PROMPT_CHARS} 字）")

    exe = _which(cli)
    if not exe:
        raise RemoteError(f"本机找不到 {cli} 可执行文件（不在 PATH 里）")
    if not cwd or not os.path.isdir(cwd):
        raise RemoteError(f"工作目录不存在: {cwd or '(空)'}")

    if cli == "grok":
        argv = [exe, "--cwd", cwd, "-r", sid, "-p", prompt]
        if auto_approve:
            argv.insert(1, "--always-approve")
    elif cli == "codex":
        # --skip-git-repo-check 是**必须**的：不加的话，只要会话目录不是 git 仓库，
        # codex 会直接 `Not inside a trusted directory` 退出（1 秒内失败，不跑）。
        # 我们是回到一场已存在的会话，要求它是 git 仓库毫无道理。
        argv = [exe, "exec", "resume", sid, prompt, "--skip-git-repo-check"]
        if auto_approve:
            # 必须排在 resume 之前，否则 codex 会把它当成 prompt 的一部分
            argv[2:2] = ["--dangerously-bypass-approvals-and-sandbox"]
    elif cli == "claude":
        argv = [exe, "-p", "--resume", sid, prompt]
        if auto_approve:
            argv[1:1] = ["--dangerously-skip-permissions"]
    elif cli == "opencode":
        argv = [exe, "run", "--session", sid, prompt]
    elif cli == "gemini":
        argv = [exe, "-p", "--resume", sid, prompt]
        if auto_approve:
            argv[1:1] = ["--yolo"]
    elif cli in ("kimi", "pi"):
        # 这两个没有稳定的「续跑」子命令，统一走 -p 单轮模式 + 会话 id。
        # 拿不准参数就别硬猜 —— 调用方会在失败卡上拿到真实报错。
        argv = [exe, "-p", "--session", sid, prompt]
    else:
        raise RemoteError(
            f"不支持无头续跑: {cli!r}"
            f"（能续跑 {', '.join(HEADLESS_CLIS)}；"
            f"HRack 的 kimi/pi 请用面板上的「投喂」走 Bridge，别走这条）"
        )
    return argv


def headless_resume(
    cli: str, sid: str, cwd: str, prompt: str,
    timeout: int = DEFAULT_TIMEOUT, auto_approve: bool = False,
) -> tuple[bool, str]:
    """无头续跑一场会话，返回 (成功?, 输出文本)。

    输出里混着 CLI 自己的状态行和 ANSI 转义，统一清一遍再回传 ——
    飞书卡片渲染不了终端控制序列，不清的话会看到一堆 `[2m` 之类。
    """
    try:
        argv = build_argv(cli, sid, cwd, prompt, auto_approve)
    except RemoteError as exc:
        return False, str(exc)

    try:
        proc = subprocess.run(
            argv,
            cwd=cwd,
            capture_output=True,
            timeout=timeout,
            check=False,
            # **stdin 必须关掉。**
            # 不关的话子进程继承我们的 stdin，`grok -r ... -p ...` 会安安静静
            # 等键盘输入 —— 表现是**零输出挂死**，超时才炸，还以为是 grok 不支持无头续跑。
            # 关掉之后同一个命令 19 秒正常返回。这是个真实踩过的坑。
            # 顺带好处：CLI 若要交互式确认，读到 EOF 会立刻失败退出，而不是吊住。
            stdin=subprocess.DEVNULL,
            # NO_COLOR 是通用约定，能少一大截转义序列。_clean 兜底清 ANSI，
            # 但源头不产生更省事。TERM=dumb 同理。
            env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"},
        )
    except subprocess.TimeoutExpired:
        return False, f"超时（{timeout} 秒）——会话可能卡住或任务太大，可缩短 prompt 再试"
    except OSError as exc:
        return False, f"启动失败: {exc}"

    out = _clean(proc.stdout.decode("utf-8", errors="replace"))
    err = _clean(proc.stderr.decode("utf-8", errors="replace"))

    if proc.returncode != 0:
        detail = out or err or "(没有任何输出)"
        return False, f"退出码 {proc.returncode}\n{detail}"
    return True, (out or "(没有输出)")


ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")


def _clean(text: str) -> str:
    """去掉 ANSI 转义和多余空行。终端控制序列在卡片里只会变成乱码。"""
    text = ANSI.sub("", text or "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.rstrip() for ln in text.split("\n")]
    out: list[str] = []
    for ln in lines:
        if not ln and out and not out[-1]:
            continue
        out.append(ln)
    return "\n".join(out).strip()


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="远程续跑：读正文 / 无头续跑")
    ap.add_argument("cli", nargs="?", help="grok | codex | claude | opencode | gemini")
    ap.add_argument("sid", nargs="?", help="会话 id")
    ap.add_argument("--turns", type=int, default=MAX_TURNS)
    ap.add_argument("--ask", help="给定 prompt 就真跑一轮（会消耗额度，谨慎）")
    ap.add_argument("--cwd", default="")
    ap.add_argument("--dry", action="store_true", help="只打印 argv，不执行")
    a = ap.parse_args()

    if not a.cli or not a.sid:
        print("各家无头续跑语法：")
        for c in READERS:
            exe = _which(c) or "(未安装)"
            print(f"  {c:<10} {exe}")
        print()
        print("用法示例：")
        print("  python -m feishu_hub.remote grok <sid> --turns 5")
        print("  python -m feishu_hub.remote grok <sid> --cwd D:\\x --ask '继续' --dry")
        raise SystemExit(0)

    if a.ask:
        if a.dry:
            print(build_argv(a.cli, a.sid, a.cwd or os.getcwd(), a.ask))
        else:
            ok, out = headless_resume(a.cli, a.sid, a.cwd or os.getcwd(), a.ask)
            print(f"[{'ok' if ok else 'x'}] {out[:2000]}")
    else:
        turns = read_transcript(a.cli, a.sid, a.turns)
        print(f"读到 {len(turns)} 轮：\n")
        for t in turns:
            body = t.text if len(t.text) <= 300 else t.text[:300] + " …"
            print(f"[{t.label}] {body}\n")
