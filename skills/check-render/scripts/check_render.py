#!/usr/bin/env python3
"""Check a rendered video for the problems that slip past a glance at a few frames.

    check_render.py <video> [--intro-frames 105] [--expect-seconds 39.8] [--min-mbps 15]
                    [--fade-frames 50] [--keep <frames dir>]

Decodes every frame small (FilmCraft, no ffmpeg) and reports:
  frozen   runs of identical frames inside the edit (a stuck clip, a still where a clip should move)
  black    runs of black frames that are not the final fade
  ending   whether the end fades smoothly or cuts to black (Dip to Black at a sequence end can)
  intro    whether an animated intro actually animates (a stale image sequence renders static)
  stream   duration, size, frame rate, video bitrate, audio streams
Exit code 1 when something needs fixing. Needs Pillow and $FILMCRAFT_CLI (or filmcraft-cli on PATH).
"""
import argparse, glob, json, os, shutil, subprocess, sys, tempfile
from PIL import Image, ImageChops, ImageStat

CLI = os.environ.get("FILMCRAFT_CLI") or shutil.which("filmcraft-cli") or "filmcraft-cli"


def cli(*args, stdin=None):
    try:
        r = subprocess.run([CLI, *args], input=stdin, capture_output=True, text=True)
    except FileNotFoundError:
        sys.exit("filmcraft-cli not found: set FILMCRAFT_CLI to its full path (or put it on PATH)")
    if r.returncode != 0:
        sys.exit(f"filmcraft-cli failed:\n{r.stderr or r.stdout}")
    return r.stdout


def runs(flags, min_len):
    out, start = [], None
    for i, f in enumerate(flags + [False]):
        if f and start is None:
            start = i
        if not f and start is not None:
            if i - start >= min_len:
                out.append((start, i))
            start = None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--intro-frames", type=int, default=0, help="length of an animated intro to check")
    ap.add_argument("--expect-seconds", type=float)
    ap.add_argument("--min-mbps", type=float, default=0)
    ap.add_argument("--fade-frames", type=int, default=60, help="how many final frames may legitimately dim")
    ap.add_argument("--keep", help="keep the decoded frames here")
    a = ap.parse_args()

    video = os.path.abspath(a.video)
    p = json.loads(cli("--compact", "probe", video))
    v = p["video"]
    fps = v["frame_rate"]["num"] / v["frame_rate"]["den"]
    stream = {"seconds": round(p["duration"] / 254016000000, 3), "size": f"{v['width']}x{v['height']}",
              "fps": round(fps, 3), "mbps": round((v.get("bitrate") or 0) / 1e6, 1),
              "audio_streams": len(p.get("audio_streams", []))}

    tmp = tempfile.mkdtemp(prefix="fc-check-")
    proj = os.path.join(tmp, "p.fcproj")
    cli("--save-as", proj, "--compact", "run", "-", stdin="\n".join(json.dumps(s) for s in [
        {"id": "file.newProject", "params": {"name": "check"}},
        {"id": "file.import", "params": {"paths": [video]}},
        {"id": "file.newSequence", "params": {"name": "check", "width": v["width"], "height": v["height"], "fps": fps}},
        {"id": "timeline.place", "params": {"item": 1, "track": "V1", "frame": 0, "audio": False}},
    ]) + "\n")
    out_dir = a.keep or os.path.join(tmp, "f")
    os.makedirs(out_dir, exist_ok=True)
    cli("--project", proj, "export", os.path.join(out_dir, "f.png"), "--format", "png", "--scale", "0.2", "--no-audio")
    files = sorted(glob.glob(os.path.join(out_dir, "*.png")))
    ims = [Image.open(f).convert("L") for f in files]
    if not a.keep:
        shutil.rmtree(tmp, ignore_errors=True)

    n = len(ims)
    luma = [ImageStat.Stat(im).mean[0] for im in ims]
    d = [0.0] + [ImageStat.Stat(ImageChops.difference(ims[i], ims[i - 1])).mean[0] for i in range(1, n)]
    body_end = n - a.fade_frames
    lo = a.intro_frames
    problems = []

    frozen = [r for r in runs([i >= lo and i < body_end and d[i] < 0.05 and luma[i] > 12 for i in range(n)], int(fps * 0.4))]
    for s, e in frozen:
        problems.append(f"frozen: frames {s}-{e} ({s / fps:.2f}-{e / fps:.2f}s) do not change")
    black = [r for r in runs([i >= lo and i < body_end and luma[i] < 6 for i in range(n)], 3)]
    for s, e in black:
        problems.append(f"black: frames {s}-{e} ({s / fps:.2f}-{e / fps:.2f}s)")

    tail = luma[-a.fade_frames:]
    biggest_drop = max((tail[i - 1] - tail[i] for i in range(1, len(tail))), default=0)
    ending = "fades out" if tail and tail[-1] < 12 and biggest_drop < 25 else \
             "cuts to black" if tail and tail[-1] < 12 else "ends on picture"
    if ending == "cuts to black":
        i = n - a.fade_frames + max(range(1, len(tail)), key=lambda i: tail[i - 1] - tail[i])
        problems.append(f"ending: hard cut to black at {i / fps:.2f}s instead of a fade (use the fade tool)")

    intro = None
    if a.intro_frames:
        changes = sum(1 for i in range(1, min(a.intro_frames, n)) if d[i] > 0.2)
        intro = {"frames": a.intro_frames, "frames_that_change": changes}
        if changes < 3:
            problems.append("intro: does not animate (a stale or still image sequence? bake it with import_media bake=true)")

    if a.expect_seconds and abs(stream["seconds"] - a.expect_seconds) > 0.1:
        problems.append(f"duration {stream['seconds']}s, expected {a.expect_seconds}s")
    if a.min_mbps and stream["mbps"] < a.min_mbps:
        problems.append(f"bitrate {stream['mbps']} Mbps below {a.min_mbps} (render with bitrateMbps)")

    print(json.dumps({"stream": stream, "frames": n, "ending": ending, "intro": intro,
                      "frozen": [[s, e] for s, e in frozen], "black": [[s, e] for s, e in black],
                      "problems": problems, "ok": not problems}, indent=1))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
