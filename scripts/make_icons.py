"""Draw Narra's app icon (1024px, fed to `tauri icon`) and the menu-bar template icon.

The mark is a five-petal narra blossom (the Philippine national tree has small golden
flowers) whose center is a clock face. Pure stdlib: shapes are signed-distance
functions, antialiased by coverage.
"""
import math
import struct
import sys
import zlib
from pathlib import Path

PETALS = 5


def write_png(path, size, pixels):
    raw = b"".join(b"\x00" + bytes(pixels[y * size * 4:(y + 1) * size * 4]) for y in range(size))
    chunk = lambda tag, data: struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def sd_round_rect(x, y, half, radius):
    qx, qy = abs(x) - half + radius, abs(y) - half + radius
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - radius


def sd_segment(x, y, ax, ay, bx, by, r):
    px, py, dx, dy = x - ax, y - ay, bx - ax, by - ay
    t = max(0.0, min(1.0, (px * dx + py * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - dx * t, py - dy * t) - r


def sd_petals(x, y, dist, radius):
    """Union of PETALS rounded petals: circles on a ring, stretched outward into ovals."""
    best = 1e9
    for k in range(PETALS):
        a = math.radians(k * 360 / PETALS)
        ux, uy = math.sin(a), -math.cos(a)
        # Petal-local coords: u along the petal axis, v across it.
        u = (x * ux + y * uy) - dist
        v = -x * uy + y * ux
        best = min(best, math.hypot(u * 0.78, v) - radius * 0.9)
    return best


def sd_hands(x, y, s):
    """Hour hand toward 10 o'clock, minute hand toward 12."""
    a = math.radians(-60)
    hour = sd_segment(x, y, 0, 0, math.sin(a) * 0.55 * s, -math.cos(a) * 0.55 * s, 0.12 * s)
    minute = sd_segment(x, y, 0, 0, 0, -0.8 * s, 0.1 * s)
    return min(hour, minute)


def cover(d, px):
    return max(0.0, min(1.0, 0.5 - d / px))


def mix(a, b, t):
    return [a[k] + (b[k] - a[k]) * t for k in range(3)]


def app_icon(size):
    px = 2.0 / size
    out = bytearray(size * size * 4)
    wood_top, wood_bottom = (0xB4, 0x4A, 0x24), (0x6B, 0x21, 0x0F)
    petal_light, petal_dark = (0xFF, 0xD8, 0x5C), (0xF2, 0xA9, 0x1E)
    cream, ink = (0xFF, 0xF6, 0xE0), (0x6B, 0x21, 0x0F)
    for j in range(size):
        y = (j + 0.5) / size * 2 - 1
        for i in range(size):
            x = (i + 0.5) / size * 2 - 1
            a_bg = cover(sd_round_rect(x, y, 0.82, 0.19), px)
            if a_bg == 0:
                continue
            r = math.hypot(x, y)
            rgb = mix(wood_top, wood_bottom, (y + 1) / 2)
            # Soft shadow under the flower.
            shadow = cover(sd_petals(x, y - 0.03, 0.3, 0.27) - 0.02, 0.08)
            rgb = mix(rgb, (0x3A, 0x10, 0x05), 0.35 * shadow)
            petals = cover(sd_petals(x, y, 0.3, 0.27), px)
            rgb = mix(rgb, mix(petal_light, petal_dark, min(1.0, r / 0.6)), petals)
            # Petal veins: thin darker lines along each petal axis.
            vein = 1e9
            for k in range(PETALS):
                a = math.radians(k * 360 / PETALS)
                vein = min(vein, sd_segment(x, y, math.sin(a) * 0.2, -math.cos(a) * 0.2,
                                            math.sin(a) * 0.46, -math.cos(a) * 0.46, 0.006))
            rgb = mix(rgb, petal_dark, 0.8 * cover(vein, px) * petals)
            face = cover(r - 0.2, px)
            rgb = mix(rgb, cream, face)
            hands = max(cover(sd_hands(x, y, 0.17), px), cover(r - 0.028, px))
            rgb = mix(rgb, ink, hands * face)
            o = (j * size + i) * 4
            out[o:o + 4] = bytes([round(rgb[0]), round(rgb[1]), round(rgb[2]), round(255 * a_bg)])
    return out


def tray_icon(size):
    """Template image: solid blossom with the clock face cut out and hands inside."""
    px = 2.0 / size
    out = bytearray(size * size * 4)
    for j in range(size):
        y = (j + 0.5) / size * 2 - 1
        for i in range(size):
            x = (i + 0.5) / size * 2 - 1
            r = math.hypot(x, y)
            blossom = cover(sd_petals(x, y, 0.5, 0.46), px)
            hole = cover(r - 0.36, px)
            hands = max(cover(sd_hands(x, y, 0.3), px), cover(r - 0.06, px))
            alpha = blossom * (1 - hole) + hands * hole
            o = (j * size + i) * 4
            out[o:o + 4] = bytes([0, 0, 0, round(255 * alpha)])
    return out


if __name__ == "__main__":
    icons = Path(sys.argv[1] if len(sys.argv) > 1 else "src-tauri/icons")
    icons.mkdir(parents=True, exist_ok=True)
    write_png(icons / "app-icon.png", 1024, app_icon(1024))
    write_png(icons / "tray.png", 64, tray_icon(64))
    print("wrote", icons / "app-icon.png", icons / "tray.png")
