# -*- coding: utf-8 -*-
"""生成 Grok Build Pager 自己的应用图标（.png + .ico）。

为什么不用第三方库：本机没装 Pillow / cairosvg，而图标只是「圆角方板 + 一颗灯 + 一条槽」
这么点几何 —— 手写一个 PNG/ICO 编码器比装依赖干净，而且完全离线可复现。

做法：4 倍超采样 + 盒式降采样（先乘 alpha 再平均，避免边缘发黑）。

用法：
    python tools/make_icon.py            # 生成 assets/icon/ 下的 png + ico
    python tools/make_icon.py --verify   # 只校验已生成的文件
"""
from __future__ import annotations

import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "assets", "icon")

SS = 4          # 超采样倍数
SIZES = (256, 128, 64, 48, 32, 24, 16)

# ── 设计参数（256 空间，跟 assets/icon.svg 保持一致）────────────────────────
PLATE = (8.0, 8.0, 240.0, 240.0, 56.0)        # x, y, w, h, r
PLATE_TOP = (0x1B, 0x22, 0x30)
PLATE_BOT = (0x0B, 0x0E, 0x13)
RING = (9.0, 9.0, 238.0, 238.0, 55.0, 2.0)    # + 线宽
RING_COLOR = (0x2C, 0x35, 0x46)
DOT = (128.0, 112.0, 32.0)
DOT_COLOR = (0xFF, 0x6B, 0x4A)
HALO = (128.0, 112.0, 76.0, 0.62)
SLOT = (76.0, 176.0, 104.0, 20.0, 10.0)
SLOT_COLOR = (0x4A, 0x55, 0x68)


# ── 几何 ──────────────────────────────────────────────────────────────────
def sd_round_rect(px, py, x, y, w, h, r):
    """圆角矩形的有符号距离：<0 在内部。"""
    cx, cy = x + w / 2.0, y + h / 2.0
    bx, by = w / 2.0 - r, h / 2.0 - r
    qx = abs(px - cx) - bx
    qy = abs(py - cy) - by
    ox, oy = max(qx, 0.0), max(qy, 0.0)
    return (ox * ox + oy * oy) ** 0.5 + min(max(qx, qy), 0.0) - r


def sd_circle(px, py, cx, cy, r):
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5 - r


def over(dst, srgb, sa):
    """source-over，全部按预乘 alpha 处理。dst = (r,g,b,a) 0..1。"""
    if sa <= 0.0:
        return dst
    sa = min(sa, 1.0)
    da = dst[3]
    oa = sa + da * (1.0 - sa)
    if oa <= 0.0:
        return (0.0, 0.0, 0.0, 0.0)
    k = 1.0 - sa
    return (
        srgb[0] * sa + dst[0] * k,
        srgb[1] * sa + dst[1] * k,
        srgb[2] * sa + dst[2] * k,
        oa,
    )


def _u8(c):
    return (c[0] / 255.0, c[1] / 255.0, c[2] / 255.0)


