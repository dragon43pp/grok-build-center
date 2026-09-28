#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线冒烟测试：不建飞书应用、不联网，把「卡片回调 → 状态变更 → 原地更新 → hook 上报」
这条主链路整条跑一遍。

为什么值得单独写：飞书那侧要开发者后台点一堆配置才能试，一旦跑不通很难分清是
「我代码错了」还是「后台没配好」。这个脚本用假客户端把飞书那一段换成录音机，
先把代码逻辑钉死。跑通了再连真飞书，出问题就一定是后台配置。

跑法：
    python tools/smoke_test.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lark_oapi as lark  # noqa: E402
from lark_oapi.event.callback.model.p2_card_action_trigger import (  # noqa: E402
    P2CardActionTrigger,
)

from feishu_hub import cards, hub as hub_mod  # noqa: E402
from feishu_hub import state as state_mod  # noqa: E402

PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [OK]   {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}  {detail}")


# ------------------------------------------------------------------ 假客户端

class FakeClient:
    """把飞书那一段换成录音机。字段名跟 FeishuClient 对齐。"""

    def __init__(self, *a, **kw) -> None:
        self.sent: list[dict] = []
        self.patched: list[dict] = []
        self.pinned: list[str] = []
        self.fail_patch = False

    def send_card(self, receive_id, card, receive_id_type="open_id"):
        self.sent.append({"to": receive_id, "type": receive_id_type, "card": card})
        return f"om_fake_{len(self.sent)}"

    def patch_card(self, message_id, card):
        if self.fail_patch:
            raise hub_mod.FeishuError("模拟更新失败")
        self.patched.append({"message_id": message_id, "card": card})

    def patch_card_quiet(self, message_id, card):
        try:
            self.patch_card(message_id, card)
            return True
        except hub_mod.FeishuError:
            return False

    def pin(self, message_id):
        self.pinned.append(message_id)
        return True


def make_hub() -> tuple[hub_mod.Hub, FakeClient]:
    cfg = hub_mod.Config(
        panel_state=os.path.join(tempfile.mkdtemp(prefix="agenthub-"), "panel.json")
    )
    h = hub_mod.Hub(cfg)
    fake = FakeClient()
    h.client = fake
    return h, fake


def cb(value: dict) -> P2CardActionTrigger:
    """按 SDK 的反序列化路径造一个真实的回调对象。"""
    return P2CardActionTrigger({"event": {"action": {"value": value}}})


def card_of(resp) -> dict:
    return resp.card.data


def wire_of(resp) -> dict:
    """按 SDK 真实的上行路径序列化一遍 —— 直接看飞书会收到什么。

    `card.type` 只认 "raw" / "template"，写错客户端直接渲染失败；
    光看内存里的对象看不出这个问题，必须序列化。
    """
    return json.loads(lark.JSON.marshal(resp))


def rows_of(card: dict) -> list[str]:
    """把卡片里所有「打开」按钮带的 sid 抓出来，用来判断翻页有没有真的换页。"""
    out: list[str] = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "callback":
                v = node.get("value") or {}
                if v.get("cmd") == "open":
                    out.append(v.get("sid", ""))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(card)
    return out


def wait_for(pred, timeout: float = 20.0, interval: float = 0.25) -> bool:
    """等后台线程干完活。重扫要 ~5 秒，所以超时给宽点。"""
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(interval)
    return pred()


# ------------------------------------------------------------------ 用例

def test_snapshot() -> None:
    print("\n[1] 快照：本机会话能扫出来")
    h, _ = make_hub()
    snap = h.snapshot(force=True)
    check("扫到会话", snap.total > 0, f"total={snap.total}")
    check("按 CLI 分组非空", bool(snap.counts_by_cli), str(snap.counts_by_cli))
    check("会话都有 cli 和 sid", all(s.cli and s.sid for s in snap.sessions))
    check("已按状态优先级排序",
          [s.status for s in snap.sessions] ==
          sorted((s.status for s in snap.sessions),
                 key=lambda k: state_mod.STATUS_ORDER.get(k, 9)))
    check("快照有缓存（20s 内不再扫）", h.snapshot() is snap)
    check("force 会重扫", h.snapshot(force=True) is not snap)


def test_panel_publish() -> None:
    print("\n[2] 首次发布：发一张 + 置顶 + 记住 message_id")
    h, fake = make_hub()
    mid = h.ensure_panel()
    check("发了卡片", len(fake.sent) == 1, f"sent={len(fake.sent)}")
    check("返回 message_id", bool(mid), str(mid))
    check("置顶了", fake.pinned == [mid], str(fake.pinned))
    check("panel.json 落地", os.path.exists(h.cfg.panel_state))
    check("落地的 message_id 一致",
          hub_mod.load_panel_state(h.cfg.panel_state).get("message_id") == mid)

    print("\n[3] 二次发布：原地更新，不再新发")
    before = len(fake.sent)
    h.ensure_panel()
    check("没有新发消息", len(fake.sent) == before, f"sent={len(fake.sent)}")
    check("走了 PATCH", len(fake.patched) == 1, f"patched={len(fake.patched)}")

    print("\n[4] 更新失败时兜底：退回新发一张")
    h2, fake2 = make_hub()
    fake2.fail_patch = True
    h2._panel = {"message_id": "om_stale"}
    mid2 = h2.ensure_panel()
    check("新发了一张", len(fake2.sent) == 1)
    check("返回的是新 id", mid2 == "om_fake_1", str(mid2))


def test_filters() -> None:
    print("\n[5] 筛选：每个 key 都能出卡片且不超限")
    h, _ = make_hub()
    snap = h.snapshot(force=True)
    for key in ("active", "all", "needs-you", "error", "codex", "claude", "opencode", "grok"):
        card = cards.build_panel(snap, key, 0)
        size = cards.card_size_kb(card)
        check(f"{key:<9} 卡片 {size:5.2f} KB < 30KB", size < 30, f"{size:.2f}KB")
        check(f"{key:<9} schema=2.0 且 update_multi", 
              card.get("schema") == "2.0" and card["config"]["update_multi"] is True)

    print("\n[6] 翻页：page 越界不炸、每页不超 PAGE_SIZE")
    page_size = cards.PAGE_SIZE
    sids0 = rows_of(cards.build_panel(snap, "all", 0))
    sids1 = rows_of(cards.build_panel(snap, "all", 1))
    sids99 = rows_of(cards.build_panel(snap, "all", 99))
    check(f"每页最多 {page_size} 行（p0={len(sids0)}）", len(sids0) <= page_size, str(len(sids0)))
    check("p1 真的换了内容", sids0 != sids1 and not (set(sids0) & set(sids1)),
          f"交集={len(set(sids0) & set(sids1))}")
    check("p99 越界夹到最后一页（343 = 34*10+3 → 3 行）",
          len(sids99) == snap.total % page_size or len(sids99) == page_size,
          f"{len(sids99)} 行 / 余数 {snap.total % page_size}")
    check("越界页不重复不丢数据",
          not (set(sids99) & set(sids0)) and not (set(sids99) & set(sids1)))
    check("翻页覆盖完整（p0+p1 无重复）", len(set(sids0) | set(sids1)) == len(sids0) + len(sids1))


