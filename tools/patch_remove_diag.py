# -*- coding: utf-8 -*-
"""拆掉「幽灵启动」排查期间加的临时插桩。

为什么要写成脚本而不是手改：`src/app/AppShell.tsx` 是 **CRLF**，
`SessionHistoryPage.tsx` 是 **LF**。手改时锚点里的 `\n` 对 CRLF 文件会
**静默匹配不到**（不报错、不生效），最后留下几行没人记得的 console.info。
所以这里每个锚点都带断言，缺一个就报错；并用 newline='' 逐字节保留原行尾。

结论（2026-09-30）：所谓「幽灵启动」是**用户本人双击了窗口里的行**，
不是 App 自发行为 —— 证据是捕获阶段记到了成对的 mousedown/mouseup/click
再跟 dblclick，以及随后六次 `keydown on TEXTAREA`（有人在终端里打字）。
插桩使命完成，删除。
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SHELL = ROOT / 'src' / 'app' / 'AppShell.tsx'
PAGE = ROOT / 'src' / 'app' / 'SessionHistoryPage.tsx'


def cut(text: str, anchor: str, label: str) -> str:
    """删掉 anchor（必须出现恰好一次），CRLF/LF 两版都试。"""
    for variant in (anchor, anchor.replace('\n', '\r\n')):
        if variant in text:
            assert text.count(variant) == 1, f'{label}: 锚点出现 {text.count(variant)} 次'
            return text.replace(variant, '', 1)
    raise AssertionError(f'{label}: 锚点没匹配上（行尾不对还是代码已改？）')


def main() -> int:
    shell = SHELL.read_text(encoding='utf-8', newline='')
    page = PAGE.read_text(encoding='utf-8', newline='')

    shell = cut(
        shell,
        """  // [TEMP-DIAG] 幽灵启动排查用，定位完删除。
  const traceLaunch = (tag: string, detail: string): void => {
    const stack = new Error().stack ?? ''
    const frames = stack
      .split('\\n')
      .slice(2, 6)
      .map((line) => line.trim().replace(/\\s*\\(.*/, ''))
      .join(' <- ')
    console.info(`[gbc-diag] ${tag} ${detail} | ${frames}`)
  }
""",
        'traceLaunch 定义',
    )
    for label, anchor in (
        ('bridge-launch', "      // [TEMP-DIAG]\n      traceLaunch('bridge-launch', request.selection.args.join(' '))\n"),
        ('launchTerminal', "    // [TEMP-DIAG]\n    traceLaunch('launchTerminal', 'shell=' + shell.id)\n"),
        ('launchCli', "    // [TEMP-DIAG]\n    traceLaunch('launchCli', 'args=' + (draft.args || '(空)'))\n"),
        (
            'resumeSession',
            "      // [TEMP-DIAG] 幽灵启动排查：如果这行出现而 SessionHistoryPage 的\n"
            "      // `handleResume` 没出现，说明调用绕过了 DOM 手势。\n"
            "      traceLaunch('resumeSession', 'id=' + session.id)\n",
        ),
    ):
        shell = cut(shell, anchor, label)

    for label, anchor in (
        ('handleResume', "      // [TEMP-DIAG] 幽灵启动排查：确认调用到底来自哪个手势。\n      console.info('[gbc-diag] handleResume ' + session.id)\n"),
        ('row-dblclick', "        // [TEMP-DIAG]\n        console.info('[gbc-diag] row-dblclick ' + session.id + ' resumable=' + String(Boolean(option)))\n"),
        ('btn-click', "            // [TEMP-DIAG]\n            console.info('[gbc-diag] btn-click ' + session.id + ' resumable=' + String(Boolean(option)))\n"),
    ):
        page = cut(page, anchor, label)

    SHELL.write_text(shell, encoding='utf-8', newline='')
    PAGE.write_text(page, encoding='utf-8', newline='')

    for path in (SHELL, PAGE):
        body = path.read_text(encoding='utf-8', newline='')
        left = body.count('TEMP-DIAG') + body.count('traceLaunch') + body.count('[gbc-diag]')
        print(f'{path.name}: 剩余插桩引用 {left}')
        assert left == 0, f'{path.name} 还有残留'
    print('全部拆干净')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
