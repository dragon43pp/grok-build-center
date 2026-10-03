#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Grok 会话深度索引 —— 管理 / 继承 / 恢复。

## 为什么值得单独写一层

grok 自己**什么都有**：`grok sessions list|search|delete`、`--fork-session`、
`--restore-code`、`grok export`、`grok usage`、`grok worktree`、
`~/.grok/sessions/session_search.sqlite`（FTS5 全文索引）。
但实测（本机 2026-09-28）它们有三个致命处：

  1. **慢**。`grok sessions list -n 8` 要 **5.3 秒** —— 它每次都要拉起 leader 进程。
     直接读 `summary.json` 同样一件事 **17 毫秒**，快 310 倍。
  2. **只认当前目录**。`grok sessions list` 只列 `--cwd` 那一场的会话；
     本机 51 场会话散在 24 个工作目录里，用它是「一场也看不见」。
  3. **中文搜不了**。`grok sessions search 小程序` 直接
     `warning: remote session search timed out` → `Total: 0`。

所以这一层的定位是：**把 grok 已经做好但埋在 CLI 里的能力，挖出来、跨项目聚合、
毫秒级呈现**。所有读取都是只读的，不改 grok 任何文件。

## 三个能力

**管理** —— 跨项目会话目录。`summary.json` 里 grok 自己写了标题、recap、
模型、git 远端、`head_commit`、turn 数…… 别人只读了标题和时间，
这里全挖出来，一次扫描（几十毫秒）就能按项目 / 模型 / 日期 / 仓库 / 全文检索。

**继承** —— `grok --fork-session` 是原生的分叉：从任意一场会话岔出去试新方向，
原会话不受污染。另外提供 `handoff_prompt()`：把一场会话的 recap + 上次做到哪 +
仓库状态压成一小段**接续提示词**，喂给一场**全新**会话。
—— 这条路很重要：1.5 MB 的大会话直接 `-r` 续跑要十几分钟（见 remote.py 实测），
但新会话吃一段 recap 是秒开。**大会话的唯一实用恢复路径就是 handoff。**

**恢复** —— 续跑前先算三件事，把「一点就卡十几分钟」变成「点之前就知道」：
  - 体量（chat_history.jsonl 字节数）→ 预估等待时间
  - 代码漂移（`head_commit` vs 仓库当前 HEAD）→ 会话是在哪个提交上做的
  - 仓库是否还在（`git_root_dir` 可能已被删/移）
