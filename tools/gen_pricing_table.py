# -*- coding: utf-8 -*-
"""从 models.dev 快照生成内置价目表 —— 只收「一方」provider，绝不收转售商。

为什么必须筛 provider：models.dev 把同一个 model id 列在几十家渠道名下，
价格能差 30 倍。实测 grok-4.7 在 opencode 渠道是 $1.4/$4.2，在 302ai 和 xai
是 $2/$6；gpt-5.6-sol 从 $1.5/$12 到 $5/$30 都有。随手取一条会得到一条
看着像模像样、实际差一个数量级的「估算」——比不估算更糟。

所以只保留模型原厂/官方托管方（xai / openai / anthropic / google …），
并且按 allowlist 顺序决定优先级：同一个 id 出现在多家一方渠道时，靠前的赢。

用法：
    python tools/gen_pricing_table.py [models_dev.json]
    默认读 %TEMP%/models_dev.json；没有就从 https://models.dev/api.json 拉一份。

产出：electron/sessions/pricing-table.ts（自动生成，别手改）
"""
from __future__ import annotations

import datetime
import json
import os
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 顺序即优先级。只放模型原厂或原厂直营的托管方。
FIRST_PARTY: list[tuple[str, str]] = [
    ("xai", "xAI"),
    ("openai", "OpenAI"),
    ("anthropic", "Anthropic"),
    ("google", "Google"),
    ("deepseek", "DeepSeek"),
    ("moonshotai", "Moonshot AI"),
    ("kimi-code-plan-global", "Moonshot AI (kimi.ai)"),
    ("kimi-code-plan-cn", "Moonshot AI (kimi.com)"),
    ("mistral", "Mistral"),
    ("poolside", "Poolside"),
    ("alibaba", "Alibaba"),
    ("alibaba-cn", "Alibaba (China)"),
]

OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "electron",
    "sessions",
    "pricing-table.ts",
)
DEFAULT_SNAPSHOT = os.path.join(os.environ.get("TEMP", ""), "models_dev.json")


def load(path: str | None) -> dict:
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    print("本地没有快照，改为联网拉 https://models.dev/api.json …")
    with urllib.request.urlopen("https://models.dev/api.json", timeout=60) as response:
        return json.load(response)


def num(value) -> float | None:
    """只有真正的数字才算数：字符串/None 一律当「没这个价」。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def main() -> int:
    snapshot = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SNAPSHOT
    raw = load(snapshot)

    # id -> entry。先来的赢（allowlist 顺序 = 优先级）。
    prices: dict[str, dict] = {}
    per_provider: list[str] = []

    for provider_id, provider_name in FIRST_PARTY:
        provider = raw.get(provider_id)
        if not provider:
            continue
        added = 0
        for model in (provider.get("models") or {}).values():
            model_id = model.get("id")
            if not model_id:
                continue
            cost = model.get("cost") or {}
            input_price = num(cost.get("input"))
            output_price = num(cost.get("output"))
            if input_price is None or output_price is None:
                # 没有输入/输出单价的行根本没法算钱，直接跳过，
                # 让它落到 'unpriced' 而不是拿一个 0 冒充免费。
                continue
            if model_id in prices:
                continue
            prices[model_id] = {
                "provider": provider_id,
                "input": input_price,
                "output": output_price,
                "cacheRead": num(cost.get("cache_read")),
                "cacheWrite": num(cost.get("cache_write")),
            }
            added += 1
        per_provider.append(f"{provider_id}={added}")

    stamp = datetime.datetime.now().strftime("%Y-%m-%d")

    def fmt(value: float | None) -> str:
        if value is None:
            return "null"
        # 保留原始精度（0.075 这类价差写死了赔钱）。
        text = repr(value)
        return text

    lines: list[str] = []
    lines.append("/**")
    lines.append(" * 内置价目表 —— 自动生成，不要手改。")
    lines.append(" *")
    lines.append(" * 由 `tools/gen_pricing_table.py` 从 models.dev 快照编译而来，")
    lines.append(" * 只保留模型原厂/官方托管方：同一个 model id 在转售渠道之间价差可达 30 倍，")
    lines.append(" * 随手取一条会得到看着合理、实际差一个数量级的「估算」，比不估算更糟。")
    lines.append(" *")
    lines.append(f" * 生成日期：{stamp}")
    lines.append(f" * 收录：{'、'.join(per_provider)}")
    lines.append(f" * 型号数：{len(prices)}")
    lines.append(" *")
    lines.append(" * 单位：美元 / 每 100 万 token。`cacheRead`/`cacheWrite` 为 null 表示")
    lines.append(" * 该渠道没有公布这项价格 —— 它不是 0，遇到这种型号要按「算不出来」处理。")
    lines.append(" */")
    lines.append("")
    lines.append("export interface BuiltinPrice {")
    lines.append("  /** 价格来自哪家（一方 provider id）。 */")
    lines.append("  provider: string")
    lines.append("  /** 未命中缓存的输入 token 单价。 */")
    lines.append("  input: number")
    lines.append("  output: number")
    lines.append("  cacheRead: number | null")
    lines.append("  cacheWrite: number | null")
    lines.append("}")
    lines.append("")
    lines.append(f"export const PRICING_GENERATED_ON = '{stamp}'")
    lines.append("")
    lines.append("/**")
    lines.append(" * 一方 provider 的**优先级顺序**（靠前的赢）。")
    lines.append(" *")
    lines.append(" * 运行时从 models.dev 刷新价目表时按这份名单筛渠道，")
    lines.append(" * 免得 allowlist 在 Python 和 TS 里各维护一份、迟早对不上。")
    lines.append(" */")
    lines.append(
        "export const FIRST_PARTY_PROVIDERS: readonly string[] = ["
        + ", ".join(f"'{provider_id}'" for provider_id, _ in FIRST_PARTY)
        + "]"
    )
    lines.append("")
    lines.append("export const BUILTIN_PRICES: Readonly<Record<string, BuiltinPrice>> = {")
    for model_id in sorted(prices):
        entry = prices[model_id]
        lines.append(
            f"  '{model_id}': {{ provider: '{entry['provider']}', "
            f"input: {fmt(entry['input'])}, output: {fmt(entry['output'])}, "
            f"cacheRead: {fmt(entry['cacheRead'])}, cacheWrite: {fmt(entry['cacheWrite'])} }},"
        )
    lines.append("}")
    lines.append("")

    with open(OUT, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines))

    print(f"已写入 {OUT}")
    print(f"  型号 {len(prices)} 条")
    print(f"  来源 {'、'.join(per_provider)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
