#!/usr/bin/env python3
"""Find the cuts (and flash / leak frames) in a folder of frames from extract_frames.py.

    detect_cuts.py <frames dir> [--soft]

Prints JSON: cuts (frame, seconds, strength), shots between them (start, end, frames, seconds),
bright flashes (cream/white frames, light leaks), and the beat: the most common shot length,
so a new edit can cut on the same rhythm. --soft also reports gentler cuts (dissolves, whips).
Needs Pillow.
"""
import argparse, glob, json, os, statistics
from collections import Counter
from PIL import Image, ImageChops, ImageStat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames")
    ap.add_argument("--soft", action="store_true", help="lower thresholds: also catch dissolves and whips")
    a = ap.parse_args()

    info = json.load(open(os.path.join(a.frames, "info.json")))
    fps = info["fps"]
    files = sorted(glob.glob(os.path.join(a.frames, "frame_*.png")))
    small = [Image.open(f).convert("RGB").resize((64, 36)) for f in files]
    luma = [ImageStat.Stat(im.convert("L")).mean[0] for im in small]
    d = [0.0] + [sum(ImageStat.Stat(ImageChops.difference(small[i], small[i - 1])).mean) / 3 for i in range(1, len(small))]

    floor, ratio = (8, 1.8) if a.soft else (18, 2.5)
    cuts = []
    for i in range(1, len(d)):
        nb = max(d[i - 1], d[i + 1] if i + 1 < len(d) else 0, 1)
        if d[i] > floor and d[i] > ratio * nb:
            cuts.append({"frame": i, "seconds": round(i / fps, 3), "strength": round(d[i], 1)})

    bounds = [0] + [c["frame"] for c in cuts] + [len(files)]
    shots = [{"start": s, "end": e, "frames": e - s, "seconds": round((e - s) / fps, 3)} for s, e in zip(bounds, bounds[1:]) if e > s]

    # flashes: sudden jumps in brightness (cream/white flash frames, light-leak peaks); relative, so
    # letterbox bars or a dark caption area don't hide them
    flashes = []
    for i in range(3, len(luma)):
        if luma[i] > 1.5 * luma[i - 3] and luma[i] - luma[i - 3] > 25 and (not flashes or i - flashes[-1] > 3):
            flashes.append(i)
    black = [i for i, v in enumerate(luma) if v < 8]

    lengths = [s["frames"] for s in shots if 4 <= s["frames"] <= fps * 2]
    beat = None
    if lengths:
        common = Counter(round(x / 2) * 2 for x in lengths).most_common(3)
        beat = {"common_shot_frames": [c for c, _ in common], "median_frames": statistics.median(lengths),
                "bpm_if_one_cut_per_beat": round(60 * fps / statistics.median(lengths), 1)}

    print(json.dumps({"fps": fps, "frames": len(files), "cuts": cuts, "shots": shots, "flash_frames": flashes,
                      "black_frames": black[:50], "beat": beat}, indent=1))


if __name__ == "__main__":
    main()
