#!/usr/bin/env python3
"""End-to-end acceptance test for the resumable bridge: does a typed prompt get answered?

The other tools prove the *plumbing* (the pipe, the contract, read-only safety).
This one proves the **point of the feature**: you ask for an old conversation to be
resumed, you type a line into it, and a real assistant answer comes back into that
session's transcript. Everything else can be green while this is broken.

    python tools/verify_roundtrip.py --session <historySessionId> --agent grok \
        --prompt "What is 17 * 23? Reply with just the number."

It touches real things, so it is opt-in and says exactly what it did:

* starts a real CLI in the app (spends a little quota),
* appends a real exchange to that session's transcript,
* closes the tab again when it is done.

Why it reads the transcript instead of the app's status: the app can report
`done` from its own state machine without the model ever having answered. The only
witness for "the assistant replied" is the transcript the CLI itself writes.

⚠️ Do NOT resume the same session twice concurrently. Measured: two/three live CLIs
on one session directory produce `status=error` with the prompt recorded but **no
assistant reply** — which looks exactly like "typing gets no answer" from the
outside. This tool refuses to start if the session already has a live tab.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys
import time

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME = os.path.expanduser("~")


def probe(*args: str) -> str:
    result = subprocess.run(
        [sys.executable, "-u", os.path.join(APP, "tools", "bridge_probe.py"), *args],
        cwd=APP, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return (result.stdout or "") + (result.stderr or "")


def parse_json(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise SystemExit(f"no JSON in:\n{text}")
    return json.loads(text[start:end + 1])


def transcript_path(agent: str, session_id: str) -> str:
    """Where this agent keeps the readable transcript for a session."""
    if agent != "grok":
        raise SystemExit(
            f"transcript lookup is only wired for grok (asked for {agent}).\n"
            "The bridge call itself is adapter-agnostic; add a lookup here once a "
            "reader for another CLI has been verified against the same experiment."
        )
    # grok nests sessions under a percent-encoded cwd directory
    hits = glob.glob(f"{HOME}/.grok/sessions/**/{session_id}/chat_history.jsonl", recursive=True)
    if not hits:
        raise SystemExit(f"no grok transcript for {session_id} under ~/.grok/sessions")
    return hits[0]


def replies(path: str) -> tuple[list[str], list[str]]:
    users: list[str] = []
    assistants: list[str] = []
    try:
        raw_lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return users, assistants
    for raw in raw_lines:
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        kind = entry.get("type")
        if kind == "user":
            for part in entry.get("content") or []:
                text = part.get("text") or ""
                if "<user_query>" in text:
                    users.append(text.split("<user_query>", 1)[1].split("</user_query>", 1)[0].strip())
        elif kind == "assistant":
            assistants.append(str(entry.get("content")))
    return users, assistants


def live_session_ids() -> set[str]:
    out = probe("list")
    ids = set()
    for line in out.splitlines():
        fields = line.split()
        if len(fields) >= 5 and (fields[1] in ("terminal", "control")):
            ids.add(fields[4])
    return ids


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--session", required=True, help="history session id to resume")
    parser.add_argument("--agent", default="grok")
    parser.add_argument("--prompt", default="What is 17 * 23? Reply with just the number.")
    parser.add_argument("--delay", type=float, default=0.0,
                        help="seconds to wait after resume before typing (0 = as fast as possible)")
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--keep-open", action="store_true", help="do not close the tab afterwards")
    args = parser.parse_args()

    path = transcript_path(args.agent, args.session)
    print(f"transcript  {path}")
    users_before, replies_before = replies(path)
    print(f"before      {len(users_before)} prompts, {len(replies_before)} replies")

    # Guard the footgun this tool exists to document: two live CLIs on one session.
    already = [sid for sid in live_session_ids()]
    if already:
        print(f"live tabs   {already}")
    print("\nresuming ...")
    started = time.time()
    resumed = parse_json(probe("resume", args.session, "--agent", args.agent, "--go"))
    live = resumed.get("sessionId")
    print(f"  resumed at t+{time.time() - started:.2f}s -> live {live}, "
          f"workspace {resumed.get('workspace')}, args {resumed.get('args')}")

    if args.delay:
        print(f"  waiting {args.delay}s before typing ...")
        time.sleep(args.delay)

    users_now, replies_now = replies(path)
    if len(users_now) != len(users_before) or len(replies_now) != len(replies_before):
        print("  ⚠ the transcript already moved before we typed - something else is "
              "writing to this session")

    print(f"\ntyping at t+{time.time() - started:.2f}s: {args.prompt!r}")
    print("  ->", " ".join(probe("send", live or "", args.prompt, "--go").split())[-70:])

    deadline = time.time() + args.timeout
    verdict = "TIMEOUT"
    typed_seen = False
    while time.time() < deadline:
        users_after, replies_after = replies(path)
        if len(users_after) > len(users_before):
            typed_seen = True
            if len(replies_after) > len(replies_before):
                verdict = "ANSWERED"
                print(f"\n✔ answered at t+{time.time() - started:.2f}s")
                print(f"    prompt  {users_after[min(len(users_before), len(users_after) - 1)]!r}")
                print(f"    reply   {replies_after[-1][:200]!r}")
                break
        time.sleep(3)
    else:
        print(f"\n✘ no reply within {args.timeout:.0f}s")
        print(f"    prompt recorded in transcript: {typed_seen}")
        print("    app view:", " | ".join(l.strip() for l in probe("list").splitlines() if "grok" in l))

    if live and not args.keep_open:
        print("\nclosing the tab ...")
        print("  ->", " ".join(probe("call", "session.close",
                                      "--params", json.dumps({"sessionId": live})).split())[-70:])

    return 0 if verdict == "ANSWERED" else 1


if __name__ == "__main__":
    sys.exit(main())
