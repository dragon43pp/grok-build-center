# -*- coding: utf-8 -*-
"""生成 Grok Build Center 的托盘 / 应用图标资产（resources/tray/）。

为什么自己算像素：本机没装 Pillow，而图标只有两个形状（一颗灯 + 一条槽）。
沿用上游「纯 Python 手写 PNG/ICO 编码器」的做法，零依赖、离线可复现。

产物分两类 —— 这个区分很容易搞错，所以写在这里：

  单色托盘图标（黑 / 白），文件名必须严格匹配 `electron/icon-theme.ts` 的
  `${basename}-16.png` 规则，basename ∈ {gbc, gbc-white, gbcTemplate}：
      gbc-{16,32,256}.png            黑，浅色任务栏用
      gbc-white-{16,32,256}.png      白，深色任务栏用
      gbcTemplate-{16,32}.png        黑 + alpha，macOS 菜单栏模板图
      gbc.ico / gbc-white.ico        上面两组各自打包

  彩色应用图标（方板 + 珊瑚灯），直接取品牌源图 `brand/icon/`：
      gbc-app-16.png / gbc-app-32.png / gbc-app.ico

  托盘里显示的是**彩色应用图标**（Windows/Linux 走 createCenterAppIcon），
  单色那套只有 macOS 的 createThemedCenterIcon 会读 —— 但构建门禁要求全在，
  所以两组都得生成。

用法：
    python tools/make_brand_icons.py            # 生成 + 校验
    python tools/make_brand_icons.py --verify   # 只校验
"""
from __future__ import annotations

import os
import shutil
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TRAY = os.path.join(ROOT, "resources", "tray")
BRAND_ICON = os.path.join(ROOT, "brand", "icon")

SS = 4                      # 超采样倍数
MONO_SIZES = (16, 32, 256)  # 单色托盘图标尺寸（ico 也按这三个打包）
ICO_SIZES = (16, 32, 48, 64, 128, 256)

# ── 设计参数（256 设计空间）──────────────────────────────────────────────
# 「一颗灯 + 一条槽」：品牌规范里「图标里只留一颗灯」的直接翻译。
# 托盘要能在 16px 被认出来，所以只保留这两个最粗的元素，不要方板。
LAMP = (128.0, 96.0, 52.0)            # cx, cy, r
SLOT = (42.0, 176.0, 172.0, 42.0, 21.0)  # x, y, w, h, r


def sd_round_rect(px, py, x, y, w, h, r):
    """圆角矩形的有符号距离。<0 表示在内部。"""
    cx, cy = x + w / 2.0, y + h / 2.0
    bx, by = w / 2.0 - r, h / 2.0 - r
    qx = abs(px - cx) - bx
    qy = abs(py - cy) - by
    ox, oy = max(qx, 0.0), max(qy, 0.0)
    return (ox * ox + oy * oy) ** 0.5 + min(max(qx, qy), 0.0) - r


def sd_circle(px, py, cx, cy, r):
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5 - r


def inside(x, y):
    if sd_circle(x, y, *LAMP) <= 0.0:
        return True
    return sd_round_rect(x, y, *SLOT) <= 0.0


