#!/usr/bin/env python3
"""Contact sheets of every clip's sampled stills, one block per clip, for visual review.

    review_sheets.py <samples dir> <out prefix> [--aspect 16:9] [--height 110] [--width 2000]

Each still is labelled with its time. On clips whose shape differs from the target frame
(e.g. portrait footage for a landscape edit) a box shows the slice that fills the frame when
centred, so you can judge whether heads or the subject survive, and pick a focus point.
Writes <out prefix>_0.jpg, _1.jpg ... (each about 2000 px tall, readable in one look).
"""
import argparse, json, os
from PIL import Image, ImageDraw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("samples")
    ap.add_argument("out")
    ap.add_argument("--aspect", default="16:9", help="target frame shape, e.g. 16:9 or 9:16")
    ap.add_argument("--height", type=int, default=110)
    ap.add_argument("--width", type=int, default=2000)
    a = ap.parse_args()
    aw, ah = (float(x) for x in a.aspect.split(":"))
    target = aw / ah
    clips = json.load(open(os.path.join(a.samples, "clips.json")))

    blocks = []
    for c in clips:
        tiles = []
        for s in c["samples"]:
            if not os.path.exists(s["path"]):
                continue
            im = Image.open(s["path"]).convert("RGB")
            w, h = im.size
            im = im.resize((max(1, int(w * a.height / h)), a.height))
            d = ImageDraw.Draw(im)
            src = w / h
            if abs(src - target) > 0.05:
                if src < target:   # source taller than the frame: a horizontal band is shown
                    bh = im.width / target
                    d.rectangle([0, (a.height - bh) / 2, im.width - 1, (a.height + bh) / 2], outline=(255, 0, 255))
                else:              # source wider: a vertical band is shown
                    bw = a.height * target
                    d.rectangle([(im.width - bw) / 2, 0, (im.width + bw) / 2, a.height - 1], outline=(255, 0, 255))
            d.text((2, 2), f"{s['t']:.1f}", fill="yellow")
            tiles.append(im)
        rows, x = [[]], 0
        for t in tiles:
            if x + t.width > a.width and rows[-1]:
                rows.append([]); x = 0
            rows[-1].append(t); x += t.width
        blk = Image.new("RGB", (a.width, 18 + len(rows) * a.height), (30, 30, 30))
        ImageDraw.Draw(blk).text((4, 3), f"{c['name']}  {c['seconds']:.1f}s  {c['width']}x{c['height']}  {c['fps']}fps", fill="white")
        for r, row in enumerate(rows):
            x = 0
            for t in row:
                blk.paste(t, (x, 18 + r * a.height)); x += t.width
        blocks.append(blk)

    sheets, h = [[]], 0
    for b in blocks:
        if h + b.height > 2000 and sheets[-1]:
            sheets.append([]); h = 0
        sheets[-1].append(b); h += b.height
    for i, sb in enumerate(sheets):
        sh = Image.new("RGB", (a.width, sum(b.height for b in sb)), "black")
        y = 0
        for b in sb:
            sh.paste(b, (0, y)); y += b.height
        sh.save(f"{a.out}_{i}.jpg", quality=82)
        print(f"{a.out}_{i}.jpg")


if __name__ == "__main__":
    main()
