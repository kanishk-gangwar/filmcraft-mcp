#!/usr/bin/env python3
"""Sample stills from every clip in a folder so the footage can be reviewed and scored.

    sample_clips.py <clips dir> <out dir> [--every 0.5] [--max-per-clip 60]

Writes <out dir>/<clip>__<seconds>.jpg and <out dir>/clips.json (path, seconds, size, fps,
portrait). Long clips are sampled more sparsely so no clip takes over. Video files only
(.mp4 .mov .m4v .mkv, any case); files named like a render (*recap*.mp4 etc.) can be
skipped with --skip.
"""
import argparse, glob, json, os, shutil, subprocess, sys, tempfile

CLI = os.environ.get("FILMCRAFT_CLI") or shutil.which("filmcraft-cli") or "filmcraft-cli"
TICKS = 254016000000
EXT = (".mp4", ".mov", ".m4v", ".mkv")


def cli(*args, stdin=None):
    try:
        r = subprocess.run([CLI, *args], input=stdin, capture_output=True, text=True)
    except FileNotFoundError:
        sys.exit("filmcraft-cli not found: set FILMCRAFT_CLI to its full path (or put it on PATH)")
    if r.returncode != 0:
        sys.exit(f"filmcraft-cli failed:\n{r.stderr or r.stdout}")
    return r.stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips")
    ap.add_argument("out")
    ap.add_argument("--every", type=float, default=0.5)
    ap.add_argument("--max-per-clip", type=int, default=60)
    ap.add_argument("--skip", nargs="*", default=[], help="substrings of file names to leave out (e.g. your own renders)")
    a = ap.parse_args()

    files = sorted(f for f in glob.glob(os.path.join(os.path.abspath(a.clips), "*"))
                   if f.lower().endswith(EXT) and not any(s in os.path.basename(f) for s in a.skip))
    if not files:
        sys.exit("no video files found")
    os.makedirs(a.out, exist_ok=True)

    clips = []
    for f in files:
        p = json.loads(cli("--compact", "probe", f))
        v = p.get("video") or {}
        if not v:
            continue
        fr = v.get("frame_rate") or {"num": 30, "den": 1}
        clips.append({"name": os.path.splitext(os.path.basename(f))[0], "path": f, "seconds": p["duration"] / TICKS,
                      "width": v["width"], "height": v["height"], "fps": round(fr["num"] / fr["den"], 3),
                      "portrait": v["height"] > v["width"]})

    tmp = tempfile.mkdtemp(prefix="fc-sample-")
    proj = os.path.join(tmp, "p.fcproj")
    out = cli("--save-as", proj, "--compact", "run", "-", stdin="\n".join(json.dumps(s) for s in [
        {"id": "file.newProject", "params": {"name": "sample"}},
        {"id": "file.import", "params": {"paths": [c["path"] for c in clips]}},
    ]) + "\n")
    items = json.loads(out.strip().splitlines()[-1])["result"]["items"]
    steps = []
    for c, item in zip(clips, items):
        c["item"] = item
        step = max(a.every, c["seconds"] / a.max_per_clip)
        t, c["samples"] = step / 2, []
        while t < c["seconds"] - 0.05:
            path = os.path.join(os.path.abspath(a.out), f"{c['name']}__{t:07.2f}.jpg")
            steps.append({"id": "file.exportFrame", "params": {"item": item, "target": "source", "time": int(t * TICKS),
                                                                 "format": "jpeg", "path": path}})
            c["samples"].append({"t": round(t, 2), "path": path})
            t += step
    print(f"exporting {len(steps)} stills from {len(clips)} clips...", file=sys.stderr)
    cli("--project", proj, "--compact", "--keep-going", "run", "-", stdin="\n".join(json.dumps(s) for s in steps) + "\n")
    shutil.rmtree(tmp, ignore_errors=True)
    with open(os.path.join(a.out, "clips.json"), "w") as f:
        json.dump(clips, f, indent=1)
    print(json.dumps([{k: c[k] for k in ("name", "seconds", "width", "height", "fps", "portrait")} for c in clips], indent=1))


if __name__ == "__main__":
    main()
