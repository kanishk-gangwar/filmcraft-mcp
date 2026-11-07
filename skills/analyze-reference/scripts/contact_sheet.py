#!/usr/bin/env python3
"""Lay frames out in a labelled grid to look at many moments at once.

    contact_sheet.py <frames dir> <out.jpg> [--from F] [--to F] [--every N] [--cols 10]
                     [--crop x0,y0,x1,y1] [--zoom 2]

Labels each tile with its time (from info.json's fps). --crop takes a region of every frame
(e.g. just the 16:9 band of a vertical reel); --zoom enlarges tiles to inspect detail.
"""
import argparse, glob, json, os
from PIL import Image, ImageDraw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames")
    ap.add_argument("out")
    ap.add_argument("--from", dest="start", type=int, default=0)
    ap.add_argument("--to", dest="end", type=int)
    ap.add_argument("--every", type=int, default=1)
    ap.add_argument("--cols", type=int, default=10)
    ap.add_argument("--crop", help="x0,y0,x1,y1 in frame pixels")
    ap.add_argument("--zoom", type=float, default=1.0)
    a = ap.parse_args()

    fps = json.load(open(os.path.join(a.frames, "info.json")))["fps"]
    files = sorted(glob.glob(os.path.join(a.frames, "frame_*.png")))
    idx = list(range(a.start, a.end if a.end is not None else len(files), a.every))
    crop = tuple(int(v) for v in a.crop.split(",")) if a.crop else None
    tiles = []
    for i in idx:
        im = Image.open(files[i]).convert("RGB")
        if crop:
            im = im.crop(crop)
        if a.zoom != 1:
            im = im.resize((int(im.width * a.zoom), int(im.height * a.zoom)))
        ImageDraw.Draw(im).text((3, 3), f"{i} {i / fps:.2f}s", fill="yellow")
        tiles.append(im)
    w, h = tiles[0].size
    rows = (len(tiles) + a.cols - 1) // a.cols
    sheet = Image.new("RGB", (a.cols * w, rows * h), (255, 0, 255))
    for k, t in enumerate(tiles):
        sheet.paste(t, ((k % a.cols) * w, (k // a.cols) * h))
    sheet.save(a.out, quality=88)
    print(f"{a.out}: {len(tiles)} frames, {sheet.width}x{sheet.height}")


if __name__ == "__main__":
    main()
