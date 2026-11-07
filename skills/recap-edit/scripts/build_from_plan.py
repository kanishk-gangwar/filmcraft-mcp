#!/usr/bin/env python3
"""Build a whole montage from a plan file, headless or live in the FilmCraft app.

    build_from_plan.py plan.json                      # writes plan["project"] headless
    build_from_plan.py plan.json --live 7878 [--launch] [--pause 0.08]

Live: drives a FilmCraft window over its control bridge so every edit shows as it happens.
Uses $FILMCRAFT_CONTROL_TOKEN; --launch starts a new window with a fresh token (macOS `open`,
else $FILMCRAFT_APP). Afterwards connect the MCP server to the same window with
connect_app(port, token) to keep editing. The plan format is in references/plan-format.md.
"""
import argparse, json, os, secrets, shutil, subprocess, sys, time

CLI = os.environ.get("FILMCRAFT_CLI") or shutil.which("filmcraft-cli") or "filmcraft-cli"
T = 254016000000

# per-shot corrections by kind of light (Lumetri params); a plan can override or add its own
LOOKS = {
    "haze":   {"contrast": 28, "blacks": -18, "highlights": -25, "vibrance": 30, "saturation": 118, "temperature": 8},
    "golden": {"contrast": 12, "highlights": -30, "shadows": 12, "vibrance": 12, "temperature": 4},
    "green":  {"contrast": 18, "blacks": -10, "highlights": -15, "vibrance": 22, "saturation": 108},
    "stage":  {"contrast": 16, "blacks": -8, "highlights": -12, "vibrance": 14},
    "night":  {"blacks": -28, "highlights": -10, "saturation": 100},
    "indoor": {"exposure": 0.3, "contrast": 20, "blacks": -10, "vibrance": 18},
    "sport":  {"contrast": 20, "blacks": -10, "vibrance": 14},
    "none":   {},
}


class Engine:
    def __init__(self, project, live_port=None, token=None, pause=0):
        self.project, self.pause = project, pause
        self.bridge = f"127.0.0.1:{live_port}" if live_port else None
        self.env = dict(os.environ, FILMCRAFT_CONTROL_TOKEN=token) if token else None

    def ex(self, cid, **params):
        if self.bridge:
            cmd = [CLI, "--bridge", self.bridge, "--compact", "exec", cid, json.dumps(params)]
        else:
            cmd = [CLI, "--project", self.project, "--save", "--compact", "exec", cid, json.dumps(params)]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, env=self.env)
        except FileNotFoundError:
            sys.exit("filmcraft-cli not found: set FILMCRAFT_CLI to its full path")
        if r.returncode != 0:
            sys.exit(f"FAILED {cid} {json.dumps(params)[:300]}\n{r.stdout[-600:]}\n{r.stderr[-600:]}")
        if self.pause:
            time.sleep(self.pause)
        out = r.stdout.strip()
        return json.loads(out) if out else None


def probe(path):
    r = subprocess.run([CLI, "--compact", "probe", path], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"cannot read {path}: {r.stderr}")
    v = json.loads(r.stdout)["video"]
    return v["width"], v["height"], v["frame_rate"]["num"] / v["frame_rate"]["den"]


def framing(W, H, w, h, mode="fill", zoom=100, focus=(0.5, 0.5)):
    base = max(W / w, H / h) if mode == "fill" else min(W / w, H / h)
    s = base * zoom / 100
    shown, frame = (w * s, h * s), (W, H)
    pos = []
    for i in range(2):
        if shown[i] <= frame[i]:
            pos.append(frame[i] / 2)
            continue
        c = frame[i] / 2 + (0.5 - focus[i]) * shown[i]
        pos.append(round(min(shown[i] / 2, max(frame[i] - shown[i] / 2, c)), 1))
    return round(s * 100, 4), pos


