#!/usr/bin/env python3
"""Check a montage plan before building it.

    plan_check.py plan.json [--clips <folder>] [--skip recap]

Reports: shots vs cut frames, each shot's source window against the clip's length, clips in
--clips that the plan never uses (people notice their best clip missing), clips used more than
once and how (a long clip at different moments is fine; the same moment twice is not), and
overlay timing. Exit code 1 on errors; repeats and unused clips are warnings.
"""
import argparse, glob, json, os, shutil, subprocess, sys
from collections import defaultdict

CLI = os.environ.get("FILMCRAFT_CLI") or shutil.which("filmcraft-cli") or "filmcraft-cli"
EXT = (".mp4", ".mov", ".m4v", ".mkv")


def seconds(path):
    try:
        r = subprocess.run([CLI, "--compact", "probe", path], capture_output=True, text=True)
    except FileNotFoundError:
        sys.exit("filmcraft-cli not found: set FILMCRAFT_CLI to its full path")
    if r.returncode != 0:
        return None
    return json.loads(r.stdout)["duration"] / 254016000000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("plan")
    ap.add_argument("--clips")
    ap.add_argument("--skip", nargs="*", default=[])
    a = ap.parse_args()
    plan = json.load(open(a.plan))
    fps = plan.get("sequence", {}).get("fps", 30)
    cuts, shots, overlays = plan["cuts"], plan["shots"], plan.get("overlays", [])
    errors, warnings = [], []

    if len(cuts) != len(shots) + 1:
        errors.append(f"{len(shots)} shots need {len(shots) + 1} cut frames; plan has {len(cuts)}")
    if any(b <= a_ for a_, b in zip(cuts, cuts[1:])):
        errors.append("cut frames must increase")

    uses = defaultdict(list)
    length = {}
    for i, (s, a_, b) in enumerate(zip(shots, cuts, cuts[1:])):
        p = os.path.abspath(s["clip"])
        if p not in length:
            length[p] = seconds(p)
        if length[p] is None:
            errors.append(f"shot {i}: cannot read {p}")
            continue
        dur = (b - a_) / fps
        if s.get("in", 0) + dur > length[p] + 1e-3:
            errors.append(f"shot {i}: {os.path.basename(p)} in {s.get('in', 0)}s + {dur:.2f}s runs past its end ({length[p]:.2f}s)")
        uses[p].append(("shot", i, s.get("in", 0), dur))
    for o in overlays:
        p = os.path.abspath(o["clip"])
        if p not in length:
            length[p] = seconds(p)
        if o["until"] <= o["frame"]:
            errors.append(f"overlay at frame {o['frame']}: ends before it starts")
        if length[p] is not None and o.get("in", 0) + (o["until"] - o["frame"]) / fps > length[p] + 1e-3:
            errors.append(f"overlay {os.path.basename(p)} runs past its end")
        if "width" not in o and "height" not in o:
            errors.append(f"overlay {os.path.basename(p)}: give width (landscape) or height (portrait)")
        uses[p].append(("overlay", o["frame"], o.get("in", 0), (o["until"] - o["frame"]) / fps))

    for p, u in uses.items():
        if len(u) > 1:
            spans = sorted((x[2], x[2] + x[3]) for x in u)
            overlap = any(s2 < e1 - 0.05 for (s1, e1), (s2, e2) in zip(spans, spans[1:]))
            warnings.append(f"{os.path.basename(p)} used {len(u)}x" + (" with OVERLAPPING moments (same footage twice)" if overlap else " at different moments"))

    if a.clips:
        folder = [os.path.abspath(f) for f in glob.glob(os.path.join(a.clips, "*"))
                  if f.lower().endswith(EXT) and not any(s in os.path.basename(f) for s in a.skip)]
        unused = sorted(os.path.basename(f) for f in folder if f not in uses)
        if unused:
            warnings.append(f"{len(unused)} clip(s) never used: {', '.join(unused)}")

    print(json.dumps({"shots": len(shots), "overlays": len(overlays), "seconds": round(cuts[-1] / fps, 3),
                      "distinct_clips": len(uses), "errors": errors, "warnings": warnings}, indent=1))
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
