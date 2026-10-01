"""给「恢复退路」补一句说明，并把旧目录摆进输入框。

两个问题一起解决：

1. **用户不知道为什么被要求选目录**。点「继续」后直接弹出一个目录框，没有交代，
   看起来像功能坏了。`resumeNoCwd`（五语都已有现成文案）就是答案，之前没人用。

2. **留空比填旧路径更危险**。`openCli` 的兜底是 `initialWorkspace.trim() ||
   lastWorkspace()` —— 留空会拿到「上次用过的目录」，那是个**存在且合法**的目录，
   于是用户直接点启动就在一个不相干的目录里把旧会话续上了，全程没有任何提示。
   这正是我们要消灭的那类「静默落错地方」。摆出旧路径 + 一句说明，用户才会主动选。

两个文件都是 CRLF。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FLOW = ROOT / "src" / "app" / "NewSessionFlow.tsx"
SHELL = ROOT / "src" / "app" / "AppShell.tsx"

FLOW_EDITS: list[tuple[str, str, str]] = [
    (
        "props：加 initialNotice",
        "  initialSkipApproval?: boolean\r\n",
        "  initialSkipApproval?: boolean\r\n"
        "  /**\r\n"
        "   * 面板顶部的提示条。恢复历史会话时用来说明「为什么让你重选目录」——\r\n"
        "   * 没有这句话，点完「继续」直接弹个目录框，看起来像功能坏了。\r\n"
        "   */\r\n"
        "  initialNotice?: string\r\n",
    ),
    (
        "解构：加 initialNotice",
        "  initialSkipApproval,\r\n",
        "  initialSkipApproval,\r\n  initialNotice = '',\r\n",
    ),
    (
        "state：notice",
        "  const [launchError, setLaunchError] = useState<string | null>(null)\r\n",
        "  const [launchError, setLaunchError] = useState<string | null>(null)\r\n"
        "  const [notice, setNotice] = useState('')\r\n",
    ),
    (
        "打开时采样提示条",
        "    if (initialCli) openCli(initialCli)\r\n",
        "    if (initialCli) openCli(initialCli)\r\n    setNotice(initialNotice)\r\n",
    ),
    (
        "草稿表单渲染提示条",
        '                <div className="flex flex-col gap-3 px-4 pb-1">\r\n',
        '                <div className="flex flex-col gap-3 px-4 pb-1">\r\n'
        '                  {notice && (\r\n'
        '                    <p\r\n'
        '                      data-testid="cli-notice"\r\n'
        '                      className="rounded-lg bg-surface-strong px-2.5 py-2 font-pingfang text-[11px] text-text-muted"\r\n'
        '                    >\r\n'
        '                      {notice}\r\n'
        '                    </p>\r\n'
        '                  )}\r\n',
    ),
]

SHELL_EDITS: list[tuple[str, str, str]] = [
    (
        "intent：cli 分支带 workspace / notice",
        "  | { kind: 'cli'; option: CliOption; args?: string; skipApproval?: boolean }\r\n",
        "  | {\r\n"
        "      kind: 'cli'\r\n"
        "      option: CliOption\r\n"
        "      args?: string\r\n"
        "      skipApproval?: boolean\r\n"
        "      /** 预填的工作目录。恢复时必须是**旧目录原值**，理由见 resumeSession。 */\r\n"
        "      workspace?: string\r\n"
        "      /** 面板顶部的提示条，用来说明这次为什么要重选目录。 */\r\n"
        "      notice?: string\r\n"
        "    }\r\n",
    ),
    (
        "askForWorkspace：带旧目录与说明",
        "          args: formatArgs(plan.args),\r\n"
        "          skipApproval: false\r\n"
        "        })\r\n"
        "        setNewSessionOpen(true)\r\n"
        "        return null\r\n"
        "      }\r\n",
        "          args: formatArgs(plan.args),\r\n"
        "          skipApproval: false,\r\n"
        "          // ⚠️ 这里必须填**旧目录原值**，不能留空。`NewSessionFlow.openCli` 的\r\n"
        "          // 兜底是 `initialWorkspace || lastWorkspace()`：留空会拿到「上次用过\r\n"
        "          // 的目录」，那是个存在且合法的目录，用户直接点启动就在一个不相干的\r\n"
        "          // 目录里把旧会话续上了 —— 又一次静默落错地方。摆出旧路径既是信息\r\n"
        "          // （原来是跑在哪儿的），也逼用户主动改。\r\n"
        "          workspace: session.cwd,\r\n"
        "          notice: strings.sessionHistory.resumeNoCwd\r\n"
        "        })\r\n"
        "        setNewSessionOpen(true)\r\n"
        "        return null\r\n"
        "      }\r\n",
    ),
    (
        "JSX：把 workspace / notice 交给面板",
        "        initialSkipApproval={\r\n",
        "        initialWorkspace={\r\n"
        "          newSessionIntent.kind === 'cli'\r\n"
        "            ? newSessionIntent.workspace\r\n"
        "            : undefined\r\n"
        "        }\r\n"
        "        initialNotice={\r\n"
        "          newSessionIntent.kind === 'cli' ? newSessionIntent.notice : undefined\r\n"
        "        }\r\n"
        "        initialSkipApproval={\r\n",
    ),
]


def apply(path: Path, edits: list[tuple[str, str, str]]) -> int:
    text = path.read_text(encoding="utf-8", newline="")
    for label, anchor, replacement in edits:
        hits = text.count(anchor)
        if hits != 1:
            print(f"FAIL  {path.name} · {label}: 锚点命中 {hits} 次（需要 1 次）")
            return 1
        text = text.replace(anchor, replacement, 1)
        print(f"ok    {path.name} · {label}")
    path.write_text(text, encoding="utf-8", newline="")
    body = path.read_bytes()
    crlf = body.count(b"\r\n")
    print(
        f"      写入 {path.name}  CRLF={crlf}  bareLF={body.count(bytes([10])) - crlf}\n"
    )
    return 0


def main() -> int:
    for path, edits in ((FLOW, FLOW_EDITS), (SHELL, SHELL_EDITS)):
        code = apply(path, edits)
        if code:
            return code
    return 0


if __name__ == "__main__":
    sys.exit(main())
