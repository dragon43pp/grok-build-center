#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多维表格（Base）同步 —— 把全部会话铺成一张真正能筛、能搜、能排序的表。

**为什么需要它**：卡片一页只能放 10 条，343 场会话要翻 35 页，手机上点到手酸。
多维表格是原生表格视图：按状态分组、按时间排序、按标题搜索、按 CLI 筛选，
而且**免费**、**可以分享给别人看**。两者分工：

    多维表格 = 完整清单（全部会话，自己筛自己搜，可分享）
    卡片     = 一眼看 + 当场动手（等你确认的排最前，点「打开」回本机）

**幂等**：靠本地状态文件记住「会话 → record_id」和内容哈希，只推变化过的行。
343 场会话每分钟全量重推既慢又浪费配额，实测稳态下每轮只推 0～3 行。

字段类型编号来自官方《字段编辑指南》：
    1 多行文本 / 2 数字 / 3 单选 / 4 多选 / 5 日期 / 7 复选框 / 15 超链接
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any

import lark_oapi as lark
from lark_oapi.api.bitable.v1 import (
    AppTableCreateHeader,
    AppTableFieldProperty,
    AppTableFieldPropertyOption,
    AppTableRecord,
    BatchCreateAppTableRecordRequest,
    BatchCreateAppTableRecordRequestBody,
    BatchUpdateAppTableRecordRequest,
    BatchUpdateAppTableRecordRequestBody,
    CreateAppRequest,
    CreateAppTableRequest,
    CreateAppTableRequestBody,
    ListAppTableRecordRequest,
    ListAppTableRequest,
    ReqApp,
    ReqTable,
)

# 批量接口上限。官方单次 500，这里再切小一点，避免单请求体过大。
CHUNK = 200

# ------------------------------------------------------------------ 表结构

# 单选字段的选项必须预先建好 —— 写入一个不存在的选项会直接报错。
# 所以 CLI 用「已知全集 + 其他」兜底，新出现的 CLI 不会把同步搞挂。
CLI_OPTIONS = [
    "Codex", "Claude Code", "Grok Build", "OpenCode", "Gemini CLI",
    "Cursor Agent", "Qwen Code", "Kimi CLI", "Amp", "Cline", "其他",
]

STATUS_OPTIONS = ["等你确认", "报错", "在跑", "空闲", "已完成", "已结束"]

# (字段名, 类型, 单选选项)
TABLE_FIELDS: list[tuple[str, int, list[str] | None]] = [
    ("标题", 1, None),
    ("会话ID", 1, None),          # resume 用的就是它
    ("CLI", 3, CLI_OPTIONS),
    ("状态", 3, STATUS_OPTIONS),
    ("项目", 1, None),
    ("项目目录", 1, None),
    ("最后活动", 5, None),
    ("开始时间", 5, None),
    ("消息数", 2, None),
    ("工具调用", 2, None),
    ("Token", 2, None),
    ("可恢复", 7, None),
    ("恢复命令", 1, None),
    ("备注", 1, None),
    ("归档", 7, None),
]

TABLE_NAME = "AI 会话"

# 状态 → 单选选项名（state.py 的 key 到中文标签）
STATUS_OPTION_OF = {
    "needs-you": "等你确认",
    "error": "报错",
    "running": "在跑",
    "idle": "空闲",
    "done": "已完成",
    "ended": "已结束",
}


def _option_names(cli_label: str) -> str:
    """把 CLI 标签映射到已建的选项，未知的落到「其他」。"""
    if cli_label in CLI_OPTIONS:
        return cli_label
    for name in CLI_OPTIONS:
        if name != "其他" and name.lower() in (cli_label or "").lower():
            return name
    return "其他"


def build_headers() -> list[AppTableCreateHeader]:
    out: list[AppTableCreateHeader] = []
    for name, ftype, options in TABLE_FIELDS:
        b = AppTableCreateHeader.builder().field_name(name).type(ftype)
        if options:
            prop = AppTableFieldProperty.builder().options(
                [AppTableFieldPropertyOption.builder().name(o).build() for o in options]
            ).build()
            b = b.property(prop)
        out.append(b.build())
    return out


# ------------------------------------------------------------------ 记录内容

def session_to_fields(s) -> dict[str, Any]:
    """把一条会话转成多维表格的一行。

    日期字段要的是**毫秒**时间戳（13 位），传秒会被解析成 1970 年。
    """
    fields: dict[str, Any] = {
        "标题": s.title or "(未命名)",
        "会话ID": s.sid,
        "CLI": _option_names(s.cli_label),
        "状态": STATUS_OPTION_OF.get(s.status, "已结束"),
        "项目": s.project,
        "项目目录": s.cwd,
        "消息数": s.msgs,
        "工具调用": s.tools,
        "Token": s.tokens,
        "可恢复": s.resumable,
        "恢复命令": s.cmd,
        "备注": s.hook_note,
        "归档": s.archived,
    }
    if s.last_ts:
        fields["最后活动"] = int(s.last_ts * 1000)
    if s.start_ts:
        fields["开始时间"] = int(s.start_ts * 1000)
    return fields


