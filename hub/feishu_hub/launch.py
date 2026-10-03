#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「回到现场」：在正确的目录里拉起正确的 CLI 并恢复那场会话。

两个关键点（都是踩过的坑）：
  1. **不要把 `cd` 拼进命令串**，把 cwd 交给子进程的 `cwd=` 参数。
     这样路径走 CreateProcessW 的 Unicode 通道，中文目录（`D:\\项目\\酒馆`）
     不会被 cmd 的代码页搞坏。
  2. **必须做输入校验**：cli/sid/cwd 都是从飞书回调里打进来的，属于外部输入。
     sid 走白名单正则，cwd 必须真实存在，cli 必须在已知集合里。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess

# 纯 ASCII 的恢复命令尾串 —— 中文只出现在 cwd 里，由 cwd= 参数承载
RESUME_TAIL = {
    "grok": "grok -r {id}",
    "codex": "codex resume {id}",
    "claude": "claude -r {id}",
    "opencode": "opencode --session {id}",
    "gemini": "gemini --resume {id}",
    "kimi": "kimi --session {id}",
    "pi": "pi --session {id}",
}

SAFE_ID = re.compile(r"^[A-Za-z0-9._\-]{1,128}$")


class LaunchError(RuntimeError):
    pass


def find_windows_terminal() -> str | None:
    """找 Windows Terminal（wt.exe）。没有就退化成新开一个 cmd 控制台。"""
    for candidate in (
        shutil.which("wt"),
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe"),
        r"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_8wekyb3d8bbwe\wt.exe",
    ):
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def build_tail(cli: str, sid: str) -> str:
    tmpl = RESUME_TAIL.get(cli)
    if not tmpl:
        raise LaunchError(f"未知的 CLI: {cli!r}（已知：{', '.join(RESUME_TAIL)}）")
    if not SAFE_ID.match(sid or ""):
        raise LaunchError(f"会话 id 不合法: {sid!r}")
    return tmpl.format(id=sid)


def resume(cli: str, sid: str, cwd: str) -> tuple[bool, str]:
    """在 cwd 里拉起 CLI 恢复会话。返回 (成功?, 说明)。"""
    try:
        tail = build_tail(cli, sid)
    except LaunchError as exc:
        return False, str(exc)

    if not cwd or not os.path.isdir(cwd):
        return False, f"目录不存在: {cwd or '(空)'}"

    wt = find_windows_terminal()
    try:
        if wt:
            # wt -d <dir> cmd /k <tail>：cwd 走参数，不进命令串
            subprocess.Popen(
                [wt, "-d", cwd, "cmd.exe", "/k", tail],
                close_fds=True,
            )
            return True, f"已在 Windows Terminal 打开 {cwd} 并执行 `{tail}`"
        subprocess.Popen(
            ["cmd.exe", "/k", tail],
            cwd=cwd,
            creationflags=subprocess.CREATE_NEW_CONSOLE,
        )
        return True, f"已在新控制台打开 {cwd} 并执行 `{tail}`"
    except Exception as exc:                              # noqa: BLE001
        return False, f"拉起终端失败: {exc}"


def open_folder(cwd: str) -> tuple[bool, str]:
    if not cwd or not os.path.isdir(cwd):
        return False, f"目录不存在: {cwd or '(空)'}"
    try:
        os.startfile(cwd)                                 # noqa: S606  (Windows only)
        return True, f"已在资源管理器打开 {cwd}"
    except Exception as exc:                              # noqa: BLE001
        return False, f"打开目录失败: {exc}"


# --------------------------------------------------------------------------
# 批量恢复
# --------------------------------------------------------------------------

def plan_many(items: list[tuple[str, str, str]]) -> tuple[list[tuple[str, str]], list[str]]:
    """把 (cli, sid, cwd) 列表过一遍校验，拆成「能开的」和「不能开的」。

    返回 (可执行列表 [(tail, cwd)], 跳过原因列表)。

    校验逻辑和单场 resume() 完全一致 —— 复用 build_tail()，不另写一套，
    否则两个入口的安全边界迟早会漂移。
    """
    ok: list[tuple[str, str]] = []
    skipped: list[str] = []
    for cli, sid, cwd in items:
        try:
            tail = build_tail(cli, sid)
        except LaunchError as exc:
            skipped.append(f"{cli}/{sid}: {exc}")
            continue
        if not cwd or not os.path.isdir(cwd):
            skipped.append(f"{cli}/{sid}: 目录不存在 {cwd or '(空)'}")
            continue
        ok.append((tail, cwd))
    return ok, skipped


def resume_many(items: list[tuple[str, str, str]], tabs: bool = True) -> tuple[bool, str]:
    """一次拉起多场会话。返回 (是否全部成功, 说明)。

    tabs=True  -> 一个 Windows Terminal 窗口里开 N 个标签页（推荐，
                  否则 5 场会话就是 5 个窗口，桌面瞬间被淹没）
    tabs=False -> 每场一个独立窗口
    """
    pairs, skipped = plan_many(items)
    if not pairs:
        return False, "没有可恢复的会话" + (f"（跳过 {len(skipped)} 场）" if skipped else "")

    wt = find_windows_terminal()
    note = f"跳过 {len(skipped)} 场" if skipped else ""

    if not wt:
        # 没有 wt 就只能每场一个新控制台
        launched = 0
        for tail, cwd in pairs:
            try:
                subprocess.Popen(
                    ["cmd.exe", "/k", tail],
                    cwd=cwd,
                    creationflags=subprocess.CREATE_NEW_CONSOLE,
                )
                launched += 1
            except Exception as exc:                      # noqa: BLE001
                skipped.append(f"{tail}: {exc}")
        return launched > 0, f"已在新控制台打开 {launched} 场" + (f"（{note}）" if note else "")

    if not tabs:
        launched = 0
        for tail, cwd in pairs:
            try:
                subprocess.Popen([wt, "-d", cwd, "cmd.exe", "/k", tail], close_fds=True)
                launched += 1
            except Exception as exc:                      # noqa: BLE001
                skipped.append(f"{tail}: {exc}")
        return launched > 0, f"已开 {launched} 个窗口" + (f"（{note}）" if note else "")

    # 一个窗口多个标签页：wt -d <dir> cmd /k <tail> ; -d <dir> cmd /k <tail> ...
    # `;` 必须是独立的一个 argv 元素，wt 才认它是标签页分隔符。
    argv: list[str] = [wt]
    for i, (tail, cwd) in enumerate(pairs):
        if i:
            argv.append(";")
        argv += ["-d", cwd, "cmd.exe", "/k", tail]
    try:
        subprocess.Popen(argv, close_fds=True)
    except Exception as exc:                              # noqa: BLE001
        return False, f"拉起终端失败: {exc}"
    return True, f"已在一个 Windows Terminal 里开 {len(pairs)} 个标签页" + (
        f"（{note}）" if note else ""
    )


if __name__ == "__main__":
    print("Windows Terminal:", find_windows_terminal() or "(未找到，将退化为 cmd 新控制台)")
    for c in ("grok", "codex", "claude", "opencode"):
        print(f"  {c:<10} -> {build_tail(c, 'abc-123')}")
    try:
        build_tail("grok", "bad id; rm -rf /")
    except LaunchError as e:
        print("  校验生效:", e)
