#!/usr/bin/env python3
"""Decode every frame of a video to PNGs with FilmCraft (no ffmpeg needed).

    extract_frames.py <video> <out dir> [--scale 0.25] [--start S --end S]

Writes <out dir>/frame_00000.png ... and <out dir>/info.json (fps, size, frame count).
Uses $FILMCRAFT_CLI, else filmcraft-cli on PATH.
"""
import argparse, glob, json, os, shutil, subprocess, sys, tempfile

CLI = os.environ.get("FILMCRAFT_CLI") or shutil.which("filmcraft-cli") or "filmcraft-cli"


def cli(*args, stdin=None):
    try:
        r = subprocess.run([CLI, *args], input=stdin, capture_output=True, text=True)
    except FileNotFoundError:
        sys.exit("filmcraft-cli not found: set FILMCRAFT_CLI to its full path (or put it on PATH)")
    if r.returncode != 0:
        sys.exit(f"filmcraft-cli {' '.join(args[:4])}... failed:\n{r.stderr or r.stdout}")
    return r.stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--scale", type=float, default=0.25, help="fraction of the frame size (0.25 is plenty for analysis)")
    ap.add_argument("--start", type=float)
    ap.add_argument("--end", type=float)
    a = ap.parse_args()

    video = os.path.abspath(a.video)
    probe = json.loads(cli("--compact", "probe", video))
    v = probe["video"]
    fps = v["frame_rate"]["num"] / v["frame_rate"]["den"]
    os.makedirs(a.out, exist_ok=True)
    for f in glob.glob(os.path.join(a.out, "frame_*.png")):
        os.remove(f)

    tmp = tempfile.mkdtemp(prefix="fc-frames-")
    proj = os.path.join(tmp, "p.fcproj")
    steps = [
        {"id": "file.newProject", "params": {"name": "frames"}},
        {"id": "file.import", "params": {"paths": [video]}},
        {"id": "file.newSequence", "params": {"name": "frames", "width": v["width"], "height": v["height"], "fps": fps}},
        {"id": "timeline.place", "params": {"item": 1, "track": "V1", "frame": 0, "audio": False}},
    ]
    out = cli("--save-as", proj, "--compact", "run", "-", stdin="\n".join(json.dumps(s) for s in steps) + "\n")
    if '"ok":false' in out:
        sys.exit(f"could not build the frame project:\n{out}")
    raw = os.path.join(tmp, "raw")
    os.makedirs(raw)
    args = ["--project", proj, "export", os.path.join(raw, "f.png"), "--format", "png", "--scale", str(a.scale), "--no-audio"]
    if a.start is not None and a.end is not None:
        args += ["--start", str(a.start), "--end", str(a.end)]
    cli(*args)
    files = sorted(glob.glob(os.path.join(raw, "*.png")))
    for i, f in enumerate(files):
        shutil.move(f, os.path.join(a.out, f"frame_{i:05d}.png"))
    shutil.rmtree(tmp, ignore_errors=True)

    info = {"video": video, "fps": fps, "width": v["width"], "height": v["height"], "frames": len(files),
            "start": a.start or 0, "scale": a.scale}
    with open(os.path.join(a.out, "info.json"), "w") as f:
        json.dump(info, f, indent=1)
    print(json.dumps(info))


if __name__ == "__main__":
    main()
