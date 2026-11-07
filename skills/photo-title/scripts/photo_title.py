#!/usr/bin/env python3
"""Animated title whose letters are built from photos, one photo per stroke, snapping in.

    photo_title.py --photos <dir> --out <frames dir> (--mask traced.png | --font F.ttf --text 2026)
                   [--width 1920 --height 1080] [--height-frac 0.58] [--frames 105]
                   [--glyph-starts 6,22,40,54] [--step 3] [--sideways] [--seed 11]
                   [--first-frame-full] [--background 0,0,0] [--reuse 2=0]

The letter outline comes from a traced reference (trace_mask.py: the exact shape) or a font.
It is cleaned at 2x (dents filled, bumps shaved) and scaled down so edges come out smooth and
anti-aliased. Each glyph is split into strokes along its own edges: grid lines where the
glyph's outline changes, horizontal bars merged, vertical strokes merged, so seams follow the
lettering. Each stroke gets its own photo, cropped to fit (sideways with --sideways, as many
reels do), and strokes appear top to bottom, one every --step frames from each glyph's start.
Writes <frames dir>/title_0000.png ...; bake it with the MCP import_media bake=true.
"""
import argparse, glob, os, random
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


def clean(mask, size):
    """smooth, anti-aliased outline at `size`, via a 2x cleanup"""
    big = mask.resize((size[0] * 2, size[1] * 2), Image.LANCZOS).point(lambda v: 255 if v > 127 else 0)
    k = max(3, (min(big.size) // 60) | 1)
    pad = k * 2
    canvas = Image.new("L", (big.width + 2 * pad, big.height + 2 * pad), 0)
    canvas.paste(big, (pad, pad))
    canvas = canvas.filter(ImageFilter.MaxFilter(k)).filter(ImageFilter.MinFilter(k))
    canvas = canvas.filter(ImageFilter.MinFilter(k)).filter(ImageFilter.MaxFilter(k))
    canvas = canvas.filter(ImageFilter.GaussianBlur(k * 0.6)).point(lambda v: 255 if v > 127 else 0)
    canvas = canvas.crop((pad, pad, pad + big.width, pad + big.height))
    return canvas.resize(size, Image.LANCZOS)


def split_glyphs(mask, min_gap=3):
    cols = [any(mask.getpixel((x, y)) > 127 for y in range(0, mask.height, 2)) for x in range(mask.width)]
    spans, start = [], None
    for x, c in enumerate(cols + [False]):
        if c and start is None:
            start = x
        if not c and start is not None:
            spans.append([start, x]); start = None
    merged = []
    for s in spans:                       # bridge hairline gaps inside one glyph
        if merged and s[0] - merged[-1][1] < min_gap:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    return [tuple(s) for s in merged if s[1] - s[0] > mask.width * 0.02]


def grid_lines(m, axis):
    """positions where the glyph's cross-section changes: stroke and counter edges"""
    w, h = m.size
    n, length = (h, w) if axis == "y" else (w, h)
    prof = []
    for i in range(n):
        line = [m.getpixel((j, i)) > 127 if axis == "y" else m.getpixel((i, j)) > 127 for j in range(0, length, 2)]
        prof.append(line)
    lines, margin, tol = [], 0.07 * n, 0.08 * n
    for i in range(1, n):
        change = sum(a != b for a, b in zip(prof[i], prof[i - 1]))
        if change > 0.06 * len(prof[i]) and margin < i < n - margin:
            if lines and i - lines[-1] < tol:
                continue
            lines.append(i)
    return [0] + lines + [n]


def pieces(m):
    """strokes as rectangles: grid cells, bars merged across, strokes merged down"""
    ys, xs = grid_lines(m, "y"), grid_lines(m, "x")
    def filled(x0, y0, x1, y1):
        box = m.crop((x0, y0, x1, y1)).point(lambda v: 255 if v > 127 else 0)
        hist = box.histogram()
        return hist[255] > 0.15 * (x1 - x0) * (y1 - y0)
    rows = []
    for y0, y1 in zip(ys, ys[1:]):
        row, run = [], None
        for x0, x1 in zip(xs, xs[1:]):
            if filled(x0, y0, x1, y1):
                run = [run[0], y0, x1, y1] if run else [x0, y0, x1, y1]
            elif run:
                row.append(run); run = None
        if run:
            row.append(run)
        rows.append(row)
    out = []
    for row in rows:                      # merge a piece into the one above when they share x extent
        for p in row:
            above = next((q for q in out if q[0] == p[0] and q[2] == p[2] and q[3] == p[1]), None)
            if above:
                above[3] = p[3]
            else:
                out.append(list(p))
    # the first and last row bands reach the glyph's edges
    return sorted(out, key=lambda r: (r[1], r[0]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--photos", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mask")
    ap.add_argument("--font")
    ap.add_argument("--text")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--height-frac", type=float, default=0.58, help="letter height as a fraction of the frame")
    ap.add_argument("--frames", type=int, default=105)
    ap.add_argument("--glyph-starts", help="first frame of each glyph, comma separated")
    ap.add_argument("--step", type=float, default=3, help="frames between strokes")
    ap.add_argument("--sideways", action="store_true")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--first-frame-full", action="store_true", help="frame 0 shows the finished title (as some reels open)")
    ap.add_argument("--background", default="0,0,0")
    ap.add_argument("--reuse", nargs="*", default=[],
                    help="i=j: glyph i takes glyph j's shape (a repeated letter traced cleaner once), e.g. 2=0")
    a = ap.parse_args()
    random.seed(a.seed)
    bg = tuple(int(v) for v in a.background.split(","))

    if a.mask:
        word = Image.open(a.mask).convert("L")
    elif a.font and a.text:
        f = ImageFont.truetype(a.font, 600)
        bb = f.getbbox(a.text)
        word = Image.new("L", (bb[2] - bb[0] + 20, bb[3] - bb[1] + 20), 0)
        ImageDraw.Draw(word).text((10 - bb[0], 10 - bb[1]), a.text, font=f, fill=255)
        word = word.crop(word.getbbox())
    else:
        raise SystemExit("give --mask, or --font and --text")

    scale = a.height * a.height_frac / word.height
    spans = split_glyphs(word)
    glyphs = [clean(word.crop((s, 0, e, word.height)), (max(1, round((e - s) * scale)), round(word.height * scale)))
              for s, e in spans]
    for pair in a.reuse:
        i, j = (int(v) for v in pair.split("="))
        glyphs[i] = glyphs[j].copy()
    offsets = [round((s - spans[0][0]) * scale) for s, _ in spans]
    total_w = offsets[-1] + glyphs[-1].width
    ox, oy = (a.width - total_w) // 2, (a.height - glyphs[0].height) // 2

    photos = [ImageOps.exif_transpose(Image.open(p)).convert("RGB")
              for p in sorted(glob.glob(os.path.join(a.photos, "*")))
              if p.lower().endswith((".jpg", ".jpeg", ".png", ".heic", ".webp"))]
    if not photos:
        raise SystemExit("no photos found")
    for p in photos:
        p.thumbnail((900, 900))
    if a.sideways:
        photos = [p.rotate(-90, expand=True) for p in photos]
    random.shuffle(photos)

    starts = [int(v) for v in a.glyph_starts.split(",")] if a.glyph_starts else \
        [6 + round(i * (a.frames * 0.55) / max(1, len(glyphs))) for i in range(len(glyphs))]
    layers, k = [], 0
    for g in glyphs:
        ps = []
        for x0, y0, x1, y1 in pieces(g):
            pm = Image.new("L", g.size, 0)
            ImageDraw.Draw(pm).rectangle([x0, y0, x1 - 1, y1 - 1], fill=255)
            pm = Image.composite(g, pm.point(lambda v: 0), pm)       # piece = glyph pixels inside its rectangle
            img = Image.new("RGB", g.size, bg)
            img.paste(ImageOps.fit(photos[k % len(photos)], (x1 - x0, y1 - y0)), (x0, y0))
            ps.append((pm, img)); k += 1
        layers.append(ps)

    os.makedirs(a.out, exist_ok=True)
    for f in glob.glob(os.path.join(a.out, "title_*.png")):
        os.remove(f)
    for frame in range(a.frames):
        canvas = Image.new("RGB", (a.width, a.height), bg)
        for i, ps in enumerate(layers):
            for j, (pm, img) in enumerate(ps):
                if not (a.first_frame_full and frame == 0) and frame < starts[min(i, len(starts) - 1)] + j * a.step:
                    break
                canvas.paste(img, (ox + offsets[i], oy), pm)
        if a.first_frame_full and 0 < frame < min(starts):
            canvas = Image.new("RGB", (a.width, a.height), bg)
        canvas.save(os.path.join(a.out, f"title_{frame:04d}.png"), compress_level=1)
    print(f"{a.frames} frames in {a.out}: {len(glyphs)} glyphs, {k} photo pieces")


if __name__ == "__main__":
    main()
