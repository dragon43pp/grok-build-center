#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
飞书卡片 JSON 2.0 构造。

三个必须记住的官方约束（来自 open.feishu.cn 文档，写错就不渲染）：
  1. **必须显式声明 `"schema": "2.0"`**，不填默认 1.0。
  2. **2.0 废弃了 `action` 交互模块** —— 按钮直接放进 `body.elements`。
  3. **`config.update_multi` 必须是 `true`**，否则后面 `PATCH` 更新卡片会失败。

另外：
  - 卡片整体 ≤ 30 KB，所以一页只放 PAGE_SIZE 条，别想一次塞完 343 场。
  - 按钮回调走 `behaviors: [{"type": "callback", "value": {...}}]`，
    回调里从 `event.action.value` 取回。

按钮 type 可选值：default / primary / danger / text / primary_text /
danger_text / primary_filled / danger_filled / laser
"""

from __future__ import annotations

import json
import time

from .state import STATUS_COLOR, STATUS_DOT, STATUS_LABEL, Session, Snapshot, filter_sessions

PAGE_SIZE = 10

# 筛选按钮：key 会被塞进回调 value
FILTERS: list[tuple[str, str]] = [
    ("active", "活跃"),
    ("needs-you", "等你确认"),
    ("codex", "Codex"),
    ("claude", "Claude"),
    ("grok", "Grok"),
    ("opencode", "OpenCode"),
    ("kimi", "Kimi"),
    ("all", "全部"),
]


def _md(text: str) -> str:
    """最小化转义：飞书 lark_md 里 * _ ` ~ 是语法字符。"""
    out = text or ""
    for ch in ("*", "_", "`", "~"):
        out = out.replace(ch, "\\" + ch)
    return out


def _btn(label: str, value: dict, btype: str = "default", size: str = "small") -> dict:
    return {
        "tag": "button",
        "type": btype,
        "size": size,
        "text": {"tag": "plain_text", "content": label},
        "behaviors": [{"type": "callback", "value": value}],
    }


def _col_set(elements_per_col: list[list[dict]], flex: str = "flow") -> dict:
    return {
        "tag": "column_set",
        "flex_mode": flex,
        "background_style": "default",
        "columns": [
            {"tag": "column", "width": "auto", "weight": 1, "vertical_align": "center",
             "elements": els}
            for els in elements_per_col
        ],
    }


def _summary_line(snap: Snapshot) -> str:
    parts = []
    for status in ("needs-you", "error", "running", "idle"):
        n = snap.counts_by_status.get(status, 0)
        if n:
            parts.append(f"{STATUS_DOT[status]}{n} {STATUS_LABEL[status]}")
    ended = snap.counts_by_status.get("ended", 0)
    if ended:
        parts.append(f"· {ended} 已结束")
    clock = time.strftime("%H:%M:%S", time.localtime(snap.generated_at))
    return f"**共 {snap.total} 场会话**　{'　'.join(parts)}\n更新于 {clock} · 存活进程 {snap.live_procs}"


def _filter_row(active_key: str, snap: Snapshot) -> dict:
    cols: list[list[dict]] = []
    for key, label in FILTERS:
        n = len(filter_sessions(snap, key))
        # 数量为 0 的筛选除了「全部」都藏起来，省地方
        if n == 0 and key != "all":
            continue
        btype = "primary" if key == active_key else "default"
        cols.append([_btn(f"{label} {n}", {"cmd": "filter", "key": key}, btype, "tiny")])
    return _col_set(cols)


