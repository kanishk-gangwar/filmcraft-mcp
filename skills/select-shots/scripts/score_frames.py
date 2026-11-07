#!/usr/bin/env python3
"""Score sampled stills for how usable they are, and find each clip's best window.

    score_frames.py <samples dir> [--window 1.0]

Reads clips.json from sample_clips.py. Per still: sharpness (edge variance), motion (change
from the previous still: high = shake or a fast pan), brightness, contrast, saturation and
clipped highlights/shadows. Per clip: the steadiest, sharpest window of --window seconds,
and flags (dark, washed out, shaky, soft). Writes scores.json and prints a summary.
These numbers rank and flag; the visual review (review_sheets.py) decides.
"""
import argparse, json, os
from PIL import Image, ImageChops, ImageFilter, ImageStat


def measure(path, prev):
    im = Image.open(path).convert("RGB")
    im.thumbnail((480, 480))
    g = im.convert("L")
    hist = g.histogram()
    n = sum(hist)
    small = g.resize((64, 64))
    return small, {
        "sharp": round(ImageStat.Stat(g.filter(ImageFilter.FIND_EDGES)).var[0]),
        "luma": round(ImageStat.Stat(g).mean[0]),
        "contrast": round(ImageStat.Stat(g).stddev[0]),
        "sat": round(ImageStat.Stat(im.convert("HSV")).mean[1]),
        "hi_clip": round(sum(hist[250:]) / n, 3),
        "lo_clip": round(sum(hist[:6]) / n, 3),
        "motion": round(ImageStat.Stat(ImageChops.difference(small, prev)).mean[0], 1) if prev else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("samples")
    ap.add_argument("--window", type=float, default=1.0, help="seconds the shot will be on screen")
    a = ap.parse_args()
    clips = json.load(open(os.path.join(a.samples, "clips.json")))

    report = []
    for c in clips:
        prev, rows = None, []
        for s in c["samples"]:
            if not os.path.exists(s["path"]):
                continue
            prev, m = measure(s["path"], prev)
            rows.append({"t": s["t"], **m})
        if not rows:
            continue
        if len(rows) > 1:                  # the first still has no predecessor: borrow the next one's motion
            rows[0]["motion"] = rows[1]["motion"]
        motions = [r["motion"] for r in rows if r["motion"] is not None]
        sharp_med = sorted(r["sharp"] for r in rows)[len(rows) // 2]
        # best window: lowest mean motion, then highest sharpness, over consecutive stills
        span = max(1, round(a.window / max(0.01, (rows[1]["t"] - rows[0]["t"]) if len(rows) > 1 else 1)))
        best = None
        for i in range(len(rows)):
            w = rows[i:i + span]
            mo = [r["motion"] for r in w if r["motion"] is not None]
            score = (sum(mo) / len(mo) if mo else 0) - 0.02 * sum(r["sharp"] for r in w) / len(w) / 10
            if best is None or score < best[0]:
                best = (score, w[0]["t"])
        luma = sum(r["luma"] for r in rows) / len(rows)
        flags = []
        if luma < 60: flags.append("dark")
        if luma > 175: flags.append("bright/washed")
        if motions and sorted(motions)[len(motions) // 2] > 25: flags.append("shaky or fast-moving")
        if sharp_med < 900: flags.append("soft")
        if sum(r["sat"] for r in rows) / len(rows) < 25: flags.append("grey/low colour")
        report.append({"name": c["name"], "seconds": round(c["seconds"], 2), "portrait": c["portrait"],
                       "best_start": best[1], "median_sharp": sharp_med, "mean_luma": round(luma),
                       "median_motion": sorted(motions)[len(motions) // 2] if motions else 0,
                       "flags": flags, "stills": rows})
    with open(os.path.join(a.samples, "scores.json"), "w") as f:
        json.dump(report, f, indent=1)
    for r in report:
        print(f"{r['name'][:28]:28} {r['seconds']:6.1f}s {'P' if r['portrait'] else 'L'} best@{r['best_start']:<6} "
              f"sharp {r['median_sharp']:<5} motion {r['median_motion']:<5} luma {r['mean_luma']:<4} {', '.join(r['flags'])}")


if __name__ == "__main__":
    main()