def test_card_callback() -> None:
    print("\n[7] 卡片回调：filter / page / refresh / open / folder / 未知指令")
    h, fake = make_hub()
    h.ensure_panel()
    sent_before = len(fake.sent)

    t0 = time.time()
    r = h.on_card(cb({"cmd": "filter", "key": "codex"}))
    elapsed = time.time() - t0
    check("filter 生效", h._filter == "codex", h._filter)
    check("filter 重置页码", h._page == 0, str(h._page))
    check("返回了卡片 JSON", bool(card_of(r)), str(r.card.type))
    check("toast 是 info", r.toast.type == "info", str(r.toast.type))

    # 上线前最容易踩的坑：card.type 只有 raw / template 两个合法值
    wire = wire_of(r)
    check("上行 card.type == 'raw'（不是 card_json）",
          wire["card"]["type"] == "raw", str(wire["card"]["type"]))
    check("上行 card.data 是对象不是字符串",
          isinstance(wire["card"]["data"], dict), type(wire["card"]["data"]).__name__)
    check("上行卡片 schema 2.0 保住了",
          wire["card"]["data"].get("schema") == "2.0", str(wire["card"]["data"].get("schema")))
    check("上行卡片 update_multi 保住了",
          wire["card"]["data"]["config"]["update_multi"] is True)
    check("上行卡片有 body.elements",
          bool(wire["card"]["data"]["body"]["elements"]))
    check("上行没有 null 字段（SDK 会把 None 删掉）",
          "null" not in lark.JSON.marshal(r))
    check("toast 也一起上行了", wire["toast"]["type"] == "info", str(wire.get("toast")))
    # 关键：飞书卡片回调约 3 秒超时，绝不能在里面做 5 秒的重扫
    check(f"回调在 1 秒内返回（实测 {elapsed:.2f}s）", elapsed < 1.0, f"{elapsed:.2f}s")
    check("没有多发消息（回包里的 card 就是原地更新）", len(fake.sent) == sent_before)
    check("面板状态落盘了", hub_mod.load_panel_state(h.cfg.panel_state).get("filter") == "codex")
    check("回的卡片确实是 codex 那批",
          all(s.cli == "codex" for s in h.snapshot().sessions
              if s.sid in rows_of(card_of(r))))

    h.on_card(cb({"cmd": "page", "key": "all", "page": "2"}))
    check("page 生效", h._page == 2, str(h._page))
    check("page 同时切了 filter", h._filter == "all", h._filter)

    h.on_card(cb({"cmd": "page", "key": "all", "page": "-5"}))
    check("负页码被夹到 0", h._page == 0, str(h._page))

    r = h.on_card(cb({"cmd": "refresh"}))
    check("refresh 不炸", r.toast.type == "info")
    check("refresh 立刻告诉用户在刷（不干等）",
          "刷新" in r.toast.content, r.toast.content)

    r = h.on_card(cb({"cmd": "folder", "cli": "grok", "sid": "nope"}))
    check("未知会话的 folder 走 error toast", r.toast.type == "error", str(r.toast.type))

    r = h.on_card(cb({"cmd": "不存在"}))
    check("未知指令回 warning", r.toast.type == "warning", str(r.toast.type))

    r = h.on_card(P2CardActionTrigger({"event": {}}))
    check("空 action 不炸（默认 refresh）", r.toast.type == "info", str(r.toast.type))

    print("\n[8] 回调里的 sid 不能拼进命令行")
    h2, _ = make_hub()
    h2.ensure_panel()
    r = h2.on_card(cb({"cmd": "open", "cli": "grok", "sid": "x; rm -rf /", "cwd": ""}))
    check("注入被拒", r.toast.type == "error", str(r.toast.content))


