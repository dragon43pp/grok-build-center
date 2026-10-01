#!/usr/bin/env python3
"""Probe each configured grok relay for account quota/credits.

Reads the relay definitions out of ~/.grok/config.toml (the same file the
grok CLI itself uses) and issues ONE deliberately tiny request per relay so
that the only thing being measured is whether the upstream account will
accept a request at all.

It exists because of a real diagnosis: a resumed grok session recorded the
user's prompt, then died ~2s later with status=error and produced no
assistant text.  The cause was upstream -- the relay answered

    HTTP 402 Payment Required: insufficient_quota:
    remaining quota cannot cover the predicted cost; available=0

which is indistinguishable, from inside a TUI, from "the app is broken".

Usage:
    python tools/probe_relay_quota.py                 # every relay in config
    python tools/probe_relay_quota.py --only fusheng  # substring match

Never prints key material; only a short prefix + length.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

# A 1-token request: we are measuring authorization/quota, not the model.
PROBE_TIMEOUT = 30


def config_path() -> Path:
    home = os.environ.get("GROK_HOME")
    base = Path(home) if home else Path.home() / ".grok"
    return base / "config.toml"


def load_relays(path: Path) -> tuple[dict, list[dict]]:
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    relays: list[dict] = []
    for name, block in (data.get("model") or {}).items():
        relays.append({"alias": name, **block})
    return data, relays


def key_for(block: dict) -> str | None:
    env_key = block.get("env_key")
    if env_key:
        value = os.environ.get(env_key)
        if value:
            return value
    # Some configs embed the key directly.
    inline = block.get("api_key") or block.get("key")
    return inline or None


def mask(secret: str) -> str:
    if len(secret) <= 8:
        return "*" * len(secret)
    return f"{secret[:6]}…({len(secret)} chars)"


def probe(relay: dict) -> dict:
    alias = relay["alias"]
    base_url = (relay.get("base_url") or "").rstrip("/")
    model = relay.get("model")
    backend = (relay.get("api_backend") or "chat_completions").lower()
    key = key_for(relay)

    result = {"alias": alias, "model": model, "backend": backend, "base_url": base_url}
    if not base_url:
        result["verdict"] = "no base_url in config"
        return result
    if not key:
        result["verdict"] = f"missing env var {relay.get('env_key')!r}"
        return result
    result["key"] = mask(key)

    if backend == "responses":
        url = f"{base_url}/responses"
        body = {"model": model, "input": "hi", "max_output_tokens": 1}
    else:
        url = f"{base_url}/chat/completions"
        body = {"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1}

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # Some relays gate on this.
            "User-Agent": "grok-build-center-quota-probe/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT) as resp:
            payload = resp.read().decode("utf-8", "replace")
            result["http_status"] = resp.status
            result["verdict"] = "OK -- account accepted the request"
            result["body_head"] = payload[:300]
    except urllib.error.HTTPError as err:
        payload = err.read().decode("utf-8", "replace")
        result["http_status"] = err.code
        result["body_head"] = payload[:600]
        if err.code == 402:
            result["verdict"] = "NO CREDIT (402 Payment Required)"
        elif err.code == 401:
            result["verdict"] = "key rejected (401 Unauthorized)"
        elif err.code == 429:
            result["verdict"] = "rate limited (429)"
        else:
            result["verdict"] = f"HTTP {err.code}"
    except Exception as exc:  # noqa: BLE001 - diagnostics tool
        result["verdict"] = f"transport error: {type(exc).__name__}: {exc}"

    return result


def extract_quota_hint(body: str) -> str | None:
    match = re.search(r'"message"\s*:\s*"([^"]{0,300})"', body or "")
    return match.group(1) if match else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", default=None, help="substring filter on the alias")
    parser.add_argument("--config", default=None, help="override path to config.toml")
    parser.add_argument("--json", action="store_true", help="emit raw JSON")
    args = parser.parse_args()

    path = Path(args.config) if args.config else config_path()
    if not path.exists():
        print(f"config not found: {path}", file=sys.stderr)
        return 2

    data, relays = load_relays(path)
    default_alias = (data.get("models") or {}).get("default")
    if args.only:
        relays = [r for r in relays if args.only.lower() in r["alias"].lower()]
    if not relays:
        print("no matching relays", file=sys.stderr)
        return 2

    results = [probe(r) for r in relays]

    if args.json:
        print(json.dumps({"default": default_alias, "results": results}, indent=2, ensure_ascii=False))
        return 0

    print(f"config : {path}")
    print(f"default: {default_alias}")
    print()
    for r in results:
        star = " (DEFAULT)" if r["alias"] == default_alias else ""
        print(f"[{r['alias']}]{star}")
        print(f"   model  : {r.get('model')}   backend: {r.get('backend')}")
        print(f"   url    : {r.get('base_url')}")
        print(f"   key    : {r.get('key', '(none)')}")
        status = r.get("http_status")
        print(f"   result : {status if status is not None else '-'}  {r['verdict']}")
        hint = extract_quota_hint(r.get("body_head", ""))
        if hint:
            print(f"   detail : {hint}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
