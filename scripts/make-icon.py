#!/usr/bin/env python3
"""Render public/apple-touch-icon.png from the same shapes as public/icon.svg.

iOS ignores SVG for home-screen icons, so the PWA needs one real PNG. Rather
than commit a binary nobody can edit, this regenerates it — stdlib only, no
Pillow, no ImageMagick, so it still runs on a fresh machine.

    python3 scripts/make-icon.py
"""

import struct
import zlib
from pathlib import Path

SIZE = 180
BG = (0x0D, 0x0D, 0x0F)
RED = (0xC4, 0x23, 0x28)
BLUE = (0x2E, 0x4F, 0xA8)
CIRCLES = [((72, 90, 52), RED), ((108, 90, 52), BLUE)]
SS = 4  # supersampling factor — cheap antialiasing


def coverage(cx, cy, r, x, y):
    """Fraction of pixel (x, y) inside the circle, by supersampling."""
    hits = 0
    for sy in range(SS):
        for sx in range(SS):
            px = x + (sx + 0.5) / SS
            py = y + (sy + 0.5) / SS
            if (px - cx) ** 2 + (py - cy) ** 2 <= r * r:
                hits += 1
    return hits / (SS * SS)


def render():
    rows = []
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            # Screen blend, matching mix-blend-mode:screen in the SVG:
            # result = 1 - (1-a)(1-b), so the overlap goes bright violet.
            acc = [0.0, 0.0, 0.0]
            for (cx, cy, r), colour in CIRCLES:
                cov = coverage(cx, cy, r, x, y)
                if not cov:
                    continue
                for i in range(3):
                    contribution = (colour[i] / 255) * cov * 0.95
                    acc[i] = 1 - (1 - acc[i]) * (1 - contribution)
            row += bytes(
                round(BG[i] + (255 - BG[i]) * acc[i] if acc[i] else BG[i]) for i in range(3)
            )
        rows.append(bytes(row))
    return rows


def png(rows):
    raw = b"".join(b"\x00" + row for row in rows)  # filter type 0 per scanline

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "public" / "apple-touch-icon.png"
    out.write_bytes(png(render()))
    print(f"wrote {out} ({out.stat().st_size} bytes)")
