#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键安装向导 —— 把「照着文档点 7 步后台」压成一条命令。

目标：**别人拿到这个仓库，跑一条命令就能用**，不需要读我的文档去猜哪个权限叫什么、
哪张表要建哪些列。所有要手工做的东西都在这一个脚本里问清楚、建好、写进 config.json。

它做的事：
  1. 校验 app_id / app_secret 能不能用（真调一次接口，不是格式检查）
  2. 自动建一个多维表格，按需要的 15 列建好表 —— 你不用手动建列
  3. 拿到你的 open_id（让你给机器人发条消息，脚本自己接）
  4. 写出 config.json
  5. 打印「还差什么」

跑法：
    python tools/setup.py                 # 完整向导
    python tools/setup.py --check         # 只检查现有 config.json 能不能用
    python tools/setup.py --bitable-only  # 只补建多维表格
    python tools/setup.py --receive-id-only  # 只补 open_id

已有的 config.json 会被**保留并合并**，不会覆盖掉你手填的值。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lark_oapi as lark  # noqa: E402
from lark_oapi.api.auth.v3 import (  # noqa: E402
    InternalTenantAccessTokenRequestBody,
    InternalTenantAccessTokenRequest,
)

from feishu_hub import bitable as bt  # noqa: E402
from feishu_hub.feishu import FeishuClient, build_dispatcher, run_ws  # noqa: E402
from feishu_hub.hub import Config  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config.json")

BOLD, DIM, OFF = "\033[1m", "\033[2m", "\033[0m"


def hr(title: str = "") -> None:
    print()
    print(f"{BOLD}{'─' * 66}{OFF}")
    if title:
        print(f"{BOLD}  {title}{OFF}")
        print(f"{BOLD}{'─' * 66}{OFF}")


def ok(msg: str) -> None:
    print(f"  \033[32m✓\033[0m {msg}")


def warn(msg: str) -> None:
    print(f"  \033[33m!\033[0m {msg}")


def bad(msg: str) -> None:
    print(f"  \033[31m✗\033[0m {msg}")


def ask(prompt: str, default: str = "", secret: bool = False) -> str:
    tip = f" [{default}]" if default else ""
    if secret:
        import getpass
        try:
            val = getpass.getpass(f"  {prompt}{tip}: ").strip()
        except (EOFError, KeyboardInterrupt):
            val = ""
    else:
        try:
            val = input(f"  {prompt}{tip}: ").strip()
        except (EOFError, KeyboardInterrupt):
            val = ""
    return val or default


# ------------------------------------------------------------------ 配置读写

def load_raw() -> dict:
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, json.JSONDecodeError):
            pass
    return {}