def launch(port):
    token = secrets.token_hex(32)
    if sys.platform == "darwin":
        app = os.environ.get("FILMCRAFT_APP", "FilmCraft")
        subprocess.Popen(["open", "-n", "-a", app, "--env", f"FILMCRAFT_CONTROL_TOKEN={token}", "--args", "--control", str(port)])
    else:
        subprocess.Popen([os.environ.get("FILMCRAFT_APP", "filmcraft"), "--control", str(port)],
                         env=dict(os.environ, FILMCRAFT_CONTROL_TOKEN=token), start_new_session=True)
    for _ in range(45):
        time.sleep(1)
        r = subprocess.run([CLI, "--bridge", f"127.0.0.1:{port}", "--compact", "inspect", "project"],
                           capture_output=True, text=True, env=dict(os.environ, FILMCRAFT_CONTROL_TOKEN=token))
        if r.returncode == 0 and '"error"' not in r.stdout:
            return token
    sys.exit("launched FilmCraft but it did not answer")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("plan")
    ap.add_argument("--live", type=int, metavar="PORT")
    ap.add_argument("--launch", action="store_true")
    ap.add_argument("--pause", type=float, default=0.0, help="seconds between live commands, to watch")
    a = ap.parse_args()
    plan = json.load(open(a.plan))
    looks = {**LOOKS, **plan.get("looks", {})}
    project = os.path.abspath(plan["project"])
    seq = plan.get("sequence", {"width": 1920, "height": 1080, "fps": 30})
    W, H, FPS = seq["width"], seq["height"], seq["fps"]
    cuts, shots, overlays = plan["cuts"], plan["shots"], plan.get("overlays", [])
    if len(cuts) != len(shots) + 1:
        sys.exit(f"{len(shots)} shots need {len(shots) + 1} cut frames, got {len(cuts)}")
    total = cuts[-1]
    n_over = len(overlays)
    V_FLASH, V_GRADE, V_CAPTION = 2 + n_over, 3 + n_over, 4 + n_over

    token = None
    if a.live:
        token = launch(a.live) if a.launch else os.environ.get("FILMCRAFT_CONTROL_TOKEN")
        if not token:
            sys.exit("live mode needs FILMCRAFT_CONTROL_TOKEN, or --launch")
    e = Engine(project, a.live, token, a.pause)
    if a.live:
        e.ex("file.newProject", name=plan.get("name", "Edit"))
        e.ex("file.saveAs", path=project)
    else:
        os.makedirs(os.path.dirname(project), exist_ok=True)
        r = subprocess.run([CLI, "--save-as", project, "--compact", "run", "-"], input=json.dumps(
            {"id": "file.newProject", "params": {"name": plan.get("name", "Edit")}}) + "\n", capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(r.stderr)
    e.ex("file.newSequence", name=plan.get("name", "Edit"), width=W, height=H, fps=FPS, video=V_CAPTION, audio=2)
    if plan.get("max_render_quality", True):
        e.ex("sequence.settings", maxRenderQuality=True)

    # media
    paths = []
    for s in shots + overlays:
        if os.path.abspath(s["clip"]) not in paths:
            paths.append(os.path.abspath(s["clip"]))
    extra = [plan[k]["path"] for k in ("audio", "intro") if k in plan] + [l["path"] for l in plan.get("light_leaks", [])]
    ids = e.ex("file.import", paths=paths + [os.path.abspath(x) for x in extra])["items"]
    item = dict(zip(paths + [os.path.abspath(x) for x in extra], ids))
    size = {p: probe(p) for p in paths}

    if "audio" in plan:
        e.ex("timeline.place", item=item[os.path.abspath(plan["audio"]["path"])], track="A1", frame=0,
             video=False, audio=True, duration={"frame": total})
    if "intro" in plan:
        e.ex("timeline.place", item=item[os.path.abspath(plan["intro"]["path"])], track="V1", frame=0,
             audio=False, duration={"frame": plan["intro"]["frames"]})

    def put(s, a_frame, b_frame, track):
        p = os.path.abspath(s["clip"])
        c = e.ex("timeline.place", item=item[p], track=track, frame=a_frame, audio=False,
                 sourceIn={"seconds": s.get("in", 0)}, duration={"frame": b_frame - a_frame})["clips"][0]
        if s.get("blend24") or (size[p][2] < 25 and FPS > 25):
            e.ex("clip.speedDuration", clips=[c], speed=100, interpolation="frameBlending", ripple=False)
        if s.get("denoise"):
            e.ex("effects.apply", clips=[c], effect="vr_denoise")
            e.ex("effects.setParam", clip=c, effect="vr_denoise", param="amount", value=s["denoise"])
        look = s.get("look", "none")
        params = looks[look] if isinstance(look, str) else look
        if params or s.get("sharpen"):
            e.ex("effects.apply", clips=[c], effect="lumetri")
            for k, v in {**params, **({"sharpen": s["sharpen"]} if s.get("sharpen") else {})}.items():
                e.ex("effects.setParam", clip=c, effect="lumetri", param=k, value=v)
        return c, p

    v1 = []
    for s, a_frame, b_frame in zip(shots, cuts, cuts[1:]):
        c, p = put(s, a_frame, b_frame, "V1")
        w, h, _ = size[p]
        sc, pos = framing(W, H, w, h, s.get("mode", "fill"), s.get("zoom", 100), tuple(s.get("focus") or (0.5, 0.5)))
        e.ex("effects.setParam", clip=c, effect="motion", param="scale", value=sc)
        e.ex("effects.setParam", clip=c, effect="motion", param="position", value=pos)
        if s.get("rotate"):
            e.ex("effects.setParam", clip=c, effect="motion", param="rotation", value=s["rotate"])
        v1.append((c, s))
    for c, s in v1:
        t = s.get("transition")
        if t:
            e.ex("sequence.applyVideoTransition", clip=c, effect=t["effect"], edge="in", frames=t.get("frames", 6),
                 align="center", **({"params": t["params"]} if t.get("params") else {}))

    def fade(clip, b_frame, n):
        for f, v in [(b_frame - n, 100), (b_frame - 1, 0)]:
            e.ex("effects.setParam", clip=clip, effect="opacity", param="opacity", value=v, time=f * T // FPS, keyframe=True)

    if plan.get("fade_out_frames"):
        fade(v1[-1][0], total, plan["fade_out_frames"])

    for leak in plan.get("light_leaks", []):
        c = e.ex("timeline.place", item=item[os.path.abspath(leak["path"])], track=f"V{V_FLASH}", frame=leak["frame"],
                 audio=False)["clips"][0]
        e.ex("effects.setParam", clip=c, effect="opacity", param="blend", value=leak.get("blend", "Screen"))

    # pictures stacking onto the frame on the beat, each with a flash first
    if overlays:
        matte = e.ex("file.newColorMatte", color=plan.get("flash_color", "#f3eedc"), seconds=1)
        matte = matte.get("item") or matte.get("items", [None])[0]
        for i, o in enumerate(overlays):
            c, p = put(o, o["frame"], o["until"], f"V{2 + i}")
            w, h, _ = size[p]
            if o.get("rotate") in (90, 270):
                w, h = h, w
            upright = "height" in o           # sized by height (portrait pictures), else by width
            sc = H * o["height"] / h * 100 if upright else W * o["width"] / w * 100
            pos = [round(W * o["center"][0], 1), round(H * o["center"][1], 1)]
            e.ex("effects.setParam", clip=c, effect="motion", param="scale", value=round(sc, 4))
            e.ex("effects.setParam", clip=c, effect="motion", param="position", value=pos)
            if o.get("rotate"):
                e.ex("effects.setParam", clip=c, effect="motion", param="rotation", value=o["rotate"])
            if o.get("shadow", True):
                e.ex("effects.apply", clips=[c], effect="drop_shadow")
            n = o.get("flash_frames", 1)
            if n:
                fl = e.ex("timeline.place", item=matte, track=f"V{V_FLASH}", frame=o["frame"], duration={"frame": n})["clips"][0]
                if upright:
                    e.ex("effects.setParam", clip=fl, effect="motion", param="uniform_scale", value=False)
                    e.ex("effects.setParam", clip=fl, effect="motion", param="scale", value=o["height"] * 100)
                    e.ex("effects.setParam", clip=fl, effect="motion", param="scale_width",
                         value=round(H * o["height"] * w / h / W * 100, 3))
                else:
                    e.ex("effects.setParam", clip=fl, effect="motion", param="scale", value=o["width"] * 100)
                e.ex("effects.setParam", clip=fl, effect="motion", param="position", value=pos)
        end = plan.get("overlay_end_flash")
        if end:
            fl = e.ex("timeline.place", item=matte, track=f"V{V_FLASH}", frame=end["frame"],
                      duration={"frame": max(o["until"] for o in overlays) - end["frame"]})["clips"][0]
            e.ex("effects.setParam", clip=fl, effect="motion", param="scale", value=end["width"] * 100)
            e.ex("effects.setParam", clip=fl, effect="motion", param="position",
                 value=[round(W * end["center"][0], 1), round(H * end["center"][1], 1)])

    grade = plan.get("grade")
    if grade:
        start = grade.get("start_frame", plan.get("intro", {}).get("frames", 0))
        adj = e.ex("file.newAdjustmentLayer", seconds=(total - start) / FPS)
        adj = adj.get("item") or adj.get("items", [None])[0]
        g = e.ex("timeline.place", item=adj, track=f"V{V_GRADE}", frame=start, duration={"frame": total - start})["clips"][0]
        e.ex("effects.apply", clips=[g], effect="lumetri")
        for k, v in grade["lumetri"].items():
            e.ex("effects.setParam", clip=g, effect="lumetri", param=k, value=v)

    cap = plan.get("caption")
    if cap:
        pos = cap.get("position", [56, H - 52])
        r = e.ex("graphics.newText", text=cap["text"], position=pos, size=cap.get("size", 30), font=cap.get("font", "Courier New"),
                 fontStyle=cap.get("style", "Bold"), seconds=total / FPS, track=V_CAPTION - 1, time=0)
        clip = r.get("clip") or r.get("clips", [None])[0]
        e.ex("graphics.set", clip=clip, layer=0, props={"fill_color": cap.get("color", "#ffffff"), "align": "left",
             "font": cap.get("font", "Courier New"), "font_style": cap.get("style", "Bold"), "size": cap.get("size", 30),
             "position": pos, "shadow": True, "tracking": cap.get("tracking", 10)})
        if plan.get("fade_out_frames"):
            fade(clip, total, plan["fade_out_frames"])

    e.ex("file.save")
    print(json.dumps({"project": project, "frames": total, "seconds": round(total / FPS, 3), "shots": len(shots),
                      "overlays": n_over, **({"live": f"127.0.0.1:{a.live}", "token": token} if a.live else {})}))


if __name__ == "__main__":
    main()
