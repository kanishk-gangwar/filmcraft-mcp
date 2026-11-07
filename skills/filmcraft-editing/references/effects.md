# FilmCraft effects and transitions quick reference

Full lists: `run_command("effects.list", {"kind": "Video" | "VideoTransition" | "Audio", "detail": true})`.

## Video transitions (ids for add_transition `effect`)

| Feel | ids |
|---|---|
| Dissolves | cross_dissolve, film_dissolve, additive_dissolve, dip_to_black, dip_to_white, dip_to_color, luma_fade, morph_cut |
| Flashes & light | flash (white pop), light_leak (`color`, `amount`, `seed`), vr_light_leaks, chroma_leak, burn_chroma, flare, light_sweep, glow, ray |
| Motion | whip, push, slide, cross_zoom, zoom_blur, spin_motion, pull_motion, pop_motion, roll, stretch, directional_blur_transition |
| Glitch / texture | glitch, vhs_damage, chaos, earthquake, flicker, tv_power, mosaic_transition |
| Wipes | linear_wipe, clock_wipe, radial_wipe, iris_round, barn_doors, venetian_blinds, page_peel |

Reel conventions: a 4–8 frame `flash` (cream/white) into the first shot after a title; `whip` between
locations; a light leak (custom overlay, see recap-edit) on a big beat; hard cuts everywhere else.

## Lumetri parameters

basic: temperature, tint, exposure (-5..5), contrast, highlights, shadows, whites, blacks (-100..100),
saturation (0..200, 100 = none). creative: faded_film, sharpen, vibrance, creative_sat, shadow_tint,
highlight_tint (colours). curves: curve_luma / curve_red / curve_green / curve_blue as `[[x, y], ...]`
in 0..1. vignette: vignette_amount (-5..5, negative darkens), vignette_midpoint, vignette_feather.
Presets: `run_command("lumetri.presets")`, `lumetri.applyPreset {name, clips}` — e.g. "Golden Dusk",
"Warm Negative", "Teal Shadows, Warm Skin", "Faded Print".

## Other useful effects

| id | params | use |
|---|---|---|
| vr_denoise | amount 0–100, noise_type Fast/Slow | night / low-light shots (keep amount moderate) |
| median | radius | heavy smoothing; usually too soft for video |
| drop_shadow | — | lift picture-in-picture overlays off the frame |
| gaussian_blur | blurriness | blurred backgrounds behind a fitted portrait clip |
| track_matte | matte "Video 2", composite | footage inside text (the matte track stays visible; a black matte + Multiply blend is often simpler) |
| noise | amount, color, grain_size | film grain (skip on noisy night footage) |
| crop | left/top/right/bottom % | trim edges |

## Opacity blend modes

Normal, Multiply (white text under footage → footage inside letters, over a black matte), Screen
(light leaks / flares over a shot), Overlay, Soft Light, Add, Lighten, Darken, Difference...

## Sequence settings

`run_command("sequence.settings", {"maxRenderQuality": true})` — sharper scaling of 4K sources.
