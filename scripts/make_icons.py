"""Build Narra's icons from the pixel-art logo (src-tauri/icons/narra-source.png):

- app-icon.png (1024): the tree on a rounded cream tile, scaled nearest-neighbour so the
  pixel art stays crisp. Feed it to `npx tauri icon` for the .icns/.ico set.
- tray.png (64): menu-bar template image — the tree's silhouette with the clock hands and
  ticks cut out.
- ui/narra.png (256): the logo for the sidebar, onboarding and widget.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from pngio import read_png, write_png  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src-tauri/icons/narra-source.png'


def bbox(w, h, px):
    xs = [x for x in range(w) if any(px[(y * w + x) * 4 + 3] > 128 for y in range(0, h, 2))]
    ys = [y for y in range(h) if any(px[(y * w + x) * 4 + 3] > 128 for x in range(0, w, 2))]
    return xs[0], ys[0], xs[-1] + 1, ys[-1] + 1


def crop(w, px, box):
    x0, y0, x1, y1 = box
    cw, ch = x1 - x0, y1 - y0
    out = bytearray(cw * ch * 4)
    for y in range(ch):
        s = ((y0 + y) * w + x0) * 4
        out[y * cw * 4:(y + 1) * cw * 4] = px[s:s + cw * 4]
    return cw, ch, out


def sample_nearest(sw, sh, src, dw, dh):
    out = bytearray(dw * dh * 4)
    for y in range(dh):
        sy = min(sh - 1, int((y + 0.5) * sh / dh))
        for x in range(dw):
            sx = min(sw - 1, int((x + 0.5) * sw / dw))
            o, s = (y * dw + x) * 4, (sy * sw + sx) * 4
            out[o:o + 4] = src[s:s + 4]
    return out


def sample_area(sw, sh, src, dw, dh, value=None):
    """Box-filter downscale (premultiplied). value(px_index) -> alpha override for masks."""
    out = bytearray(dw * dh * 4)
    for y in range(dh):
        ya, yb = int(y * sh / dh), max(int(y * sh / dh) + 1, int((y + 1) * sh / dh))
        for x in range(dw):
            xa, xb = int(x * sw / dw), max(int(x * sw / dw) + 1, int((x + 1) * sw / dw))
            r = g = b = a = n = 0
            for yy in range(ya, yb):
                for xx in range(xa, xb):
                    i = (yy * sw + xx) * 4
                    al = src[i + 3] if value is None else value(i)
                    r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n += 1
            o = (y * dw + x) * 4
            if a:
                out[o:o + 3] = bytes((round(r / a), round(g / a), round(b / a)))
            out[o + 3] = round(a / n)
    return out


def rounded_tile(size, inset, radius, top, bottom):
    out = bytearray(size * size * 4)
    lo, hi = inset, size - inset
    for y in range(size):
        t = (y - lo) / (hi - lo)
        col = [round(top[k] + (bottom[k] - top[k]) * t) for k in range(3)]
        for x in range(size):
            dx = max(lo + radius - x, 0, x - (hi - radius) + 1)
            dy = max(lo + radius - y, 0, y - (hi - radius) + 1)
            d = (dx * dx + dy * dy) ** 0.5
            if x < lo or x >= hi or y < lo or y >= hi:
                continue
            cover = 1.0 if (dx == 0 or dy == 0) and d <= radius else max(0.0, min(1.0, radius - d + 0.5))
            if dx == 0 and dy == 0:
                cover = 1.0
            o = (y * size + x) * 4
            out[o:o + 4] = bytes(col + [round(255 * cover)])
    return out


def over(dst, size, src, sw, sh, ox, oy):
    for y in range(sh):
        for x in range(sw):
            s = (y * sw + x) * 4
            a = src[s + 3] / 255
            if a == 0:
                continue
            d = ((oy + y) * size + ox + x) * 4
            for k in range(3):
                dst[d + k] = round(src[s + k] * a + dst[d + k] * (1 - a))
            dst[d + 3] = max(dst[d + 3], src[s + 3])


def main():
    w, h, px = read_png(SRC)
    box = bbox(w, h, px)
    cw, ch, art = crop(w, px, box)

    # App icon: cream tile (macOS icon grid: 824px tile inside 1024), tree ~76% of the tile.
    size, inset = 1024, 100
    icon = rounded_tile(size, inset, 185, (0xFB, 0xF4, 0xE2), (0xEE, 0xE2, 0xC4))
    target = 640
    scale = target / max(cw, ch)
    tw, th = round(cw * scale), round(ch * scale)
    tree = sample_nearest(cw, ch, art, tw, th)
    over(icon, size, tree, tw, th, (size - tw) // 2, (size - th) // 2 + 14)
    write_png(ROOT / 'src-tauri/icons/app-icon.png', size, size, icon)

    # UI logo.
    side = max(cw, ch)
    sq = bytearray(side * side * 4)
    over(sq, side, art, cw, ch, (side - cw) // 2, (side - ch) // 2)
    write_png(ROOT / 'ui/narra.png', 256, 256, sample_area(side, side, sq, 256, 256))

    # Tray template: silhouette; cream clock marks (inside the canopy's centre) become holes.
    def cream(i):
        r, g, b = sq[i], sq[i + 1], sq[i + 2]
        return r > 200 and g > 190 and b > 150
    cx0, cy0, cx1, cy1 = int(side * 0.27), int(side * 0.18), int(side * 0.73), int(side * 0.62)

    def mask(i):
        p = i // 4
        x, y = p % side, p // side
        if cx0 <= x < cx1 and cy0 <= y < cy1 and cream(i):
            return 0
        return 255 if sq[i + 3] > 128 else 0
    tray = sample_area(side, side, sq, 64, 64, value=mask)
    for i in range(0, len(tray), 4):
        tray[i:i + 3] = b'\x00\x00\x00'
    write_png(ROOT / 'src-tauri/icons/tray.png', 64, 64, tray)
    print('wrote app-icon.png, tray.png, ui/narra.png')


if __name__ == '__main__':
    main()
