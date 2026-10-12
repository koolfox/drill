#!/usr/bin/env python3
"""Generate the menu-bar / system-tray icons (pure stdlib: zlib + struct).

Outputs (app/overlay/):
  trayTemplate.png      16x16 black glyph  — macOS status item (template image)
  trayTemplate@2x.png   32x32 black glyph  — macOS retina
  tray.png              32x32 white glyph  — Windows / Linux tray (dark taskbar)

Shape: a microphone (teleprompter/voice), drawn with distance functions and
4x supersampling so the edges are antialiased.
"""
import math
import os
import struct
import zlib


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def seg(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / l2))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def inside(x, y):
    """x,y are in a 16x16 design space."""
    if seg(x, y, 8, 2.6, 8, 6.6) <= 2.4:  # microphone head
        return True
    d = math.hypot(x - 8, y - 6.6)
    if 3.4 <= d <= 4.5 and y >= 6.6:  # U bracket
        return True
    if seg(x, y, 8, 10.0, 8, 14.2) <= 0.9:  # stem
        return True
    if seg(x, y, 5.0, 14.6, 11.0, 14.6) <= 0.9:  # base
        return True
    return False


def render(size, color):
    ss = 4
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            hit = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) * 16.0 / size
                    y = (py + (sy + 0.5) / ss) * 16.0 / size
                    if inside(x, y):
                        hit += 1
            alpha = round(hit * 255 / (ss * ss))
            row.append((color[0], color[1], color[2], alpha))
        rows.append(row)
    return rows


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "overlay")
    write_png(os.path.join(out, "trayTemplate.png"), 16, render(16, (0, 0, 0)))
    write_png(os.path.join(out, "trayTemplate@2x.png"), 32, render(32, (0, 0, 0)))
    write_png(os.path.join(out, "tray.png"), 32, render(32, (255, 255, 255)))
    print("icons written to", os.path.normpath(out))


if __name__ == "__main__":
    main()