def test_hook_server() -> None:
    print("\n[9] hook 端点：CLI 上报 → 状态变化 → 面板自动更新")
    h, fake = make_hub()
    h.cfg.hook_port = 8791
    h.ensure_panel()
    h.start_hook_server()
    threading.Thread(target=h._refresher, daemon=True).start()
    time.sleep(0.4)

    # 本机回环地址不能走系统代理 —— 这台机器上 http_proxy 是设着的，
    # 走代理会绕一圈，运气不好直接 502，看起来像「面板挂了」。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def post(payload: dict) -> tuple[int, dict]:
        req = urllib.request.Request(
            "http://127.0.0.1:8791/hook",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with opener.open(req, timeout=30) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:          # 4xx 会被 urllib 抛出来
            return e.code, json.loads(e.read() or b"{}")

    with opener.open("http://127.0.0.1:8791/health", timeout=30) as resp:
        health = json.loads(resp.read())
    check("/health 通", health.get("ok") is True, str(health))
    check("/health 报会话数", health.get("sessions", 0) > 0, str(health))

    t0 = time.time()
    code, body = post({"cli": "grok", "sid": "smoke-1", "status": "needs-you",
                       "note": "要不要删这个文件", "cwd": "D:\\proj"})
    elapsed = time.time() - t0
    check("POST /hook 返回 200", code == 200, str(code))
    check("返回 ok", body.get("ok") is True, str(body))
    # 这条是给 CLI 用的，必须立刻返回 —— 否则拖慢的是用户正在敲的终端
    check(f"hook 在 1 秒内返回（实测 {elapsed:.2f}s）", elapsed < 1.0, f"{elapsed:.2f}s")

    ok = wait_for(lambda: any(
        s.cli == "grok" and s.sid == "smoke-1" and s.status == "needs-you"
        for s in h.snapshot(max_age=0.01).sessions
    ))
    check("后台线程把 hook 事件并进快照", ok)

    snap = h.snapshot(max_age=0.01)
    hit = [s for s in snap.sessions if s.cli == "grok" and s.sid == "smoke-1"]
    check("会话库里没有它，也要补一行出来（不能静默丢掉）", len(hit) == 1, f"hit={len(hit)}")
    if hit:
        check("状态是 needs-you", hit[0].status == "needs-you", hit[0].status)
        check("备注带上了", hit[0].hook_note == "要不要删这个文件", hit[0].hook_note)
        check("合成行也能恢复（CLI 自己认得这个 id）", hit[0].resumable is True)
        check("合成行带上了 cwd", hit[0].cwd == "D:\\proj", hit[0].cwd)
    check("needs-you 排在最前", snap.sessions[0].status == "needs-you", snap.sessions[0].status)
    check("后台把面板 PATCH 了", wait_for(lambda: len(fake.patched) > 0, 5),
          str(len(fake.patched)))

    print("\n[9b] 有 sid 且会话库里有：直接改那一条，不新增行")
    # 注意别挑到上面那条合成行 —— 合成行的 title 就是 note，比不出「标题有没有被顶掉」
    real = [s for s in snap.sessions
            if s.sid and s.cli == "grok" and s.sid != "smoke-1"][0]
    n_before = snap.total
    post({"cli": real.cli, "sid": real.sid, "status": "error",
          "note": "模拟报错", "cwd": real.cwd})
    wait_for(lambda: any(s.sid == real.sid and s.status == "error"
                         for s in h.snapshot(max_age=0.01).sessions))
    snap2 = h.snapshot(max_age=0.01)
    check("命中已有会话，没有多出一行", snap2.total == n_before, f"{n_before} → {snap2.total}")
    got = [s for s in snap2.sessions if s.sid == real.sid][0]
    check("状态改成 error", got.status == "error", got.status)
    check("标题没被备注顶掉", got.title == real.title, got.title)

    print("\n[10] 上报的注意力卡片 + 防刷屏")
    att = [s for s in fake.sent if "等你" in json.dumps(s["card"], ensure_ascii=False)]
    check("推了「有会话在等你」", len(att) == 1, f"att={len(att)}")
    post({"cli": "grok", "sid": "smoke-1", "status": "needs-you",
          "note": "又来一次", "cwd": "D:\\proj"})
    time.sleep(1.5)
    att = [s for s in fake.sent if "等你" in json.dumps(s["card"], ensure_ascii=False)]
    check("5 分钟内同一会话不重复推", len(att) == 1, f"att={len(att)}")

    print("\n[11] 坏输入不炸服务")
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:8791/hook", data=b"{not json",
            headers={"Content-Type": "application/json"})
        with opener.open(req, timeout=10) as resp:
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code
    check("坏 JSON 返回 400", code == 400, str(code))

    code, body = post({"status": "needs-you"})
    check("缺 cli 返回 400", body.get("error") == "cli required", str(body))

    print("\n[12] hook 事件会过期")
    h.hooks._events["grok|smoke-1"]["at"] = time.time() - (31 * 60)
    h.hooks.prune()
    snap = h.snapshot(force=True)
    hit = [s for s in snap.sessions if s.sid == "smoke-1"]
    check("过期后不再是 needs-you",
          not hit or hit[0].status != "needs-you",
          hit[0].status if hit else "no row")


def test_cwd_lookup() -> None:
    print("\n[13] 回调只带 cli/sid，cwd 回查快照")
    h, _ = make_hub()
    snap = h.snapshot(force=True)
    sample = snap.sessions[0]
    got = h._cwd_of({"cli": sample.cli, "sid": sample.sid})
    check("查到了 cwd", got == sample.cwd, f"{got!r} != {sample.cwd!r}")
    check("查不到就空串", h._cwd_of({"cli": "nope", "sid": "nope"}) == "")


# ------------------------------------------------------------------ 远程续跑

def test_remote() -> None:
    print("\n[14] 远程续跑：表单身份解析 / 卡片结构 / argv 安全边界")
    from feishu_hub import cards, remote

    # --- 表单身份编码/解码（表单按钮不能带 value，身份只能藏在 input 的 name 里）
    for cli, sid in (("grok", "01a0c807-d734-76a3-8ad3-fdb3d94ce2d6"),
                     ("opencode", "ses_3ffc58f44ffe3ESjIR5LkoWMBC")):
        name = cards.ask_input_name(cli, sid)
        got = cards.parse_ask({name: "继续改"})
        check(f"{cli} 身份往返一致", got == (cli, sid, "继续改"), f"{got}")
    check("空表单解出空三元组", cards.parse_ask({}) == ("", "", ""))
    check("空内容也解得出身份", cards.parse_ask({"p__grok__abc": ""}) == ("grok", "abc", ""))

    # --- 详情卡结构：form 必须在卡片根节点下，不能被容器套住
    h, fake = make_hub()
    snap = h.snapshot(force=True)
    sample = next((s for s in snap.sessions if s.sid), None)
    if sample is None:
        check("能拿到样本会话", False, "快照里没有带 sid 的会话")
        return
    turns = remote.read_transcript(sample.cli, sample.sid, 6)
    card = cards.build_detail(sample, turns)
    els = card["body"]["elements"]
    forms = [e for e in els if e.get("tag") == "form"]
    check("详情卡有且只有一个 form", len(forms) == 1, f"{len(forms)} 个")
    check("form 直接挂在 body 下（没被容器套住）", bool(forms))
    if forms:
        sub = forms[0]["elements"]
        inputs = [c for c in sub if c.get("tag") == "input"]
        submits = [c for c in sub if c.get("form_action_type") == "submit"]
        check("form 里有 input", len(inputs) == 1, f"{len(inputs)} 个")
        check("form 里有提交按钮", len(submits) == 1, f"{len(submits)} 个")
        # Card 2.0 用 form_action_type；1.0 的 action_type: form_submit 是错的
        check("提交按钮不用 action_type（那是 1.0 的写法）",
              all("action_type" not in c for c in submits))
        if inputs:
            check("input 的 name 带得上 cli/sid",
                  cards.parse_ask({inputs[0]["name"]: "x"})[:2] == (sample.cli, sample.sid))
    size = cards.card_size_kb(card)
    check("详情卡不超 30 KB", size < 30, f"{size:.1f} KB")
    check("详情卡是 schema 2.0", card.get("schema") == "2.0")

    # --- 结果卡：飞书限 30 KB **字节**，中文一个字 3 字节，
    #     所以必须按字节截断。只按字符截会爆三倍。
    for label, big in (("中文 4 万字", "字" * 40000), ("ASCII 4 万字符", "x" * 40000)):
        rc = cards.build_result(sample, "继续", True, big)
        size = cards.card_size_kb(rc)
        check(f"超长输出不爆 30 KB（{label}）", size < 30, f"{size:.1f} KB")
    # 详情卡同样按字节截断（正文可能全是中文）
    long_turns = [remote.Turn("assistant", "中文字" * 3000) for _ in range(10)]
    dc = cards.build_detail(sample, long_turns)
    dsize = cards.card_size_kb(dc)
    check("长正文详情卡不爆 30 KB", dsize < 30, f"{dsize:.1f} KB")

    # --- argv 安全边界（**不能**真跑，只拼不执行）
    cwd = sample.cwd or tempfile.gettempdir()
    if not os.path.isdir(cwd):
        cwd = tempfile.gettempdir()
    for bad in ("bad id; rm -rf /", "", None, "x" * 200):
        try:
            remote.build_argv("grok", bad, cwd, "hi")
            check(f"非法 sid 被拦下: {str(bad)[:18]!r}", False, "竟然通过了")
        except remote.RemoteError:
            check(f"非法 sid 被拦下: {str(bad)[:18]!r}", True)
    for bad_prompt in ("", "   ", "x" * 5000):
        try:
            remote.build_argv("grok", "abc-123", cwd, bad_prompt)
            check(f"非法 prompt 被拦下: {bad_prompt[:12]!r}", False, "竟然通过了")
        except remote.RemoteError:
            check(f"非法 prompt 被拦下: {bad_prompt[:12]!r}", True)
    try:
        remote.build_argv("grok", "abc-123", os.path.join(tempfile.gettempdir(), "肯定不存在-xyz"), "hi")
        check("不存在的目录被拦下", False, "竟然通过了")
    except remote.RemoteError:
        check("不存在的目录被拦下", True)

    # 关键：prompt 里的 shell 元字符必须原样当成一个 argv 元素，不能被解释
    argv = remote.build_argv("grok", "abc-123", cwd, 'hello; rm -rf / && echo "pwned"')
    check("prompt 里带注入字符仍是单个 argv 元素",
          argv[-1] == 'hello; rm -rf / && echo "pwned"', f"{argv[-1]!r}")
    check("argv 里没有 shell 分隔符被拆开",
          all(a != "&&" and a != ";" for a in argv))

    # --- ANSI 清理（终端控制序列在卡片里只能变乱码）
    dirty = "\x1b[32m绿色\x1b[0m\n\n\n下一行\r\n尾"
    clean = remote._clean(dirty)
    check("ANSI 转义被剥掉", "\x1b" not in clean, repr(clean))
    check("连续空行被压掉", "\n\n\n" not in clean, repr(clean))
    check("内容还在", "绿色" in clean and "下一行" in clean, repr(clean))

    # --- 真跑一次子进程，但用**假 CLI** —— 验证 argv→捕获→清洗 这条链路真的通
    #     （不能实测真 agent：又慢又费额度，而且冒烟测试不该联网）
    tmp = tempfile.mkdtemp(prefix="agenthub-fakecli-")
    fake = os.path.join(tmp, "fakecli.cmd")
    with open(fake, "w", encoding="ascii") as fh:
        fh.write("@echo off\r\necho \x1b[32mOK\x1b[0m\r\necho ARGS=%*\r\n")
    real_which = remote._which
    try:
        remote._which = lambda name: fake if name == "grok" else None
        ok, out = remote.headless_resume("grok", "abc-123", cwd, "继续改", timeout=30)
        check("假 CLI 跑通并判定成功", ok, out[:120])
        check("输出里 ANSI 已被清掉", "\x1b" not in out, repr(out[:80]))
        check("输出带回了真实内容", "OK" in out and "ARGS=" in out, repr(out[:120]))
        # prompt 原样传到了子进程（没被 shell 吃掉引号/分号）
        ok2, out2 = remote.headless_resume("grok", "abc-123", cwd, 'hi; rm -rf /', timeout=30)
        check("注入字符串原样进了子进程", "hi; rm -rf /" in out2, repr(out2[:160]))
    finally:
        remote._which = real_which
        shutil.rmtree(tmp, ignore_errors=True)

    # --- 各家 argv 的必备参数（都是踩过坑才加上的，钉住别再被删掉）
    codex_argv = remote.build_argv("codex", "abc-123", cwd, "继续")
    # 不加这个，只要会话目录不是 git 仓库，codex 1 秒内直接退出：
    # `Not inside a trusted directory and --skip-git-repo-check was not specified.`
    # 我们是回到一场**已存在**的会话，要求它是 git 仓库毫无道理。
    check("codex argv 带 --skip-git-repo-check",
          "--skip-git-repo-check" in codex_argv, f"{codex_argv}")
    check("codex 用的是 exec resume 子命令",
          codex_argv[1:3] == ["exec", "resume"], f"{codex_argv[1:3]}")
    # 放行开关必须排在 resume 之前，排后面会被 codex 当成 prompt 的一部分
    bypass = remote.build_argv("codex", "abc-123", cwd, "继续", auto_approve=True)
    check("codex 的放行开关排在 resume 之前",
          bypass.index("--dangerously-bypass-approvals-and-sandbox") < bypass.index("resume"),
          f"{bypass}")
    check("grok 的放行开关在子命令之前",
          remote.build_argv("grok", "abc-123", cwd, "继续", auto_approve=True)[1] == "--always-approve")

    # --- 无头续跑必须关掉 stdin。
    #     不关的话子进程继承我们的 stdin 并**等输入**，`grok -r ... -p ...` 会零输出挂死
    #     —— 会被误判成「grok 不支持无头续跑」。这个坑真实卡了整整一轮排查。
    seen: dict = {}

    class _FakeSub:
        DEVNULL = subprocess.DEVNULL

        class TimeoutExpired(Exception):
            pass

        @staticmethod
        def run(argv, **kw):
            seen.clear()
            seen.update(kw)

            class _R:
                returncode = 0
                stdout = b"OK"
                stderr = b""
            return _R()

    real_sub = remote.subprocess
    remote.subprocess = _FakeSub
    try:
        remote.headless_resume("grok", "abc-123", cwd, "继续", timeout=5)
    finally:
        remote.subprocess = real_sub
    check("无头续跑关掉了 stdin（不关 grok 会等输入挂死）",
          seen.get("stdin") == subprocess.DEVNULL, repr(seen.get("stdin")))
    check("无头续跑传了超时", seen.get("timeout") == 5, repr(seen.get("timeout")))
    check("无头续跑禁了彩色输出（少一堆转义序列）",
          (seen.get("env") or {}).get("NO_COLOR") == "1", repr((seen.get("env") or {}).get("NO_COLOR")))

    # --- 真跑一次子进程，但用**假 CLI** —— 验证 argv→捕获→清洗 这条链路真的通
    #     （不能实测真 agent：又慢又费额度，而且冒烟测试不该联网）
    tmp2 = tempfile.mkdtemp(prefix="agenthub-fakecli2-")
    # 这个假 CLI 会**读一行 stdin**。stdin 没关的话它会一直等，
    # 于是 headless_resume 超时 —— 正好当上面那条断言的活体对照。
    blocking = os.path.join(tmp2, "blocking.cmd")
    with open(blocking, "w", encoding="ascii") as fh:
        fh.write("@echo off\r\nset /p X=\r\necho GOT=%X%\r\n")
    real_which2 = remote._which
    try:
        remote._which = lambda name: blocking if name == "grok" else None
        ok3, out3 = remote.headless_resume("grok", "abc-123", cwd, "继续", timeout=20)
        check("假 CLI 读 stdin 时不会挂死（因为 stdin 已关）", ok3, out3[:120])
    finally:
        remote._which = real_which2
        shutil.rmtree(tmp2, ignore_errors=True)

    # --- 会话体量提示：大会话恢复是**分钟级**的（实测 1.5 MB 的会话 10 分钟没回来），
    #     必须在点按钮之前就说清楚，否则用户以为程序卡死了。
    check("小会话不提示体量", remote.size_hint(10 * 1024) == "", repr(remote.size_hint(10 * 1024)))
    check("中等会话提示「偏大」", "偏大" in remote.size_hint(remote.HEAVY_BYTES + 1))
    check("超大会话提示「很大」", "很大" in remote.size_hint(remote.HUGE_BYTES + 1))
    check("非法 sid 量不到体量", remote.session_size("grok", "../etc/passwd") == 0)
    gs = next((x for x in snap.sessions if x.cli == "grok" and x.sid), None)
    if gs:
        n = remote.session_size("grok", gs.sid)
        check("能量到 grok 会话体量", n > 0, f"{n} 字节")

    # --- 详情卡带体量提示时也不能爆
    dc2 = cards.build_detail(sample, turns, hint=remote.size_hint(remote.HUGE_BYTES + 1))
    check("详情卡带上了体量提示",
          "很大" in json.dumps(dc2, ensure_ascii=False))
    check("带提示的详情卡仍不超 30 KB", cards.card_size_kb(dc2) < 30, f"{cards.card_size_kb(dc2):.1f} KB")

    # --- 结果卡要写上耗时（等了几分钟得让用户知道这是正常的）
    txt = json.dumps(cards.build_result(sample, "继续", True, "好了", secs=185), ensure_ascii=False)
    check("结果卡写上了耗时", "3 分 5 秒" in txt, txt[-260:])
    check("耗时短就按秒显示",
          "42 秒" in json.dumps(cards.build_result(sample, "继续", True, "好了", secs=42),
                                ensure_ascii=False))
    check("没耗时就不显示",
          "耗时" not in json.dumps(cards.build_result(sample, "继续", True, "好了"),
                                   ensure_ascii=False))


# ------------------------------------------------------------------ 多维表格

class _Resp:
    def __init__(self, data=None, code=0, msg="ok"):
        self.data = data
        self.code = code
        self.msg = msg

    def success(self):
        return self.code == 0


class _Obj:
    """把 dict 包成属性对象，模拟 SDK 的响应体。"""

    def __init__(self, **kw):
        self.__dict__.update(kw)


class FakeBitable:
    """多维表格的假服务端。记录所有写入，用来验证「只推变化」的幂等逻辑。

    这块逻辑写错的话，343 行会被反复插成双份、三份 —— 而且不会报错，
    只会在表里慢慢堆垃圾。所以必须离线测。
    """

    def __init__(self):
        self.rows: dict[str, dict] = {}      # record_id → fields
        self.calls = {"create": 0, "update": 0, "delete": 0, "list": 0}
        self._seq = 0
        self._fields: dict[str, list[str]] = {}

        outer = self

        class _Record:
            def batch_create(self, req):
                outer.calls["create"] += 1
                out = []
                for r in req.request_body.records:
                    outer._seq += 1
                    rid = f"rec{outer._seq:04d}"
                    outer.rows[rid] = dict(r.fields)
                    out.append(_Obj(record_id=rid, fields=r.fields))
                return _Resp(_Obj(records=out))

            def batch_update(self, req):
                outer.calls["update"] += 1
                for r in req.request_body.records:
                    outer.rows[r.record_id] = dict(r.fields)
                return _Resp(_Obj(records=list(req.request_body.records)))

            def batch_delete(self, req):
                outer.calls["delete"] += 1
                for rid in req.request_body.records:
                    outer.rows.pop(rid, None)
                return _Resp(_Obj())

            def list(self, req):
                outer.calls["list"] += 1
                items = [
                    _Obj(record_id=rid, fields=f) for rid, f in outer.rows.items()
                ]
                return _Resp(_Obj(items=items, has_more=False, page_token=""))

        class _Table:
            def create(self, req):
                name = req.request_body.table.name
                outer._fields[name] = [
                    f.field_name for f in (req.request_body.table.fields or [])
                ]
                return _Resp(_Obj(table_id="tblFAKE"))

            def list(self, req):
                return _Resp(_Obj(items=[]))

        self._record = _Record()
        self._table = _Table()

    # 模拟 client.bitable.v1.xxx 的嵌套访问
    @property
    def bitable(self):
        outer = self

        class _V1:
            app_table = outer._table
            app_table_record = outer._record

        class _B:
            v1 = _V1()

        class _Root:
            bitable = _B()

        return _Root().bitable


def _fake_sessions(n: int):
    from feishu_hub.state import Session

    out = []
    for i in range(n):
        out.append(Session(
            cli="codex", cli_label="Codex", sid=f"sid-{i:03d}",
            title=f"会话 {i}", cwd=f"D:\\proj{i % 3}", last_ts=1_790_000_000 + i * 60,
            start_ts=1_789_000_000, msgs=i, tools=i * 2, tokens=i * 100,
            resumable=True, cmd=f"codex resume sid-{i:03d}", archived=False,
            status="ended",
        ))
    return out


def test_bitable_sync() -> None:
    print("\n[15] 多维表格：建表与字段定义")
    from feishu_hub import bitable as bt

    fake = FakeBitable()
    tmp = tempfile.mkdtemp(prefix="bitable-")
    sync = bt.BitableSync(fake, "bascnFAKE", "", os.path.join(tmp, "state.json"))
    tid = sync.ensure_table()
    check("建了表", tid == "tblFAKE", str(tid))
    cols = fake._fields.get(bt.TABLE_NAME, [])
    check(f"建了 {len(bt.TABLE_FIELDS)} 列", len(cols) == len(bt.TABLE_FIELDS), str(len(cols)))
    check("第一列是「标题」（主字段）", cols[0] == "标题", str(cols[:1]))
    check("含单选「状态」", "状态" in cols)
    check("含日期「最后活动」", "最后活动" in cols)
    check("含「会话ID」（做身份用）", "会话ID" in cols)

    print("\n[16] 首次同步 + 幂等（这块写错会把行插成双份）")
    sessions = _fake_sessions(25)
    st = sync.sync(sessions)
    check("首次全部新增", st["create"] == 25, str(st))
    check("没有更新", st["update"] == 0, str(st))
    check("表里 25 行", len(fake.rows) == 25, str(len(fake.rows)))

    st = sync.sync(sessions)
    check("原样再同步一次：0 新增", st["create"] == 0, str(st))
    check("原样再同步一次：0 更新（幂等）", st["update"] == 0, str(st))
    check("原样再同步一次：25 未变", st["unchanged"] == 25, str(st))
    check("表里还是 25 行（没插双份）", len(fake.rows) == 25, str(len(fake.rows)))

    print("\n[17] 只推变化过的行")
    sessions[3].status = "needs-you"
    sessions[3].hook_note = "在等你确认"
    st = sync.sync(sessions)
    check("恰好 1 行更新", st["update"] == 1, str(st))
    check("0 行新增", st["create"] == 0, str(st))
    rid = next(k for k, v in fake.rows.items() if v.get("会话ID") == "sid-003")
    check("状态写对了", fake.rows[rid]["状态"] == "等你确认", str(fake.rows[rid]["状态"]))
    check("备注写对了", fake.rows[rid]["备注"] == "在等你确认")
    check("其他 24 行没动", st["unchanged"] == 24, str(st))

    print("\n[18] 会话消失 → 删行（只有 hook 合成行会消失）")
    st = sync.sync(sessions[:24])
    check("删了 1 行", st["delete"] == 1, str(st))
    check("表里剩 24 行", len(fake.rows) == 24, str(len(fake.rows)))

    print("\n[19] 无 sid 的合成行不进表（没有稳定身份）")
    from feishu_hub.state import Session

    ghost = Session(cli="grok", cli_label="Grok Build", sid="", title="刚开的会话",
                    cwd="D:\\x", last_ts=time.time(), start_ts=time.time(),
                    msgs=0, tools=0, tokens=0, resumable=False, cmd="",
                    archived=False, status="needs-you")
    st = sync.sync(sessions[:24] + [ghost])
    check("合成行被跳过", st["total"] == 24, str(st))
    check("没有为它新增行", st["create"] == 0, str(st))

    print("\n[20] 本地索引丢了 → 从表里读回来，不重插")
    sync2 = bt.BitableSync(fake, "bascnFAKE", "tblFAKE", os.path.join(tmp, "gone.json"))
    check("新实例本地索引是空的", sync2._records == {})
    n = sync2.rebuild_index()
    check(f"读回 {n} 行已有记录", n == 24, str(n))
    st = sync2.sync(sessions[:24])
    check("重建后不重插（0 新增）", st["create"] == 0, str(st))
    check("也不误删（0 删除）", st["delete"] == 0, str(st))

    print("\n[21] 超过单批上限要分批")
    big = _fake_sessions(bt.CHUNK + 37)
    tmp2 = tempfile.mkdtemp(prefix="bitable2-")
    sync3 = bt.BitableSync(fake, "bascnFAKE", "tblFAKE", os.path.join(tmp2, "s.json"))
    st = sync3.sync(big)
    check(f"{len(big)} 行全部写入", st["create"] == len(big), str(st))
    check(f"分了 {2} 批（CHUNK={bt.CHUNK}）", fake.calls["create"] >= 2, str(fake.calls))

    print("\n[22] 字段值的类型必须对")
    s = _fake_sessions(1)[0]
    f = bt.session_to_fields(s)
    check("日期是毫秒时间戳（13 位）",
          f["最后活动"] > 10**12, str(f["最后活动"]))
    check("数字字段是 int", isinstance(f["消息数"], int), type(f["消息数"]).__name__)
    check("复选框是 bool", isinstance(f["可恢复"], bool), type(f["可恢复"]).__name__)
    check("单选「状态」在预设选项里",
          f["状态"] in bt.STATUS_OPTIONS, f["状态"])
    check("单选「CLI」在预设选项里",
          f["CLI"] in bt.CLI_OPTIONS, f["CLI"])

    print("\n[23] 未知 CLI 落到「其他」，不会把同步搞挂")
    from feishu_hub.state import Session as S2

    weird = S2(cli="newcli", cli_label="某新出的 CLI", sid="x1", title="t", cwd="D:\\y",
               last_ts=time.time(), start_ts=time.time(), msgs=1, tools=1, tokens=1,
               resumable=True, cmd="newcli -r x1", archived=False, status="ended")
    fw = bt.session_to_fields(weird)
    check("映射到「其他」", fw["CLI"] == "其他", fw["CLI"])
    check("部分匹配也能认（如 'Claude Code (beta)'）",
          bt._option_names("Claude Code (beta)") == "Claude Code",
          bt._option_names("Claude Code (beta)"))

    print("\n[24] 状态映射覆盖全部状态")
    for key in state_mod.STATUS_ORDER:
        check(f"{key:<10} → 有对应选项",
              key in bt.STATUS_OPTION_OF
              and bt.STATUS_OPTION_OF[key] in bt.STATUS_OPTIONS,
              str(bt.STATUS_OPTION_OF.get(key)))


def test_feed_channel() -> None:
    """外部事件流通道：事件流水状态机 + 快照合并 + 卡片按钮。

    这块的价值在于 `blocked` —— 对端已经在记「哪场在等你确认」了，
    不接它就是白扔。用一个临时 events.jsonl 把六种 kind 全过一遍。
    """
    import json as _json

    from feishu_hub import feed as fd
    from feishu_hub import state as st_mod

    print("\n[25] 事件流水：六种 kind 都要认")
    tmp = tempfile.mkdtemp(prefix="feed-")
    log = os.path.join(tmp, "events.jsonl")
    base = int(time.time() * 1000) - 60_000

    def line(kind, adapter="grok", detail="", title="", at=None):
        return _json.dumps({
            "id": f"e-{kind}-{at}", "kind": kind, "adapterId": adapter,
            "occurredAt": at if at is not None else base,
            "title": title, "detail": detail,
        }, ensure_ascii=False)

    ws = "D:\\proj\\alpha"
    with open(log, "w", encoding="utf-8") as fh:
        fh.write(line("session_start", "grok", ws, "Grok Build", base) + "\n")
        fh.write(line("tool_call", "grok", "", "grep", base + 1000) + "\n")
        fh.write(line("blocked", "grok", "", "要删 3 个文件，确认？", base + 2000) + "\n")

    w = fd.EventWatcher(log)
    w.poll()
    runs = w.runs
    check("认出一场会话", len(runs) == 1, str(len(runs)))
    run = list(runs.values())[0]
    check("blocked → needs-you", run.effective_status() == "needs-you", run.effective_status())
    check("记下了 blocked 的说明", "删" in run.note, run.note)
    check("工具调用数统计到了", run.tool_calls == 1, str(run.tool_calls))

    print("\n[26] approved / completed / session_exit 的状态流转")
    with open(log, "a", encoding="utf-8") as fh:
        fh.write(line("approved", "grok", "", "", base + 3000) + "\n")
        fh.write(line("completed", "grok", "", "turn completed", base + 4000) + "\n")
        fh.write(line("session_exit", "grok", "exit code 0", "Grok Build", base + 5000) + "\n")
    w.poll()
    run = list(w.runs.values())[0]
    check("approved 后不再是 needs-you", run.status != "needs-you", run.status)
    check("session_exit 标记为已退出", run.exited)
    check("已退出 → ended", run.effective_status() == "ended", run.effective_status())

    print("\n[27] 增量读：第二次只读新增的行")
    before = w._offset
    with open(log, "a", encoding="utf-8") as fh:
        fh.write(line("session_start", "kimi", "D:\\proj\\beta", "Kimi", base + 6000) + "\n")
    w.poll()
    check("偏移量前进了", w._offset > before, f"{before} -> {w._offset}")
    check("新会话被认出来了", len(w.runs) == 2, str(len(w.runs)))
    check("kimi 的 cli 名映射正确",
          any(r.cli == "kimi" for r in w.runs.values()),
          str([r.cli for r in w.runs.values()]))

    print("\n[28] 文件被压缩重写（变小）→ 从头重读，不丢状态机")
    with open(log, "w", encoding="utf-8") as fh:
        fh.write(line("session_start", "codex", ws, "Codex", base + 7000) + "\n")
    w.poll()
    check("重读后只剩新文件里的那一场", len(w.runs) == 1, str(len(w.runs)))
    check("是 codex 那一场", list(w.runs.values())[0].cli == "codex",
          list(w.runs.values())[0].cli)

    print("\n[29] 坏行不能把解析搞崩（断电截断是常态）")
    with open(log, "a", encoding="utf-8") as fh:
        fh.write('{"kind": "tool_call", "adapterId": "grok", "occurre\n')  # 截断
        fh.write("not json at all\n")
        fh.write(line("tool_call", "codex", "", "bash", base + 8000) + "\n")
    ok = w.poll()
    check("坏行被跳过，没抛异常", ok is True or w.ok, str(w.last_error))
    check("坏行后面的正常行照样读到了",
          list(w.runs.values())[0].tool_calls == 1,
          str(list(w.runs.values())[0].tool_calls))

    print("\n[30] 事件流状态并进快照：优先级在进程/文件时间之上")
    from feishu_hub.state import HookStore, Session

    now = time.time()
    run = fd.Run(cli="grok", workspace=ws, started_at=now - 600, last_at=now - 10,
                 status="needs-you", note="要删 3 个文件")
    fstate = fd.FeedState(runs={run.key: run}, events_ok=True)
    sessions = [Session(
        cli="grok", cli_label="Grok Build", sid="g-1", title="旧会话", cwd=ws,
        last_ts=now - 86400 * 30, start_ts=now - 86400 * 40, msgs=3, tools=1,
        tokens=10, resumable=True, cmd="grok -r g-1", archived=False,
    )]
    import feishu_hub.state as st
    orig = st.build_records
    try:
        st.build_records = lambda *a, **k: ([{
            "cli": "grok", "cliLabel": "Grok Build", "id": "g-1", "title": "旧会话",
            "cwd": ws, "start": "2026-01-01 00:00:00", "last": "2026-01-01 00:00:00",
            "msgs": 3, "tools": 1, "tokens": 10, "resumable": True,
            "cmd": "grok -r g-1", "archived": False,
        }], {})
        snap = st.build_snapshot(HookStore(), fstate)
    finally:
        st.build_records = orig
    hit = [s for s in snap.sessions if s.sid == "g-1"]
    check("会话被事件流状态接管", hit and hit[0].status == "needs-you",
          str(hit[0].status if hit else "none"))
    check("事件流的说明带过来了", hit and "删" in hit[0].feed_note, str(hit))
    check("最后活动时间跟着事件流走（不再显示 1 个月前）",
          hit and hit[0].last_ts > now - 3600, str(hit[0].last_ts if hit else 0))

    print("\n[31] 事件流里有、会话库里没有的 → 补成一行，不能漏掉「等你确认」")
    run2 = fd.Run(cli="grok", workspace="D:\\proj\\gamma", started_at=now - 60,
                  last_at=now - 5, status="needs-you", note="等你批准")
    fstate2 = fd.FeedState(runs={run2.key: run2}, events_ok=True)
    try:
        st.build_records = lambda *a, **k: ([], {})
        snap2 = st.build_snapshot(HookStore(), fstate2)
    finally:
        st.build_records = orig
    check("补出一行", snap2.total == 1, str(snap2.total))
    check("状态是 needs-you",
          snap2.sessions and snap2.sessions[0].status == "needs-you",
          str(snap2.sessions[0].status if snap2.sessions else "none"))

    print("\n[32] 过老的事件流 run 不能把「已结束」顶成「在跑」")
    old = fd.Run(cli="grok", workspace=ws, started_at=now - 999999,
                 last_at=now - 999999, status="running")
    fstate3 = fd.FeedState(runs={old.key: old}, events_ok=True)
    try:
        st.build_records = lambda *a, **k: ([{
            "cli": "grok", "cliLabel": "Grok Build", "id": "g-1", "title": "旧会话",
            "cwd": ws, "start": "2026-01-01 00:00:00", "last": "2026-01-01 00:00:00",
            "msgs": 3, "tools": 1, "tokens": 10, "resumable": True,
            "cmd": "grok -r g-1", "archived": False,
        }], {})
        snap3 = st.build_snapshot(HookStore(), fstate3)
    finally:
        st.build_records = orig
    check("僵尸 run 被丢掉，仍是 ended",
          snap3.sessions and snap3.sessions[0].status == "ended",
          str(snap3.sessions[0].status if snap3.sessions else "none"))

    print("\n[33] 卡片：可反向操作的会话才出现「批准/拒绝」")
    s_ok = Session(cli="opencode", cli_label="opencode", sid="oc-1", title="会", cwd=ws,
                   last_ts=now, start_ts=now, msgs=1, tools=0, tokens=0,
                   resumable=True, cmd="", archived=False, status="needs-you",
                   bridge_id="ses-1", controllable=True)
    s_no = Session(cli="grok", cli_label="Grok Build", sid="g-1", title="会", cwd=ws,
                   last_ts=now, start_ts=now, msgs=1, tools=0, tokens=0,
                   resumable=True, cmd="", archived=False, status="needs-you")
    snapc = st.Snapshot(sessions=[s_ok, s_no], generated_at=now,
                        counts_by_cli={}, counts_by_status={}, live_procs=0)
    card = cards.build_panel(snapc, "needs-you", 0, approve=True)
    text = _json.dumps(card, ensure_ascii=False)
    check("开了 approve：可控会话有「批准」按钮", "批准" in text)
    check("不可控会话没有「批准」按钮", text.count("批准") == 1, str(text.count("批准")))

    # 默认不开 —— 摆一个点了只会弹「未开启」的按钮，比不摆更招人烦
    card_off = _json.dumps(cards.build_panel(snapc, "needs-you", 0), ensure_ascii=False)
    check("默认不开 approve：连可控会话也不摆按钮", "批准" not in card_off)

    print("\n[34] 表单：投喂（s__）和无头续跑（p__）要能分开")
    check("send 表单认得出",
          cards.parse_form({cards.send_input_name("ses-1"): "继续"}) ==
          ("send", "", "ses-1", "继续"))
    check("ask 表单认得出",
          cards.parse_form({cards.ask_input_name("grok", "g-1"): "继续"}) ==
          ("ask", "grok", "g-1", "继续"))
    check("parse_ask 只认 ask（向后兼容）",
          cards.parse_ask({cards.send_input_name("ses-1"): "x"}) == ("", "", ""))

    print("\n[35] 没配置 / 对端没开 → 全部降级，不抛异常")
    fresh = fd.FeedLink()
    check("默认没配置：整条通道是关的", fresh.enabled is False, str(fresh.enabled))
    check("默认没配置：事件流水不算已配置", fresh.watcher.configured is False)
    check("默认没配置：控制管道不算已配置", fresh.control.configured is False)
    check("默认没配置：poll() 不发一次 IO 就返回空",
          fresh.poll().runs == {} and fresh.watcher._offset == 0)

    link = fd.FeedLink()
    link.watcher.path = os.path.join(tmp, "不存在的文件.jsonl")
    st4 = link.poll(use_control=False)
    check("事件流水不可用也不崩", st4.events_ok is False)
    check("runs 是空的", st4.runs == {}, str(len(st4.runs)))
    try:
        st4b = link.poll(use_control=True)
        check("Bridge 拿不到也照常返回", isinstance(st4b, fd.FeedState))
    except Exception as exc:                                   # noqa: BLE001
        check("Bridge 拿不到也照常返回", False, str(exc))
    shutil.rmtree(tmp, ignore_errors=True)


def test_session_store() -> None:
    print("\n[36] 会话索引：时间解析 / 显示宽度 / 检索 / 消歧")
    from feishu_hub import groksessions as gs

    # --- 纳秒时间戳。grok 写的是 9 位小数，fromisoformat 在旧版本上会直接炸。
    ts = gs.parse_iso("2026-09-22T13:42:17.343922400Z")
    expect = datetime(2026, 9, 22, 13, 42, 17, 343922, tzinfo=timezone.utc).timestamp()
    check("纳秒 ISO 能解析", abs(ts - expect) < 0.01, f"{ts} vs {expect}")
    check("空串得 0", gs.parse_iso("") == 0.0)
    check("垃圾串得 0 不抛", gs.parse_iso("不是时间") == 0.0)
    check("无 Z 也当 UTC",
          abs(gs.parse_iso("2026-09-22T13:42:17") -
              datetime(2026, 9, 22, 13, 42, 17, tzinfo=timezone.utc).timestamp()) < 0.01)

    # --- 显示宽度：中文算 2 列，否则中文列会整体歪掉
    check("中文算 2 宽", gs._disp_width("中文") == 4)
    check("ASCII 算 1 宽", gs._disp_width("abc") == 3)
    check("混排宽度", gs._disp_width("a中b") == 4)
    check("不超宽就原样返回", gs.trunc_disp("短", 10) == "短")
    cut = gs.trunc_disp("中" * 20, 11)
    check("截断后不超宽", gs._disp_width(cut) <= 11, f"{gs._disp_width(cut)}")
    check("截断带省略号", cut.endswith("…"))

    # --- 检索：空格分隔 = AND
    def mk(sid, title, recap="", cwd="D:\\x"):
        return gs.GrokSession(sid=sid, cwd=cwd, sdir="", title=title, recap=recap)

    rows = [mk("01a", "云函数部署", "把 21 个云函数传上去了"),
            mk("01b", "首页还原", "改了导航栏"),
            mk("01c", "云函数调试", "登录失败")]
    check("单词命中 2 场", len(gs.search(rows, "云函数")) == 2)
    check("AND 语义只留 1 场", len(gs.search(rows, "云函数 部署")) == 1)
    check("搜 recap 也能中", len(gs.search(rows, "导航栏")) == 1)
    check("搜路径能中", len(gs.search(rows, "D:\\x")) == 3)
    check("大小写不敏感", len(gs.search([mk("01d", "Fix Bug", cwd="D:\\A")], "fix")) == 1)
    check("空查询返回全部", len(gs.search(rows, "")) == 3)
    check("搜不到就是空", gs.search(rows, "不存在的词") == [])

    # --- 消歧：认不出来时必须返回 None，不能瞎猜（猜错就是在错会话上执行续跑）
    check("完整 id 直认", gs.resolve(rows, "01a").sid == "01a")
    check("id 前缀直认", gs.resolve(rows, "01b").sid == "01b")
    check("标题唯一就直认", gs.resolve(rows, "首页还原").sid == "01b")
    check("标题歧义返回 None", gs.resolve(rows, "云函数") is None)
    check("前缀歧义返回 None", gs.resolve(rows, "01") is None)
    check("UUID 形状但不存在 → None", gs.resolve(
        rows, "00000000-0000-0000-0000-000000000000") is None)
    check("歧义时列得出候选", len(gs.ambiguous(rows, "云函数")) == 2)

    print("\n[37] git 状态：纯读文件（不 spawn git），含 worktree / packed-refs")
    tmp = tempfile.mkdtemp(prefix="gbp-git-")
    try:
        sha = "a" * 40
        repo = os.path.join(tmp, "repo")
        os.makedirs(os.path.join(repo, ".git", "refs", "heads"))
        with open(os.path.join(repo, ".git", "HEAD"), "w", encoding="utf-8") as fh:
            fh.write("ref: refs/heads/main\n")
        with open(os.path.join(repo, ".git", "refs", "heads", "main"), "w",
                  encoding="utf-8") as fh:
            fh.write(sha + "\n")
        check("读出 loose ref", gs.read_git_head(repo) == (sha, "main"))

        # packed-refs：clone 过的大仓库 ref 都是打包的，loose 文件不存在
        repo2 = os.path.join(tmp, "packed")
        os.makedirs(os.path.join(repo2, ".git"))
        with open(os.path.join(repo2, ".git", "HEAD"), "w", encoding="utf-8") as fh:
            fh.write("ref: refs/heads/dev\n")
        with open(os.path.join(repo2, ".git", "packed-refs"), "w",
                  encoding="utf-8") as fh:
            fh.write("# pack-refs with: peeled fully-peeled sorted\n")
            fh.write(f"{'b' * 40} refs/heads/dev\n")
            fh.write(f"{'c' * 40} refs/heads/main\n")
        check("读出 packed ref", gs.read_git_head(repo2) == ("b" * 40, "dev"))

        # worktree / submodule：`.git` 是文件，内容是 `gitdir: <路径>`
        wt = os.path.join(tmp, "wt")
        os.makedirs(wt)
        real = os.path.join(tmp, "real-git")
        os.makedirs(os.path.join(real, "refs", "heads"))
        with open(os.path.join(real, "HEAD"), "w", encoding="utf-8") as fh:
            fh.write("ref: refs/heads/feat\n")
        with open(os.path.join(real, "refs", "heads", "feat"), "w",
                  encoding="utf-8") as fh:
            fh.write("d" * 40 + "\n")
        with open(os.path.join(wt, ".git"), "w", encoding="utf-8") as fh:
            fh.write(f"gitdir: {real}\n")
        check("认出 worktree 的 gitdir 文件",
              gs.read_git_head(wt) == ("d" * 40, "feat"))

        # detached HEAD
        det = os.path.join(tmp, "det")
        os.makedirs(os.path.join(det, ".git"))
        with open(os.path.join(det, ".git", "HEAD"), "w", encoding="utf-8") as fh:
            fh.write("e" * 40 + "\n")
        check("detached HEAD 读出无分支", gs.read_git_head(det) == ("e" * 40, ""))

        check("不是仓库 → 空", gs.read_git_head(tmp) == ("", ""))
        check("目录不存在 → 空", gs.read_git_head(os.path.join(tmp, "没这个")) == ("", ""))

        print("\n[38] 代码漂移：会话停在哪个提交 vs 仓库现在走到哪")
        live_repo = os.path.join(tmp, "live")
        os.makedirs(os.path.join(live_repo, ".git", "refs", "heads"))
        with open(os.path.join(live_repo, ".git", "HEAD"), "w", encoding="utf-8") as fh:
            fh.write("ref: refs/heads/main\n")
        with open(os.path.join(live_repo, ".git", "refs", "heads", "main"), "w",
                  encoding="utf-8") as fh:
            fh.write("9" * 40 + "\n")

        clean = gs.GrokSession(sid="x", cwd=live_repo, sdir="", git_root=live_repo,
                               head_commit="9" * 40, head_branch="main")
        check("同提交 → clean", gs.drift(clean).state == "clean", gs.drift(clean).state)
        check("clean 是 ok 的", gs.drift(clean).ok)

        moved = gs.GrokSession(sid="x", cwd=live_repo, sdir="", git_root=live_repo,
                               head_commit="7" * 40, head_branch="main")
        d = gs.drift(moved)
        check("不同提交 → moved", d.state == "moved")
        check("moved 带上两个提交", d.was == "7" * 40 and d.now == "9" * 40)
        check("moved 不是 ok", not d.ok)

        gone = gs.GrokSession(sid="x", cwd=os.path.join(tmp, "已删"), sdir="",
                              git_root=os.path.join(tmp, "已删"), head_commit="7" * 40)
        check("仓库被删 → missing-repo", gs.drift(gone).state == "missing-repo")

        nogit = gs.GrokSession(sid="x", cwd=tmp, sdir="", git_root=tmp,
                               head_commit="7" * 40)
        check("目录在但不是仓库 → no-repo", gs.drift(nogit).state == "no-repo")

        unknown = gs.GrokSession(sid="x", cwd=tmp, sdir="")
        check("没记录提交 → unknown", gs.drift(unknown).state == "unknown")

        print("\n[39] 恢复体检：跑不了 / 要等多久 / 正在跑")
        empty_body = gs.GrokSession(sid="01a", cwd=live_repo, sdir="", body_bytes=0,
                                    head_commit="9" * 40)
        check("小会话不提示等待", gs.preflight(empty_body).cost_note == "")
        heavy = gs.GrokSession(sid="01a", cwd=live_repo, sdir="",
                               body_bytes=gs.LIGHT_BYTES,
                               head_commit="9" * 40)
        check("400 KB 起提示", "几分钟" in gs.preflight(heavy).cost_note)
        huge = gs.GrokSession(sid="01a", cwd=live_repo, sdir="",
                              body_bytes=gs.HEAVY_BYTES,
                              head_commit="9" * 40)
        check("1 MB 起提示十几分钟", "十几分钟" in gs.preflight(huge).cost_note)
        check("体量分档", (heavy.weight, huge.weight) == ("heavy", "huge"))

        no_cwd = gs.GrokSession(sid="01a", cwd=os.path.join(tmp, "没这个"), sdir="")
        check("目录不存在 → 不可跑", not gs.preflight(no_cwd).runnable)
        bad_sid = gs.GrokSession(sid="有 空格/斜杠", cwd=live_repo, sdir="")
        check("非法 sid → 不可跑", not gs.preflight(bad_sid).runnable)

        running = gs.GrokSession(sid="01a", cwd=live_repo, sdir="", live_pid=12345,
                                 head_commit="9" * 40)
        pre = gs.preflight(running)
        check("正在跑也警告", any("正在运行" in w for w in pre.warnings))
        check("正在跑不阻塞（只警告）", pre.runnable)
        moved_pre = gs.preflight(gs.GrokSession(sid="01a", cwd=live_repo, sdir="",
                                                head_commit="7" * 40))
        check("代码漂移进 warnings", any("已经往前走了" in w or "变动" in w
                                        for w in moved_pre.warnings))

        print("\n[40] 恢复命令：argv 数组 + 两条硬约束")
        s = gs.GrokSession(sid="01a0ce08-da0e-76e1-a03b-72a6c9aa66f5",
                           cwd="D:\\微信小程序\\言值顾问", sdir="")
        argv = gs.resume_argv(s)
        check("argc 数组不是字符串", isinstance(argv, list) and all(
            isinstance(x, str) for x in argv))
        check("必须带 --cwd", "--cwd" in argv and s.cwd in argv)
        check("带上 -r 和 sid", "-r" in argv and s.sid in argv)
        check("默认不带 fork", "--fork-session" not in argv)
        check("默认不带 restore-code", "--restore-code" not in argv)

        fargv = gs.resume_argv(s, fork=True, fork_sid="11111111-2222-3333-4444-555555555555")
        check("fork 带 --fork-session", "--fork-session" in fargv)
        check("fork 带 -s 新 id", "-s" in fargv and
              "11111111-2222-3333-4444-555555555555" in fargv)
        try:
            gs.resume_argv(s, fork=True, fork_sid="不是-uuid")
            check("非法 fork id 要报错", False, "没抛异常")
        except ValueError:
            check("非法 fork id 要报错", True)

        # 这条是实测踩出来的：只给 --restore-code 会被 grok 直接拒绝
        #   Error: --restore-code on a remote session requires --worktree
        rargv = gs.resume_argv(s, restore_code=True)
        check("restore-code 自动补 --worktree",
              "--restore-code" in rargv and ("-w" in rargv or "--worktree" in rargv),
              " ".join(rargv))
        check("restore_argv 同款", "-w" in gs.restore_argv(s))

        print("\n[41] 继承：接续提示词 / 新会话 argv")
        src = gs.GrokSession(
            sid="01a0bee1-0298-7583-b41a-7818f5060200", cwd="D:\\微信小程序\\造书成剧",
            sdir="", title="造书成剧缺陷修复", model="grok-4.7", agent="grok-build-plan",
            num_chat_messages=135, body_bytes=gs.HEAVY_BYTES,
            last_turn="贴图话题文案已备好，待发布。",
            recap="把精选选段扩成十四段长原文。",
            git_root="", git_remotes=["https://github.com/dragon43pp/zaoshuchengju.git"],
            head_commit="4" * 40, head_branch="codex/writer-dream-v7")
        p = gs.handoff_prompt(src, ask="把发布流程补完")
        for must in ("造书成剧缺陷修复", "贴图话题文案已备好", "把精选选段扩成十四段",
                     "把发布流程补完", "135 轮对话", "不要修改任何文件"):
            check(f"提示词含「{must[:14]}」", must in p)
        check("提示词带上工作目录", src.cwd in p)
        check("提示词带上会话结束时的提交", "44444444" in p)
        check("没给 ask 时没有「接下来」段",
              "## 接下来要做的" not in gs.handoff_prompt(src))
        check("能不塞 recap", "把精选选段扩成十四段" not in
              gs.handoff_prompt(src, include_recap=False))
        check("能不塞 git", "github.com/dragon43pp" not in
              gs.handoff_prompt(src, include_git=False))
        # 提示词不能太长 —— 接续的意义就是短，长了自己也变成要重放的历史
        check("提示词 < 2000 字（长会话才划算）", len(p) < 2000, f"{len(p)} 字")

        nargv = gs.new_session_argv(src, "接续提示词", model="grok-4.7")
        check("新会话不带 -r", "-r" not in nargv)
        check("新会话带 --cwd", "--cwd" in nargv)
        check("新会话把 prompt 作为独立元素", nargv[-1] == "接续提示词")
        check("新会话能换模型", "--model" in nargv)
        check("fork_sid 是合法 UUID", bool(gs.UUID_RE.match(gs.fork_sid())))

        print("\n[42] 离线 HTML 报告：自包含、转义、不超预算")
        from tools import sessions_html
        import re as _re
        html = sessions_html.render([src, clean, moved])
        check("有 DOCTYPE", html.startswith("<!DOCTYPE html>"))
        # 只查「会真去加载外部东西」的写法。别用 'http://' 做子串判断 ——
        # SVG 的 xmlns="http://www.w3.org/2000/svg" 会被误伤（那不是网络请求）。
        ext = (_re.findall(r'(?:src|href)\s*=\s*["\']https?://', html)
               + _re.findall(r'@import|url\(\s*["\']?https?://', html))
        check("没有外链资源（离线可看）", not ext, str(ext[:2]))
        check("跟随深浅色", "prefers-color-scheme" in html)
        check("中文标题渲染进去了", "造书成剧缺陷修复" in html)
        check("搜索框在", 'id="q"' in html)
        check("珊瑚色只用来点灯", sessions_html.CORAL.lower() in html.lower())
        # XSS：标题里塞标签必须被转义，否则一份本地报告就能变成注入点
        evil = gs.GrokSession(sid="01e", cwd="D:\\x", sdir="",
                              title='<img src=x onerror=alert(1)>')
        evil_html = sessions_html.render([evil])
        check("标题里的 HTML 被转义", "<img src=x" not in evil_html)
        check("实体转义生效", "&lt;img" in evil_html)
        check("报告体积可控", len(html) / 1024 < 400, f"{len(html) / 1024:.0f} KB")

        print("\n[43] 真机只读自检：扫本机会话库（没有就跳过）")
        real = gs.load_all()
        if not real:
            print("  （跳过：本机没有 grok 会话）")
        else:
            check(f"扫到 {len(real)} 场会话", len(real) > 0)
            check("按最近活跃倒序",
                  all(real[i].active_ts >= real[i + 1].active_ts
                      for i in range(len(real) - 1)))
            check("每场都有 sid 和 cwd 至少其一",
                  all(s.sid and (s.cwd is not None) for s in real))
            check("空会话也能读出来不抛",
                  all(s.body_bytes >= 0 for s in real))
            t0 = time.time()
            gs.load_all()
            dt = (time.time() - t0) * 1000
            # `grok sessions list -n 8` 实测 5300 ms，我们这条路必须快到不像话
            check(f"全量扫描 < 500 ms（实测 {dt:.0f} ms）", dt < 500)
            with_live = [s for s in real if s.live]
            print(f"  （本机 {len(real)} 场 · {len(with_live)} 场正在跑 · "
                  f"{len(gs.group_by_project(real))} 个项目）")
            if real[0].recap or real[0].last_turn:
                check("详情渲染得出来", "可以这么用" in gs.render_detail(real[0]))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    print("=" * 68)
    print("Grok Build Center · 离线冒烟测试（不联网、不建飞书应用）")
    print("=" * 68)

    test_snapshot()
    test_panel_publish()
    test_filters()
    test_card_callback()
    test_hook_server()
    test_cwd_lookup()
    test_remote()
    test_bitable_sync()
    test_feed_channel()
    test_session_store()

    print("\n" + "=" * 68)
    print(f"通过 {PASS} · 失败 {FAIL}")
    print("=" * 68)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
