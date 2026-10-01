"""补上「空 cwd」的兜底。

发现的真问题：主进程的 `resolveWorkspace` 把**空工作区解析成 Home**
（`runtimeWorkspace` 的注释就写着「空工作区以所选安装的实际运行环境 Home 为准」）。
新建会话时那是有意为之，但恢复历史会话时它是个坑：会话没记 cwd 时，
`grok --resume <id>` 会在 `~` 里静默起一个会话 —— 用户看不到任何异常，
agent 却在一个错误的目录里开工了。

所以恢复路径必须在调用之前就把空 cwd 拦下来，退到「让用户指一个目录」，
跟「目录已经不存在」走同一条路。

AppShell.tsx 是 CRLF，锚点带 \\r\\n。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "src" / "app" / "AppShell.tsx"

OLD = (
    "      let workspace: string\r\n"
    "      try {\r\n"
    "        workspace = await window.cliApi.resolveWorkspace(installation.id, session.cwd)\r\n"
    "      } catch {\r\n"
    "        setNewSessionIntent({\r\n"
    "          kind: 'cli',\r\n"
    "          option,\r\n"
    "          args: formatArgs(plan.args),\r\n"
    "          skipApproval: false\r\n"
    "        })\r\n"
    "        setNewSessionOpen(true)\r\n"
    "        return null\r\n"
    "      }\r\n"
)

NEW = (
    "      // 目录算不出来（不存在、或压根没记）时退到「让你选一个」，不报错收场。\r\n"
    "      const askForWorkspace = (): null => {\r\n"
    "        setNewSessionIntent({\r\n"
    "          kind: 'cli',\r\n"
    "          option,\r\n"
    "          args: formatArgs(plan.args),\r\n"
    "          skipApproval: false\r\n"
    "        })\r\n"
    "        setNewSessionOpen(true)\r\n"
    "        return null\r\n"
    "      }\r\n"
    "      // ⚠️ 空 cwd 不能交给 resolveWorkspace：它把空工作区**解析成 Home**\r\n"
    "      // （新建会话时那是有意为之），于是恢复会在 Home 里静默起一个会话 ——\r\n"
    "      // 用户看不出任何异常，agent 却在错误的目录里开工了。\r\n"
    "      if (!session.cwd.trim()) return askForWorkspace()\r\n"
    "\r\n"
    "      let workspace: string\r\n"
    "      try {\r\n"
    "        workspace = await window.cliApi.resolveWorkspace(installation.id, session.cwd)\r\n"
    "      } catch {\r\n"
    "        return askForWorkspace()\r\n"
    "      }\r\n"
)


def main() -> int:
    text = TARGET.read_text(encoding="utf-8", newline="")
    hits = text.count(OLD)
    if hits != 1:
        print(f"FAIL  锚点命中 {hits} 次（需要恰好 1 次），未写盘")
        return 1
    TARGET.write_text(text.replace(OLD, NEW, 1), encoding="utf-8", newline="")
    body = TARGET.read_bytes()
    crlf = body.count(b"\r\n")
    print(f"ok   空 cwd 兜底已写入  CRLF={crlf}  bareLF={body.count(chr(10).encode()) - crlf}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