def _session_row(s: Session, ask: bool = True, approve: bool = False) -> dict:
    dot = STATUS_DOT[s.status]
    bits = [f"`{_md(s.project)}`", _md(s.cli_label)]
    if s.msgs:
        bits.append(f"{s.msgs} 条")
    if s.tokens:
        bits.append(f"{s.tokens / 1000:.0f}k tok")
    bits.append(s.last_str)
    if s.hook_note:
        bits.append(f"**{_md(s.hook_note)}**")
    left = {
        "tag": "markdown",
        "content": f"{dot} **{_md(s.title)}**\n{' · '.join(bits)}",
    }
    cols = [[left]]
    if ask and s.sid:
        # 「看」和「动」分开：详情是进入这一场（看正文 + 发指令），
        # 打开是在本机弹终端。手机上多数时候要的是前者。
        cols.append([_btn("详情", {"cmd": "detail", "cli": s.cli, "sid": s.sid}, "default", "tiny")])
    # 三个条件同时成立才摆按钮：① Bridge 够得着 ② 真的在等你 ③ 配置允许。
    # 第三条是信任开关 —— 手机上一点就让本机继续执行工具，默认不开。
    # 摆一个点了只会弹「未开启」的按钮，比不摆更让人火大。
    if s.controllable and s.status == "needs-you" and approve:
        cols.append([_btn("批准", {"cmd": "approve", "cli": s.cli, "sid": s.sid},
                          "primary", "tiny")])
        cols.append([_btn("拒绝", {"cmd": "deny", "cli": s.cli, "sid": s.sid},
                          "danger", "tiny")])

    right = _btn(
        "打开" if s.resumable else "—",
        {"cmd": "open", "cli": s.cli, "sid": s.sid},
        "primary" if s.status in ("needs-you", "error") else "default",
        "small",
    )
    if not s.resumable:
        right["disabled"] = True
    cols.append([right])
    return _col_set(cols, flex="flow")


def _pager(page: int, pages: int, filter_key: str) -> dict:
    prev = _btn("‹ 上一页", {"cmd": "page", "page": page - 1, "key": filter_key}, "default", "tiny")
    nxt = _btn("下一页 ›", {"cmd": "page", "page": page + 1, "key": filter_key}, "default", "tiny")
    if page <= 0:
        prev["disabled"] = True
    if page >= pages - 1:
        nxt["disabled"] = True
    return _col_set(
        [
            [prev],
            [{"tag": "markdown", "content": f"<font color='grey'>{page + 1} / {pages}</font>"}],
            [nxt],
            [_btn("⟳ 刷新", {"cmd": "refresh", "key": filter_key, "page": page}, "default", "tiny")],
            [_btn("全部重置", {"cmd": "filter", "key": "active"}, "text", "tiny")],
        ]
    )