def save_raw(data: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


# ------------------------------------------------------------------ 各步骤

def check_credentials(app_id: str, app_secret: str, domain: str) -> tuple[bool, str]:
    """真调一次接口验凭证。只检查格式没意义 —— 密钥错了要到发消息时才发现。"""
    client = lark.Client.builder().app_id(app_id).app_secret(app_secret) \
        .domain(domain).build()
    body = InternalTenantAccessTokenRequestBody.builder() \
        .app_id(app_id).app_secret(app_secret).build()
    req = InternalTenantAccessTokenRequest.builder().request_body(body).build()
    resp = client.auth.v3.tenant_access_token.internal(req)
    if resp.success():
        return True, "凭证有效"
    hints = {
        10003: "app_secret 不对",
        10014: "app_id 不对，或这个应用被删了",
        10012: "应用未发布，或凭证无效",
    }
    return False, hints.get(resp.code, f"code={resp.code} msg={resp.msg}")


def setup_bitable(client: lark.Client, raw: dict) -> bool:
    """建 Base + 建表。已经有就复用。"""
    token = raw.get("bitable_app_token") or ""

    if token:
        ok(f"已有多维表格 app_token={token}")
        name = ask("要给这张表起什么名字", raw.get("bitable_table_name") or bt.TABLE_NAME)
        sync = bt.BitableSync(client, token, raw.get("bitable_table_id") or "",
                              os.path.join(ROOT, "bitable-state.json"))
        try:
            tid = sync.ensure_table(name)
        except bt.BitableError as exc:
            bad(f"建表失败：{exc}")
            return False
        ok(f"数据表就绪 table_id={tid}")
        raw["bitable_table_id"] = tid
        raw["bitable_table_name"] = name
        return True

    print()
    print(f"  {DIM}多维表格是「看全部会话」的地方：343 场会话在卡片上要翻 35 页，")
    print(f"  在 Base 里可以直接筛、搜、排序，还能分享给别人看。免费。{OFF}")
    print()
    ans = ask("现在就建一个多维表格？(y/n)", "y").lower()
    if ans.startswith("n"):
        warn("跳过多维表格。之后想开就重跑：python tools/setup.py --bitable-only")
        return False

    name = ask("多维表格名字", "Grok Build Center")
    try:
        app_token, url = bt.create_base(client, name)
    except bt.BitableError as exc:
        bad(str(exc))
        print()
        print(f"  {DIM}多半是权限没开。开发者后台 → 权限管理 → 加「查看、评论、编辑和管理多维表格」")
        print(f"  （scope: bitable:app），然后**重新创建版本并发布** —— 只加权限不重发版本不生效。{OFF}")
        return False

    ok(f"已创建多维表格")
    print(f"    app_token : {app_token}")
    print(f"    打开链接  : {url}")

    sync = bt.BitableSync(client, app_token, "", os.path.join(ROOT, "bitable-state.json"))
    try:
        tid = sync.ensure_table(bt.TABLE_NAME)
    except bt.BitableError as exc:
        bad(f"建表失败：{exc}")
        return False
    ok(f"已建好 {len(bt.TABLE_FIELDS)} 列（不用你手动建列）")

    raw["bitable_app_token"] = app_token
    raw["bitable_table_id"] = tid
    raw["bitable_table_name"] = bt.TABLE_NAME
    raw["bitable_url"] = url
    return True


def setup_receive_id(app_id: str, app_secret: str, domain: str, raw: dict) -> bool:
    print()
    print(f"  {DIM}面板要发给谁。自己用就填你自己的 open_id；想发到群里就填 chat_id。{OFF}")
    print(f"  {DIM}下一步会让你给机器人发一条消息，脚本自己接住并把 id 打出来。{OFF}")
    print()
    if not ask("现在去拿 open_id？(y/n)", "y").lower().startswith("y"):
        warn("跳过。之后补：python tools/setup.py --receive-id-only")
        return False

    print()
    print(f"{BOLD}  现在切到飞书，给这个机器人随便发一条消息（单聊或群里 @ 它都行）。{OFF}")
    print(f"  {DIM}（机器人要先发布，并且你在「可用范围」里 —— 否则搜不到它）{OFF}")
    print()

    got: dict = {}

    def on_message(data) -> None:
        ev = data.event
        sender = ev.sender.sender_id.open_id if ev.sender and ev.sender.sender_id else ""
        chat = ev.message.chat_id
        if ev.message.chat_type == "p2p" and sender:
            got.update({"receive_id": sender, "receive_id_type": "open_id"})
        elif chat:
            got.update({"receive_id": chat, "receive_id_type": "chat_id"})
        print(f"  \033[32m✓\033[0m 收到！receive_id = {got.get('receive_id')}")
        print(f"    （类型 {got.get('receive_id_type')}，chat_type={ev.message.chat_type}）")

    handler = build_dispatcher(on_message, lambda d: None)
    client = lark.ws.Client(app_id=app_id, app_secret=app_secret,
                            event_handler=handler, domain=domain,
                            log_level=lark.LogLevel.WARN, auto_reconnect=True)

    import threading

    def stop_when_done() -> None:
        import time
        for _ in range(180):                  # 最多等 3 分钟
            time.sleep(1)
            if got:
                time.sleep(0.5)
                client._auto_reconnect = False
                os._exit(0)                   # 长连接是阻塞的，拿到就干脆退出
        print("  \033[33m!\033[0m 等太久没收到消息，跳过。之后补：python tools/setup.py --receive-id-only")
        os._exit(1)

    threading.Thread(target=stop_when_done, daemon=True).start()
    run_ws(app_id, app_secret, handler, domain, log_level=lark.LogLevel.WARN)
    return bool(got)


# ------------------------------------------------------------------ 主流程

def cmd_check(raw: dict) -> int:
    hr("检查现有配置")
    cfg = Config.load(CONFIG_PATH)
    missing = cfg.validate()
    if missing:
        bad(f"缺：{', '.join(missing)}")
    else:
        ok("app_id / app_secret / receive_id 都有")

    if cfg.app_id and cfg.app_secret:
        good, msg = check_credentials(cfg.app_id, cfg.app_secret, cfg.domain)
        (ok if good else bad)(f"凭证：{msg}")
    else:
        return 1

    if cfg.bitable_app_token:
        client = FeishuClient(cfg.app_id, cfg.app_secret, cfg.domain).raw
        sync = bt.BitableSync(client, cfg.bitable_app_token, cfg.bitable_table_id,
                              cfg.bitable_state)
        try:
            tables = sync._list_tables()
            names = [t["name"] for t in tables]
            ok(f"多维表格可访问，里面有 {len(tables)} 张表：{names}")
            if cfg.bitable_table_id and cfg.bitable_table_id not in [t["table_id"] for t in tables]:
                warn("配置里的 table_id 在表里找不到，重跑 --bitable-only 重建")
        except bt.BitableError as exc:
            bad(f"多维表格不可访问：{exc}")
    else:
        warn("没配多维表格（可选，但建议开：卡片翻页很痛苦）")

    hr()
    if not missing:
        print(f"  {BOLD}配置可用，直接跑：run.cmd{OFF}")
    return 0


def cmd_bitable_only(raw: dict) -> int:
    hr("补建多维表格")
    cfg = Config.load(CONFIG_PATH)
    if not (cfg.app_id and cfg.app_secret):
        bad("先有 app_id / app_secret。完整向导：python tools/setup.py")
        return 2
    client = FeishuClient(cfg.app_id, cfg.app_secret, cfg.domain).raw
    if setup_bitable(client, raw):
        save_raw(raw)
        ok(f"已写入 {CONFIG_PATH}")
        return 0
    return 1


def cmd_receive_id_only(raw: dict) -> int:
    hr("补 open_id")
    cfg = Config.load(CONFIG_PATH)
    if not (cfg.app_id and cfg.app_secret):
        bad("先有 app_id / app_secret。完整向导：python tools/setup.py")
        return 2
    setup_receive_id(cfg.app_id, cfg.app_secret, cfg.domain, raw)
    return 0


def cmd_full(raw: dict) -> int:
    hr("Grok Build Center · 安装向导")
    print(f"  {DIM}先把飞书应用建出来（开发者后台 7 步，见 README「第一步」），")
    print(f"  拿到 app_id / app_secret 再回来。这里只做后面那些手工活。{OFF}")

    hr("1/4 · 凭证")
    app_id = ask("App ID", raw.get("app_id") or os.environ.get("FEISHU_APP_ID", ""))
    if not app_id:
        bad("没有 app_id，退出")
        return 2
    app_secret = ask("App Secret", raw.get("app_secret") or
                     os.environ.get("FEISHU_APP_SECRET", ""), secret=True)
    if not app_secret:
        bad("没有 app_secret，退出")
        return 2

    domain = ask("域名（国内飞书直接回车）", raw.get("domain") or "https://open.feishu.cn")
    good, msg = check_credentials(app_id, app_secret, domain)
    if not good:
        bad(f"凭证校验失败：{msg}")
        print(f"  {DIM}确认一下：App ID/Secret 抄对了？应用创建了吗？{OFF}")
        return 1
    ok(msg)
    raw.update({"app_id": app_id, "app_secret": app_secret, "domain": domain})

    hr("2/4 · 多维表格")
    setup_bitable(FeishuClient(app_id, app_secret, domain).raw, raw)

    hr("3/4 · 面板发给谁")
    setup_receive_id(app_id, app_secret, domain, raw)

    hr("4/4 · 写配置")
    raw.setdefault("refresh_secs", 60)
    raw.setdefault("hook_port", 8799)
    raw.setdefault("push_on_needs_you", True)
    save_raw(raw)
    ok(f"已写入 {CONFIG_PATH}")

    hr("完成")
    print(f"  {BOLD}下一步：{OFF}")
    print(f"    run.cmd                     启动面板")
    print(f"    run.cmd --bitable-preview   先看要写进多维表格的行")
    print()
    print(f"  {DIM}想要橙色的「等你确认」，还要配 CLI hook（README 第三步）：{OFF}")
    print(f"    python tools\\report.py --cli codex --status needs-you --note \"在等你\"")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Grok Build Center · 安装向导")
    ap.add_argument("--check", action="store_true", help="只检查现有配置")
    ap.add_argument("--bitable-only", action="store_true", help="只补建多维表格")
    ap.add_argument("--receive-id-only", action="store_true", help="只补 open_id")
    args = ap.parse_args()

    raw = load_raw()
    if args.check:
        return cmd_check(raw)
    if args.bitable_only:
        return cmd_bitable_only(raw)
    if args.receive_id_only:
        return cmd_receive_id_only(raw)
    return cmd_full(raw)


if __name__ == "__main__":
    sys.exit(main())
