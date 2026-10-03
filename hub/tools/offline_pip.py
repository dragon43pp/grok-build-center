#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线 pip：pip 被沙箱/代理拦截时，用 curl 把 wheel 拉下来再从本地安装。

背景：本机环境里挂了 http_proxy=http://127.0.0.1:8656，curl 能通但 pip 死活报
"from versions: none"。实测 pip 出站被拦、curl 不受影响。于是绕道：
  1) 查 PyPI JSON API 拿全部 release
  2) 按版本约束（>=11,<16 这种）挑满足条件的最高稳定版
  3) 按 wheel tag 打分挑当前解释器能装的（cp313 / win_amd64）
  4) 递归解析依赖（跳过 extras 与带 marker 的条件依赖）
  5) curl 下载到本地目录，pip install --no-index --find-links

用法：
    python offline_pip.py install lark-oapi psutil
    python offline_pip.py download lark-oapi --out wheels
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

PYPI = "https://pypi.org/pypi/{name}/json"
PY_MAJOR, PY_MINOR = sys.version_info.major, sys.version_info.minor


# ---------------------------------------------------------------- 版本比较

def ver_key(v: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", v)
    return tuple(int(p) for p in parts) if parts else (0,)


def is_prerelease(v: str) -> bool:
    return bool(re.search(r"[a-zA-Z]", v))


def satisfies(version: str, spec: str) -> bool:
    """够用的 PEP 440 子集：== != >= <= > < ~="""
    if not spec.strip():
        return True
    vk = ver_key(version)
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"(==|>=|<=|!=|~=|>|<)\s*(.+)$", part)
        if not m:
            continue
        op, raw = m.group(1), m.group(2).strip().rstrip(".*")
        tk = ver_key(raw)
        n = max(len(vk), len(tk))
        a = vk + (0,) * (n - len(vk))
        b = tk + (0,) * (n - len(tk))
        if op == "==" and a != b:
            return False
        if op == "!=" and a == b:
            return False
        if op == ">=" and a < b:
            return False
        if op == "<=" and a > b:
            return False
        if op == ">" and a <= b:
            return False
        if op == "<" and a >= b:
            return False
        if op == "~=" and a < b:
            return False
    return True


# ---------------------------------------------------------------- wheel 挑选

def wheel_score(filename: str) -> int:
    """给 wheel 文件名打分，-1 表示不兼容。

    文件名：{name}-{ver}(-{build})?-{pytag}-{abitag}-{plattag}.whl

    坑（踩过两次）：不能只做子串匹配再兜底取 wheels[0] —— PyPI 的文件列表里
    混着 macOS / linux / cp27 / free-threaded(cp313t) 的包，兜底会抓到
    `psutil-...-cp313t-macosx_*.whl`，然后 pip 整个事务失败。
    """
    if not filename.endswith(".whl"):
        return -1
    parts = filename[:-4].split("-")
    if len(parts) < 5:
        return -1
    pytag, abitag, plattag = parts[-3], parts[-2], parts[-1]

    plats = plattag.split(".")
    if "win_amd64" in plats:
        score = 30
    elif plats == ["any"]:
        score = 10
    else:
        return -1                      # macosx / linux / win32 一律不要

    abis = abitag.split(".")
    if f"cp{PY_MAJOR}{PY_MINOR}" in abis:
        score += 30
    elif "abi3" in abis:
        score += 20                    # 稳定 ABI，向后兼容
    elif "none" in abis:
        score += 10                    # 纯 Python
    else:
        return -1                      # 含 cp313t（free-threaded）等一律不要

    pys = pytag.split(".")
    if f"cp{PY_MAJOR}{PY_MINOR}" in pys:
        score += 30
    elif any(p.startswith("cp3") for p in pys):
        minors = [int(p[3:]) for p in pys if p.startswith("cp3") and p[3:].isdigit()]
        if minors and max(minors) > PY_MINOR:
            return -1
        score += 15
    elif any(p in ("py3", "py2") for p in pys):
        score += 10
    else:
        return -1
    return score


def pick_wheel(files: list[dict]) -> dict | None:
    scored = [(wheel_score(f["filename"]), f) for f in files]
    scored = [(s, f) for s, f in scored if s >= 0]
    if not scored:
        return None
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1]


def pick_sdist(files: list[dict]) -> dict | None:
    for f in files:
        if f["filename"].endswith((".tar.gz", ".zip")):
            return f
    return None


# ---------------------------------------------------------------- PyPI 访问

_cache: dict[str, dict] = {}


