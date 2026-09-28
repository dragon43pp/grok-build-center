# -*- coding: utf-8 -*-
"""把本地 git 提交推上 GitHub —— 走 Git Data API，不需要 git-over-HTTPS。

为什么需要这个：有些机器上 `github.com:443` 被墙（`git push` 必然超时），
但 `api.github.com` 是通的。此时常规推送整套失效，而 API 路径可用。

关键点：**复刻 commit SHA**。
Git 的 commit 哈希只由 tree + parent + author + committer + message 决定，
所以只要用同样的字段通过 API 重建提交，得到的 SHA 会和本地**逐字节一致**。
这样本地和远端不会出现「两份历史」，之后网络恢复了直接 `git push` 也能对上。

用法：
    python tools/gh_push.py --repo dragon43pp/grok-build-pager
    python tools/gh_push.py --repo owner/name --ref main --dry-run
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def git(*args, binary=False):
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), r.stderr.decode("utf-8", "replace")))
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def gh_api(path, method="GET", body=None, tries=5):
    """带重试的 gh api 调用。

    这台机器到 api.github.com 的路由不稳定，TLS handshake timeout 是常态，
    所以网络类错误一律重试（指数退避），只有明确的 4xx 才直接抛。
    """
    cmd = ["gh", "api", path, "--method", method]
    if body is not None:
        cmd += ["--input", "-"]
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    # MSYS_NO_PATHCONV：Git Bash 会把 /repos/... 当路径改写成 D:/... 直接报假错误
    env = dict(os.environ, MSYS_NO_PATHCONV="1")

    last = ""
    for attempt in range(1, tries + 1):
        r = subprocess.run(cmd, cwd=ROOT, env=env, input=payload, capture_output=True)
        if r.returncode == 0:
            out = r.stdout.decode("utf-8", "replace").strip()
            return json.loads(out) if out else {}
        last = r.stderr.decode("utf-8", "replace").strip()
        retryable = any(k in last for k in (
            "handshake timeout", "timeout", "timed out", "connection reset",
            "EOF", "temporarily unavailable", "502", "503", "504", "500",
        ))
        if not retryable or attempt == tries:
            break
        wait = min(2 ** attempt, 20)
        print("        [retry %d/%d] %s  -> %.0fs 后重试" % (attempt, tries, last.splitlines()[-1][:70], wait))
        import time as _t
        _t.sleep(wait)
    raise RuntimeError("gh api %s %s failed: %s" % (method, path, last))


def parse_person(line):
    """'Name <mail> 1700000000 +0800' -> (name, email, iso8601)"""
    head, _, tail = line.rpartition("> ")
    name, _, email = head.partition(" <")
    epoch, _, tz = tail.partition(" ")
    tz = tz.strip()
    import datetime as _dt
    sign = 1 if tz.startswith("+") else -1
    oh, om = int(tz[1:3]), int(tz[3:5])
    off = _dt.timedelta(hours=oh, minutes=om) * sign
    dt = _dt.datetime.fromtimestamp(int(epoch), _dt.timezone(off))
    return name.strip(), email.strip(), dt.isoformat()


def read_commit(sha):
    raw = git("cat-file", "-p", sha)
    head, _, message = raw.partition("\n\n")
    info = {"sha": sha, "tree": None, "parents": [], "author": None,
            "committer": None, "message": message}
    for line in head.splitlines():
        if line.startswith("tree "):
            info["tree"] = line[5:].strip()
        elif line.startswith("parent "):
            info["parents"].append(line[7:].strip())
        elif line.startswith("author "):
            info["author"] = parse_person(line[7:])
        elif line.startswith("committer "):
            info["committer"] = parse_person(line[10:])
    return info


def tree_entries(sha):
    """flatten 递归树 -> [(path, mode, blob_sha)]"""
    out = []
    for line in git("ls-tree", "-r", "-z", sha).split("\0"):
        if not line.strip():
            continue
        meta, path = line.split("\t", 1)
        mode, typ, obj = meta.split(" ")
        if typ == "blob":
            out.append((path, mode, obj))
    return out


def main():
    ap = argparse.ArgumentParser(description="用 Git Data API 把本地提交推上 GitHub")
    ap.add_argument("--repo", required=True, help="owner/name")
    ap.add_argument("--ref", default="main")
    ap.add_argument("--from", dest="start", default=None,
                    help="从这个祖先开始推（默认推全部历史直到 HEAD）")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if a.start:
        revs = git("rev-list", "--reverse", "%s..HEAD" % a.start).split()
    else:
        revs = git("rev-list", "--reverse", "HEAD").split()
    if not revs:
        print("没有要推的提交")
        return 1

    print("仓库   %s" % a.repo)
    print("分支   %s" % a.ref)
    print("提交   %d 个，从 %s 到 %s" % (len(revs), revs[0][:8], revs[-1][:8]))
    print("=" * 62)

    blob_cache = {}
    api_calls = 0

    for idx, sha in enumerate(revs, 1):
        c = read_commit(sha)
        entries = tree_entries(c["tree"])
        print("\n[%d/%d] %s  %s" % (idx, len(revs), sha[:8], c["message"].splitlines()[0][:50]))
        print("      %d 个文件" % len(entries))

        if a.dry_run:
            continue

        tree_items = []
        for path, mode, obj in entries:
            if obj not in blob_cache:
                data = git("cat-file", "blob", obj, binary=True)
                if not data:
                    # GitHub 的 blobs API 对空内容直接报 malformed，
                    # 而空 blob 的 sha 是可算的，不用走网络。
                    blob_cache[obj] = subprocess.run(
                        ["git", "hash-object", "-t", "blob", "--stdin"],
                        cwd=ROOT, input=b"", capture_output=True
                    ).stdout.decode().strip()
                else:
                    try:
                        r = gh_api("/repos/%s/git/blobs" % a.repo, "POST",
                                   {"content": base64.b64encode(data).decode("ascii"),
                                    "encoding": "base64"})
                    except RuntimeError as e:
                        raise RuntimeError("%s  (文件: %s, %d 字节)" % (e, path, len(data)))
                    api_calls += 1
                    blob_cache[obj] = r["sha"]
                    if len(blob_cache) % 20 == 0:
                        print("        ... 已上传 %d 个 blob" % len(blob_cache))
            tree_items.append({"path": path, "mode": mode, "type": "blob", "sha": blob_cache[obj]})

        t = gh_api("/repos/%s/git/trees" % a.repo, "POST", {"tree": tree_items})
        api_calls += 1

        payload = {"message": c["message"], "tree": t["sha"]}
        if c["parents"]:
            payload["parents"] = c["parents"]
        an, ae, ad = c["author"]
        cn, ce, cd = c["committer"]
        payload["author"] = {"name": an, "email": ae, "date": ad}
        payload["committer"] = {"name": cn, "email": ce, "date": cd}

        cm = gh_api("/repos/%s/git/commits" % a.repo, "POST", payload)
        api_calls += 1

        if cm["sha"] != sha:
            print("      [!!] SHA 不一致：本地 %s / 远端 %s" % (sha[:12], cm["sha"][:12]))
            print("           本地与远端会出现两份历史，需要 git fetch + reset 对齐")
        else:
            print("      [ok] SHA 复刻一致 %s" % sha[:12])

        last = cm["sha"]

    if a.dry_run:
        print("\n(dry-run，什么都没写)")
        return 0

    try:
        gh_api("/repos/%s/git/refs" % a.repo, "POST",
               {"ref": "refs/heads/%s" % a.ref, "sha": last})
        print("\n[ok] 新建 refs/heads/%s -> %s" % (a.ref, last[:12]))
    except RuntimeError as e:
        if "already exists" not in str(e) and "422" not in str(e):
            raise
        # 空仓库要先有东西才能建 blob，所以通常先垫过一个占位提交；
        # 这里要把它顶掉，必须是 force（我们的提交跟占位提交没有祖先关系）。
        gh_api("/repos/%s/git/refs/heads/%s" % (a.repo, a.ref), "PATCH",
               {"sha": last, "force": True})
        print("\n[ok] 更新 refs/heads/%s -> %s（force）" % (a.ref, last[:12]))

    print("API 调用 %d 次（blob %d 个）" % (api_calls, len(blob_cache)))
    print("https://github.com/%s" % a.repo)
    return 0


if __name__ == "__main__":
    sys.exit(main())