def render_mono(size, level):
    """渲染 size×size 的单色图：RGB=level，alpha=形状覆盖率。返回 RGBA bytes。"""
    n = size * SS
    step = 256.0 / n
    acc = bytearray(size * size)          # 每个目标像素的 alpha 累加
    for sy in range(n):
        y = sy * step
        for sx in range(n):
            if inside(sx * step, y):
                acc[(sy // SS) * size + (sx // SS)] += 1
    inv = 255.0 / (SS * SS)
    out = bytearray(size * size * 4)
    for i, hits in enumerate(acc):
        a = int(hits * inv + 0.5)
        o = i * 4
        if a == 0:
            continue
        out[o] = level
        out[o + 1] = level
        out[o + 2] = level
        out[o + 3] = a
    return bytes(out)


# ── 编码器 ──────────────────────────────────────────────────────────────
def _chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def png_bytes(w, h, rgba):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)                     # filter: None
        raw += rgba[y * stride:(y + 1) * stride]
    return (b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + _chunk(b"IEND", b""))


def ico_bytes(entries):
    """entries: [(size, png_blob)]，内部按尺寸升序写出。PNG 内嵌（Vista+ 支持）。"""
    entries = sorted(entries, key=lambda e: e[0])
    n = len(entries)
    out = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16 * n
    dirs, blobs = bytearray(), bytearray()
    for size, blob in entries:
        dim = 0 if size >= 256 else size
        dirs += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        blobs += blob
        offset += len(blob)
    return out + bytes(dirs) + bytes(blobs)


# ── 产物清单 ────────────────────────────────────────────────────────────
def mono_pngs(level):
    return {"%d" % s: png_bytes(s, s, render_mono(s, level)) for s in MONO_SIZES}


def ico_from(level):
    return ico_bytes([
        (s, png_bytes(s, s, render_mono(s, level))) for s in ICO_SIZES
    ])


APP_COPIES = {
    "gbc-app-16.png": "center-16.png",
    "gbc-app-32.png": "center-32.png",
    "gbc-app.ico": "center.ico",
}


def expected_names():
    names = []
    for s in MONO_SIZES:
        names.append("gbc-%d.png" % s)
        names.append("gbc-white-%d.png" % s)
    names += ["gbcTemplate-16.png", "gbcTemplate-32.png"]
    names += ["gbc.ico", "gbc-white.ico"]
    names += sorted(APP_COPIES)
    return names


def build():
    os.makedirs(TRAY, exist_ok=True)
    print("生成单色托盘图标（一颗灯 + 一条槽）")

    black = mono_pngs(0)
    white = mono_pngs(255)
    for size, blob in black.items():
        open(os.path.join(TRAY, "gbc-%s.png" % size), "wb").write(blob)
        print("  gbc-%-9s %6d bytes" % (size + ".png", len(blob)))
    for size, blob in white.items():
        open(os.path.join(TRAY, "gbc-white-%s.png" % size), "wb").write(blob)
        print("  gbc-white-%-9s %6d bytes" % (size + ".png", len(blob)))

    # macOS template image：黑色 + alpha，系统按菜单栏明暗自动反色
    for size in (16, 32):
        shutil.copyfile(os.path.join(TRAY, "gbc-%d.png" % size),
                        os.path.join(TRAY, "gbcTemplate-%d.png" % size))
        print("  gbcTemplate-%-4s （取 gbc-%d.png）" % ("%d.png" % size, size))

    for name, blob in (("gbc.ico", ico_from(0)), ("gbc-white.ico", ico_from(255))):
        open(os.path.join(TRAY, name), "wb").write(blob)
        print("  %-16s %6d bytes  (%d 个尺寸)" % (name, len(blob), len(ICO_SIZES)))

    print("复制彩色应用图标（品牌源图 brand/icon/）")
    for dest, source in sorted(APP_COPIES.items()):
        src = os.path.join(BRAND_ICON, source)
        if not os.path.exists(src):
            raise SystemExit("缺少品牌源图 %s —— 先跑 tools/make_icon.py" % src)
        shutil.copyfile(src, os.path.join(TRAY, dest))
        print("  %-18s <- brand/icon/%s" % (dest, source))
    return verify()


def verify():
    ok = True
    print("\n校验 resources/tray/")
    for name in expected_names():
        path = os.path.join(TRAY, name)
        if not os.path.exists(path):
            print("  FAIL 缺 %s" % name)
            ok = False
    for name in ("gbc.ico", "gbc-white.ico", "gbc-app.ico"):
        path = os.path.join(TRAY, name)
        if not os.path.exists(path):
            continue
        d = open(path, "rb").read()
        reserved, kind, count = struct.unpack("<HHH", d[:6])
        if (reserved, kind) != (0, 1):
            print("  FAIL %s ico 头不对" % name)
            ok = False
            continue
        for i in range(count):
            _, _, _, _, _, bpp, size, off = struct.unpack(
                "<BBBBHHII", d[6 + i * 16:22 + i * 16])
            if d[off:off + 8] != b"\x89PNG\r\n\x1a\n" or bpp != 32:
                print("  FAIL %s 第 %d 个条目不是 32bpp PNG" % (name, i))
                ok = False
        print("  %-16s %d 个尺寸，全部为 32bpp PNG" % (name, count))

    # 上游遗留的 hrack-* 图标必须清掉：extraResources 会整目录打进安装包，
    # 留着就等于把别人的 logo 装进我们的产品里。
    stale = sorted(n for n in os.listdir(TRAY)
                   if n.lower().startswith("hrack"))
    if stale:
        print("  FAIL 仍有上游图标残留：%s" % ", ".join(stale))
        ok = False

    print("OK" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(verify() if "--verify" in sys.argv else build())