def fields_hash(fields: dict) -> str:
    blob = json.dumps(fields, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


# ------------------------------------------------------------------ 同步器

class BitableError(RuntimeError):
    pass


class BitableSync:
    """把快照同步到多维表格。幂等：只推变化过的行。"""

    def __init__(self, client: lark.Client, app_token: str, table_id: str,
                 state_path: str) -> None:
        self._c = client
        self.app_token = app_token
        self.table_id = table_id
        self.state_path = state_path
        self._state = self._load()

    # ---------------------------------------------------------- 状态

    def _load(self) -> dict:
        if os.path.exists(self.state_path):
            try:
                with open(self.state_path, encoding="utf-8") as fh:
                    return json.load(fh)
            except (OSError, json.JSONDecodeError):
                pass
        return {"records": {}}

    def _save(self) -> None:
        tmp = self.state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self._state, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, self.state_path)

    @property
    def _records(self) -> dict[str, dict]:
        return self._state.setdefault("records", {})

    # ---------------------------------------------------------- 建表

    def ensure_table(self, table_name: str = TABLE_NAME) -> str:
        """表存在就复用；不存在就按 TABLE_FIELDS 建一张。返回 table_id。"""
        tables = self._list_tables()
        for t in tables:
            if t.get("name") == table_name:
                self.table_id = t.get("table_id")
                return self.table_id

        body = (
            CreateAppTableRequestBody.builder()
            .table(
                ReqTable.builder()
                .name(table_name)
                .default_view_name("全部会话")
                .fields(build_headers())
                .build()
            )
            .build()
        )
        req = (
            CreateAppTableRequest.builder()
            .app_token(self.app_token)
            .request_body(body)
            .build()
        )
        resp = self._c.bitable.v1.app_table.create(req)
        if not resp.success():
            raise BitableError(
                f"建表失败 code={resp.code} msg={resp.msg}（多半是缺 bitable:app 权限）"
            )
        self.table_id = resp.data.table_id
        return self.table_id

    def _list_tables(self) -> list[dict]:
        req = (
            ListAppTableRequest.builder()
            .app_token(self.app_token)
            .page_size(100)
            .build()
        )
        resp = self._c.bitable.v1.app_table.list(req)
        if not resp.success():
            raise BitableError(f"列数据表失败 code={resp.code} msg={resp.msg}")
        return [
            {"table_id": t.table_id, "name": t.name}
            for t in (resp.data.items or [])
        ]

    # ---------------------------------------------------------- 重建索引

    def rebuild_index(self) -> int:
        """把表里已有的行读回来，按「CLI|会话ID」重建 record_id 映射。

        本地状态文件丢了（换机器、被删）时用得上 —— 不然会把 343 行重新插一遍，
        表里变成双份。
        """
        index: dict[str, dict] = {}
        page_token = ""
        while True:
            b = ListAppTableRecordRequest.builder().app_token(self.app_token) \
                .table_id(self.table_id).page_size(500)
            if page_token:
                b = b.page_token(page_token)
            resp = self._c.bitable.v1.app_table_record.list(b.build())
            if not resp.success():
                raise BitableError(f"读记录失败 code={resp.code} msg={resp.msg}")
            for rec in (resp.data.items or []):
                f = rec.fields or {}
                cli = f.get("CLI")
                sid = f.get("会话ID")
                if isinstance(cli, list):      # 单选有时返回数组
                    cli = cli[0] if cli else ""
                if isinstance(sid, list):
                    sid = sid[0] if sid else ""
                if sid:
                    key = f"{cli}|{sid}"
                    index[key] = {"rid": rec.record_id, "hash": ""}
            if not resp.data.has_more:
                break
            page_token = resp.data.page_token or ""
            if not page_token:
                break
        self._records.clear()
        self._records.update(index)
        self._save()
        return len(index)

    # ---------------------------------------------------------- 主流程

    def sync(self, sessions: list, dry_run: bool = False) -> dict:
        """把会话列表同步进表。返回统计。

        只推变化过的行；消失的行删掉（只有 hook 合成行会消失，会话库里的历史不会）。
        """
        if not self.table_id:
            raise BitableError("还没确定 table_id，先调 ensure_table()")

        live: dict[str, dict] = {}
        for s in sessions:
            if not s.sid:
                # 没 sid 的合成行（CLI 上报了但还没落盘、且没给 id）不进来：
                # 没有稳定身份，30 分钟后过期还会留下孤儿行
                continue
            fields = session_to_fields(s)
            live[f"{s.cli_label}|{s.sid}"] = {
                "fields": fields,
                "hash": fields_hash(fields),
            }

        to_create, to_update, unchanged = [], [], 0
        for key, item in live.items():
            known = self._records.get(key)
            if not known:
                to_create.append((key, item))
            elif known.get("hash") != item["hash"]:
                to_update.append((key, known["rid"], item))
            else:
                unchanged += 1

        to_delete = [
            (key, rec["rid"])
            for key, rec in self._records.items()
            if key not in live
        ]

        stats = {
            "total": len(live), "create": len(to_create),
            "update": len(to_update), "unchanged": unchanged,
            "delete": len(to_delete), "dry_run": dry_run,
        }
        if dry_run:
            return stats

        for i in range(0, len(to_create), CHUNK):
            batch = to_create[i:i + CHUNK]
            self._batch_create(batch)

        for i in range(0, len(to_update), CHUNK):
            batch = to_update[i:i + CHUNK]
            self._batch_update(batch)

        if to_delete:
            self._batch_delete([rid for _, rid in to_delete])
            for key, _ in to_delete:
                self._records.pop(key, None)

        self._save()
        return stats

    # ---------------------------------------------------------- 批量调用

    def _batch_create(self, batch: list[tuple[str, dict]]) -> None:
        records = [
            AppTableRecord.builder().fields(item["fields"]).build()
            for _, item in batch
        ]
        body = BatchCreateAppTableRecordRequestBody.builder().records(records).build()
        req = (
            BatchCreateAppTableRecordRequest.builder()
            .app_token(self.app_token).table_id(self.table_id)
            .request_body(body).build()
        )
        resp = self._c.bitable.v1.app_table_record.batch_create(req)
        if not resp.success():
            raise BitableError(f"批量新增失败 code={resp.code} msg={resp.msg}")
        # 建完要把 record_id 记下来，否则下一轮会当成新行重插一遍
        for (key, item), rec in zip(batch, resp.data.records or []):
            self._records[key] = {"rid": rec.record_id, "hash": item["hash"]}

    def _batch_update(self, batch: list[tuple[str, str, dict]]) -> None:
        records = [
            AppTableRecord.builder().record_id(rid).fields(item["fields"]).build()
            for _, rid, item in batch
        ]
        body = BatchUpdateAppTableRecordRequestBody.builder().records(records).build()
        req = (
            BatchUpdateAppTableRecordRequest.builder()
            .app_token(self.app_token).table_id(self.table_id)
            .request_body(body).build()
        )
        resp = self._c.bitable.v1.app_table_record.batch_update(req)
        if not resp.success():
            raise BitableError(f"批量更新失败 code={resp.code} msg={resp.msg}")
        for key, _, item in batch:
            self._records[key] = {"rid": self._records[key]["rid"], "hash": item["hash"]}

    def _batch_delete(self, rids: list[str]) -> None:
        from lark_oapi.api.bitable.v1 import (
            BatchDeleteAppTableRecordRequest,
            BatchDeleteAppTableRecordRequestBody,
        )

        for i in range(0, len(rids), CHUNK):
            body = BatchDeleteAppTableRecordRequestBody.builder() \
                .records(rids[i:i + CHUNK]).build()
            req = (
                BatchDeleteAppTableRecordRequest.builder()
                .app_token(self.app_token).table_id(self.table_id)
                .request_body(body).build()
            )
            resp = self._c.bitable.v1.app_table_record.batch_delete(req)
            if not resp.success():
                # 删不掉不是致命的，下一轮还会再试
                print(f"[warn] 批量删除失败 code={resp.code} msg={resp.msg}")