def build_panel(snap: Snapshot, filter_key: str = "active", page: int = 0,
                ask: bool = True, approve: bool = False) -> dict:
    """构造常驻面板卡。这张卡会被原地 PATCH 更新，不重发。

    ask=False 时每行只有「打开」，不带「详情」——远程续跑关掉时用。
    approve=True 时，可反向操作的会话会多出「批准 / 拒绝」。
    """
    rows = filter_sessions(snap, filter_key)
    pages = max(1, (len(rows) + PAGE_SIZE - 1) // PAGE_SIZE)
    page = max(0, min(page, pages - 1))
    chunk = rows[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]

    elements: list[dict] = [
        {"tag": "markdown", "content": _summary_line(snap)},
        _filter_row(filter_key, snap),
        {"tag": "hr"},
    ]

    if not chunk:
        elements.append({"tag": "markdown", "content": "<font color='grey'>这个筛选下没有会话。</font>"})
    else:
        for s in chunk:
            elements.append(_session_row(s, ask=ask, approve=approve))
            elements.append({"tag": "hr", "margin": "2px 0px"})

    label = dict(FILTERS).get(filter_key, filter_key)
    elements.append({"tag": "markdown",
                     "content": f"<font color='grey'>筛选：{label} · 第 {page + 1}/{pages} 页 · {len(rows)} 场</font>"})
    elements.append(_pager(page, pages, filter_key))

    return {
        "schema": "2.0",
        "config": {"update_multi": True},
        "header": {
            "template": "blue",
            "title": {"tag": "plain_text", "content": "Grok Build Pager"},
            "subtitle": {"tag": "plain_text", "content": f"{snap.total} 场会话 · 点「打开」回到现场"},
        },
        "body": {"elements": elements},
    }


def card_size_kb(card: dict) -> float:
    return len(json.dumps(card, ensure_ascii=False).encode("utf-8")) / 1024


# ------------------------------------------------------------------ 详情卡

# 卡片整体上限是 **30 KB 字节**，不是字符。
# 中文一个字 3 字节，所以按字符算预算会直接爆三倍 ——
# 曾经把 RESULT_BUDGET 当成 12000「字」用，实测出 35.7 KB 的卡，飞书直接拒绝。
CARD_LIMIT_BYTES = 30 * 1024


def clip_bytes(text: str, max_bytes: int, note: str = "…") -> str:
    """按**字节**截断（不是按字符）。多字节字符被切一半时丢掉那半截。"""
    raw = (text or "").encode("utf-8")
    if len(raw) <= max_bytes:
        return text or ""
    return raw[:max_bytes].decode("utf-8", errors="ignore") + note


# 正文区（不含表单、标题）能占多少字节，留足余量给其余元素
DETAIL_BUDGET = 16 * 1024

# 表单里输入框的 name 前缀。会话身份只能藏在这里 ——
# 表单内的提交按钮**不能带 behaviors**，也就带不了自定义 value（官方约束），
# 而回调只回 `form_value`（按组件 name 映射）。所以把 cli/sid 编进 name。
INPUT_PREFIX = "p__"

# 「投喂到活着的那一场」用的前缀。走 HRack Bridge 的 session.send，
# 跟上面的无头续跑是**两条不同的路**：
#   p__ → remote.py 另起一个无头进程（那场 TUI 看不到这句话）
#   s__ → 直接塞进 HRack 里正在跑的那一场（同一场会话，上下文连续）
# 表单内的提交按钮带不了 behaviors，所以身份只能编进 name —— 跟 p__ 同理。
SEND_PREFIX = "s__"


def ask_input_name(cli: str, sid: str) -> str:
    return f"{INPUT_PREFIX}{cli}__{sid}"


def send_input_name(bridge_id: str) -> str:
    return f"{SEND_PREFIX}{bridge_id}"


def parse_form(form_value: dict) -> tuple[str, str, str, str]:
    """从 form_value 里解出 (kind, cli, sid, text)。

    kind: 'ask'（无头续跑）| 'send'（投喂到活着的会话）| ''（认不出来）。
    """
    for key, val in (form_value or {}).items():
        if key.startswith(SEND_PREFIX):
            return "send", "", key[len(SEND_PREFIX):], (val or "").strip()
        if key.startswith(INPUT_PREFIX):
            rest = key[len(INPUT_PREFIX):]
            cli, _, sid = rest.partition("__")
            return "ask", cli, sid, (val or "").strip()
    return "", "", "", ""


def parse_ask(form_value: dict) -> tuple[str, str, str]:
    """从 form_value 里解出 (cli, sid, prompt)。只认无头续跑那一种。"""
    kind, cli, sid, text = parse_form(form_value)
    if kind != "ask":
        return "", "", ""
    return cli, sid, text


def _turn_md(role: str, text: str, limit_bytes: int) -> str:
    tag = "**你**" if role == "user" else "**AI**"
    body = (text or "").strip()
    clipped = clip_bytes(body, limit_bytes)
    if clipped != body:
        clipped += "\n…（已截断）"
    return f"{tag}\n{_md(clipped)}"


def build_detail(s: Session, turns: list, ask: bool = True, hint: str = "") -> dict:
    """一场会话的详情卡：能看正文，还能直接发一句话让它继续。

    `turns` 是 `remote.read_transcript()` 的结果（[Turn, ...]）。
    `hint` 是体量提示（`remote.size_hint()` 的产物）—— 大会话恢复要几分钟，
    提前说清楚，免得用户以为卡死了。
    """
    dot = STATUS_DOT.get(s.status, "")
    info = " · ".join(
        p for p in (
            f"{dot}{STATUS_LABEL.get(s.status, s.status)}",
            _md(s.cli_label),
            f"`{_md(s.project)}`",
            s.last_str,
            (f"{s.msgs} 条" if s.msgs else ""),
            (f"{s.tokens / 1000:.0f}k tok" if s.tokens else ""),
        ) if p
    )

    elements: list[dict] = [
        {"tag": "markdown", "content": f"**{_md(s.title)}**\n{info}"},
        {"tag": "hr"},
        {"tag": "markdown", "content": f"<font color='grey'>{_md(s.cwd or '(目录未知)')}</font>"},
    ]

    if turns:
        per = max(200, DETAIL_BUDGET // max(1, len(turns)))
        for t in turns:
            elements.append({"tag": "markdown", "content": _turn_md(t.role, t.text, per)})
            elements.append({"tag": "hr", "margin": "2px 0px"})
    else:
        elements.append({"tag": "markdown",
                         "content": "<font color='grey'>读不到这一场的对话正文"
                                    f"（{_md(s.cli_label)} 的存储格式尚未支持，或会话文件已清理）。</font>"})

    # form 只能待在卡片根节点下，不能被别的容器套住 —— 直接放进 body.elements
    if ask and (s.bridge_id or s.sid):
        if s.bridge_id:
            # 这场是 HRack 里活着的（当前只有 OpenCode 会话），直接投进去。
            # 走的是同一场会话，上下文连续 —— 不像无头续跑那样另起炉灶。
            elements.append({
                "tag": "markdown",
                "content": "<font color='green'>这场正在 HRack 里跑着，"
                           "下面这句会**直接投进这一场**（同一上下文）。</font>",
            })
            elements.append({
                "tag": "form",
                "name": "send_form",
                "elements": [
                    {
                        "tag": "input",
                        "name": send_input_name(s.bridge_id),
                        "required": True,
                        "placeholder": {"tag": "plain_text",
                                        "content": "接着上一轮继续，比如「把这个改完」"},
                        "label": {"tag": "plain_text", "content": "投给正在跑的这一场"},
                    },
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "投进去"},
                        "type": "primary",
                        "form_action_type": "submit",
                        "name": "btn_send",
                    },
                ],
            })
        elif s.sid:
            if hint:
                elements.append({
                    "tag": "markdown",
                    "content": f"<font color='orange'>⏳ {_md(hint)}</font>",
                })
            elements.append({
                "tag": "form",
                "name": "ask_form",
                "elements": [
                    {
                        "tag": "input",
                        "name": ask_input_name(s.cli, s.sid),
                        "required": True,
                        "placeholder": {"tag": "plain_text",
                                        "content": "接着上一轮继续，比如「把这个改完」"},
                        "label": {"tag": "plain_text", "content": "让 AI 继续这一场"},
                    },
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "发到本机执行"},
                        "type": "primary",
                        # Card 2.0 用 form_action_type（1.0 才是 action_type: form_submit）
                        "form_action_type": "submit",
                        "name": "btn_ask",
                    },
                ],
            })
            elements.append({"tag": "markdown",
                             "content": "<font color='grey'>提交后会在本机用无头模式续跑这一场会话，"
                                        "结果回传到这里。不涉及终端，机器上不会弹窗。</font>"})

    return {
        "schema": "2.0",
        "config": {"update_multi": True},
        "header": {
            "template": "blue",
            "title": {"tag": "plain_text", "content": "会话详情"},
            "subtitle": {"tag": "plain_text", "content": f"{_md(s.cli_label)} · 点「发到本机执行」继续任务"},
        },
        "body": {"elements": elements},
    }


