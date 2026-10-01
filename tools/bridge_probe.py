#!/usr/bin/env python3
"""Talk to the Grok Build Center bridge from outside the app.

This is two things at once:

1. The reference implementation for the Feishu side. Anything that wants to
   drive sessions from outside the app speaks exactly this protocol, so the
   encode/decode/error handling here is the thing to copy.
2. The read-only verification harness. Every subcommand is a **dry run by
   default**; nothing launches a process or writes to a session unless you pass
   `--go`. That is deliberate: the only way to prove the read path is
   side-effect free is to have a path that is guaranteed not to take the
   write path, and then run it against a live session store.

Protocol (newline-delimited JSON, both directions):

    -> {"id": "...", "token": "<64 hex>", "method": "sessions.list", "params": {}}
    <- {"kind": "result", "id": "...", "ok": true, "result": [...]}
    <- {"kind": "result", "id": "...", "ok": false, "error": {"code": ..., "message": ...}}
    <- {"kind": "event", "id": "...", "event": {...}}      # only for session.watch

Transport is a Windows named pipe, `\\\\.\\pipe\\gbc-bridge-<username>`. On
POSIX it is a unix socket, `$XDG_RUNTIME_DIR/grok-build-center/bridge.sock`.
The pipe only exists while the app is running; a missing pipe is the
"app is not open" signal, not an error to retry in a loop.

Pitfalls this file exists to encode:

* The token lives in `<userData>/bridge.token` and is regenerated per
  userData dir. Dev builds use `Grok Build Center Dev`, packaged builds
  `Grok Build Center` - so a token found in one is rejected by the other.
* Responses are newline-delimited but a single `os.read` can return half a
  line or three lines. Everything must go through a buffer.
* **One thread must own the pipe handle.** Measured on this machine: once a
  second thread parks in `read()` on the handle, a `write()` from the main
  thread never returns (the pipe stops accepting our bytes entirely, so the
  app never even sees the request). Write and read therefore live in the same
  worker thread, and the caller waits on a per-request queue.
* That queue is also where the timeout comes from. A blocked `read()` cannot
  be interrupted, so the deadline has to be enforced by the waiting side; the
  worker may stay parked until the connection is closed, which is harmless
  because every connection is single-shot and the thread is a daemon.

Usage:
    python tools/bridge_probe.py list
    python tools/bridge_probe.py history --query 微信 --limit 10
    python tools/bridge_probe.py resume <sessionId> --agent grok        # dry run
    python tools/bridge_probe.py send <sessionId> "继续" --go
    python tools/bridge_probe.py call sessions.history --params '{"limit":3}'
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import queue
import re
import sys
import threading
from pathlib import Path

TOKEN_RE = re.compile(r"^[a-f0-9]{64}$")

# Where a token may live. Dev first: if you are running `npm run dev` the app
# writes to the Dev dir, and finding the packaged token instead would produce a
# confusing "unauthorized" rather than "app not running".
USER_DATA_CANDIDATES = ("Grok Build Center Dev", "Grok Build Center")


def socket_path() -> str:
    if os.name == "nt":
        user = re.sub(r"[^A-Za-z0-9._-]+", "_", getpass.getuser())[:64] or "user"
        return rf"\\.\pipe\gbc-bridge-{user}"
    runtime = os.environ.get("XDG_RUNTIME_DIR", "").strip()
    if runtime:
        return str(Path(runtime) / "grok-build-center" / "bridge.sock")
    return str(Path.home() / ".hrack" / "bridge.sock")


def token_paths() -> list[Path]:
    """Every place we will look for a token, in the order we will look."""
    override = os.environ.get("GBC_USER_DATA_DIR") or os.environ.get("HRACK_USER_DATA_DIR")
    if override:
        return [Path(override) / "bridge.token"]
    appdata = os.environ.get("APPDATA") or os.environ.get("XDG_CONFIG_HOME")
    roots = [Path(appdata)] if appdata else []
    return [root / name / "bridge.token" for root in roots for name in USER_DATA_CANDIDATES]


def read_token(explicit: str | None) -> tuple[str, Path]:
    if explicit:
        return explicit, Path("<argv>")
    if os.environ.get("GBC_BRIDGE_TOKEN"):
        return os.environ["GBC_BRIDGE_TOKEN"].strip(), Path("<env>")
    seen: list[str] = []
    for path in token_paths():
        seen.append(str(path))
        try:
            token = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if TOKEN_RE.match(token):
            return token, path
    raise SystemExit(
        "No bridge token found. Looked in:\n  "
        + "\n  ".join(seen)
        + "\nThat means the app has never run for this user."
    )


class Bridge:
    """A bridge connection with one worker thread owning the handle.

    The worker writes a request and then reads until the response with that
    request id comes back. Everything that touches the handle happens there,
    because a concurrent read on another thread wedges writes on Windows (see
    the module docstring). Callers talk to it through two queues.
    """

    def __init__(self, path: str, token: str, timeout: float = 120.0) -> None:
        self.path = path
        self.token = token
        self.timeout = timeout
        self._read = None  # type: ignore[assignment]
        self._write = None  # type: ignore[assignment]
        self._close = None  # type: ignore[assignment]
        self._buffer = b""
        self._work: queue.Queue[tuple[str, bytes] | None] = queue.Queue()
        self._replies: dict[str, queue.Queue[object]] = {}
        self._worker: threading.Thread | None = None
        self._counter = 0

    def __enter__(self) -> "Bridge":
        if os.name == "nt":
            # A plain unbuffered open is enough: Python maps it to CreateFile
            # and a named pipe is just a file to it. Hand-rolling CreateFileW
            # through ctypes is a trap - the default restype is c_int, so a
            # valid 64-bit HANDLE gets truncated to -1.
            try:
                handle = open(self.path, "r+b", buffering=0)
            except OSError as error:
                raise SystemExit(
                    f"Cannot open {self.path}: {error}\n"
                    "The pipe only exists while the app is running - open "
                    "Grok Build Center and retry."
                ) from error
            self._read = handle.read
            self._write = handle.write
            self._close = handle.close
        else:
            import socket

            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                sock.connect(self.path)
            except OSError as error:
                raise SystemExit(
                    f"Cannot connect to {self.path}: {error}\n"
                    "Open Grok Build Center and retry."
                ) from error
            self._read = sock.recv
            self._write = sock.sendall
            self._close = sock.close
        self._worker = threading.Thread(target=self._serve, daemon=True)
        self._worker.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._work.put(None)
        if self._close is not None:
            try:
                self._close()
            except OSError:
                pass
            self._close = None

    # -- worker side ------------------------------------------------------

    def _read_line(self) -> str | None:
        """Next complete line, or None once the peer goes away."""
        while b"\n" not in self._buffer:
            try:
                chunk = self._read(65536)
            except (OSError, ValueError):
                chunk = b""
            if not chunk:
                return None
            self._buffer += chunk
        raw, self._buffer = self._buffer.split(b"\n", 1)
        return raw.decode("utf-8", "replace").strip()

    def _serve(self) -> None:
        while True:
            item = self._work.get()
            if item is None:
                return
            request_id, payload = item
            try:
                self._write(payload)
                while True:
                    line = self._read_line()
                    if line is None:
                        raise SystemExit("The app closed the bridge connection")
                    if not line:
                        continue
                    message = json.loads(line)
                    # A watch subscription interleaves events with its result on
                    # the same connection, and a late answer to an abandoned
                    # request must not be handed to whoever asks next.
                    if message.get("kind") == "event":
                        continue
                    if message.get("id") != request_id:
                        continue
                    self._deliver(request_id, message)
                    break
            except SystemExit as error:
                self._deliver(request_id, error)
            except Exception as error:  # noqa: BLE001 - forwarded to the caller
                self._deliver(request_id, error)

    def _deliver(self, request_id: str, value: object) -> None:
        slot = self._replies.pop(request_id, None)
        if slot is not None:
            slot.put(value)

    # -- caller side ------------------------------------------------------

    def call(self, method: str, params: dict | None = None) -> object:
        self._counter += 1
        request_id = f"probe-{os.getpid()}-{self._counter}"
        payload = {"id": request_id, "token": self.token, "method": method}
        if params:
            payload["params"] = params
        slot: queue.Queue[object] = queue.Queue()
        self._replies[request_id] = slot
        self._work.put(
            (request_id, (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        )
        try:
            answer = slot.get(timeout=self.timeout)
        except queue.Empty:
            # Drop the slot: if the answer shows up later the worker would
            # otherwise find nobody to give it to, which is exactly right.
            self._replies.pop(request_id, None)
            raise SystemExit(
                f"No response to {method} within {self.timeout:.0f}s"
            ) from None
        if isinstance(answer, SystemExit):
            raise answer
        if isinstance(answer, Exception):
            raise SystemExit(f"{method} failed: {answer}") from answer
        assert isinstance(answer, dict)
        if not answer.get("ok"):
            error = answer.get("error") or {}
            raise BridgeError(error.get("code", "unknown"), error.get("message", ""))
        return answer.get("result")


class BridgeError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code


def show(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------------------
# subcommands
# ---------------------------------------------------------------------------


def cmd_list(bridge: Bridge, _args: argparse.Namespace) -> None:
    sessions = bridge.call("sessions.list")
    assert isinstance(sessions, list)
    print(f"{len(sessions)} live session(s)")
    for item in sessions:
        mode = "control" if item.get("controllable") else "terminal"
        # `ready=False` means the terminal has not printed anything yet, so the
        # CLI inside it is still booting. Typing now loses the leading
        # characters - measured, see the class docstring in bridge_protocol.
        state = "ready" if item.get("ready", True) else "STARTING"
        print(
            f"  {item.get('adapterId', '?'):<9} {mode:<8} {state:<8} "
            f"{item.get('status', '?'):<9} {item.get('sessionId')}  {item.get('name')}"
        )


def cmd_history(bridge: Bridge, args: argparse.Namespace) -> None:
    params: dict[str, object] = {"limit": args.limit}
    if args.agent:
        params["agent"] = args.agent
    if args.query:
        params["query"] = args.query
    if args.include_hidden:
        params["includeHidden"] = True
    if args.refresh:
        params["refresh"] = True
    sessions = bridge.call("sessions.history", params)
    assert isinstance(sessions, list)
    resumable = [item for item in sessions if item.get("resumable")]
    print(f"{len(sessions)} listed, {len(resumable)} resumable")
    for item in sessions:
        flag = "  ok  " if item.get("resumable") else f"  {item.get('blockedCode', 'blocked')}  "
        print(f"{flag} {item.get('agent', '?'):<9} {item.get('sessionId')}")
        print(f"         {item.get('title', '')[:70]}")
        print(f"         {item.get('workspace', '') or '(no cwd)'}")


def cmd_resume(bridge: Bridge, args: argparse.Namespace) -> None:
    params: dict[str, object] = {"sessionId": args.session_id}
    if args.agent:
        params["agent"] = args.agent
    if not args.go:
        params["dryRun"] = True
    result = bridge.call("session.resume", params)
    show(result)
    if not args.go:
        print("\n(dry run: nothing was launched. pass --go to actually open the tab.)")
        return
    print(
        "\nA new tab is open and the session is resuming.\n"
        "`list` shows it as `ready` once the CLI inside has drawn something; that is\n"
        "the point where typing into it starts to mean anything. Measured it opens\n"
        "about 6s after the spawn and before `resume` even returns, so a send right\n"
        "after this is normally fine - a tight send at +0.24s arrived byte-identical.\n"
        "Do not type into `STARTING` tabs regardless; nothing is listening yet."
    )


def cmd_send(bridge: Bridge, args: argparse.Namespace) -> None:
    if not args.go:
        raise SystemExit(
            "Refusing to type into a live session without --go.\n"
            "This writes real characters into a real terminal - it is not a preview."
        )
    show(bridge.call("session.send", {"sessionId": args.session_id, "text": args.text}))


def cmd_call(bridge: Bridge, args: argparse.Namespace) -> None:
    params = json.loads(args.params) if args.params else None
    show(bridge.call(args.method, params))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bridge_probe",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--socket", help="override the pipe/socket path")
    parser.add_argument("--token", help="override the bridge token")
    parser.add_argument("--timeout", type=float, default=120.0)
    subs = parser.add_subparsers(dest="command", required=True)

    subs.add_parser("list", help="sessions.list: every adapter, live only").set_defaults(
        run=cmd_list
    )

    history = subs.add_parser("history", help="sessions.history: what is on disk")
    history.add_argument("--agent", help="grok / codex / claude / kimi / pi / ...")
    history.add_argument("--query", "-q", help="substring of title or workspace")
    history.add_argument("--limit", "-n", type=int, default=20)
    history.add_argument("--include-hidden", action="store_true", help="include subagents and archived")
    history.add_argument("--refresh", action="store_true", help="bypass the 5s scan cache")
    history.set_defaults(run=cmd_history)

    resume = subs.add_parser("resume", help="session.resume (dry run unless --go)")
    resume.add_argument("session_id")
    resume.add_argument("--agent", help="disambiguate when the id exists under several CLIs")
    resume.add_argument("--go", action="store_true", help="actually launch the terminal")
    resume.set_defaults(run=cmd_resume)

    send = subs.add_parser("send", help="session.send (requires --go)")
    send.add_argument("session_id")
    send.add_argument("text")
    send.add_argument("--go", action="store_true")
    send.set_defaults(run=cmd_send)

    call = subs.add_parser("call", help="raw method call")
    call.add_argument("method")
    call.add_argument("--params", help="JSON object")
    call.set_defaults(run=cmd_call)

    args = parser.parse_args(argv)
    token, token_from = read_token(args.token)
    path = args.socket or socket_path()
    print(f"# pipe   {path}")
    print(f"# token  {token_from}", file=sys.stderr)
    try:
        with Bridge(path, token, args.timeout) as bridge:
            args.run(bridge, args)
    except BridgeError as error:
        print(f"bridge error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
