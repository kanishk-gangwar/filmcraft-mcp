# filmcraft-mcp

An MCP server that lets Claude edit video through [FilmCraft](https://github.com/storytold/filmcraft), the open-source Rust editor modelled on Premiere Pro. Claude can create projects, import media, cut, trim, frame, grade, keyframe, fade, add transitions, titles and markers, and render an mp4. It edits a `.fcproj` file headless, or drives the FilmCraft desktop app live so you watch every edit land in its window.

## How it drives FilmCraft (and why)

FilmCraft ships **`filmcraft-cli`**, a headless engine that runs the same 650+ commands as the GUI (`exec`, `run`, `inspect`, `export`, `render`, `probe`). This server uses that CLI (route **a**: an existing headless mode):

- **Project file = source of truth.** Each tool call runs `filmcraft-cli --project p.fcproj --save exec <command> <json>`. The edit lands in the `.fcproj` file at once, so you can open, inspect or hand off the project at any point. The CLI holds an OS lock while it saves, so concurrent calls don't lose edits.
- **Or the live app.** After `connect_app`, the same tools send their commands to a running FilmCraft window through the CLI's control bridge (`filmcraft-cli --bridge 127.0.0.1:PORT`), so edits appear in the app as they happen. Save with `save_project`.
- **Export is native.** FilmCraft has its own H.264 / AAC encoder, plus ProRes, DNxHR, GIF, PNG and WAV. ffmpeg is **not** needed to render.
- **Why not FilmCraft's own MCP server?** `filmcraft-cli mcp` exists and exposes generic tools (`command_run`, `sequence_inspect`, …). It holds the project in memory, though, and you have to save explicitly. You also have to know command ids and the tick time base (254,016,000,000 ticks per second). This server adds editor-level tools that take times in seconds and save on every call. The generic route is still available through `run_command` / `run_batch`.

Routes considered:
- (b) writing `.fcproj` JSON directly works (schema v17, documented in FilmCraft's `docs/project-files.md`), but it is brittle compared with the engine's own commands.
- (c) patching FilmCraft wasn't needed.

## Install as a Claude Code plugin (MCP server + skills)

The repo is also a Claude Code plugin: one install gives you the MCP server and the editing skills
below. You still need the FilmCraft CLI (step 1 of Setup) and, to watch edits live, the desktop app.

```
/plugin install filmcraft --marketplace kanishk-gangwar/filmcraft-mcp
```

On older Claude Code: `/plugin marketplace add kanishk-gangwar/filmcraft-mcp`, then
`/plugin install filmcraft@filmcraft-mcp`. Claude Code asks for the full path to `filmcraft-cli`
(change it later with `claude plugin configure filmcraft@filmcraft-mcp`). Restart Claude Code after
installing.

### Skills

| Skill | What it does |
|---|---|
| `recap-edit` | The whole job: footage + a reference reel → a beat-synced montage that copies the reference's cuts, music, transitions, intro and colour, built live in FilmCraft. Plans the cut as a JSON file (`build_from_plan.py` builds it headless or live; `plan_check.py` catches unused clips and bad in-points) |
| `analyze-reference` | Takes a reference video apart: every frame, exact cut frames, the beat, flash and light-leak frames, contact sheets of each section |
| `select-shots` | Samples and scores every clip (sharpness, shake, exposure, colour), review sheets with the landscape slice of portrait clips, best window per clip |
| `match-grade` | Measures shadows / midtones / highlights / saturation of the reference and the edit and says which way to move; per-shot looks by light |
| `photo-title` | Animated title made of photos (one per stroke, snapping in), letter shapes traced pixel for pixel from the reference or set in a font, clean anti-aliased edges |
| `check-render` | Decodes the render and reports frozen stretches, black gaps, hard cuts to black, a static intro, duration, bitrate and audio |
| `filmcraft-editing` | How to use the tools well: live mode, framing portrait footage, effects, keyframes, fades, baking image sequences, render quality |

Ask in plain words ("edit the clips in ~/Videos/goa like this reel", "check this render") and Claude
picks the skill, or call one directly, e.g. `/filmcraft:recap-edit`. The skill scripts need Python 3
with Pillow (`pip install pillow`).

## Setup

Works on macOS, Windows and Linux. You need:
- **Node 18+**
- **Claude Code**
- the **FilmCraft CLI** (`filmcraft-cli`)
- optionally, the **FilmCraft desktop app**, to open and watch the projects Claude edits

No Rust, Homebrew or ffmpeg is needed.

### 1. Get the FilmCraft CLI

Downloads are on the [FilmCraft releases page](https://github.com/storytold/filmcraft/releases). These steps were tested with v0.17.1.

| OS | Where the CLI comes from |
|---|---|
| macOS | The separate `filmcraft-cli-<ver>-macos-universal.zip` asset (signed and notarized). The `.app` doesn't include the CLI. |
| Windows | Installed with the app (MSI): `%LOCALAPPDATA%\Programs\ArtCraft\FilmCraft\filmcraft-cli.exe` |
| Linux | Installed with the `.deb` / `.rpm` package: `/usr/bin/filmcraft-cli` |

On macOS, for example:

```bash
mkdir -p ~/filmcraft-cli && cd ~/filmcraft-cli && curl -LO https://github.com/storytold/filmcraft/releases/download/v0.17.1/filmcraft-cli-0.17.1-macos-universal.zip && unzip -j filmcraft-cli-0.17.1-macos-universal.zip
```

```bash
~/filmcraft-cli/filmcraft-cli --version
```

The server looks for the CLI at `$FILMCRAFT_CLI`, then `bin/filmcraft-cli` inside this package, then `filmcraft-cli` on `PATH`.

### 2. Register the server with Claude Code

**Option A: straight from GitHub (recommended, no clone).** `npx` downloads and builds the server. The first start on a machine takes about 30 s; later starts are instant.

```bash
claude mcp add --scope user filmcraft-edit -e FILMCRAFT_CLI=$HOME/filmcraft-cli/filmcraft-cli -- npx -y github:kanishk-gangwar/filmcraft-mcp
```

On Windows, set `FILMCRAFT_CLI` to the full path of `filmcraft-cli.exe`.

**Option B: from a clone** (to change the code, or to run the demo):

```bash
git clone https://github.com/kanishk-gangwar/filmcraft-mcp.git && cd filmcraft-mcp && npm install
```

`npm install` also builds `dist/`. Then run:

```bash
claude mcp add --scope user filmcraft-edit -e FILMCRAFT_CLI=$HOME/filmcraft-cli/filmcraft-cli -- node $PWD/dist/index.js
```

Either command writes an entry like this to `~/.claude.json`:

```json
"filmcraft-edit": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "github:kanishk-gangwar/filmcraft-mcp"],
  "env": { "FILMCRAFT_CLI": "/Users/<you>/filmcraft-cli/filmcraft-cli" }
}
```

To share the server with everyone working in one project, put the same block under `mcpServers` in that project's `.mcp.json`. Optional: set `FFMPEG_PATH` (or install ffmpeg) for the `ffmpeg_*` tools.

### 3. Check it works

```bash
claude mcp list
```

You should see `filmcraft-edit: … ✔ Connected`. Then ask Claude something like *"Create a FilmCraft project at ~/Movies/test.fcproj, import ~/Movies/clip.mp4, keep 0–5 s and 10–15 s with a dissolve between them, and render ~/Movies/cut.mp4."*

### 4. See the edit in FilmCraft (optional)

Install the desktop app from the same releases page:

| OS | Package |
|---|---|
| macOS | `.dmg` |
| Windows | `.msi` |
| Linux | AppImage, Flatpak, `.deb` or `.rpm` |

Open the `.fcproj` Claude wrote (on macOS: `open -a FilmCraft path/to/project.fcproj`), or let Claude drive the app live:

### 5. Watch Claude edit live (optional)

Ask Claude to call `connect_app` (or say "edit it live in FilmCraft"). The server:

1. launches a **new** FilmCraft window listening on a control port (default 7878), sharing a fresh `FILMCRAFT_CONTROL_TOKEN` with it. A FilmCraft window you already have open is left alone.
2. sends every later tool call to that window. Tools called without `project`, or with the project the app has open, edit the app; tools given another project file still edit that file headless.
3. saves only when asked (`save_project`).

To attach to an app you started yourself instead, run it as `FILMCRAFT_CONTROL_TOKEN=<64 hex chars> filmcraft --control 7878` and pass the same `token` (or set `FILMCRAFT_CONTROL_TOKEN` for the server) with `launch: false`.

The server finds the app at `$FILMCRAFT_APP`, else `FilmCraft` (macOS, via `open -n -a`), `%LOCALAPPDATA%\Programs\ArtCraft\FilmCraft\FilmCraft.exe` (Windows) or `filmcraft` on `PATH` (Linux).

## Tools

Times are in **seconds**. Clip ids come from `list_timeline` and item ids from `import_media` / `inspect_project`. Every editing tool saves the project file; in live mode the app holds the edits until `save_project`. `project` is optional on every editing tool once `connect_app` has run.

**Project & media**

| Tool | What it does |
|---|---|
| `create_project` | New `.fcproj` with one sequence (size, fps, track counts); opens it in the app when connected |
| `import_media` | Import video, audio, stills, image sequences, or EDL / FCP7 XML / FCPXML / OTIO / AAF timelines. `bake: true` renders an image sequence to a ProRes `.mov` first (the app can show stale frames of a re-written sequence) |
| `inspect_project` | Bins and items with ids, types, durations |
| `probe_media` | Codec, size, rate, streams of a file, plus a summary: seconds, width, height, fps, portrait |

**Editing**

| Tool | What it does |
|---|---|
| `add_clip` | Place an item: `in` / `out` (source), `position`, `track` / `audioTrack`, overwrite or `insert` |
| `trim_clip` | Move a clip's in or out edge by `delta` seconds or `deltaFrames`; regular or `ripple` |
| `split_clip` | Razor at a time (all tracks, one track, or one clip) |
| `delete_clips` | Lift or ripple-delete clips |
| `move_clip` | Move a clip (with linked audio) in time or to another track |
| `set_speed` | Speed in percent, reverse, and `interpolation` (frame blending smooths 24 fps clips in a 30 fps sequence) |
| `add_transition` | Video or audio transition at a clip edge, with transition `params` (e.g. light leak colour) |
| `add_text` | Title (graphic clip) with size, position, alignment, colour, font, track |
| `add_marker` | Sequence marker with name, comment, colour, duration |

**Look & framing**

| Tool | What it does |
|---|---|
| `fit_clip` | Frame a clip: `fill` (cover, cropping) or `fit`, `zoom` to punch in, `focusX` / `focusY` to choose the part of the source in view, kept so a filled frame never shows an edge. Built for portrait footage in a landscape sequence |
| `apply_effect` | Add an effect (Lumetri, denoise, blur, keying…) to clips and set its parameters |
| `set_effect_param` | Set any effect parameter by name, or keyframe it at a timeline time (motion scale/position, opacity and blend mode, Lumetri curves…) |
| `fade` | Fade a clip in from / out to black with opacity keyframes (reliable at the end of a sequence); Constant Power for audio clips |

**Looking & output**

| Tool | What it does |
|---|---|
| `list_timeline` | Compact timeline: tracks, clips with their added effects, transitions, markers (`raw` for the full JSON) |
| `export_frames` | Stills from a source item (to pick moments) or the Program, at given times or every N seconds |
| `render_frame` | One Program frame as an image, to check the edit |
| `render` | Export to mp4 / mov / gif / png / wav… with preset, format, range, scale, `bitrateMbps` / `bitrateMode`, `maxRenderQuality` (sharper scaling of 4K sources), and wait |
| `export_timeline` | FCP7 XML / FCPXML / OTIO / EDL / AAF / OMF for Premiere, Resolve and others |

**Live app**

| Tool | What it does |
|---|---|
| `connect_app` | Launch or attach to a FilmCraft window and edit it live from then on; can `open` a project |
| `app_status` | Whether the server is driving the app, and the project it has open |
| `save_project` | Save the app's project (or Save As a path) |
| `disconnect_app` | Go back to editing project files |

**Escape hatches**

| Tool | What it does |
|---|---|
| `list_commands` | Search FilmCraft's engine commands |
| `run_command` | Run any engine command (captions, audio mix, graphics…) |
| `run_batch` | Several engine commands in one process (or one bridge call), saved once |
| `ffmpeg_convert` / `ffmpeg_run` | Fallback for what FilmCraft can't do (needs ffmpeg) |

## Demo (verified)

```bash
export FILMCRAFT_CLI=$HOME/filmcraft-cli/filmcraft-cli   # wherever step 1 put it
python3 scripts/make_sample.py samples      # 6 s numbered colour frames + beeps (Pillow)
# build samples/sample.mp4 with FilmCraft itself (no ffmpeg):
B=$FILMCRAFT_CLI; S=$PWD/samples   # run from a clone (Option B)
printf '%s\n' '{"id":"file.newProject","params":{"name":"Master"}}' '{"id":"file.newSequence","params":{"name":"Master","width":640,"height":360,"fps":30}}' | $B --save-as $S/master.fcproj run -
$B --project $S/master.fcproj --save exec file.import "{\"paths\":[\"$S/frames/f000.png\"],\"imageSequence\":true}"
$B --project $S/master.fcproj --save exec file.import "{\"paths\":[\"$S/tone.wav\"]}"
$B --project $S/master.fcproj --save exec timeline.place item=8 track=V1 time=0
$B --project $S/master.fcproj --save exec timeline.place item=9 track=A1 time=0
$B --project $S/master.fcproj export $S/sample.mp4 --range entire
node scripts/demo.mjs samples              # the edit, through the MCP server
```

`scripts/demo.mjs` connects to the server as an MCP client and runs these steps:
1. Creates `demo.fcproj` (640×360, 30 fps) and imports `sample.mp4`.
2. Places source 0–3 s and 4–6 s back to back, cutting out second 4.
3. Ripple-trims the first clip's out edge by 0.5 s.
4. Adds a 10-frame Cross Dissolve at the cut.
5. Adds a centred title on V2 for 0–2 s and a green marker at the cut.
6. Renders `demo.mp4` (4.5 s, H.264 High + AAC, 135 frames, about 0.3 s to encode), a PNG frame, and `demo.xml` (FCP7 XML).

Open `samples/demo.fcproj` in the FilmCraft app (0.17.1) to see the edit.

### Smoke test of the editing tools

```bash
node scripts/smoke.mjs /tmp/fc-smoke <portrait clip> <landscape clip> [<first still of an image sequence>]
```

```bash
node scripts/smoke.mjs /tmp/fc-smoke-live <portrait clip> <landscape clip> --live
```

The first edits a project file; `--live` launches a FilmCraft window and makes the same edits in it. Both frame, grade, keyframe, transition, fade, export frames, render at 30 Mbps and check the result.

## What FilmCraft can't do headlessly (or at all, as of 0.17.1)

- **GUI-only interaction:** the mouse and keyboard tools (`ui_click`, `ui_screenshot`, …) need the desktop app running with `--control PORT` and FilmCraft's own MCP in `--bridge` mode. This server doesn't use them.
- **Live sync without `connect_app`:** headless edits change the file on disk. A project already open in FilmCraft doesn't reload by itself: reopen it or use File ▸ Revert, or edit it live with `connect_app` instead.
- **`.prproj`:** Premiere projects can't be opened. Bring them in as FCP7 XML, AAF or OTIO (`import_media`).
- **Delivery codecs:** software export is H.264 only. HEVC needs a hardware encoder (VideoToolbox on macOS, 8-bit SDR). There is no AV1 / VP9 / WebM export, so use `ffmpeg_convert`.
- **Inputs:** no DivX / Xvid, DV, camera RAW or E-AC-3. Transcode them first with `ffmpeg_convert`.
- **Graphics in interchange:** titles don't survive FCP7 XML export (FilmCraft reports this). OTIO keeps them under `metadata.filmcraft`.
- **Speech-to-text** (`Transcribe`) needs a CLI built with the `whisper` feature. The release CLI doesn't have it.

## Notes

- `import_media` with `imageSequence: true` applies to every path in that call, so import audio separately.
- An image sequence imports at the app's default still rate (29.97 fps) unless you reinterpret it (`clip.interpretFootage`), or bake it (`import_media` with `bake: true`, at `fps`).
- H.264 size follows `bitrateMbps`, not `quality`: without a bitrate a 1080p render lands around 20 Mbps.
- Dip to Black on the last clip of a sequence can cut to black instead of fading; use `fade`.
- Errors come back as MCP `isError` results carrying FilmCraft's own message, for example `timeline.place failed: … no such item`.
