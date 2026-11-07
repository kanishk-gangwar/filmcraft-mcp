# Montage plan format (build_from_plan.py)

One JSON file describes the whole edit. Paths are absolute. Frames are sequence frames.

```json
{
  "name": "2026 Recap",
  "project": "/Users/me/Videos/2026_recap.fcproj",
  "sequence": {"width": 1920, "height": 1080, "fps": 30},
  "max_render_quality": true,

  "audio": {"path": "/Users/me/reference.mp4"},
  "intro": {"path": "/Users/me/assets/intro.mov", "frames": 105},

  "cuts":  [105, 118, 129, 140, 198, 289, 1118, 1194],
  "shots": [
    {"clip": "/footage/cliff.mp4", "in": 2.0, "look": "golden", "zoom": 116, "focus": [0.4, 0.5],
     "transition": {"effect": "flash", "frames": 6}},
    {"clip": "/footage/beach.mp4", "in": 1.0, "look": "haze"},
    {"clip": "/footage/dance.mp4", "in": 2.5, "look": "stage", "focus": [0.5, 0.4]},
    {"clip": "/footage/cave.mp4", "in": 2.0, "look": "indoor"},
    {"clip": "/footage/cliffpan.mp4", "in": 3.0, "look": "haze"},
    {"clip": "/footage/tennis.mp4", "in": 4.2, "look": "sport",
     "transition": {"effect": "light_leak", "frames": 6, "params": {"color": [1, 0.5, 0.15, 1], "amount": 100}}},
    {"clip": "/footage/night.mp4", "in": 1.0, "look": "night", "denoise": 45, "sharpen": 0},
    {"clip": "/footage/rider.mov", "in": 7.9, "look": "golden", "focus": [0.5, 0.71], "blend24": true}
  ],

  "overlays": [
    {"clip": "/footage/selfie.mov", "in": 1.5, "frame": 486, "until": 546, "center": [0.72, 0.27], "height": 0.52,
     "look": "golden", "flash_frames": 1},
    {"clip": "/footage/group.mp4", "in": 4.0, "frame": 538, "until": 546, "center": [0.49, 0.5], "width": 0.78,
     "flash_frames": 2, "rotate": 0}
  ],
  "flash_color": "#f3eedc",
  "overlay_end_flash": {"frame": 544, "center": [0.62, 0.5], "width": 0.7},

  "light_leaks": [{"path": "/Users/me/assets/leak.mov", "frame": 281, "blend": "Screen"}],

  "grade": {"start_frame": 105, "lumetri": {"temperature": 2, "contrast": 18, "exposure": -0.2, "blacks": -16,
            "whites": 18, "curve_red": [[0,0],[0.15,0.13],[0.8,0.83],[1,1]],
            "curve_blue": [[0,0.01],[0.15,0.17],[0.45,0.45],[1,0.84]], "vignette_amount": -0.7}},

  "caption": {"text": "core memories : 2026", "size": 30, "font": "Courier New", "style": "Bold",
              "position": [56, 1028], "color": "#ffffff"},
  "fade_out_frames": 50,

  "looks": {"moody": {"contrast": 25, "saturation": 85, "temperature": -6}}
}
```

## Fields

- `cuts`: shot boundaries, `len(shots) + 1` values; shot *i* runs `cuts[i]`..`cuts[i+1]`. Use the
  reference's cut frames. The first value is where shots start (after the intro).
- shot: `clip`, `in` (source seconds), `look` (preset name or a Lumetri params object), `mode`
  (fill | fit), `zoom` (%), `focus` `[x, y]` (0..1 of the source: which part stays in view), `rotate`
  (degrees), `denoise` (vr_denoise amount), `sharpen` (Lumetri sharpen, for upscaled low-res clips),
  `blend24` (frame blending; automatic for <25 fps sources), `transition` on its in-edge.
- overlay: a picture over the main shots from `frame` to `until`, centred at `center` (fractions of the
  frame), sized by `width` (landscape clips, fraction of frame width) or `height` (portrait clips shown
  whole, fraction of frame height). A `flash_frames`-long matte in `flash_color` pops first, in the
  picture's own shape. `shadow` (default true) adds a drop shadow.
- `overlay_end_flash`: a larger flash that holds until the overlays end (the cut out of the section).
- `light_leaks`: baked overlay movies (light_leak.py) placed at `frame`, blended (default Screen).
- `grade`: adjustment layer from `start_frame` to the end with Lumetri params (match-grade).
- `looks`: add or override per-shot presets. Built in: haze, golden, green, stage, night, indoor, sport, none.

Tracks: V1 shots, V2.. one per overlay, then flashes/leaks, grade, caption.
