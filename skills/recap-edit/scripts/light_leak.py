#!/usr/bin/env python3
"""Light-leak burst with swirling light streaks, as a 15-frame overlay for a cut.

    light_leak.py <out dir> [--width 1920 --height 1080]

Streaks arc over the outgoing shot, a deep orange flare sweeps in from the right, the frame
blows out to warm yellow-white at the cut (frame 8), then streaks swirl over the incoming shot.
Black background: place it on a track above the cut starting 8 frames early, blend mode Screen,
and bake it with import_media bake=true. Matches the light leak common in recap reels."""
import argparse, glob, math, os
from PIL import Image, ImageChops, ImageDraw, ImageFilter

_ap = argparse.ArgumentParser()
_ap.add_argument("out")
_ap.add_argument("--width", type=int, default=1920)
_ap.add_argument("--height", type=int, default=1080)
_a = _ap.parse_args()
OUT, W, H = _a.out, _a.width, _a.height
N = 15                       # the cut sits at frame 8
os.makedirs(OUT, exist_ok=True)
for f in glob.glob(OUT + "/*.png"):
    os.remove(f)


def streaks(img, t, alpha, seed):
    """thin glowing orange arcs that sweep across the frame"""
    lay = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(lay)
    for k in range(3):
        cx = W * (0.35 + 0.25 * k + 0.08 * math.sin(seed + k)) + t * 260 * (1 if k % 2 else -1)
        cy = H * (0.55 + 0.15 * math.cos(seed * 2 + k))
        rx, ry = W * (0.28 + 0.1 * k), H * (0.35 + 0.12 * k)
        a0 = (seed * 40 + t * 140 + k * 110) % 360
        box = [cx - rx, cy - ry, cx + rx, cy + ry]
        col = (int(255 * alpha), int(150 * alpha), int(50 * alpha))
        d.arc(box, a0, a0 + 120, fill=col, width=5)
    glow = lay.filter(ImageFilter.GaussianBlur(9))
    return ImageChops.add(ImageChops.add(img, glow), lay)


def flare(img, amount, x_from_right):
    """deep orange vertical light from the right edge, soft"""
    lay = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(lay)
    x0 = W - x_from_right
    for i in range(14):
        x = x0 + i * x_from_right / 14
        c = (int(255 * amount), int((95 + i * 6) * amount), int((25 + i * 3) * amount))
        d.rectangle([x, 0, W, H], fill=c)
    return ImageChops.add(img, lay.filter(ImageFilter.GaussianBlur(120)))


def wash(img, amount):
    lay = Image.new("RGB", (W, H), (int(255 * amount), int(215 * amount), int(120 * amount)))
    return ImageChops.add(img, lay)


# per frame: (streak alpha, flare amount, flare width as fraction of W, wash amount)
PLAN = [
    (0.0, 0.0, 0.0, 0.0),
    (0.55, 0.0, 0.0, 0.0),
    (0.75, 0.0, 0.0, 0.0),
    (0.9, 0.55, 0.25, 0.0),
    (0.9, 0.8, 0.35, 0.0),
    (0.8, 0.95, 0.5, 0.0),
    (0.7, 1.0, 0.6, 0.05),
    (0.6, 1.0, 0.75, 0.15),
    (0.3, 1.0, 1.1, 0.75),     # yellow-white blowout
    (0.3, 1.0, 1.1, 0.6),
    (0.5, 0.7, 0.7, 0.25),     # incoming shot appears through it
    (0.85, 0.35, 0.4, 0.0),
    (0.9, 0.0, 0.0, 0.0),      # swirl over the new shot
    (0.6, 0.0, 0.0, 0.0),
    (0.0, 0.0, 0.0, 0.0),
]
assert len(PLAN) == N
for i, (sa, fa, fw, wa) in enumerate(PLAN):
    img = Image.new("RGB", (W, H), (0, 0, 0))
    if fa:
        img = flare(img, fa, fw * W)
    if wa:
        img = wash(img, wa)
    if sa:
        img = streaks(img, i / N, sa, seed=1.3 + (0 if i < 8 else 2.1))
    img.save(f"{OUT}/leak_{i:04d}.png", compress_level=1)
print("wrote", N)