外加 `--restore-code`：grok 原生支持**连代码快照一起恢复**，不用手动 checkout。
"""

from __future__ import annotations

import ctypes
import glob
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import unquote

# 体量分档。阈值沿用 remote.py 的实测结论：
#   60 KB → 首次续跑 19 秒；1547 KB → 600 秒仍不返回。
# 恢复成本跟历史长度强相关且非线性，所以 400 KB 就要开始打预防针。
LIGHT_BYTES = 400 * 1024
HEAVY_BYTES = 1024 * 1024

SAFE_SID = re.compile(r"^[A-Za-z0-9._\-]{1,128}$")
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                     r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def grok_home() -> str:
    """优先认 `GROK_HOME`（grok 自己认这个变量），否则 `~/.grok`。"""
    env = os.environ.get("GROK_HOME")
    if env and os.path.isdir(env):
        return env
    return os.path.join(os.path.expanduser("~"), ".grok")


def sessions_root() -> str:
    return os.path.join(grok_home(), "sessions")


# ---------------------------------------------------------------- 时间解析

def parse_iso(text: str | None) -> float:
    """grok 的时间戳是 `2026-09-22T13:42:17.343922400Z` —— **九位纳秒**。

    `datetime.fromisoformat` 在 3.11+ 能吃纳秒，但为了不押运行时的版本，
    统一先把小数位截到六位再解析。截掉的是纳秒，对「几小时前/几天前」没有意义。
    """
    if not text:
        return 0.0
    s = str(text).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    m = re.match(r"^(.*\.\d{6})\d*(\+\d{2}:\d{2})?$", s)
    if m:
        s = m.group(1) + (m.group(2) or "")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def rel(ts: float) -> str:
    """人话时间。跟 state._rel 同款，但这里是独立模块，不互相 import。"""
    if not ts:
        return "—"
    delta = max(0.0, datetime.now(timezone.utc).timestamp() - ts)
    if delta < 90:
        return "刚刚"
    if delta < 3600:
        return f"{int(delta // 60)} 分钟前"
    if delta < 86400:
        return f"{int(delta // 3600)} 小时前"
    days = int(delta // 86400)
    if days < 30:
        return f"{days} 天前"
    if days < 365:
        return f"{days // 30} 个月前"
    return f"{days // 365} 年前"


# ---------------------------------------------------------------- 进程存活

def pid_alive(pid: int) -> bool:
    """pid 是否还活着。

    **Windows 上不能图省事用 `os.kill(pid, 0)`** —— 那个在 Windows 上走的是
    `TerminateProcess`，信号 0 是特例但语义仍不干净，而且会被杀软盯上。
    正规做法是 `OpenProcess` + `GetExitCodeProcess == STILL_ACTIVE(259)`。

    注意：`argtypes` 必须逐个声明。x64 下少声明一个参数，多出来的会从寄存器里
    取到垃圾值，轻则判断错、重则进程直接访问违规崩掉（没有 traceback）。
    """
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        try:
            from ctypes import wintypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.OpenProcess.restype = wintypes.HANDLE
            k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            k32.GetExitCodeProcess.restype = wintypes.BOOL
            k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE,
                                               ctypes.POINTER(wintypes.DWORD)]
            k32.CloseHandle.argtypes = [wintypes.HANDLE]
            h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not h:
                return False
            try:
                code = wintypes.DWORD()
                if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
                    return False
                return code.value == STILL_ACTIVE
            finally:
                k32.CloseHandle(h)
        except (OSError, AttributeError):
            return False
    try:
        os.kill(int(pid), 0)
    except OSError:
        return False
    return True


def live_sessions() -> dict[str, int]:
    """`~/.grok/active_sessions.json` → {session_id: pid}，只留真的还活着的。

    这个文件是 grok 自己维护的活会话注册表 —— **别人没读过它**，
    而它是「哪场会话正开着」最权威的来源（比扫进程命令行准得多）。
    grok 被强杀时这里会留残项，所以必须过一遍 pid 存活检查。
    """
    path = os.path.join(grok_home(), "active_sessions.json")
    out: dict[str, int] = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            rows = json.load(fh)
    except (OSError, ValueError):
        return out
    if not isinstance(rows, list):
        return out
    for row in rows:
        if not isinstance(row, dict):
            continue
        sid = str(row.get("session_id") or "")
        pid = int(row.get("pid") or 0)
        if sid and pid_alive(pid):
            out[sid] = pid
    return out


# ---------------------------------------------------------------- git 状态（零 subprocess）

def _read_ref(git_dir: str, ref: str) -> str:
    """从 .git 里直接读出一个 ref 的 commit。不 spawn git —— 单次要 30ms，扫 51 场就是 1.5 秒。"""
    loose = os.path.join(git_dir, *ref.split("/"))
    try:
        with open(loose, encoding="utf-8", errors="replace") as fh:
            sha = fh.read().strip()
        if re.fullmatch(r"[0-9a-fA-F]{40}", sha):
            return sha.lower()
    except OSError:
        pass
    # 打包过的 ref 在 packed-refs 里
    try:
        with open(os.path.join(git_dir, "packed-refs"), encoding="utf-8",
                  errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("^"):
                    continue
                parts = line.split(" ", 1)
                if len(parts) == 2 and parts[1] == ref:
                    return parts[0].lower()
    except OSError:
        pass
    return ""


def _resolve_git_dir(workdir: str) -> str:
    """拿到真正的 git 目录。worktree / submodule 的 `.git` 是**文件**，内容是 `gitdir: <路径>`。"""
    dot = os.path.join(workdir, ".git")
    if os.path.isdir(dot):
        return dot
    if os.path.isfile(dot):
        try:
            with open(dot, encoding="utf-8", errors="replace") as fh:
                text = fh.read().strip()
        except OSError:
            return ""
        if text.lower().startswith("gitdir:"):
            target = text.split(":", 1)[1].strip()
            if not os.path.isabs(target):
                target = os.path.normpath(os.path.join(workdir, target))
            return target if os.path.isdir(target) else ""
    return ""


def read_git_head(workdir: str) -> tuple[str, str]:
    """(commit, branch)。读不到就是 ("", "")。**纯读文件，不 spawn git。**"""
    git_dir = _resolve_git_dir(workdir) if workdir else ""
    if not git_dir:
        return "", ""
    try:
        with open(os.path.join(git_dir, "HEAD"), encoding="utf-8",
                  errors="replace") as fh:
            head = fh.read().strip()
    except OSError:
        return "", ""
    if head.startswith("ref:"):
        ref = head.split(":", 1)[1].strip()
        # refs/heads/main → main
        branch = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
        return _read_ref(git_dir, ref), branch
    if re.fullmatch(r"[0-9a-fA-F]{40}", head):        # detached HEAD
        return head.lower(), ""
    return "", ""


# ---------------------------------------------------------------- 会话模型

@dataclass
class GrokSession:
    sid: str
    cwd: str
    sdir: str

    title: str = ""
    manual_title: str = ""
    auto_title: str = ""
    recap: str = ""
    last_turn: str = ""

    created_ts: float = 0.0
    updated_ts: float = 0.0
    active_ts: float = 0.0

    num_messages: int = 0
    num_chat_messages: int = 0
    model: str = ""
    agent: str = ""
    sandbox: str = ""

    git_root: str = ""
    git_remotes: list[str] = field(default_factory=list)
    head_commit: str = ""
    head_branch: str = ""

    live_pid: int = 0
    body_bytes: int = 0
    unreadable: bool = False

    # ---- 派生属性

    @property
    def key(self) -> str:
        return self.sid

    @property
    def project(self) -> str:
        cwd = (self.cwd or "").rstrip("\\/")
        return os.path.basename(cwd) or cwd or "(未知目录)"

    @property
    def live(self) -> bool:
        return self.live_pid > 0

    @property
    def sid8(self) -> str:
        return self.sid[:8]

    @property
    def weight(self) -> str:
        """light / heavy / huge —— 决定续跑前要不要警告。"""
        if self.body_bytes >= HEAVY_BYTES:
            return "huge"
        if self.body_bytes >= LIGHT_BYTES:
            return "heavy"
        return "light"

    @property
    def size_label(self) -> str:
        n = self.body_bytes
        if n >= 1048576:
            return f"{n / 1048576:.1f} MB"
        if n >= 1024:
            return f"{n / 1024:.0f} KB"
        return f"{n} B"

    @property
    def active_str(self) -> str:
        return rel(self.active_ts or self.updated_ts)

    @property
    def resume_cost(self) -> str:
        """点「继续」之前，把代价说清楚。"""
        if self.weight == "huge":
            return f"历史很大（{self.size_label}），续跑可能要十几分钟"
        if self.weight == "heavy":
            return f"历史偏大（{self.size_label}），续跑可能要几分钟"
        return ""

    def shortcut(self, limit: int = 60) -> str:
        """给列表用的一行摘要：优先 recap，其次上次做到哪。"""
        text = (self.recap or self.last_turn or "").strip().replace("\n", " ")
        if not text:
            return ""
        return text if len(text) <= limit else text[:limit] + "…"


def _load_summary(path: str) -> tuple[dict, bool]:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return json.load(fh), True
    except (OSError, ValueError):
        return {}, False


def load_one(sdir: str, live: dict[str, int] | None = None) -> GrokSession | None:
    """从一个会话目录建出 GrokSession。读不出 summary.json 也返回对象（标记 unreadable）。"""
    sid = os.path.basename(sdir.rstrip("\\/"))
    if not SAFE_SID.match(sid):
        return None
    summary, ok = _load_summary(os.path.join(sdir, "summary.json"))
    info = summary.get("info") if isinstance(summary.get("info"), dict) else {}
    cwd = str(info.get("cwd") or "")

    manual = str(summary.get("manual_title") or summary.get("pinned_title") or "").strip()
    auto = str(summary.get("generated_title") or summary.get("session_summary") or "").strip()

    s = GrokSession(
        sid=sid,
        cwd=cwd,
        sdir=sdir,
        title=manual or auto or "(未命名)",
        manual_title=manual,
        auto_title=auto,
        recap=str(summary.get("last_recap") or "").strip(),
        last_turn=str(summary.get("last_turn_summary") or "").strip(),
        created_ts=parse_iso(summary.get("created_at")),
        updated_ts=parse_iso(summary.get("updated_at")),
        active_ts=parse_iso(summary.get("last_active_at") or summary.get("updated_at")),
        num_messages=int(summary.get("num_messages") or 0),
        num_chat_messages=int(summary.get("num_chat_messages") or 0),
        model=str(summary.get("current_model_id") or ""),
        agent=str(summary.get("agent_name") or ""),
        sandbox=str(summary.get("sandbox_profile") or ""),
        git_root=str(summary.get("git_root_dir") or ""),
        git_remotes=[r for r in (summary.get("git_remotes") or []) if isinstance(r, str)],
        head_commit=str(summary.get("head_commit") or ""),
        head_branch=str(summary.get("head_branch") or ""),
        unreadable=not ok,
    )

    if not s.created_ts or not s.active_ts:
        try:
            mt = os.path.getmtime(sdir)
            s.created_ts = s.created_ts or mt
            s.active_ts = s.active_ts or mt
            s.updated_ts = s.updated_ts or mt
        except OSError:
            pass

    if not s.cwd:
        # 目录名就是 URL 编码后的 cwd（`D%3A%5Cgrok` → `D:\grok`）
        enc = os.path.basename(os.path.dirname(sdir.rstrip("\\/")))
        s.cwd = unquote(enc)

    body = os.path.join(sdir, "chat_history.jsonl")
    try:
        s.body_bytes = os.path.getsize(body)
    except OSError:
        s.body_bytes = 0

    live = live if live is not None else live_sessions()
    s.live_pid = live.get(sid, 0)
    return s


def load_all(*, with_live: bool = True) -> list[GrokSession]:
    """扫全部项目、全部会话。**一次 17 毫秒**（51 场实测）。

    按最近活跃倒序 —— 「管理」的第一需求永远是「我最近在做哪个」。
    """
    live = live_sessions() if with_live else {}
    rows: list[GrokSession] = []
    root = sessions_root()
    for path in glob.glob(os.path.join(root, "*", "*", "summary.json")):
        s = load_one(os.path.dirname(path), live)
        if s:
            rows.append(s)
    rows.sort(key=lambda x: x.active_ts or x.updated_ts or 0, reverse=True)
    return rows


# ---------------------------------------------------------------- 检索

def _haystack(s: GrokSession) -> str:
    return "\n".join([
        s.title, s.manual_title, s.auto_title, s.recap, s.last_turn,
        s.cwd, s.project, s.model, s.agent, " ".join(s.git_remotes),
    ])


def search(rows: list[GrokSession], query: str, limit: int = 0) -> list[GrokSession]:
    """大小写不敏感的子串检索，覆盖标题/recap/上次做到哪/路径/模型/仓库。

    `grok sessions search` 中文会超时返回 0，这里是纯本地字符串匹配，没有这个问题。
    空格分隔的多个词是 **AND**（都命中才算），这是搜「项目 + 事由」时最合直觉的语义。
    """
    terms = [t for t in (query or "").lower().split() if t]
    if not terms:
        return rows[:limit] if limit else rows
    hits = [s for s in rows if all(t in _haystack(s).lower() for t in terms)]
    return hits[:limit] if limit else hits


def resolve(rows: list[GrokSession], token: str) -> GrokSession | None:
    """把用户给的东西认成一场会话：完整 id / id 前缀 / 标题（忽略大小写）。

    刻意只认**唯一**匹配。标题撞车时返回 None 而不是随便挑一场 ——
    在这儿猜错，用户就是在错误的会话上执行了续跑或分叉。
    这与 grok 自己的 `-r <title>` 语义（ambiguous 就报错）保持一致。
    """
    token = (token or "").strip()
    if not token:
        return None
    for s in rows:
        if s.sid == token:
            return s
    if UUID_RE.match(token):
        return None
    pref = [s for s in rows if s.sid.startswith(token)]
    if len(pref) == 1:
        return pref[0]
    low = token.lower()
    exact = [s for s in rows if s.title.lower() == low and s.manual_title]
    if len(exact) == 1:
        return exact[0]
    named = [s for s in rows if s.title.lower() == low]
    if len(named) == 1:
        return named[0]
    sub = [s for s in rows if low in s.title.lower()]
    if len(sub) == 1:
        return sub[0]
    return None


def ambiguous(rows: list[GrokSession], token: str) -> list[GrokSession]:
    """resolve 失败时，列出它到底撞上了哪几场，好让用户补一个前缀。"""
    low = (token or "").strip().lower()
    if not low:
        return []
    return [s for s in rows if low in s.title.lower() or s.sid.startswith(low)]


def group_by_project(rows: list[GrokSession]) -> dict[str, list[GrokSession]]:
    out: dict[str, list[GrokSession]] = {}
    for s in rows:
        out.setdefault(s.cwd or "(未知)", []).append(s)
    return dict(sorted(out.items(), key=lambda kv: -max(s.active_ts for s in kv[1])))


# ---------------------------------------------------------------- 恢复前的体检

@dataclass
class Drift:
    """这场会话是在哪个代码版本上做的，现在仓库走到哪了。"""
    state: str          # clean | moved | missing-repo | no-repo | unknown
    note: str
    was: str = ""
    now: str = ""

    @property
    def ok(self) -> bool:
        return self.state in ("clean", "no-repo", "unknown")


def drift(s: GrokSession) -> Drift:
    """会话记录的 `head_commit` vs 仓库当前 HEAD。

    这是**别人都没有的一件事**：grok 把 `head_commit` 写进了 summary.json，
    但没有任何地方拿它跟现在的仓库比过。后果很实在 ——
    你三天后 `-r` 继续一场会话，如果这期间仓库已经往前合了 20 个提交，
    AI 是在**它记忆里的旧代码**上做判断的，它的「这个文件有 X 函数」可能早就不成立了。
    点继续之前先知道这件事，比事后 debug 便宜得多。
    """
    commit = (s.head_commit or "").strip().lower()
    root = (s.git_root or "").strip()
    if not commit:
        return Drift("unknown", "会话没记录 git 状态（非 git 目录里开的，或早期版本）")
    workdir = root.rstrip("\\/") or s.cwd
    if not workdir or not os.path.isdir(workdir):
        return Drift("missing-repo", f"会话记录的仓库目录已经不在了：{workdir or '(空)'}",
                     was=commit)
    now_commit, now_branch = read_git_head(workdir)
    if not now_commit:
        return Drift("no-repo", "工作目录在，但已经不是 git 仓库了", was=commit)
    if now_commit == commit:
        branch = now_branch or s.head_branch or "?"
        return Drift("clean", f"代码没动过（{branch} @ {commit[:8]}）",
                     was=commit, now=now_commit)
    was_branch = s.head_branch or "?"
    now_label = f"{now_branch or '?'} @ {now_commit[:8]}"
    return Drift(
        "moved",
        f"仓库已经往前走了：会话停在 {was_branch} @ {commit[:8]}，现在是 {now_label}。"
        "AI 记忆里的代码可能已经过时。",
        was=commit, now=now_commit,
    )


@dataclass
class Recon:
    """续跑前的一次完整体检：能不能跑、要等多久、代码变没变。"""
    session: GrokSession
    drift: Drift
    cost_note: str
    blockers: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def runnable(self) -> bool:
        return not self.blockers

    def lines(self) -> list[str]:
        out = [f"会话：{self.session.title}  ({self.session.sid})",
               f"目录：{self.session.cwd}"]
        if self.session.model:
            out.append(f"模型：{self.session.model}"
                       + (f" · agent {self.session.agent}" if self.session.agent else ""))
        out.append(f"体量：{self.session.size_label} · {self.session.num_chat_messages} 轮对话"
                   + ("  ·  🟠 正在运行" if self.session.live else ""))
        out.append(f"时间：{self.session.active_str}")
        out.append(f"代码：{self.drift.note}")
        if self.cost_note:
            out.append(f"预期：{self.cost_note}")
        for b in self.blockers:
            out.append(f"✗ {b}")
        for w in self.warnings:
            out.append(f"! {w}")
        return out


def preflight(s: GrokSession) -> Recon:
    """恢复前体检。把「跑不了」「要等十几分钟」「代码变过」三件事在点之前说清楚。"""
    d = drift(s)
    blockers: list[str] = []
    warnings: list[str] = []

    if not SAFE_SID.match(s.sid or ""):
        blockers.append("会话 id 不合法")
    if not s.cwd or not os.path.isdir(s.cwd):
        blockers.append(f"工作目录不存在：{s.cwd or '(空)'}")
    if s.unreadable:
        warnings.append("summary.json 读不出来（可能正在写入），元数据可能不全")
    if s.live:
        # 关键提醒：grok 允许两个进程同时续跑同一场会话，结果是两边都在写
        # 同一份 chat_history，最后谁也说不清哪句是谁说的。
        warnings.append(f"这场会话正在运行（pid {s.live_pid}）——"
                        "再续跑会变成两个进程写同一份历史；想岔开请用「分叉」")
    if d.state == "moved":
        warnings.append("代码已在会话之后变动，恢复前建议看一眼 diff")

    return Recon(session=s, drift=d, cost_note=s.resume_cost,
                 blockers=blockers, warnings=warnings)


# ---------------------------------------------------------------- 继承：分叉 / 接续

def _grok_exe() -> str:
    import shutil
    return shutil.which("grok") or "grok"


def resume_argv(s: GrokSession, *, fork: bool = False, fork_sid: str = "",
                restore_code: bool = False, worktree: str | None = None,
                prompt: str = "", auto_approve: bool = False) -> list[str]:
    """拼恢复命令。**argv 数组，不拼 shell 串。**

    参数对应 grok 原生能力，逐条实测（`grok --help` + 真跑）：
      -r <id>            按 id 恢复（也支持 `<标题>`，但标题会歧义，我们一律用 id）
      --fork-session     分叉：新开一个 session id，原会话不受影响
      -s <uuid>          给分叉出来的新会话指定 id（只能配 --fork-session 用）
      -w/--worktree      开一个**新 git worktree**
      --restore-code     连**代码快照**一起恢复
      -p <prompt>        无头单轮；不带则开交互式 TUI
      -m/--model         换模型（接续时常用：旧会话用便宜模型，接手换强的）

    两个必须记住的硬约束（都踩过）：

    1. **恢复必须带 `--cwd`**。不带的话 grok 按**调用者的当前目录**去找会话，
       结果就是「找不到这场会话」然后去联网恢复，报一个跟真实原因无关的鉴权错。
    2. **`--restore-code` 必须配 `--worktree`**。只给 `--restore-code` 会被直接拒绝：

           Error: --restore-code on a remote session requires --worktree
           (refusing to check out snapshot code into the current directory)

       这不是限制，是保护 —— 它**永远不往你当前目录里签出**，而是把快照恢复到一个
       新 worktree。比自己 `git checkout` 回去安全得多（你手头没提交的改动不会被冲掉）。
       所以这里自动补 `--worktree`，别让调用方自己记得。
    """
    exe = _grok_exe()
    argv = [exe, "--cwd", s.cwd, "-r", s.sid]
    if fork:
        argv.append("--fork-session")
        if fork_sid:
            if not UUID_RE.match(fork_sid):
                raise ValueError(f"分叉会话 id 必须是 UUID：{fork_sid!r}")
            argv += ["-s", fork_sid]
    if restore_code or worktree is not None:
        # --restore-code 单独用会被拒，必须挂在新 worktree 上；worktree="" 表示自动起名
        argv += ["-w", worktree] if worktree else ["-w"]
    if restore_code:
        argv.append("--restore-code")
    if auto_approve:
        argv.append("--always-approve")
    if prompt:
        argv += ["-p", prompt]
    return argv


def restore_argv(s: GrokSession, *, fork_sid: str = "") -> list[str]:
    """「连代码一起恢复」的推荐形态。

    只在**代码已经不在手边**时才需要 —— 本地会话的代码本来就在 `cwd` 里，
    `-r` 恢复对话即可，没什么可 restore 的。真正需要它的场景是：
    会话是在某个 worktree 里做的，而那个 worktree 已经被 `grok worktree gc` 清掉，
    或者仓库整个被改写了。这时 `--restore-code` 把当时的代码快照重新铺到一个新
    worktree 里，你就能在**当时的代码上**继续，而不是在已经往前跑了 50 个 commit 的
    当前分支上继续。

    注意它**不会**动你当前目录 —— 新 worktree 是另起一个目录。
    """
    return resume_argv(s, fork=fork_sid != "", fork_sid=fork_sid, restore_code=True)


def handoff_prompt(s: GrokSession, *, ask: str = "", include_git: bool = True,
                   include_recap: bool = True) -> str:
    """把一场会话压成一小段**接续提示词**，喂给一场全新会话。

    为什么需要它：`-r` 恢复的代价跟历史长度**强相关且非线性** ——
    60 KB 的会话 19 秒回来，1547 KB 的要 600 秒还不回来（remote.py 实测）。
    而「新会话 + 一段 recap」是秒开的。所以对大会话，**接续才是唯一实用的恢复**。

    提示词里刻意**只放结论不放过程**：recap 是 grok 自己压缩出来的，已经是最干的干货；
    把 chat_history 塞进去反而会重新撑爆上下文，等于白折腾。
    结尾那句「先别动代码」是有意的默认 —— 接续失败最贵的形态就是
    AI 拿着半懂的状态直接改文件。
    """
    lines: list[str] = []
    lines.append(f"# 接续一场 Grok Build 会话：{s.title}")
    lines.append("")
    lines.append("你在一个**新会话**里接手之前的工作。以下是上一场会话留下的状态，"
                 "请不要重新问一遍我已经说过的背景。")
    lines.append("")
    lines.append(f"- 工作目录：`{s.cwd}`")
    if s.model:
        lines.append(f"- 上一个会话用的模型：`{s.model}`"
                     + (f"（agent `{s.agent}`）" if s.agent else ""))
    lines.append(f"- 上一场会话：`{s.sid}`，{s.num_chat_messages} 轮对话，"
                 f"最后活跃 {s.active_str}")
    if include_git and (s.git_remotes or s.head_commit):
        if s.git_remotes:
            lines.append(f"- 仓库：{s.git_remotes[0]}")
        if s.head_commit:
            lines.append(f"- 会话结束时的提交：`{s.head_branch or '?'} @ {s.head_commit[:8]}`")
    lines.append("")

    d = drift(s)
    if d.state == "moved":
        lines.append(f"> ⚠️ {d.note} 下面这段记忆里的代码细节可能已经不准，请以实际文件为准。")
        lines.append("")

    if include_recap and s.last_turn:
        lines.append("## 上次做到哪")
        lines.append(s.last_turn)
        lines.append("")
    if include_recap and s.recap:
        lines.append("## 会话回顾")
        lines.append(s.recap)
        lines.append("")

    if ask.strip():
        lines.append("## 接下来要做的")
        lines.append(ask.strip())
        lines.append("")

    lines.append("## 现在请先做这三件事，**不要修改任何文件**")
    lines.append("1. 复述你对当前状态的理解（两三句就够）")
    lines.append("2. 列出你认为接下来要做的 3 件事，按优先级")
    lines.append("3. 指出上面这些状态里你觉得可疑或缺失的地方")
    lines.append("")
    lines.append("等我确认之后，再开始动手。")
    return "\n".join(lines)


def new_session_argv(s: GrokSession, prompt: str, *, model: str = "",
                     agent: str = "", auto_approve: bool = False) -> list[str]:
    """在同一个工作目录里开一场**全新**会话，把接续提示词作为开场白。

    不带 `-r`，所以没有任何历史重放成本。`--cwd` 必须带，否则新会话会开在
    调用者的当前目录，而不是上一场会话的项目里。
    """
    argv = [_grok_exe(), "--cwd", s.cwd]
    if model:
        argv += ["--model", model]
    if agent:
        argv += ["--agent", agent]
    if auto_approve:
        argv.append("--always-approve")
    argv.append(prompt)
    return argv


def fork_sid() -> str:
    """给分叉出来的会话生成一个 v4 UUID（grok 要求新会话 id 必须是合法 UUID）。"""
    import uuid
    return str(uuid.uuid4())


# ---------------------------------------------------------------- 文本报告

def _disp_width(text: str) -> int:
    """显示宽度：CJK / 全角算 2 列。终端对齐必须按这个算，
    按 `len()` 算的话中文列会整体歪掉。"""
    return sum(2 if ord(c) > 0x2E80 else 1 for c in text)


def trunc_disp(text: str, width: int, tail: str = "…") -> str:
    """按显示宽度截断，不切碎宽字符。"""
    if _disp_width(text) <= width:
        return text
    budget = width - _disp_width(tail)
    out: list[str] = []
    used = 0
    for ch in text:
        cw = 2 if ord(ch) > 0x2E80 else 1
        if used + cw > budget:
            break
        out.append(ch)
        used += cw
    return "".join(out) + tail


def _pad_disp(text: str, width: int) -> str:
    return text + " " * max(0, width - _disp_width(text))


def render_list(rows: list[GrokSession], *, show_recap: bool = False,
                limit: int = 0, total: int = 0) -> str:
    """终端列表。两行一场：第一行状态+标题，第二行接续摘要 + 目录。

    空会话（0 字节正文）单独标出来 —— 本机 51 场里有十几场是这种，
    多半是启动失败或只问了句「ok」就退出的。不标的话用户会去点它，
    然后困惑「为什么恢复出来是空的」。
    """
    rows = rows[:limit] if limit else rows
    if not rows:
        return "（没有匹配的会话）"

    C_ACT, C_SZ, C_MD = 10, 9, 18
    title_w = max(30, 118 - (C_ACT + C_SZ + C_MD))

    out: list[str] = []
    out.append(_pad_disp("活跃", C_ACT) + _pad_disp("体量", C_SZ)
               + _pad_disp("模型", C_MD) + "标题")
    out.append("─" * 118)
    for s in rows:
        lamp = "🟠 在跑" if s.live else "·"
        if s.body_bytes == 0:
            title = f"{s.title}   〔空会话〕"
        else:
            title = s.title
        out.append(_pad_disp(lamp, C_ACT) + _pad_disp(s.size_label, C_SZ)
                   + _pad_disp(trunc_disp(s.model, C_MD - 1), C_MD)
                   + trunc_disp(title, title_w))
        tail = s.shortcut(88)
        second = f"{s.active_str} · {s.cwd}"
        if show_recap and tail:
            second = f"{s.active_str} · {tail}"
        out.append(" " * (C_ACT + C_SZ) + "└ " + trunc_disp(second, 108))
    out.append("")
    shown = len(rows)
    alln = total or len(load_all())
    out.append(f"共 {shown} 场" + (f"（本机共 {alln} 场）" if shown != alln else ""))
    return "\n".join(out)


def render_detail(s: GrokSession) -> str:
    """单场会话的完整卡片 —— 管理、体检、可执行的下一步。"""
    r = preflight(s)
    out: list[str] = []
    out.append("=" * 74)
    out.append(f"{s.title}")
    out.append("=" * 74)
    for line in r.lines():
        out.append(f"  {line}")
    if s.git_remotes:
        out.append(f"  仓库：{s.git_remotes[0]}")
        for extra in s.git_remotes[1:]:
            out.append(f"        {extra}")
    out.append("")
    if s.last_turn:
        out.append("  上次做到哪：")
        for line in s.last_turn.splitlines()[:8]:
            out.append(f"    {line}")
        out.append("")
    if s.recap:
        out.append("  会话回顾：")
        for line in s.recap.splitlines()[:10]:
            out.append(f"    {line}")
        out.append("")
    out.append("  可以这么用：")
    out.append(f"    续跑         grok --cwd \"{s.cwd}\" -r {s.sid}")
    out.append(f"    分叉（不动原会话） grok --cwd \"{s.cwd}\" -r {s.sid} --fork-session")
    if s.head_commit:
        out.append(f"    连代码一起恢复  ... --restore-code")
    out.append(f"    接续到新会话   python tools/sessions.py handoff {s.sid8} --ask \"<你要做什么>\"")
    return "\n".join(out)


if __name__ == "__main__":
    rows = load_all()
    print(render_list(rows, show_recap=True, limit=20))
    if rows:
        print()
        print(render_detail(rows[0]))
        print()
        print("接续提示词预览：")
        print("-" * 74)
        print(handoff_prompt(rows[0]))