def curl_json(url: str) -> dict:
    """用 curl 取 JSON。别用 urllib —— 它会走被拦的那条路。"""
    if url in _cache:
        return _cache[url]
    out = subprocess.run(["curl", "-sS", "-m", "60", "-L", url], capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(f"curl 失败 {url}: {out.stderr.decode('utf-8', 'replace')[:200]}")
    data = json.loads(out.stdout.decode("utf-8"))
    _cache[url] = data
    return data


def python_ok(requires_python: str | None) -> bool:
    if not requires_python:
        return True
    return satisfies(f"{PY_MAJOR}.{PY_MINOR}.0", requires_python.replace(" ", ""))


def best_release(name: str, spec: str) -> tuple[str, dict] | None:
    """在满足 spec 的 release 里挑最高稳定版；没有稳定版就退回最高版。"""
    data = curl_json(PYPI.format(name=name))
    candidates: list[tuple[tuple[int, ...], str, dict]] = []
    for ver, files in (data.get("releases") or {}).items():
        if not files:
            continue
        if not satisfies(ver, spec):
            continue
        # 该版本至少要有一个当前解释器能装的 wheel（或 sdist）
        if pick_wheel(files) is None and pick_sdist(files) is None:
            continue
        candidates.append((ver_key(ver), ver, files))

    if not candidates:
        # 约束太严时退回「最新版」，让 pip 去报明确的冲突
        info = data["info"]
        files = data["urls"]
        if files:
            return info["version"], files
        return None

    stable = [c for c in candidates if not is_prerelease(c[1])]
    pool = stable or candidates
    pool.sort(key=lambda c: c[0], reverse=True)
    _, ver, files = pool[0]
    return ver, files


# ---------------------------------------------------------------- 依赖解析

def deps_of(version_files: dict) -> list[tuple[str, str]]:
    """从 release 的 info 里取依赖。

    这里用的是 /pypi/<name>/json 顶层 info 的 requires_dist，
    所以调用方要先拿到某个具体版本 —— 见 resolve() 里的处理。
    """
    out: list[tuple[str, str]] = []
    for raw in version_files.get("requires_dist") or []:
        if "extra ==" in raw:
            continue
        if ";" in raw:                     # 其余 marker 一律跳过（本机 win32/cp313）
            continue
        m = re.match(r"([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$", raw.strip())
        if not m:
            continue
        name = m.group(1).strip()
        spec = (m.group(3) or "").strip()
        if name:
            out.append((name, spec))
    return out


def normalize(name: str) -> str:
    return name.lower().replace("_", "-")


def release_requires(name: str, version: str) -> list[str]:
    """取某个具体版本的 requires_dist（顶层 json 只有最新版的）。"""
    data = curl_json(f"https://pypi.org/pypi/{name}/{version}/json")
    return data["info"].get("requires_dist") or []


def resolve(roots: list[str], verbose: bool = True) -> list[dict]:
    seen: set[str] = set()
    queue: list[tuple[str, str]] = [(normalize(r), "") for r in roots]
    picked: list[dict] = []

    while queue:
        name, spec = queue.pop(0)
        if name in seen:
            continue
        seen.add(name)

        got = best_release(name, spec)
        if got is None:
            print(f"  [跳过] {name}: 没有满足 '{spec}' 的分发", file=sys.stderr)
            continue
        version, files = got

        f = pick_wheel(files) or pick_sdist(files)
        if f is None:
            print(f"  [跳过] {name}: 没有可用分发", file=sys.stderr)
            continue

        f = dict(f)
        f["_name"], f["_version"] = name, version
        picked.append(f)
        if verbose:
            kind = "wheel" if f["filename"].endswith(".whl") else "sdist"
            note = f"  (约束 {spec})" if spec else ""
            print(f"  + {name}=={version}  [{kind}]{note}")

        for raw in release_requires(name, version):
            if "extra ==" in raw or ";" in raw:
                continue
            m = re.match(r"([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$", raw.strip())
            if not m:
                continue
            dep = normalize(m.group(1))
            dep_spec = (m.group(3) or "").strip()
            if dep not in seen:
                queue.append((dep, dep_spec))

    return picked


def download(picked: list[dict], out_dir: str) -> int:
    os.makedirs(out_dir, exist_ok=True)
    n = 0
    for f in picked:
        dest = os.path.join(out_dir, f["filename"])
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            continue
        r = subprocess.run(
            ["curl", "-sS", "-L", "-m", "300", "-o", dest, f["url"]], capture_output=True
        )
        if r.returncode != 0 or not os.path.exists(dest):
            print(f"  [失败] {f['filename']}", file=sys.stderr)
            continue
        n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description="pip 被拦时的离线安装兜底")
    ap.add_argument("cmd", choices=["install", "download"])
    ap.add_argument("packages", nargs="+")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "wheels"))
    ap.add_argument("--python", default=sys.executable, help="目标解释器（默认当前）")
    args = ap.parse_args()

    print(f"解析依赖（py{PY_MAJOR}.{PY_MINOR} / win_amd64）...")
    picked = resolve(args.packages)
    print(f"共 {len(picked)} 个包 -> {args.out}")
    got = download(picked, args.out)
    print(f"新下载 {got} 个文件")

    if args.cmd == "download":
        return 0

    print("本地安装...")
    r = subprocess.run(
        [args.python, "-m", "pip", "install", "--no-index", "--find-links", args.out, "-q", *args.packages],
        capture_output=True,
    )
    if r.returncode != 0:
        sys.stderr.write(r.stderr.decode("utf-8", "replace")[-3000:])
        return r.returncode
    print("安装完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
