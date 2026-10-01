"""把「从会话恢复」接到 AppShell 上。

这是一次性补丁脚本：四处替换、每处都断言**恰好命中一次**，任何一处没命中就
整体不写盘 —— 宁可失败也不要写出半截接线。AppShell.tsx 是 CRLF，锚点里必须
带 \\r\\n，否则一个都匹配不上（这是本仓库踩过的坑，见 memory 2026-09-30）。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "src" / "app" / "AppShell.tsx"

EDITS: list[tuple[str, str, str]] = [
    (
        "在 AppShell() 里取一份 strings",
        "  const [newSessionIntent, setNewSessionIntent] = useState<NewSessionIntent>({\r\n"
        "    kind: 'sheet'\r\n"
        "  })\r\n",
        "  const [newSessionIntent, setNewSessionIntent] = useState<NewSessionIntent>({\r\n"
        "    kind: 'sheet'\r\n"
        "  })\r\n"
        "  // 恢复失败时要给用户一句人话，所以这里也得有一份文案。\r\n"
        "  const strings = useStrings()\r\n",
    ),
    (
        "没有安装项时用真实文案",
        "      if (!installation) return stringsRef.current.sessionHistory.resumeBlockedUnverified\r\n",
        "      if (!installation) return strings.sessionHistory.resumeBlockedUnverified\r\n",
    ),
    (
        "resumeSession 依赖补上 strings",
        "    },\r\n    [launchCli]\r\n  )\r\n",
        "    },\r\n    [launchCli, strings]\r\n  )\r\n",
    ),
    (
        "把扫描结果与恢复回调交给会话历史页",
        "            {pageId === 'sessions' && <SessionHistoryPage />}\r\n",
        "            {pageId === 'sessions' && (\r\n"
        "              <SessionHistoryPage\r\n"
        "                clis={cliReport?.launchable ?? []}\r\n"
        "                onResumeSession={resumeSession}\r\n"
        "              />\r\n"
        "            )}\r\n",
    ),
    (
        "新建面板接住预填参数",
        "        initialTerminalPicker={newSessionIntent.kind === 'terminal'}\r\n",
        "        initialTerminalPicker={newSessionIntent.kind === 'terminal'}\r\n"
        "        initialArgs={\r\n"
        "          newSessionIntent.kind === 'cli' ? newSessionIntent.args : undefined\r\n"
        "        }\r\n"
        "        initialSkipApproval={\r\n"
        "          newSessionIntent.kind === 'cli'\r\n"
        "            ? newSessionIntent.skipApproval\r\n"
        "            : undefined\r\n"
        "        }\r\n",
    ),
]


def main() -> int:
    text = TARGET.read_text(encoding="utf-8", newline="")
    original = text

    for label, anchor, replacement in EDITS:
        hits = text.count(anchor)
        if hits != 1:
            print(f"FAIL  {label}: 锚点命中 {hits} 次（需要恰好 1 次），未写盘")
            return 1
        text = text.replace(anchor, replacement, 1)
        print(f"ok    {label}")

    if text == original:
        print("FAIL  内容没有变化")
        return 1

    TARGET.write_text(text, encoding="utf-8", newline="")
    body = TARGET.read_bytes()
    print(
        f"\n已写入 {TARGET.relative_to(ROOT)}  "
        f"CRLF={body.count(b'\\r\\n')}  bareLF={body.count(b'\\n') - body.count(b'\\r\\n')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