# ------------------------------------------------------------------ 建 Base

def create_base(client: lark.Client, name: str = "AI 会话中心") -> tuple[str, str]:
    """新建一个多维表格，返回 (app_token, url)。

    注意 body 是 `ReqApp`，不是 `CreateAppRequestBody` —— 这个模型类不存在。
    """
    body = ReqApp.builder().name(name).build()
    req = CreateAppRequest.builder().request_body(body).build()
    resp = client.bitable.v1.app.create(req)
    if not resp.success():
        raise BitableError(
            f"新建多维表格失败 code={resp.code} msg={resp.msg}"
            f"（检查是否开了 bitable:app 权限）"
        )
    return resp.data.app.app_token, resp.data.app.url


# ------------------------------------------------------------------ CLI

if __name__ == "__main__":
    from .state import STATUS_LABEL, build_snapshot

    print("多维表格字段定义（%d 列）：" % len(TABLE_FIELDS))
    for name, ftype, options in TABLE_FIELDS:
        extra = f"  选项 {len(options)} 个" if options else ""
        print(f"  {name:<10} type={ftype}{extra}")

    snap = build_snapshot()
    print()
    print(f"快照 {snap.total} 场会话")
    print("状态 → 选项映射：")
    for key, label in STATUS_LABEL.items():
        print(f"  {key:<10} → {STATUS_OPTION_OF.get(key, '已结束')}")

    sample = next((s for s in snap.sessions if s.sid), None)
    if sample:
        f = session_to_fields(sample)
        print()
        print("样例行：")
        print(json.dumps(f, ensure_ascii=False, indent=1, default=str))
        print(f"内容哈希 {fields_hash(f)}（用来判断这一行要不要重推）")
