#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多 CLI 会话历史扫描器
=====================

把本机所有 AI CLI 的会话库汇总成一份**离线可全文搜索**的 HTML，
解决「时间长记不住在哪些工作空间干了什么、对话到哪了」的问题。

数据源
------
  HRack      %APPDATA%\\HRack\\events\\events.jsonl          启动流水（标记哪场由 HRack 拉起）
  Grok       ~/.grok/sessions/<esc-cwd>/<sid>/summary.json
             ~/.grok/sessions/session_search.sqlite          FTS5 全文索引
  Codex      ~/.codex/state_5.sqlite            → threads 表（288 条：title/name/cwd/archived/tokens）
             ~/.codex/thread_history_1.sqlite   → thread_items 表（对话正文）
             ~/.codex/history.jsonl             （补充：prompt 流水）
  Claude     ~/.claude/history.jsonl            （按 sessionId 聚合）
             ~/.claude/projects/**/*.jsonl      （有则读正文）
  opencode   ~/.local/share/opencode/storage/session/global/*.json
             ~/.local/share/opencode/storage/message/<sid>/*.json

用法
----
    python build_history.py                       # 生成 session-history.html
    python build_history.py --open                # 生成后打开浏览器
    python build_history.py --search "FetchV"     # 终端全文搜索（跨所有 CLI）
    python build_history.py --cli codex           # 只扫 Codex
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sqlite3
import sys
import urllib.parse
import webbrowser
from datetime import datetime, timezone

APP_NAME = "HRack"
GROK_SESSION_GRACE_SECONDS = 180   # HRack session_start 与 grok created_at 的容差
EXCERPT_LIMIT = 12000              # 每条记录嵌入 HTML 的正文上限（字符）

# CLI 元信息：显示名 / 主题色 / 恢复命令模板
CLI_META = {
    "grok":     {"label": "Grok Build", "short": "grok",     "hue": "#7c3aed",
                 "resume": 'cd /d {cwd} && grok -r {id}'},
    "codex":    {"label": "Codex",      "short": "codex",    "hue": "#0d9488",
                 "resume": 'cd /d {cwd} && codex resume {id}'},
    "claude":   {"label": "Claude Code", "short": "claude",  "hue": "#c2410c",
                 "resume": 'cd /d {cwd} && claude -r {id}'},
    "opencode": {"label": "opencode",   "short": "opencode", "hue": "#0369a1",
                 "resume": 'cd /d {cwd} && opencode --session {id}'},
    # HRack 支持这两个 adapter，但 scan / procs / launch 三处原来都漏了，
    # 结果 HRack 里跑着的 kimi / pi 会话在这里连显示名都没有。
    "kimi":     {"label": "Kimi",       "short": "kimi",     "hue": "#2563eb",
                 "resume": 'cd /d {cwd} && kimi --session {id}'},
    "pi":       {"label": "Pi",         "short": "pi",       "hue": "#7c2d12",
                 "resume": 'cd /d {cwd} && pi --session {id}'},
}
CLI_ORDER = ["grok", "codex", "claude", "opencode", "kimi", "pi"]


# --------------------------------------------------------------------------
# 路径与通用工具
# --------------------------------------------------------------------------

def user_data_dir() -> str:
    # Git Bash / 精简环境里 %APPDATA% 可能不存在，退回 ~/AppData/Roaming
    appdata = os.environ.get("APPDATA")
    if not appdata:
        appdata = os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    return os.path.join(appdata, APP_NAME)


def home() -> str:
    return os.path.expanduser("~")


def grok_home() -> str:
    return os.path.join(home(), ".grok")


def codex_home() -> str:
    return os.path.join(home(), ".codex")


def claude_home() -> str:
    return os.path.join(home(), ".claude")


def opencode_home() -> str:
    return os.path.join(home(), ".local", "share", "opencode")


def parse_iso_utc(value: str | None):
    """解析形如 2026-09-22T04:08:04.814653100Z 的时间戳（纳秒精度）。"""
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    text = re.sub(r"(\.\d{6})\d+", r"\1", text)   # 截断到微秒
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone()


def from_epoch_ms(ms) -> datetime | None:
    try:
        return datetime.fromtimestamp(float(ms) / 1000.0).astimezone()
    except (TypeError, ValueError, OSError):
        return None


def fmt_local(dt: datetime | None) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S") if dt else "-"


def norm_ws(path: str | None) -> str:
    if not path:
        return ""
    return os.path.normcase(os.path.normpath(str(path).strip().rstrip("\\/")))


def clean_win_path(path: str | None) -> str:
    """去掉 Windows 扩展长度前缀 \\\\?\\ 与尾部分隔符。"""
    if not path:
        return ""
    text = str(path).strip()
    if text.startswith("\\\\?\\"):
        text = text[4:]
    return text.rstrip("\\/") or text


def squeeze(text: str | None, limit: int = 400) -> str:
    if not text:
        return ""
    return re.sub(r"\s+", " ", str(text)).strip()[:limit]


def make_record(cli: str, sid: str, title: str, cwd: str, start, last,
                msgs: int = 0, tools: int = 0, tokens: int = 0,
                archived: bool = False, pinned: bool = False,
                via_hrack: bool = False, resumable: bool = True,
                excerpt: str = "", note: str = "") -> dict:
    meta = CLI_META.get(cli, {})
    cmd = ""
    if resumable and sid and cwd:
        cmd = meta.get("resume", "").format(cwd=cwd, id=sid)
    elif resumable and sid:
        cmd = meta.get("resume", "").format(cwd=".", id=sid)
    sort_key = (start or datetime(1970, 1, 1, tzinfo=timezone.utc)).timestamp()
    return {
        "cli": cli,
        "cliLabel": meta.get("label", cli),
        "hue": meta.get("hue", "#666"),
        "id": sid,
        "title": squeeze(title, 300) or "(未命名)",
        "cwd": clean_win_path(cwd),
        "start": fmt_local(start),
        "last": fmt_local(last),
        "msgs": int(msgs or 0),
        "tools": int(tools or 0),
        "tokens": int(tokens or 0),
        "archived": bool(archived),
        "pinned": bool(pinned),
        "viaHrack": bool(via_hrack),
        "resumable": bool(resumable and sid),
        "cmd": cmd,
        "excerpt": squeeze(excerpt, EXCERPT_LIMIT),
        "note": note,
        "sortKey": sort_key,
    }


# --------------------------------------------------------------------------
# 数据源 0：HRack 事件流水（仅用于标记「哪场是 HRack 启动的」）
# --------------------------------------------------------------------------

# HRack 的 adapterId → 本项目内部的 cli 名。两边叫法不一样，
# 不映射的话 HRack 拉起的 kimi / codex 会话会被统统记成 grok。
HRACK_ADAPTER_TO_CLI = {
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


def hrack_cli(adapter_id: str) -> str:
    return HRACK_ADAPTER_TO_CLI.get(str(adapter_id or "").lower(),
                                    str(adapter_id or "").lower())


def read_hrack_events() -> tuple[list[dict], dict]:
    """把 events.jsonl 还原成一场场会话（按 session_start / session_exit 切分）。

    HRack 记的 kind 有六种，这里全都要认：

        session_start / tool_call / **blocked** / **approved** / completed / session_exit

    `blocked` 是「卡在等你确认」，`approved` 是「放行了」—— 这两个原来被漏掉，
    等于把 HRack 唯一比进程表多知道的那点信息直接扔了。

    坑：文件里**没有 sessionId**（每次事件的 `id` 是 UUID），所以一场会话只能
    靠「session_start 之后、session_exit 之前」这段区间来界定。也因此
    **新的一场开始时必须把上一场收掉** —— 否则 HRack 连续开三场，
    后面两场的所有事件都会算到第一场头上。
    """
    base = user_data_dir()
    log_path = os.path.join(base, "events", "events.jsonl")
    stats_path = os.path.join(base, "events", "stats.json")

    stats = {"sessions": 0, "toolCalls": 0, "blocked": 0, "approvals": 0}
    if os.path.exists(stats_path):
        try:
            with open(stats_path, encoding="utf-8") as fh:
                stats.update(json.load(fh))
        except (OSError, ValueError):
            pass

    runs: list[dict] = []
    current: dict | None = None

    if not os.path.exists(log_path):
        return runs, stats

    with open(log_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            kind = event.get("kind")
            ts = event.get("occurredAt")
            when = from_epoch_ms(ts) if isinstance(ts, (int, float)) else None

            if kind == "session_start":
                # 上一场没退就又开一场（HRack 崩过 / 直接被杀），先按没退处理收掉
                current = {
                    "adapterId": hrack_cli(event.get("adapterId")),
                    "adapterTitle": event.get("title") or "",
                    "workspace": event.get("detail") or "",
                    "startedAt": when,
                    "endedAt": None,
                    "toolCalls": 0,
                    "blocked": False,
                    "approved": 0,
                }
                runs.append(current)
            elif current is None:
                continue
            elif kind == "tool_call":
                current["toolCalls"] += 1
            elif kind == "blocked":
                current["blocked"] = True
                current["endedAt"] = current["endedAt"] or when
            elif kind == "approved":
                current["approved"] += 1
                current["blocked"] = False
            elif kind == "completed":
                current["endedAt"] = when
            elif kind == "session_exit":
                current["endedAt"] = when
                current = None        # 收掉，后面的事件才算到下一场头上

    return runs, stats


# --------------------------------------------------------------------------
# 适配器 1：Grok Build
# --------------------------------------------------------------------------

def read_grok_sessions() -> list[dict]:
    root = os.path.join(grok_home(), "sessions")
    found: list[dict] = []
    if not os.path.isdir(root):
        return found

    for encoded_ws in sorted(os.listdir(root)):
        ws_dir = os.path.join(root, encoded_ws)
        if not os.path.isdir(ws_dir):
            continue
        for sid in sorted(os.listdir(ws_dir)):
            session_dir = os.path.join(ws_dir, sid)
            if not os.path.isdir(session_dir):
                continue

            summary_path = os.path.join(session_dir, "summary.json")
            summary: dict = {}
            if os.path.exists(summary_path):
                try:
                    with open(summary_path, encoding="utf-8") as fh:
                        summary = json.load(fh)
                except (OSError, ValueError):
                    summary = {}

            info = summary.get("info") or {}
            created = parse_iso_utc(summary.get("created_at"))
            updated = parse_iso_utc(summary.get("updated_at") or summary.get("last_active_at"))
            if created is None or updated is None:
                mtime = from_epoch_ms(os.path.getmtime(session_dir) * 1000)
                created = created or mtime
                updated = updated or mtime

            title = (
                summary.get("manual_title")
                or summary.get("pinned_title")
                or summary.get("generated_title")
                or summary.get("session_summary")
                or ""
            ).strip()

            found.append({
                "sessionId": sid,
                "cwd": info.get("cwd") or urllib.parse.unquote(encoded_ws),
                "createdAt": created,
                "updatedAt": updated,
                "title": title,
                "numMessages": summary.get("num_messages") or 0,
                "numChatMessages": summary.get("num_chat_messages") or 0,
                "headless": summary.get("session_kind") == "headless",
                "lastTurn": squeeze(summary.get("last_turn_summary"), 300),
            })

    found.sort(key=lambda item: item["createdAt"] or datetime(1970, 1, 1, tzinfo=timezone.utc),
               reverse=True)
    return found


def read_grok_index() -> dict[str, str]:
    """{session_id: 正文}，来自 grok 自带 FTS 索引。"""
    db = os.path.join(grok_home(), "sessions", "session_search.sqlite")
    result: dict[str, str] = {}
    if not os.path.exists(db):
        return result
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            for sid, content in conn.execute("select session_id, content from session_docs"):
                if sid:
                    result[sid] = content or ""
        finally:
            conn.close()
    except sqlite3.Error as exc:
        print(f"[warn] grok 全文索引读取失败：{exc}", file=sys.stderr)
    return result


def fts_search(term: str, limit: int = 30) -> list[tuple[str, str, str]]:
    """用 grok 自带 FTS 搜会话内容，返回 [(session_id, cwd, title)]。"""
    db = os.path.join(grok_home(), "sessions", "session_search.sqlite")
    if not os.path.exists(db):
        return []
    # FTS5 语法：含 - : * 等字符的查询词要整体加引号
    query = term if re.fullmatch(r"[A-Za-z0-9_]+", term) else f'"{term}"'
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            rows = conn.execute(
                """
                select d.session_id, d.cwd, d.title
                from session_docs_fts f join session_docs d on d.rowid = f.rowid
                where session_docs_fts match ? limit ?
                """,
                (query, limit),
            ).fetchall()
        finally:
            conn.close()
        return [(r[0], r[1] or "", r[2] or "") for r in rows]
    except sqlite3.Error as exc:
        print(f"[warn] grok FTS 查询失败：{exc}", file=sys.stderr)
        return []


# --------------------------------------------------------------------------
# 适配器 2：Codex
# --------------------------------------------------------------------------

CODEX_BODY_ITEM_TYPES = ("userMessage", "agentMessage")


def _codex_item_text(raw: str) -> str:
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return ""
    content = obj.get("content")
    parts: list[str] = []
    if isinstance(content, list):
        for seg in content:
            if isinstance(seg, dict):
                txt = seg.get("text")
                if isinstance(txt, str) and txt.strip():
                    parts.append(txt.strip())
    elif isinstance(content, str) and content.strip():
        parts.append(content.strip())
    return " ".join(parts)


def read_codex_sessions() -> list[dict]:
    """主索引取 state_5.sqlite 的 threads 表（比解析 jsonl 快且带标题）。"""
    db = os.path.join(codex_home(), "state_5.sqlite")
    found: list[dict] = []
    if not os.path.exists(db):
        return found

    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute("""
                select id, title, name, cwd, archived, is_pinned, tokens_used,
                       created_at_ms, updated_at_ms, first_user_message,
                       source, model, git_branch, cli_version, project_id
                from threads
            """).fetchall()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        print(f"[warn] Codex state_5.sqlite 读取失败：{exc}", file=sys.stderr)
        return found

    for row in rows:
        sid = row["id"]
        if not sid:
            continue
        title = (row["title"] or "").strip() or (row["name"] or "").strip()
        fum = (row["first_user_message"] or "").strip()
        if not title:
            title = fum
        start = from_epoch_ms(row["created_at_ms"])
        last = from_epoch_ms(row["updated_at_ms"])
        if start is None and last is None:
            last = start = None
        found.append({
            "sessionId": sid,
            "title": title,
            "firstUserMessage": fum,
            "cwd": clean_win_path(row["cwd"]),
            "createdAt": start,
            "updatedAt": last or start,
            "archived": bool(row["archived"]),
            "pinned": bool(row["is_pinned"]),
            "tokens": row["tokens_used"] or 0,
            "source": row["source"] or "",
            "model": row["model"] or "",
            "branch": row["git_branch"] or "",
            "cliVersion": row["cli_version"] or "",
        })
    return found


def read_codex_counts() -> dict[str, dict]:
    """从 thread_history_1.sqlite 聚合每个线程的消息数 / 工具调用数。"""
    db = os.path.join(codex_home(), "thread_history_1.sqlite")
    out: dict[str, dict] = {}
    if not os.path.exists(db):
        return out

    tool_types = {"commandExecution", "fileChange", "mcpToolCall", "webSearch",
                  "dynamicToolCall", "imageGeneration"}
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            for tid, itype, n in conn.execute(
                "select thread_id, item_type, count(*) from thread_items group by thread_id, item_type"
            ):
                entry = out.setdefault(tid, {"msgs": 0, "tools": 0})
                if itype in CODEX_BODY_ITEM_TYPES:
                    entry["msgs"] += n
                elif itype in tool_types:
                    entry["tools"] += n
        finally:
            conn.close()
    except sqlite3.Error as exc:
        print(f"[warn] Codex 计数读取失败：{exc}", file=sys.stderr)
    return out


def read_codex_bodies() -> dict[str, str]:
    """从 thread_history_1.sqlite 抽每个线程的对话正文（用于全文搜索）。"""
    db = os.path.join(codex_home(), "thread_history_1.sqlite")
    out: dict[str, str] = {}
    if not os.path.exists(db):
        return out

    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            cur = conn.execute(
                """
                select thread_id, item_type, item_json
                from thread_items
                where item_type in ('userMessage','agentMessage')
                order by thread_id, created_at_ms
                """
            )
            cur_thread: str | None = None
            buf: list[str] = []
            size = 0
            for tid, _itype, raw in cur:
                if tid != cur_thread:
                    if cur_thread is not None:
                        out[cur_thread] = " ".join(buf)[:EXCERPT_LIMIT]
                    cur_thread, buf, size = tid, [], 0
                if size >= EXCERPT_LIMIT or not raw or len(raw) > 400_000:
                    continue
                text = _codex_item_text(raw)
                if text:
                    buf.append(text)
                    size += len(text)
            if cur_thread is not None:
                out[cur_thread] = " ".join(buf)[:EXCERPT_LIMIT]
        finally:
            conn.close()
    except sqlite3.Error as exc:
        print(f"[warn] Codex 对话正文读取失败：{exc}", file=sys.stderr)
    return out


def read_codex_prompt_history() -> dict[str, list[str]]:
    """~/.codex/history.jsonl：{session_id: [prompt, ...]}。"""
    path = os.path.join(codex_home(), "history.jsonl")
    out: dict[str, list[str]] = {}
    if not os.path.exists(path):
        return out
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
                sid = obj.get("session_id")
                text = (obj.get("text") or "").strip()
                if sid and text:
                    out.setdefault(sid, []).append(text)
    except OSError:
        pass
    return out


# --------------------------------------------------------------------------
# 适配器 3：Claude Code
# --------------------------------------------------------------------------

def read_claude_sessions() -> list[dict]:
    """主索引取 history.jsonl，按 sessionId 聚合；project 就是工作目录。"""
    path = os.path.join(claude_home(), "history.jsonl")
    agg: dict[str, dict] = {}
    if os.path.exists(path):
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
                    sid = obj.get("sessionId")
                    if not sid:
                        continue
                    entry = agg.setdefault(sid, {
                        "sessionId": sid, "count": 0, "first": None, "last": None,
                        "project": obj.get("project") or "", "firstDisplay": "",
                        "prompts": [],
                    })
                    entry["count"] += 1
                    ts = obj.get("timestamp")
                    when = from_epoch_ms(ts) if ts else None
                    if when:
                        if entry["first"] is None or when < entry["first"]:
                            entry["first"] = when
                        if entry["last"] is None or when > entry["last"]:
                            entry["last"] = when
                    display = (obj.get("display") or "").strip()
                    if display:
                        if not entry["firstDisplay"]:
                            entry["firstDisplay"] = display
                        if len(entry["prompts"]) < 40:
                            entry["prompts"].append(display)
        except OSError:
            pass

    # 项目目录下的会话 jsonl（有则作为补充，取 cwd / 消息数）
    detail: dict[str, dict] = {}
    proj_root = os.path.join(claude_home(), "projects")
    if os.path.isdir(proj_root):
        for root, _dirs, files in os.walk(proj_root):
            for name in files:
                if not name.endswith(".jsonl"):
                    continue
                sid = name[:-6]
                fpath = os.path.join(root, name)
                cwd = ""
                msgs = 0
                tools = 0
                first_user = ""
                try:
                    with open(fpath, encoding="utf-8", errors="replace") as fh:
                        for line in fh:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                obj = json.loads(line)
                            except ValueError:
                                continue
                            if obj.get("cwd") and not cwd:
                                cwd = obj["cwd"]
                            typ = obj.get("type")
                            if typ == "user":
                                msgs += 1
                                if not first_user:
                                    msg = obj.get("message") or {}
                                    c = msg.get("content")
                                    if isinstance(c, str):
                                        first_user = c.strip()
                                    elif isinstance(c, list):
                                        for seg in c:
                                            if isinstance(seg, dict) and seg.get("type") == "text":
                                                first_user = (seg.get("text") or "").strip()
                                                break
                            elif typ == "assistant":
                                msgs += 1
                                msg = obj.get("message") or {}
                                for seg in (msg.get("content") or []):
                                    if isinstance(seg, dict) and seg.get("type") == "tool_use":
                                        tools += 1
                except OSError:
                    continue
                detail[sid] = {"cwd": cwd, "msgs": msgs, "tools": tools,
                               "firstUser": first_user, "path": fpath}

    found: list[dict] = []
    for sid, entry in agg.items():
        extra = detail.get(sid, {})
        found.append({
            "sessionId": sid,
            "title": extra.get("firstUser") or entry["firstDisplay"],
            "cwd": clean_win_path(extra.get("cwd") or entry["project"]),
            "createdAt": entry["first"],
            "updatedAt": entry["last"] or entry["first"],
            "msgs": extra.get("msgs") or entry["count"],
            "tools": extra.get("tools") or 0,
            "prompts": entry["prompts"],
        })

    # 只有 jsonl、不在 history 里的会话也补上
    for sid, extra in detail.items():
        if sid in agg:
            continue
        mtime = from_epoch_ms(os.path.getmtime(extra["path"]) * 1000)
        found.append({
            "sessionId": sid,
            "title": extra.get("firstUser") or "",
            "cwd": clean_win_path(extra.get("cwd")),
            "createdAt": mtime,
            "updatedAt": mtime,
            "msgs": extra.get("msgs") or 0,
            "tools": extra.get("tools") or 0,
            "prompts": [],
        })

    return found


# --------------------------------------------------------------------------
# 适配器 4：opencode
# --------------------------------------------------------------------------

def read_opencode_sessions() -> list[dict]:
    base = os.path.join(opencode_home(), "storage")
    sess_dir = os.path.join(base, "session", "global")
    msg_root = os.path.join(base, "message")
    part_root = os.path.join(base, "part")

    found: list[dict] = []
    if not os.path.isdir(sess_dir):
        return found

    for name in sorted(os.listdir(sess_dir)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(sess_dir, name)
        try:
            with open(path, encoding="utf-8") as fh:
                obj = json.load(fh)
        except (OSError, ValueError):
            continue

        sid = obj.get("id") or name[:-5]
        times = obj.get("time") or {}
        start = from_epoch_ms(times.get("created"))
        last = from_epoch_ms(times.get("updated")) or start

        # 消息正文：storage/message/<sid>/*.json 的 summary.title + part 文本
        msgs = 0
        tools = 0
        prompts: list[str] = []
        body: list[str] = []
        msg_dir = os.path.join(msg_root, sid)
        if os.path.isdir(msg_dir):
            for mname in sorted(os.listdir(msg_dir)):
                if not mname.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(msg_dir, mname), encoding="utf-8") as fh:
                        msg = json.load(fh)
                except (OSError, ValueError):
                    continue
                msgs += 1
                role = msg.get("role") or ""
                msum = msg.get("summary")
                msum = msum if isinstance(msum, dict) else {}
                summary = msum.get("title") or ""
                if role == "user" and summary:
                    prompts.append(summary)
                    body.append(summary)
                if role == "assistant":
                    for part in _opencode_parts(part_root, msg.get("id") or ""):
                        if part:
                            body.append(part)
                tools += len(msum.get("diffs") or [])

        found.append({
            "sessionId": sid,
            "title": obj.get("title") or (prompts[0] if prompts else ""),
            "cwd": clean_win_path(obj.get("directory")),
            "createdAt": start,
            "updatedAt": last,
            "msgs": msgs,
            "tools": tools,
            "prompts": prompts,
            "excerpt": " ".join(body),
            "slug": obj.get("slug") or "",
            "version": obj.get("version") or "",
        })

    return found


def _opencode_parts(part_root: str, msg_id: str) -> list[str]:
    if not msg_id:
        return []
    d = os.path.join(part_root, msg_id)
    if not os.path.isdir(d):
        return []
    out: list[str] = []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return []
    for name in names[:60]:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, name), encoding="utf-8") as fh:
                obj = json.load(fh)
        except (OSError, ValueError):
            continue
        if obj.get("type") == "text" and isinstance(obj.get("text"), str):
            out.append(obj["text"].strip())
    return out


# --------------------------------------------------------------------------
# 汇总
# --------------------------------------------------------------------------

def build_records(cli_filter: set[str] | None = None) -> tuple[list[dict], dict]:
    want = (lambda c: cli_filter is None or c in cli_filter)
    records: list[dict] = []
    counts: dict[str, int] = {}

    runs, stats = read_hrack_events()
    run_tool_calls: dict[str, int] = {}   # sessionId -> HRack 统计的工具调用数
    run_by_session: dict[str, dict] = {}
    matched_run_indexes: set[int] = set()

    # 先把各家的会话收齐，再统一把 HRack 启动记录挂上去。
    # 顺序不能反：原来只拿 grok 会话去匹配，HRack 拉起的 codex / claude / kimi
    # 场次一律匹配不上，最后被当成 grok 合成一条噪音行 —— 标签是错的，
    # 而且跟真实会话重了一份。
    collected: dict[str, list[dict]] = {}
    if want("grok"):
        collected["grok"] = read_grok_sessions()
    if want("codex"):
        collected["codex"] = read_codex_sessions()
    if want("claude"):
        collected["claude"] = read_claude_sessions()
    if want("opencode"):
        collected["opencode"] = read_opencode_sessions()
    for cli, items in collected.items():
        counts[cli] = len(items)

    grok_index = read_grok_index() if want("grok") else {}
    codex_bodies = read_codex_bodies() if want("codex") else {}
    codex_counts = read_codex_counts() if want("codex") else {}
    prompt_hist = read_codex_prompt_history() if want("codex") else {}

    # 用「同 CLI + 同工作空间 + 开始时间邻近」把 HRack 启动记录挂到会话上。
    # HRack 不写 sessionId，这是唯一能做的关联 —— 好在 HRack 一次只在一个
    # 工作空间里跑同一个 adapter，容差 180 秒足够区分先后两场。
    for idx, run in enumerate(runs):
        rcli = run["adapterId"] or "grok"
        if rcli not in collected or run["startedAt"] is None:
            continue
        ws = norm_ws(run["workspace"])
        best, best_delta = None, None
        for session in collected[rcli]:
            if session["sessionId"] in run_by_session:
                continue
            if norm_ws(session["cwd"]) != ws or session["createdAt"] is None:
                continue
            delta = abs((session["createdAt"] - run["startedAt"]).total_seconds())
            if delta <= GROK_SESSION_GRACE_SECONDS and (best_delta is None or delta < best_delta):
                best, best_delta = session, delta
        if best is not None:
            run_by_session[best["sessionId"]] = run
            run_tool_calls[best["sessionId"]] = run["toolCalls"]
            matched_run_indexes.add(idx)

    # ---- grok ----
    for session in collected.get("grok", []):
        sid = session["sessionId"]
        run = run_by_session.get(sid)
        headless = session["headless"]
        records.append(make_record(
            "grok", sid, session["title"], session["cwd"],
            session["createdAt"], session["updatedAt"],
            msgs=session["numChatMessages"] or session["numMessages"],
            tools=run_tool_calls.get(sid, 0),
            via_hrack=run is not None,
            resumable=not headless,
            excerpt=grok_index.get(sid, ""),
            note="headless" if headless else "",
        ))

    # ---- codex ----
    for session in collected.get("codex", []):
        sid = session["sessionId"]
        excerpt = codex_bodies.get(sid, "") or " ".join(prompt_hist.get(sid, []))
        counter = codex_counts.get(sid, {})
        records.append(make_record(
            "codex", sid, session["title"], session["cwd"],
            session["createdAt"], session["updatedAt"],
            msgs=counter.get("msgs", 0), tools=counter.get("tools", 0),
            tokens=session["tokens"],
            archived=session["archived"], pinned=session["pinned"],
            via_hrack=sid in run_by_session,
            excerpt=excerpt,
            note=(" · ".join(x for x in (
                session["source"],
                session["model"],
                session["branch"],
            ) if x)),
        ))

    # ---- claude ----
    for session in collected.get("claude", []):
        sid = session["sessionId"]
        records.append(make_record(
            "claude", sid, session["title"], session["cwd"],
            session["createdAt"], session["updatedAt"],
            msgs=session["msgs"],
            tools=session["tools"] or run_tool_calls.get(sid, 0),
            via_hrack=sid in run_by_session,
            excerpt=" ".join(session.get("prompts") or []),
        ))

    # ---- opencode ----
    for session in collected.get("opencode", []):
        sid = session["sessionId"]
        records.append(make_record(
            "opencode", sid, session["title"], session["cwd"],
            session["createdAt"], session["updatedAt"],
            msgs=session["msgs"],
            tools=session["tools"] or run_tool_calls.get(sid, 0),
            via_hrack=sid in run_by_session,
            excerpt=session.get("excerpt", ""),
            note=session.get("slug") or "",
        ))

    # 没能挂到任何会话上的 HRack 启动记录，单独列一行（会话文件已不在磁盘）。
    # 用 run 自己的 adapterId 当 cli —— 原来这里写死 "grok"，kimi/codex 的
    # 场次都被贴成了 Grok。
    for idx, run in enumerate(runs):
        if idx in matched_run_indexes:
            continue
        rcli = run["adapterId"] or "grok"
        if cli_filter is not None and rcli not in cli_filter:
            continue
        records.append(make_record(
            rcli, "", run["adapterTitle"] or "(未命名会话)",
            run["workspace"], run["startedAt"], run["endedAt"],
            tools=run["toolCalls"], via_hrack=True, resumable=False,
            note="会话文件已不在磁盘",
        ))
    counts["hrack-unmatched"] = len(runs) - len(matched_run_indexes)

    records.sort(key=lambda r: r["sortKey"], reverse=True)
    stats["hrackRuns"] = len(runs)
    stats["hrackMatched"] = len(matched_run_indexes)
    return records, stats


# --------------------------------------------------------------------------
# 渲染
# --------------------------------------------------------------------------

def esc(text) -> str:
    return html.escape(str(text), quote=True)


TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>全 CLI 会话历史</title>
<style>
  :root {
    --bg:#f7f7f6; --card:#fff; --line:rgba(0,0,0,.08); --line-soft:rgba(0,0,0,.05);
    --ink:#171717; --ink2:#525252; --ink3:#8a8a8a;
    --accent:#185fa5; --accent-soft:#e6f1fb; --warn:#854f0b; --warn-soft:#faeeda;
    --mark:#faeeda;
    --mono:"Maple Mono",Consolas,"Cascadia Mono",monospace;
    --sans:"PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:13px;line-height:1.6}
  .wrap{max-width:1560px;margin:0 auto;padding:36px 26px 72px}
  h1{font-size:20px;font-weight:500;margin:0 0 6px}
  .sub{color:var(--ink3);font-size:12px;margin-bottom:24px}
  .sub code{font-family:var(--mono);font-size:11px;color:var(--ink2)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 15px;cursor:pointer;
        transition:border-color .15s,box-shadow .15s}
  .card:hover{border-color:rgba(24,95,165,.35)}
  .card.on{border-color:rgba(24,95,165,.55);box-shadow:0 0 0 3px var(--accent-soft)}
  .card .k{font-size:11px;color:var(--ink3);letter-spacing:.06em}
  .card .v{font-family:var(--mono);font-size:21px;margin-top:2px}
  .card .n{font-size:11px;color:var(--ink3)}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px}
  .note{background:var(--warn-soft);border:1px solid rgba(133,79,11,.22);color:var(--warn);
         border-radius:12px;padding:12px 16px;margin-bottom:18px;font-size:12px}
  .searchbar{position:sticky;top:0;z-index:6;background:var(--bg);padding:10px 0 10px;margin-bottom:2px}
  .searchbar input{width:100%;font-family:var(--sans);font-size:14px;padding:11px 14px;border-radius:10px;
      border:1px solid var(--line);background:var(--card);color:var(--ink);outline:none}
  .searchbar input:focus{border-color:rgba(24,95,165,.45)}
  .searchmeta{font-size:11.5px;color:var(--ink3);margin-top:7px;min-height:18px;display:flex;
      align-items:center;gap:12px;flex-wrap:wrap}
  .toggles{display:flex;gap:14px;flex-wrap:wrap}
  .toggles label{font-size:11.5px;color:var(--ink2);cursor:pointer;user-select:none;display:flex;
      align-items:center;gap:5px}
  .toggles input{accent-color:var(--accent)}
  h2{font-size:14px;font-weight:500;margin:26px 0 10px;color:var(--ink2)}
  h2 span{color:var(--ink3);font-weight:400;font-size:12px}
  .tablewrap{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:11px;font-weight:500;color:var(--ink3);letter-spacing:.04em;
      padding:11px 12px;border-bottom:1px solid var(--line);white-space:nowrap;background:#fcfcfc;
      position:sticky;top:0}
  td{padding:11px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top}
  tr:last-child td{border-bottom:0}
  tr:hover td{background:#fbfbfa}
  .mono{font-family:var(--mono);font-size:11.5px}
  .nowrap{white-space:nowrap}
  .num{text-align:right}
  .dim{color:var(--ink3)}
  .dim2{color:var(--ink3);font-size:10.5px}
  .ws{color:var(--accent);word-break:break-all;max-width:250px}
  .title{min-width:230px;word-break:break-word}
  .badge{display:inline-block;font-family:var(--mono);font-size:10px;padding:1px 6px;border-radius:999px;
          background:#f1efe8;color:#5f5e5a;margin-left:6px;white-space:nowrap}
  .clitag{display:inline-block;font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:6px;
          color:#fff;white-space:nowrap;font-weight:500}
  mark{background:var(--mark);color:inherit;padding:0 1px;border-radius:2px}
  code.cmd{display:inline-block;font-family:var(--mono);font-size:11px;color:var(--ink2);
      background:#f5f5f4;border:1px solid var(--line);border-radius:6px;padding:3px 7px;cursor:pointer;
      word-break:break-all;max-width:400px}
  code.cmd:hover{background:var(--accent-soft);border-color:rgba(24,95,165,.3);color:var(--accent)}
  .snip{margin-top:7px;font-size:11.5px;color:var(--ink2);background:#fafaf9;border-left:2px solid var(--line);
         padding:6px 9px;border-radius:0 6px 6px 0;word-break:break-word;max-height:92px;overflow:hidden}
  .empty{padding:26px;text-align:center;color:var(--ink3);font-size:12px}
  .foot{margin-top:26px;color:var(--ink3);font-size:11.5px;line-height:1.9}
  .foot code{font-family:var(--mono);font-size:11px;background:#f5f5f4;padding:1px 5px;border-radius:4px}
  .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(8px);background:#171717;
      color:#fff;font-size:12px;padding:7px 14px;border-radius:8px;opacity:0;transition:opacity .18s,transform .18s;
      pointer-events:none}
  .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
</style>
</head>
<body>
<div class="wrap">
  <h1>全 CLI 会话历史</h1>
  <div class="sub">
    生成于 __GENERATED__ ·
    扫描 <code>~/.grok</code> · <code>~/.codex</code> · <code>~/.claude</code> · <code>~/.local/share/opencode</code>
  </div>

  <div class="cards" id="cards">__CARDS__</div>

  <div class="note">
    <b>为什么原来的工具看不到这些？</b>
    HRack 的会话列表只存在于主进程内存（PTY 进程），退出即清空，且只把 <code>terminalId</code> 写进
    Local Storage，<b>你起的名字从未落盘</b>。本页直接从各家 CLI 自己的会话库里重建——
    包含 <b>grok / Codex / Claude Code / opencode</b>，并且<b>能搜对话正文</b>。
  </div>

  <div class="searchbar">
    <input id="q" type="search" placeholder="搜标题、工作空间、会话 ID，或对话正文里的关键词（例如 FetchV / 畸变 / uselookbook）" autocomplete="off">
    <div class="searchmeta">
      <span id="meta"></span>
      <span class="toggles">
        <label><input type="checkbox" id="hideArchived"> 隐藏已归档</label>
        <label><input type="checkbox" id="onlyHrack"> 只看 HRack 启动</label>
        <label><input type="checkbox" id="groupWs"> 按工作空间分组</label>
      </span>
    </div>
  </div>

  <h2 id="h-main">会话列表 <span id="c-main"></span></h2>
  <div class="tablewrap" id="tablewrap">
    <table>
      <thead><tr>
        <th>CLI</th><th>开始</th><th>工作空间</th><th>标题 / 匹配片段</th><th>会话 ID</th>
        <th>消息</th><th>工具</th><th>Tokens</th><th>最后活动</th><th>续聊命令（点击复制）</th>
      </tr></thead>
      <tbody id="tb"></tbody>
    </table>
  </div>
  <div class="empty" id="empty" style="display:none">没有匹配的会话。</div>

  <div class="foot">
    <b>怎么让会话名不丢</b>：<br>
    · <b>grok</b>：会话内执行 <code>/rename 标题</code>（别名 <code>/title</code>），标题写进 <code>summary.json</code> 永久保留，之后 <code>grok -r "标题"</code> 可恢复。<br>
    · <b>Codex</b>：桌面端线程标题存在 <code>~/.codex/state_5.sqlite</code> 的 <code>threads</code> 表，<code>codex resume &lt;ID&gt;</code> 直接续聊。<br>
    · <b>Claude Code</b>：<code>claude -r &lt;ID&gt;</code> 或 <code>claude -c</code> 续聊上一场。<br>
    · <b>opencode</b>：<code>opencode --session &lt;ID&gt;</code> 或 <code>opencode -c</code>。<br>
    在 HRack 界面里改的名字<b>不会持久化</b>——这是 HRack 的缺陷，不是你的操作问题。
  </div>
</div>
<div class="toast" id="toast">已复制</div>
<script>
const DATA = __PAYLOAD__;
const CLI_LABELS = __CLI_LABELS__;

let activeClis = new Set(Object.keys(CLI_LABELS));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function mark(text, term) {
  const safe = esc(text);
  if (!term) return safe;
  const re = new RegExp('(' + term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

function snippet(excerpt, term) {
  if (!term || !excerpt) return '';
  const i = excerpt.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return '';
  const from = Math.max(0, i - 90);
  const text = (from > 0 ? '…' : '') + excerpt.slice(from, i + 220) + '…';
  return '<div class="snip">' + mark(text, term) + '</div>';
}

function row(rec, term) {
  const cmdCell = rec.cmd
    ? '<code class="cmd" data-cmd="' + esc(rec.cmd) + '">' + esc(rec.cmd) + '</code>'
    : '<span class="dim">-</span>';
  const badges = [];
  if (rec.viaHrack) badges.push('<span class="badge">HRack 启动</span>');
  if (rec.archived) badges.push('<span class="badge">已归档</span>');
  if (rec.note) badges.push('<span class="badge">' + esc(rec.note) + '</span>');
  const idCell = rec.id
    ? '<span class="mono dim2">' + esc(rec.id) + '</span>'
    : '<span class="dim">无会话 ID</span>';
  return '<tr>'
    + '<td class="nowrap"><span class="clitag" style="background:' + rec.hue + '">' + esc(rec.cliLabel) + '</span></td>'
    + '<td class="nowrap mono">' + esc(rec.start) + '</td>'
    + '<td class="ws mono">' + mark(rec.cwd, term) + '</td>'
    + '<td class="title">' + mark(rec.title, term) + badges.join('') + snippet(rec.excerpt, term) + '</td>'
    + '<td class="nowrap">' + idCell + '</td>'
    + '<td class="nowrap mono num">' + (rec.msgs ? rec.msgs.toLocaleString() : '-') + '</td>'
    + '<td class="nowrap mono num">' + (rec.tools ? rec.tools.toLocaleString() : '-') + '</td>'
    + '<td class="nowrap mono num">' + (rec.tokens ? rec.tokens.toLocaleString() : '-') + '</td>'
    + '<td class="nowrap mono dim">' + esc(rec.last || '-') + '</td>'
    + '<td>' + cmdCell + '</td>'
    + '</tr>';
}

function wsKey(rec) {
  const p = (rec.cwd || '(未知)').replace(/[\\\\/]+$/, '');
  const parts = p.split(/[\\\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function render() {
  const t = (document.getElementById('q').value || '').trim();
  const low = t.toLowerCase();
  const hideArchived = document.getElementById('hideArchived').checked;
  const onlyHrack = document.getElementById('onlyHrack').checked;
  const groupWs = document.getElementById('groupWs').checked;

  const matched = DATA.filter(function (r) {
    if (!activeClis.has(r.cli)) return false;
    if (hideArchived && r.archived) return false;
    if (onlyHrack && !r.viaHrack) return false;
    if (!t) return true;
    return (r.title + ' ' + r.cwd + ' ' + r.id + ' ' + r.note + ' ' + r.excerpt)
      .toLowerCase().indexOf(low) >= 0;
  });

  let html = '';
  if (groupWs) {
    const groups = {};
    matched.forEach(function (r) {
      const k = r.cwd || '(未知工作空间)';
      (groups[k] = groups[k] || []).push(r);
    });
    const keys = Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length; });
    keys.forEach(function (k) {
      const list = groups[k];
      const clis = {};
      list.forEach(function (r) { clis[r.cliLabel] = (clis[r.cliLabel] || 0) + 1; });
      const tag = Object.keys(clis).map(function (c) { return c + ' ' + clis[c]; }).join(' · ');
      html += '<tr><td colspan="10" style="background:#fbfbfa;padding:10px 12px;border-bottom:1px solid var(--line)">'
        + '<b class="mono" style="color:var(--accent)">' + mark(k, t) + '</b>'
        + '<span class="dim2" style="margin-left:10px">' + list.length + ' 场 · ' + esc(tag) + '</span></td></tr>';
      html += list.map(function (r) { return row(r, t); }).join('');
    });
  } else {
    html = matched.map(function (r) { return row(r, t); }).join('');
  }

  document.getElementById('tb').innerHTML = html;
  document.getElementById('empty').style.display = matched.length ? 'none' : 'block';
  document.getElementById('c-main').textContent = '· ' + matched.length + ' 场';
  const filtered = t || hideArchived || onlyHrack || activeClis.size < Object.keys(CLI_LABELS).length;
  document.getElementById('meta').textContent = filtered
    ? '匹配 ' + matched.length + ' / ' + DATA.length + ' 场会话'
    : '共 ' + DATA.length + ' 场会话';
  bindCopy();
}

function bindCopy() {
  document.querySelectorAll('code.cmd').forEach(function (node) {
    node.onclick = function () {
      const text = node.getAttribute('data-cmd') || '';
      navigator.clipboard.writeText(text).then(function () {
        const toast = document.getElementById('toast');
        toast.classList.add('on');
        setTimeout(function () { toast.classList.remove('on'); }, 1200);
      });
    };
  });
}

document.querySelectorAll('#cards .card').forEach(function (card) {
  card.onclick = function () {
    const cli = card.getAttribute('data-cli');
    if (!cli) return;
    if (activeClis.size === 1 && activeClis.has(cli)) {
      activeClis = new Set(Object.keys(CLI_LABELS));
    } else {
      activeClis = new Set([cli]);
    }
    document.querySelectorAll('#cards .card').forEach(function (c) {
      const id = c.getAttribute('data-cli');
      c.classList.toggle('on', id && activeClis.size === 1 && activeClis.has(id));
    });
    render();
  };
});

let timer = null;
document.getElementById('q').addEventListener('input', function () {
  clearTimeout(timer);
  timer = setTimeout(render, 120);
});
['hideArchived', 'onlyHrack', 'groupWs'].forEach(function (id) {
  document.getElementById(id).addEventListener('change', render);
});

render();
</script>
</body>
</html>
"""


def render_cards(counts: dict, total: int, searchable: int) -> str:
    cards = [
        ('<div class="card" data-cli=""><div class="k">总会话数</div>'
         f'<div class="v">{total:,}</div><div class="n">跨 {len(CLI_ORDER)} 个 CLI</div></div>')
    ]
    for cli in CLI_ORDER:
        n = counts.get(cli, 0)
        meta = CLI_META[cli]
        cards.append(
            f'<div class="card" data-cli="{esc(cli)}">'
            f'<div class="k"><span class="dot" style="background:{meta["hue"]}"></span>{esc(meta["label"])}</div>'
            f'<div class="v">{n:,}</div><div class="n">场会话</div></div>'
        )
    cards.append(
        f'<div class="card" data-cli=""><div class="k">可搜正文</div>'
        f'<div class="v">{searchable:,}</div><div class="n">含对话内容</div></div>'
    )
    return "\n  ".join(cards)


def render_html(records: list[dict], counts: dict, generated_at: datetime) -> str:
    payload = json.dumps(records, ensure_ascii=False).replace("</", "<\\/")
    labels = json.dumps({c: CLI_META[c]["label"] for c in CLI_ORDER}, ensure_ascii=False)
    searchable = sum(1 for r in records if r["excerpt"])
    return (TEMPLATE
            .replace("__GENERATED__", esc(generated_at.strftime("%Y-%m-%d %H:%M:%S")))
            .replace("__CARDS__", render_cards(counts, len(records), searchable))
            .replace("__CLI_LABELS__", labels)
            .replace("__PAYLOAD__", payload))


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="扫描本机全部 AI CLI 的会话历史")
    parser.add_argument("--out", default=None, help="输出 HTML 路径")
    parser.add_argument("--open", dest="open_after", action="store_true", help="生成后打开浏览器")
    parser.add_argument("--search", default=None, help="在终端全文搜索所有 CLI 会话")
    parser.add_argument("--cli", default=None,
                        help="只扫指定 CLI，逗号分隔（grok,codex,claude,opencode）")
    args = parser.parse_args()

    cli_filter = None
    if args.cli:
        cli_filter = {c.strip().lower() for c in args.cli.split(",") if c.strip()}
        unknown = cli_filter - set(CLI_ORDER)
        if unknown:
            print(f"[error] 未知 CLI：{', '.join(sorted(unknown))}（可选：{', '.join(CLI_ORDER)}）",
                  file=sys.stderr)
            return 2

    here = os.path.dirname(os.path.abspath(__file__))

    if args.search:
        records, _ = build_records(cli_filter)
        term = args.search
        low = term.lower()
        hits = [r for r in records
                if low in (r["title"] + " " + r["cwd"] + " " + r["id"] + " " + r["excerpt"]).lower()]
        if not hits:
            print(f'没有匹配 "{term}" 的会话。')
            return 1
        print(f'匹配 "{term}" 的会话（{len(hits)} 场）：\n')
        for r in hits[:40]:
            print(f"  [{r['cliLabel']}] {r['start']}  {r['cwd']}")
            print(f"      标题：{r['title']}")
            if r["cmd"]:
                print(f"      续聊：{r['cmd']}")
            i = r["excerpt"].lower().find(low)
            if i >= 0:
                seg = r["excerpt"][max(0, i - 60): i + 160].replace("\n", " ")
                print(f"      …{seg}…")
            print()
        return 0

    out_path = args.out or os.path.join(here, "session-history.html")
    records, stats = build_records(cli_filter)
    counts = {c: sum(1 for r in records if r["cli"] == c) for c in CLI_ORDER}

    document = render_html(records, counts, datetime.now())
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(document)

    print("扫描结果")
    print("-" * 46)
    for cli in CLI_ORDER:
        print(f"  {CLI_META[cli]['label']:<13}: {counts.get(cli, 0):>5} 场")
    print(f"  {'HRack 启动记录':<11}: {stats.get('hrackRuns', 0):>5} 场"
          f"（匹配到 grok 会话 {stats.get('hrackMatched', 0)} 场）")
    print(f"  {'可搜正文':<13}: {sum(1 for r in records if r['excerpt']):>5} 场")
    print(f"  {'合计':<13}: {len(records):>5} 场")
    print("-" * 46)
    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"输出：{out_path}  ({size_mb:.1f} MB)")

    if args.open_after:
        webbrowser.open("file:///" + out_path.replace("\\", "/"))

    return 0


if __name__ == "__main__":
    sys.exit(main())
