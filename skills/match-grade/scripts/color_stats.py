#!/usr/bin/env python3
"""Measure a look: mean RGB of shadows, midtones and highlights, plus saturation.

    color_stats.py <frames...|dir> [--crop x0,y0,x1,y1] [--every N]
    color_stats.py --ref <dir or frames> --ours <dir or frames> [--ref-crop ...] [--ours-crop ...]

With --ref/--ours it compares the two and says which way to move (warmer highlights,
more neutral shadows, brighter...). Crop the reference to its picture area when it has
letterbox bars or a caption, or the black will skew the shadows.
"""
import argparse, glob, json, os
from PIL import Image, ImageStat


def frames(spec, every):
    out = []
    for s in spec:
        out += sorted(glob.glob(os.path.join(s, "*.png")) + glob.glob(os.path.join(s, "*.jpg"))) if os.path.isdir(s) else [s]
    return out[::every]


def stats(files, crop=None):
    acc = {k: [0, 0, 0, 0] for k in ("all", "shadows", "mids", "highlights")}
    sat = 0
    for f in files:
        im = Image.open(f).convert("RGB")
        if crop:
            im = im.crop(crop)
        im = im.resize((96, 54))
        sat += ImageStat.Stat(im.convert("HSV")).mean[1]
        data = im.get_flattened_data() if hasattr(im, "get_flattened_data") else im.getdata()
        for r, g, b in data:
            l = r * 0.3 + g * 0.59 + b * 0.11
            k = "shadows" if l < 70 else "mids" if l < 170 else "highlights"
            for key in ("all", k):
                x = acc[key]
                x[0] += r; x[1] += g; x[2] += b; x[3] += 1
    out = {k: [round(v[0] / v[3]), round(v[1] / v[3]), round(v[2] / v[3])] for k, v in acc.items() if v[3]}
    out["saturation"] = round(sat / max(1, len(files)))
    out["frames"] = len(files)
    return out


def advice(ref, ours):
    tips = []
    for zone in ("shadows", "mids", "highlights"):
        if zone not in ref or zone not in ours:
            continue
        (rr, rg, rb), (or_, og, ob) = ref[zone], ours[zone]
        warm_ref, warm_ours = rr - rb, or_ - ob
        if warm_ours - warm_ref > 5:
            tips.append(f"{zone}: ours warmer by {warm_ours - warm_ref} (R-B) -> cool them (blue curve up / red down in this range)")
        elif warm_ref - warm_ours > 5:
            tips.append(f"{zone}: reference warmer by {warm_ref - warm_ours} (R-B) -> warm them (blue curve down / red up in this range)")
        g_ref, g_ours = rg - (rr + rb) / 2, og - (or_ + ob) / 2
        if abs(g_ref - g_ours) > 5:
            tips.append(f"{zone}: green/magenta off by {round(g_ours - g_ref)} -> adjust tint or the green curve")
    lr, lo = sum(ref["all"]) / 3, sum(ours["all"]) / 3
    if abs(lr - lo) > 4:
        tips.append(f"overall: ours {'brighter' if lo > lr else 'darker'} by {abs(round(lo - lr))} -> exposure {'down' if lo > lr else 'up'}")
    if abs(ref["saturation"] - ours["saturation"]) > 6:
        tips.append(f"saturation: ours {ours['saturation']} vs {ref['saturation']} -> saturation {'down' if ours['saturation'] > ref['saturation'] else 'up'}")
    return tips or ["close match: within a few levels in every zone"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames", nargs="*")
    ap.add_argument("--crop")
    ap.add_argument("--every", type=int, default=6)
    ap.add_argument("--ref", nargs="+")
    ap.add_argument("--ours", nargs="+")
    ap.add_argument("--ref-crop")
    ap.add_argument("--ours-crop")
    a = ap.parse_args()
    box = lambda s: tuple(int(v) for v in s.split(",")) if s else None
    if a.ref and a.ours:
        r, o = stats(frames(a.ref, a.every), box(a.ref_crop)), stats(frames(a.ours, a.every), box(a.ours_crop))
        print(json.dumps({"reference": r, "ours": o, "advice": advice(r, o)}, indent=1))
    else:
        print(json.dumps(stats(frames(a.frames, a.every), box(a.crop)), indent=1))


if __name__ == "__main__":
    main()
