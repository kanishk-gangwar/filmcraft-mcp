# filmcraft-mcp

An MCP server that lets Claude edit video through [FilmCraft](https://github.com/storytold/filmcraft), the open-source Rust editor modelled on Premiere Pro. Claude can create projects, import media, cut, trim, add transitions, titles and markers, and render an mp4. The result is a normal `.fcproj` file that opens in the FilmCraft desktop app.

## How it drives FilmCraft (and why)

FilmCraft ships **`filmcraft-cli`**, a headless engine that runs the same 650+ commands as the GUI (`exec`, `run`, `inspect`, `export`, `render`, `probe`). This server uses that CLI (route **a**: an existing headless mode):

- **Project file = source of truth.** Each tool call runs `filmcraft-cli --project p.fcproj --save exec <command> <json>`. The edit lands in the `.fcproj` file at once, so you can open, inspect or hand off the project at any point. The CLI holds an OS lock while it saves, so concurrent calls don't lose edits.
- **Export is native.** FilmCraft has its own H.264 / AAC encoder, plus ProRes, DNxHR, GIF, PNG and WAV. ffmpeg is **not** needed to render.
- **Why not FilmCraft's own MCP server?** `filmcraft-cli mcp` exists and exposes generic tools (`command_run`, `sequence_inspect`, …). It holds the project in memory, though, and you have to save explicitly. You also have to know command ids and the tick time base (254,016,000,000 ticks per second). This server adds editor-level tools that take times in seconds and save on every call. The generic route is still available through `run_command` / `run_batch`.

Routes considered:
- (b) writing `.fcproj` JSON directly works (schema v17, documented in FilmCraft's `docs/project-files.md`), but it is brittle compared with the engine's own commands.
- (c) patching FilmCraft wasn't needed.

## Setup

Requirements: Node 18+ and the FilmCraft CLI. No Rust, Homebrew or ffmpeg is needed.

### Quick install on any machine (no clone)

`npx` fetches and builds the server from GitHub. You only need the FilmCraft CLI (next section) and one line:

```bash
claude mcp add --scope user filmcraft-edit -e FILMCRAFT_CLI=/abs/path/to/filmcraft-cli -- npx -y github:kanishk-gangwar/filmCraft-mcp
```

### From a clone

```bash
git clone https://github.com/kanishk-gangwar/filmCraft-mcp.git filmcraft-mcp
cd filmcraft-mcp && npm install    # also builds dist/
```

Get the CLI. On macOS, use the signed and notarized release asset (the `.app` doesn't contain it):

```bash
mkdir -p bin && cd bin && curl -LO https://github.com/storytold/filmcraft/releases/download/v0.17.1/filmcraft-cli-0.17.1-macos-universal.zip && unzip -j filmcraft-cli-0.17.1-macos-universal.zip
```

The server looks for the CLI at `$FILMCRAFT_CLI`, then `./bin/filmcraft-cli`, then `filmcraft-cli` on `PATH`.

### Register with Claude Code

```bash
claude mcp add --scope user filmcraft-edit -e FILMCRAFT_CLI=$PWD/bin/filmcraft-cli -- node $PWD/dist/index.js
```

This writes the following to `~/.claude.json`:

```json
"filmcraft-edit": {
  "type": "stdio",
  "command": "node",
  "args": ["/Users/kanishkgangwar/Documents/GitHub/filmcraft-mcp/dist/index.js"],
  "env": { "FILMCRAFT_CLI": "/Users/kanishkgangwar/Documents/GitHub/filmcraft-mcp/bin/filmcraft-cli" }
}
```

To share it with a repo instead, put the same block under `mcpServers` in that repo's `.mcp.json`. Optional: set `FFMPEG_PATH` for the `ffmpeg_*` tools.

## Tools

Times are in **seconds**. Clip ids come from `list_timeline` and item ids from `import_media` / `inspect_project`. Every editing tool saves the project.

| Tool | What it does |
|---|---|
| `create_project` | New `.fcproj` with one sequence (size, fps, track counts) |
| `import_media` | Import video, audio, stills, image sequences, or EDL / FCP7 XML / FCPXML / OTIO / AAF timelines |
| `inspect_project` | Bins and items with ids, types, durations |
| `probe_media` | Codec, size, rate, streams of a file as FilmCraft decodes it |
| `add_clip` | Place an item: `in` / `out` (source), `position`, `track` / `audioTrack`, overwrite or `insert` |
| `trim_clip` | Move a clip's in or out edge by `delta` seconds or `deltaFrames`; regular or `ripple` |
| `split_clip` | Razor at a time (all tracks, one track, or one clip) |
| `delete_clips` | Lift or ripple-delete clips |
| `move_clip` | Move a clip (with linked audio) in time or to another track |
| `set_speed` | Speed in percent, reverse |
| `add_transition` | Video or audio transition at a clip edge (Cross Dissolve, Dip to Black, …) |
| `add_text` | Title (graphic clip) with size, position, alignment, colour, font, track |
| `add_marker` | Sequence marker with name, comment, colour, duration |
| `list_timeline` | Compact timeline: tracks, clips, transitions, markers (`raw` for the full JSON) |
| `render` | Export to mp4 / mov / gif / png / wav… (preset, format, range, scale, quality) and wait |
| `render_frame` | One Program frame as PNG, to check the edit visually |
| `export_timeline` | FCP7 XML / FCPXML / OTIO / EDL / AAF / OMF for Premiere, Resolve and others |
| `list_commands` | Search FilmCraft's engine commands |
| `run_command` | Run any engine command (effects, Lumetri, keyframes, audio mix, captions…) |
| `run_batch` | Several engine commands in one process, saved once |
| `ffmpeg_convert` / `ffmpeg_run` | Fallback for what FilmCraft can't do (needs ffmpeg) |

## Demo (verified)

```bash
python3 scripts/make_sample.py samples      # 6 s numbered colour frames + beeps (Pillow)
# build samples/sample.mp4 with FilmCraft itself (no ffmpeg):
B=bin/filmcraft-cli; S=$PWD/samples
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

## What FilmCraft can't do headlessly (or at all, as of 0.17.1)

- **GUI-only interaction:** the mouse and keyboard tools (`ui_click`, `ui_screenshot`, …) need the desktop app running with `--control PORT` and FilmCraft's own MCP in `--bridge` mode. This server doesn't use them.
- **Live sync with an open app:** the CLI edits the file on disk. A project already open in FilmCraft doesn't reload by itself: reopen it or use File ▸ Revert. If you save from the app, you overwrite CLI edits made since it opened the file.
- **`.prproj`:** Premiere projects can't be opened. Bring them in as FCP7 XML, AAF or OTIO (`import_media`).
- **Delivery codecs:** software export is H.264 only. HEVC needs a hardware encoder (VideoToolbox on macOS, 8-bit SDR). There is no AV1 / VP9 / WebM export, so use `ffmpeg_convert`.
- **Inputs:** no DivX / Xvid, DV, camera RAW or E-AC-3. Transcode them first with `ffmpeg_convert`.
- **Graphics in interchange:** titles don't survive FCP7 XML export (FilmCraft reports this). OTIO keeps them under `metadata.filmcraft`.
- **Speech-to-text** (`Transcribe`) needs a CLI built with the `whisper` feature. The release CLI doesn't have it.

## Notes

- `import_media` with `imageSequence: true` applies to every path in that call, so import audio separately.
- An image sequence imports at the app's default still rate (29.97 fps) unless you reinterpret it (`clip.interpretFootage`).
- Errors come back as MCP `isError` results carrying FilmCraft's own message, for example `timeline.place failed: … no such item`.
