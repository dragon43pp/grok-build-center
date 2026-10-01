"""只读诊断日志过滤器。

任务背景：「幽灵启动」排查中，kill 阶段会刷出几万行
`Render frame was disposed before WebFrameMain could be accessed`，
把真正有用的两类信号（renderer 的 [gbc-diag] 追踪行、main 的 spawn ptyId 行）
埋在 20 万行里。本脚本只做过滤与按时间排序，不写任何东西。

用法：
    python tools/filter_diag.py <profile_dir_or_jsonl> [--all]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

NOISE = (
    'Render frame was disposed',
    'WebFrameMain',
)

KEYS = ('[gbc-diag]', 'spawn ptyId', 'session.load_session', 'autoResume')


def row_time(row: dict) -> str:
    for key in ('timestamp', 'time', 'ts', 'at'):
        if key in row:
            value = row[key]
            if isinstance(value, (int, float)):
                import datetime
                return datetime.datetime.fromtimestamp(value / 1000).strftime('%H:%M:%S.%f')[:-3]
            return str(value)
    return '?'


def iter_lines(path: Path):
    text = path.read_text(encoding='utf-8', errors='replace')
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            yield json.loads(raw)
        except json.JSONDecodeError:
            yield {'message': raw}


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    show_all = '--all' in sys.argv
    if not args:
        print('用法: python tools/filter_diag.py <profile_dir_or_jsonl> [--all]', file=sys.stderr)
        return 2

    target = Path(args[0])
    files = sorted(target.glob('logs/*.jsonl')) if target.is_dir() else [target]

    for path in files:
        rows = list(iter_lines(path))
        print(f'===== {path.parent.parent.name} :: {len(rows)} 行 =====')

        if show_all and rows:
            print('结构样例:', json.dumps(rows[0], ensure_ascii=False)[:400])

        kept = 0
        for row in rows:
            blob = json.dumps(row, ensure_ascii=False)
            if any(noise in blob for noise in NOISE):
                continue
            if not any(key.lower() in blob.lower() for key in KEYS):
                continue
            kept += 1
            print(f'{row_time(row)}  {blob[:300]}')
        print(f'--- 命中 {kept} 行（噪声 {len(rows) - kept} 行已滤） ---')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
