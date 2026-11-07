#!/usr/bin/env python3
"""Lift the outline of photo-filled (or any bright) lettering on a dark background from a frame.

    trace_mask.py <frame.png> <out mask.png> --box x0,y0,x1,y1 [--threshold 22] [--speck 450]

--box: the region holding the lettering only (leave out captions and bars).
Pixels brighter than the black background become letter. Dark spots inside the photos are
closed up, and black islands smaller than --speck px are filled, so only real counters
(the holes in 0, 6, A...) and notches stay black. Writes the cropped binary mask.
"""
import argparse
from collections import deque
from PIL import Image, ImageChops, ImageFilter


def fill_specks(m, min_area):
    w, h = m.size
    px = m.load()
    seen = bytearray(w * h)
    for y0 in range(h):
        for x0 in range(w):
            if px[x0, y0] or seen[y0 * w + x0]:
                continue
            comp, edge, q = [], False, deque([(x0, y0)])
            seen[y0 * w + x0] = 1
            while q:
                x, y = q.popleft()
                comp.append((x, y))
                edge |= x in (0, w - 1) or y in (0, h - 1)
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not px[nx, ny] and not seen[ny * w + nx]:
                        seen[ny * w + nx] = 1
                        q.append((nx, ny))
            if len(comp) < min_area and not edge:
                for x, y in comp:
                    px[x, y] = 255
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frame")
    ap.add_argument("out")
    ap.add_argument("--box", required=True)
    ap.add_argument("--threshold", type=int, default=22)
    ap.add_argument("--speck", type=int, default=450, help="fill black islands smaller than this (px)")
    a = ap.parse_args()
    im = Image.open(a.frame).convert("RGB").crop(tuple(int(v) for v in a.box.split(",")))
    r, g, b = im.split()
    m = ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda v: 255 if v > a.threshold else 0)
    m = m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    m = m.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    m = fill_specks(m, a.speck)
    m = m.crop(m.getbbox())
    m.save(a.out)
    print(f"{a.out}: {m.size[0]}x{m.size[1]}")


if __name__ == "__main__":
    main()