def render(size):
    """渲染一张 size×size 的 RGBA 图（已降采样），返回 bytes。"""
    n = size * SS
    s = 256.0 / n                      # 超采样空间 -> 设计空间
    px = bytearray(size * size * 4)

    # 先把每个超采样像素算成预乘 alpha 的 float 累加桶
    acc = [[0.0, 0.0, 0.0, 0.0] for _ in range(size * size)]

    plate_top, plate_bot = _u8(PLATE_TOP), _u8(PLATE_BOT)
    ring_c, dot_c, slot_c = _u8(RING_COLOR), _u8(DOT_COLOR), _u8(SLOT_COLOR)

    for sy in range(n):
        dy = sy * s
        for sx in range(n):
            dx = sx * s
            c = (0.0, 0.0, 0.0, 0.0)

            # 1. 底板（竖向渐变）
            if sd_round_rect(dx, dy, *PLATE) <= 0.0:
                t = min(max((dy - PLATE[1]) / PLATE[3], 0.0), 1.0)
                col = (
                    plate_top[0] + (plate_bot[0] - plate_top[0]) * t,
                    plate_top[1] + (plate_bot[1] - plate_top[1]) * t,
                    plate_top[2] + (plate_bot[2] - plate_top[2]) * t,
                )
                c = over(c, col, 1.0)

            # 2. 内描边
            d = sd_round_rect(dx, dy, *RING[:5])
            if abs(d) <= RING[5] / 2.0:
                c = over(c, ring_c, 1.0)

            # 3. 光晕（径向）
            rr = ((dx - HALO[0]) ** 2 + (dy - HALO[1]) ** 2) ** 0.5
            if rr < HALO[2]:
                k = 1.0 - (rr / HALO[2])
                a = HALO[3] * k * k
                c = over(c, dot_c, a)

            # 4. 灯
            if sd_circle(dx, dy, *DOT) <= 0.0:
                c = over(c, dot_c, 1.0)

            # 5. 槽
            if sd_round_rect(dx, dy, *SLOT) <= 0.0:
                c = over(c, slot_c, 1.0)

            bx, by = sx // SS, sy // SS
            i = by * size + bx
            a = acc[i]
            a[0] += c[0]
            a[1] += c[1]
            a[2] += c[2]
            a[3] += c[3]

    inv = 1.0 / (SS * SS)
    for i in range(size * size):
        a = acc[i]
        al = a[3] * inv
        o = i * 4
        if al <= 0.0005:
            px[o:o + 4] = b"\x00\x00\x00\x00"
            continue
        # 反预乘
        r = a[0] * inv / al
        g = a[1] * inv / al
        b = a[2] * inv / al
        px[o]     = max(0, min(255, int(r * 255.0 + 0.5)))
        px[o + 1] = max(0, min(255, int(g * 255.0 + 0.5)))
        px[o + 2] = max(0, min(255, int(b * 255.0 + 0.5)))
        px[o + 3] = max(0, min(255, int(al * 255.0 + 0.5)))
    return bytes(px)


# ── 编码器 ────────────────────────────────────────────────────────────────
def _chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def png_bytes(w, h, rgba):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)                      # filter: None
        raw += rgba[y * stride:(y + 1) * stride]
    return (b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + _chunk(b"IEND", b""))


def ico_bytes(entries):
    """entries: [(size, png_bytes)] 从小到大。用 PNG 内嵌（Vista+ 支持）。"""
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


def main(argv):
    os.makedirs(OUT, exist_ok=True)
    if "--verify" in argv:
        return verify()

    print("渲染 %s" % ", ".join("%dpx" % s for s in SIZES))
    entries = []
    for size in SIZES:
        rgba = render(size)
        blob = png_bytes(size, size, rgba)
        with open(os.path.join(OUT, "pager-%d.png" % size), "wb") as f:
            f.write(blob)
        entries.append((size, blob))
        print("  pager-%-3d.png  %6d bytes" % (size, len(blob)))

    entries.sort(key=lambda e: e[0])
    ico = ico_bytes(entries)
    ico_path = os.path.join(OUT, "pager.ico")
    with open(ico_path, "wb") as f:
        f.write(ico)
    print("  pager.ico        %6d bytes  (%d 个尺寸)" % (len(ico), len(entries)))
    return verify()


def verify():
    ok = True
    ico_path = os.path.join(OUT, "pager.ico")
    if not os.path.exists(ico_path):
        print("FAIL 缺 %s" % ico_path)
        return 1
    d = open(ico_path, "rb").read()
    reserved, kind, count = struct.unpack("<HHH", d[:6])
    if (reserved, kind) != (0, 1):
        print("FAIL ico 头不对")
        return 1
    print("校验 pager.ico：%d 个尺寸" % count)
    for i in range(count):
        w, h, _, _, planes, bpp, size, off = struct.unpack("<BBBBHHII", d[6 + i * 16:22 + i * 16])
        blob = d[off:off + size]
        good = blob[:8] == b"\x89PNG\r\n\x1a\n"
        wpx = w or 256
        print("  %-4d×%-4d  bpp=%-3d %6d bytes  PNG=%s" % (wpx, h or 256, bpp, size, "是" if good else "否"))
        ok = ok and good and bpp == 32
    print("OK" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