RESULT_BUDGET = 20 * 1024


def build_result(s: Session, prompt: str, ok: bool, output: str, secs: float = 0.0) -> dict:
    """续跑结果卡。ok=False 时把退出码和 stderr 也带上，方便排查。

    `secs` 是实际耗时 —— 大会话动辄几分钟，把耗时写上，用户才知道
    「等这么久是正常的」还是「这次特别慢」。
    """
    body = (output or "").strip()
    if body.encode("utf-8").__len__() > RESULT_BUDGET:
        body = clip_bytes(body, RESULT_BUDGET,
                          f"\n\n…（输出被截断，只回了前 {RESULT_BUDGET // 1024} KB）")

    if secs >= 60:
        took = f"{int(secs // 60)} 分 {int(secs % 60)} 秒"
    elif secs > 0:
        took = f"{secs:.0f} 秒"
    else:
        took = ""

    elements = [
        {"tag": "markdown", "content": f"**{_md(s.title or '(未命名)')}** · {_md(s.cli_label)}"
                                      + (f" · 耗时 {took}" if took else "")},
        {"tag": "hr"},
        {"tag": "markdown", "content": f"**你让它做的**\n{_md(prompt)}"},
        {"tag": "hr"},
        {"tag": "markdown", "content": _md(body) if body else "<font color='grey'>没有输出</font>"},
    ]
    return {
        "schema": "2.0",
        "config": {"update_multi": True},
        "header": {
            "template": "green" if ok else "red",
            "title": {"tag": "plain_text", "content": "续跑完成" if ok else "续跑失败"},
            "subtitle": {"tag": "plain_text", "content": _md(s.cwd or "")[:60]},
        },
        "body": {"elements": elements},
    }


if __name__ == "__main__":
    from .state import build_snapshot

    snap = build_snapshot()
    for key in ("active", "all", "codex"):
        c = build_panel(snap, key, 0)
        print(f"筛选 {key:<8} 卡片体积 {card_size_kb(c):.2f} KB / 上限 30 KB")
    c = build_panel(snap, "all", 0)
    print()
    print(json.dumps(c, ensure_ascii=False, indent=1)[:1400])
