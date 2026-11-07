---
name: recap-edit
description: Edit a folder of clips (and photos) into a beat-synced montage — a year recap, travel dump, trip highlight, "core memories" reel — matching a reference video's cuts, music, transitions, intro and colour, built in FilmCraft (live in the app if wanted). Use this whenever the user shares a reference reel/TikTok/CapCut template or says "edit my videos like this", "make a recap/montage/highlight", "same style as this video", or hands over a folder of trip footage to cut to music — even if they don't say "recap".
---

# Recap edit: footage + reference → finished montage

The user judges the result against the reference, frame by frame, and against their own footage
("where is my waterfall shot?"). So the job is: copy the reference's *structure* exactly (cut timing,
transitions, intro, colour, framing), fill it with the user's *best* moments, use every clip they gave
you, and check the render before calling it done. Each step below has a skill with scripts; set
`FILMCRAFT_CLI="${user_config.filmcraft_cli}"` (or the path to filmcraft-cli) for them.

## 1. Gather and confirm inputs

- **Footage folder** and any **photos folder** (photo-title intros, stills).
- **Reference video**: ask for the downloaded file. A web link to Instagram/TikTok is only good for a
  first look; frame-accurate timing needs the file. The reference's **audio** becomes the soundtrack
  when the user wants "the same music" (mute the clips: `audio: false`).
- **Frame shape**: match the reference (9:16 reel) unless the user asks for landscape. If the
  reference shows 16:9 footage letterboxed in a 9:16 frame, that is a style choice to copy too.

## 2. Analyse the reference → `analyze-reference`

Extract frames, detect cuts, flashes and the beat, and look at contact sheets of the intro, every
transition and any section that's not a plain cut (stacked pictures popping in on the beat, split
screens). Write down: cut frames, transition types at each, intro construction, caption style, ending,
and the colour (shadows/highlights balance). Keep the reference's exact cut frames as your plan's
`cuts` — it is what makes the edit "hit" the music.

## 3. Review all the footage → `select-shots`

Sample every clip, score it, look at the review sheets. For each clip note its best moments and, for
portrait clips, the focus height that keeps the subject (heads!) in a landscape slice. Find hero shots
for the long holds (cinematic, steady, golden light, a gesture); quick beats can take busier moments.

## 4. Plan the cut

Write a plan JSON (`references/plan-format.md`), one shot per slot between the reference's cuts:
- **Every clip appears.** Users notice missing clips immediately. With more slots than clips, repeat only
  long clips at *different* moments; with fewer, use picture-in-picture/stacked sections.
- Story order (usually chronological) with the strongest shots on the holds and the climax.
- Clips that can't fill the frame well (selfies, tight close-ups, low-res portrait) go in as whole
  pictures in an overlay section instead of being zoomed full-frame.
- Per-shot `look` by light (haze, golden, green, stage, night, indoor, sport) and `denoise` only on dark,
  noisy shots.
- Run `scripts/plan_check.py plan.json --clips <folder>`: it flags unused clips, overlapping repeats
  and in-points past a clip's end.

## 5. Build the parts the reference needs

- Photo-letter or footage-in-letters intro → `photo-title` (trace the reference's letters for an exact
  match). Bake the frames (`import_media bake=true`).
- Light-leak on a big cut → `scripts/light_leak.py <dir>`, bake, place 8 frames before the cut, blend
  Screen (`light_leaks` in the plan).
- Cream/white flashes, stacked pictures popping in on the beat → `overlays` in the plan.

## 6. Build it

`scripts/build_from_plan.py plan.json --live 7878 --launch --pause 0.08` builds it live in a new
FilmCraft window (the user watches it assemble); without `--live` it writes the project headless.
Then `connect_app(port: 7878, token: <printed token>)` to keep editing with the MCP tools.

## 7. Grade → `match-grade`

Measure the reference vs your render and tune the overall Lumetri on the adjustment layer (and
per-shot looks) until shadows, highlights, brightness and saturation line up.

## 8. Render and check → `check-render`

`render(maxRenderQuality: true, bitrateMbps: 30)`, then `check_render.py` with the intro length and
expected duration. Look at frames from every section. Report what changed, what you verified and what
you couldn't (audio by ear).

## When the user gives feedback

They will point at timestamps ("at 0:15 the pictures should stack", "heads are cut", "too zoomed",
"looks grainy", "the font is different"). Re-analyse that exact span of the reference frame by frame
before changing anything, fix it in the plan, rebuild, and re-check — don't patch blind.
