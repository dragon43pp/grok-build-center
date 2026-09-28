#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线体检的四个步骤 —— 命令行和图形前台共用这一份。

以前这四步只活在 `tools/app.py::cmd_check` 里（一屏 print）。加了图形前台之后
就有了第二个调用方，而第二个调用方要的不是「打印」而是「进度 + 统计」。
所以把「干什么」搬到这里，「怎么显示」留给各自的调用方：

    tools/app.py::cmd_check    → 打印成原来那份控制台输出
    feishu_hub/ui.py           → 画进度条、统计卡片

两边的**文字**必须一致（前台里也会原样显示这四步的输出），
所以每一步的文本都从这里出，调用方不要自己拼。

顺序不是随意的：会话库放最前（它是主角，而且最快），历史网页放最后
（它最慢，生成完正好可以直接看）。
"""

from __future__ import annotations

import contextlib
import io
import json
import os
from typing import Callable

# key / 短名（给进度条）/ head（给控制台那行 ==== 标题 ====，两边逐字一致）
STEPS: tuple[dict, ...] = (
    {"key": "sessions", "short": "会话库",  "head": "Grok 会话库（管理 · 继承 · 恢复）"},
    {"key": "feed",     "short": "事件流",  "head": "外部事件流（可选，默认关）"},
    {"key": "snapshot", "short": "本机快照", "head": "本机会话快照（面板上会长什么样）"},
    {"key": "history",  "short": "历史网页", "head": "历史会话网页（生成完自动用浏览器打开）"},
)

TOTAL = len(STEPS)


def head_of(index: int) -> str:
    """第 index 步那行标题（1 起）。控制台和前台都用它，别各写一份。"""
    return f"{index}/{TOTAL}  {STEPS[index - 1]['head']}"


def _capture(fn: Callable, *args, **kwargs) -> tuple[int, str]:
    """把某个 main() 打印的东西收回来。

    为什么要收：图形前台没有控制台，可它又得把同样这几步的输出显示出来
    （「原始输出」那一块）。不收就只能重写一遍打印逻辑，那必然漂。
    """
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = fn(*args, **kwargs)
    return (rc or 0), buf.getvalue().strip("\n")


# ---------------------------------------------------------------- 每一步

def run_sessions() -> dict:
    """1/4 会话库。本机扫 ~/.grok/sessions，不联网、不需要配置。"""
    from . import groksessions as gs

    rows = gs.load_all()
    root = gs.sessions_root()
    if not rows:
        text = f"  没扫到 grok 会话。看一眼 {root} 是不是空的。"
    else:
        text = gs.render_list(rows, limit=15, total=len(rows))
    return {
        "key": "sessions", "ok": True, "text": text, "data": {},
        "note": f"{len(rows)} 场 Grok 会话" if rows else "没扫到会话",
    }


def _cfg_flag(cfg_path: str, key: str, default=False):
    """只从 config.json 里抠一个标量出来。

    为什么不用 hub.Config：hub 头顶着 bitable / feishu 两个模块，它们会 import
    飞书 SDK（5.7 秒）。体检的这一步只是为了决定「那一行显示『已接入』还是
    『未接入』」，不值得为它把整个 SDK 拉起来。
    """
    try:
        with open(cfg_path, encoding="utf-8") as fh:
            return json.load(fh).get(key, default)
    except Exception:
        return default


def run_feed(cfg_path: str = "") -> dict:
    """2/4 外部事件流。没配就直接说「没配」，不是错误。"""
    from . import feed

    argv = ["--config", cfg_path] if cfg_path and os.path.exists(cfg_path) else []
    rc, text = _capture(feed.main, argv)
    enabled = bool(_cfg_flag(cfg_path, "feed_enabled", False)) if cfg_path else False
    return {
        "key": "feed", "ok": rc == 0, "text": text,
        "data": {"enabled": enabled},
        "note": "已接入" if enabled else "未接入（正常）",
    }


def run_snapshot(cfg_path: str = "", progress=None) -> dict:
    """3/4 本机快照 —— 面板上会长什么样。不连飞书，也不 import hub。

    等价于 `hub.main(["--print"])`：未启动的 Hub 里 `_feed` 就是一个空的
    FeedState，所以这里直接调 build_snapshot 得到的是同一份东西，
    但不付那 5.7 秒的飞书 SDK 导入。

    注意：**读会话库的重活其实发生在这里**（build_snapshot 内部要全套记录），
    这是四步里最慢的一步，所以 progress 必须传进来 —— 否则前台那 20 多秒
    会是一片死寂。
    """
    from .state import HookStore, FeedState, build_snapshot, render_table

    hooks = HookStore()
    hooks.prune()
    snap = build_snapshot(hooks, FeedState(), progress=progress)
    return {
        "key": "snapshot", "ok": True, "text": render_table(snap),
        "data": {"total": snap.total, "live": snap.live_procs,
                 "byCli": dict(snap.counts_by_cli)},
        "note": f"{snap.total} 场 · 存活进程 {snap.live_procs}",
    }


def run_history(out_path: str, progress=None) -> dict:
    """4/4 生成可搜索的历史会话网页。这步最慢，进度也最需要。"""
    from . import scan

    info = scan.generate(out_path, progress=progress)
    return {
        "key": "history", "ok": True,
        "text": scan.render_summary(info),
        "data": info,
        "note": f"{info['total']} 场 · {info['size'] / 1024 / 1024:.1f} MB",
    }


# ---------------------------------------------------------------- 一次跑完

def run_all(cfg_path: str = "", out_path: str = "",
            emit: Callable[[dict], None] | None = None,
            should_stop: Callable[[], bool] | None = None) -> list[dict]:
    """按顺序跑完四步，返回每步的结果。

    emit(event) 是唯一的回调（命令行和图形前台各自实现一份）：
        {"kind":"step_start", "key","short","head","index","total"}
        {"kind":"progress",   "key","stage", ...}     仅 history 会发
        {"kind":"step_done",  "key","ok","text","note","data"}
        {"kind":"abort",      "key"}                  被 should_stop 掐掉
    """
    def fire(event: dict) -> None:
        if emit is None:
            return
        try:
            emit(event)
        except Exception:
            pass                                  # 显示层出问题不该弄挂扫描

    stopped = (lambda: bool(should_stop and should_stop()))

    def beat_for(key: str):
        """把 scan 内部那种通用的 progress(stage, **kw) 认领到当前这一步上，
        否则进度会挂到错的步骤上去（重活在快照那步，却报成历史网页）。"""
        return lambda stage, **kw: fire(dict(kind="progress", key=key, stage=stage, **kw))

    from . import scan

    results: list[dict] = []
    # 第 3 步和第 4 步要的是同一份会话记录，缓存只在这一个 with 里有效
    with scan.cache_records():
        for index, spec in enumerate(STEPS, start=1):
            if stopped():
                fire({"kind": "abort", "key": spec["key"]})
                break
            fire({"kind": "step_start", "key": spec["key"], "short": spec["short"],
                  "head": spec["head"], "index": index, "total": TOTAL})

            beat = beat_for(spec["key"])
            if spec["key"] == "sessions":
                res = run_sessions()
            elif spec["key"] == "feed":
                res = run_feed(cfg_path)
            elif spec["key"] == "snapshot":
                res = run_snapshot(cfg_path, progress=beat)
            else:
                res = run_history(out_path, progress=beat)

            res.setdefault("short", spec["short"])
            res["index"] = index
            res["total"] = TOTAL
            results.append(res)
            fire({"kind": "step_done", **res})

    return results
