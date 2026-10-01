"""把 probe_spawn.sh 产出的所有 profile 汇总成一张矩阵。

任务背景：「幽灵启动」要回答的问题是「哪一步把 CLI 拉起来了」。逐个 profile 读日志
效率太低，这里一次性把每个 profile 的
  · 阶段（从目录名解析）
  · 有没有 `[hrack] spawn ptyId`
  · 有没有 renderer 的 `[gbc-diag]` 追踪行
  · 探测脚本自己报的「首次出现 grok」秒数
三列并排，才能看出相关性。纯只读。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

TEMP = Path.home() / 'AppData' / 'Local' / 'Temp'


def profile_stage(name: str) -> str:
    m = re.match(r'gbc-spawn-(\w+?)-\d+$', name)
    return m.group(1) if m else name


def summarize(profile: Path) -> dict:
    info = {'stage': profile_stage(profile.name), 'log': '', 'spawns': [], 'diag': [], 'first': '-'}

    log_file = profile / 'logs' / 'hrack-diagnostic.jsonl'
    if log_file.exists():
        for raw in log_file.read_text(encoding='utf-8', errors='replace').splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                row = json.loads(raw)
            except json.JSONDecodeError:
                continue
            msg = row.get('message', '')
            if 'Render frame was disposed' in msg:
                continue
            if 'spawn ptyId' in msg:
                info['spawns'].append(msg.replace('[hrack] ', ''))
            elif '[gbc-diag]' in msg:
                info['diag'].append(msg.split('|')[0].strip())

    # probe_spawn.sh 自己的 .log（文件名不含 pid）
    probe_log = TEMP / f"gbc-spawn-{info['stage']}.log"
    if probe_log.exists():
        text = probe_log.read_text(encoding='utf-8', errors='replace')
        m = re.findall(r'阶段 \S+：观察窗口第 (\d+)s 首次出现 grok', text)
        info['first'] = ('/' .join(dict.fromkeys(m))) if m else '从未'

    return info


def main() -> int:
    profiles = sorted(p for p in TEMP.glob('gbc-spawn-*') if p.is_dir())
    if not profiles:
        print('没有找到任何 profile')
        return 1

    order = {'none': 0, 'onboard': 1, 'sessions': 2, 'stats': 3, 'focus': 4, 'click': 5}
    rows = [summarize(p) for p in profiles]
    rows.sort(key=lambda r: (order.get(r['stage'], 99), r['stage']))

    print(f'{"阶段":<9}{"profile":<12}{"首次grok":<9}{"spawn":<6}{"diag":<5}主题')
    print('-' * 96)
    for r in rows:
        pid = sorted(p.name for p in profiles if profile_stage(p.name) == r['stage'])
        print(
            f"{r['stage']:<9}{'-':<12}{r['first']:<9}"
            f"{len(r['spawns']):<6}{len(r['diag']):<5}"
            f"{(r['spawns'][:1] or r['diag'][:1] or [''])[0][:44]}"
        )

    print('\n===== 明细 =====')
    for r in rows:
        if not r['spawns'] and not r['diag']:
            continue
        print(f"\n### {r['stage']}  first={r['first']}")
        for s in r['spawns']:
            print('   spawn:', s)
        for d in r['diag']:
            print('   diag :', d)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
