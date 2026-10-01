"""临时插桩：让应用自己说出「是谁拉起了 CLI」。

排查一个幽灵行为：多次应用运行里，有几次在启动后 29~65 秒**自己**拉起了
`~/.grok/bin/grok.exe`（诊断日志里的 `[hrack] spawn ptyId=`），而我们并没有点任何
启动按钮。分阶段单测（onboard / sessions / focus / click）跑下来时有时无、不可稳定
复现，靠读代码推不出来，所以直接在每条启动路径上留痕并带上调用栈。

**这是临时诊断用的，定位完要撤。** 只加 console.info，不改任何逻辑。

脚本写成**幂等**的：先把自己上次插的东西全部清掉，再重新插一遍。第一版没清，
被重复执行一次就多出一份 `const traceLaunch`，esbuild 直接报「已声明」——
这类「跑两次就坏」的补丁本身就该避免。

AppShell.tsx 是 CRLF。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHELL = ROOT / "src" / "app" / "AppShell.tsx"

PROBE = (
    "  // [TEMP-DIAG] 幽灵启动排查用，定位完删除。\r\n"
    "  const traceLaunch = (tag: string, detail: string): void => {\r\n"
    "    const stack = new Error().stack ?? ''\r\n"
    "    const frames = stack\r\n"
    "      .split('\\n')\r\n"
    "      .slice(2, 6)\r\n"
    "      .map((line) => line.trim().replace(/\\s*\\(.*/, ''))\r\n"
    "      .join(' <- ')\r\n"
    "    console.info(`[gbc-diag] ${tag} ${detail} | ${frames}`)\r\n"
    "  }\r\n"
)

EDITS: list[tuple[str, str]] = [
    (
        "  // 恢复失败时要给用户一句人话，所以这里也得有一份文案。\r\n",
        PROBE,
    ),
    (
        "    return window.appApi.onBridgeLaunch((request) => {\r\n",
        "      // [TEMP-DIAG]\r\n"
        "      traceLaunch('bridge-launch', request.selection.args.join(' '))\r\n",
    ),
    # ⚠️ 两个坑：① 锚点必须是**函数体第一行**，不能是 `const launchX = useCallback(` ——
    # 插在后者附近会让 `traceLaunch(...)` 变成 useCallback 的实参，esbuild 报
    # `Unexpected "const"`；② 插入方向必须是**锚点之后**，插在前面同样错位。
    (
        "    (shell: ShellOption, remember = false): void => {\r\n",
        "    // [TEMP-DIAG]\r\n"
        "    traceLaunch('launchTerminal', 'shell=' + shell.id)\r\n",
    ),
    (
        "    async (draft: CliLaunchDraft): Promise<string | null> => {\r\n",
        "    // [TEMP-DIAG]\r\n"
        "    traceLaunch('launchCli', 'args=' + (draft.args || '(空)'))\r\n",
    ),
]


def strip(text: str) -> str:
    """把自己上次插进去的东西全部删掉（声明块 + 所有调用行 + 标记注释行）。"""
    block = re.compile(
        r"  // \[TEMP-DIAG\][^\r\n]*\r\n"
        r"  const traceLaunch = \(tag: string, detail: string\): void => \{\r\n"
        r"(?:.*?\r\n)*?"
        r"  \}\r\n",
        re.MULTILINE,
    )
    text = block.sub("", text)
    text = re.sub(r"[ \t]*// \[TEMP-DIAG\][^\r\n]*\r\n", "", text)
    text = re.sub(r"[ \t]*traceLaunch\([^\r\n]*\r\n", "", text)
    return text


def main() -> int:
    raw = SHELL.read_text(encoding="utf-8", newline="")
    text = strip(raw)
    if text != raw:
        print(f"ok    先清掉上次插入的 {raw.count('traceLaunch')} 处引用")

    for anchor, insertion in EDITS:
        hits = text.count(anchor)
        if hits != 1:
            print(f"FAIL  锚点命中 {hits} 次（需要 1 次）：{anchor.strip()[:50]}")
            return 1
        # 插在锚点**之后**。
        text = text.replace(anchor, anchor + insertion, 1)
        print(f"ok    插入于 {anchor.strip()[:44]}")

    SHELL.write_text(text, encoding="utf-8", newline="")
    body = SHELL.read_bytes()
    crlf = body.count(b"\r\n")
    print(
        f"      写入 {SHELL.name}  CRLF={crlf}  bareLF={body.count(bytes([10])) - crlf}"
        f"  traceLaunch={text.count('traceLaunch')} 处"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
