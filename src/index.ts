#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { connect } from "./app.js";
import { abs, batch, cli, exec, liveApp, liveProjectPath, setLiveApp, TICKS_PER_SECOND, toTicks, useLive } from "./cli.js";
import { ffmpeg } from "./ffmpeg.js";
import { bakeImageSequence, clipInfo, framing, mediaSize, sequenceInfo } from "./media.js";
import { summarizeSequence } from "./timeline.js";

const server = new McpServer({ name: "filmcraft", version: "0.2.0" });

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (e: unknown): CallToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

/** Registers a tool whose handler errors become `isError` results instead of protocol errors. */
function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  readOnly = false,
) {
  server.registerTool(
    name,
    { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, openWorldHint: false } },
    (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await handler(args));
      } catch (e) {
        return fail(e);
      }
    }) as never,
  );
}

const project = z
  .string()
  .optional()
  .describe("Path to the .fcproj project file; omit to edit the FilmCraft app connected with connect_app");
const seconds = (what: string) => z.number().min(0).describe(`${what}, in seconds`);
const clipId = z.number().int().describe("Timeline clip id (from list_timeline)");
const track = z.string().describe('Track name such as "V1", "V2", "A1"');

// ---- project & media -------------------------------------------------------------------------

tool(
  "create_project",
  "Create a new FilmCraft project file with one empty sequence. When connected to the app (connect_app), it also opens there so later edits show live.",
  {
    path: z.string().describe("Where to write the .fcproj file"),
    name: z.string().default("Untitled").describe("Project and sequence name"),
    width: z.number().int().default(1920),
    height: z.number().int().default(1080),
    fps: z.number().default(30),
    videoTracks: z.number().int().min(1).max(256).default(3),
    audioTracks: z.number().int().min(0).max(256).default(3),
  },
  async (a) => {
    const results = await batch(
      [
        { id: "file.newProject", params: { name: a.name } },
        {
          id: "file.newSequence",
          params: { name: a.name, width: a.width, height: a.height, fps: a.fps, video: a.videoTracks, audio: a.audioTracks },
        },
      ],
      { saveAs: a.path },
    );
    const openedInApp = liveApp() !== null;
    if (openedInApp) await exec(undefined, "file.open", { path: abs(a.path) });
    return { project: abs(a.path), openedInApp, results };
  },
);

tool(
  "import_media",
  "Import media files (video, audio, stills, or EDL/FCP XML/FCPXML/OTIO/AAF timelines) into the project. Returns the new project item ids used by add_clip.",
  {
    project,
    paths: z.array(z.string()).min(1),
    imageSequence: z.boolean().optional().describe("Treat the first numbered still as an image sequence"),
    bake: z
      .boolean()
      .default(false)
      .describe(
        "With imageSequence: render the sequence to a ProRes .mov next to the frames and import that instead. The app can keep stale frames of a re-written sequence; a baked movie never is.",
      ),
    fps: z.number().positive().default(30).describe("Frame rate of a baked image sequence"),
  },
  async (a) => {
    let paths = a.paths.map(abs);
    let baked: string[] | undefined;
    if (a.bake) {
      if (!a.imageSequence) throw new Error("bake applies to image sequences: set imageSequence=true");
      baked = [];
      for (const p of paths) baked.push(await bakeImageSequence(p, a.fps));
      paths = baked;
    }
    const result = await exec(a.project, "file.import", {
      paths,
      ...(a.imageSequence !== undefined && !a.bake && { imageSequence: a.imageSequence }),
    });
    return baked ? { baked, ...(result as object) } : result;
  },
);

tool(
  "inspect_project",
  "List bins and project items (media, sequences, graphics) with ids, types and durations.",
  { project },
  async (a) => exec(a.project, "project.inspect", {}, false),
  true,
);

tool(
  "probe_media",
  "Media info for a file (codecs, size, rate, duration, streams) as FilmCraft decodes it, with a summary: seconds, size, fps and whether it is portrait.",
  { path: z.string() },
  async (a) => {
    const r = await cli(["probe", abs(a.path), "--compact"]);
    if (r.code !== 0) throw new Error(r.stderr || "probe failed");
    const p = r.result as { duration?: number; video?: { width: number; height: number; frame_rate?: { num: number; den: number } } };
    const v = p.video;
    const summary = {
      seconds: typeof p.duration === "number" ? Math.round((p.duration / TICKS_PER_SECOND) * 1000) / 1000 : undefined,
      ...(v && {
        width: v.width,
        height: v.height,
        fps: v.frame_rate ? Math.round((v.frame_rate.num / v.frame_rate.den) * 1000) / 1000 : undefined,
        portrait: v.height > v.width,
      }),
    };
    return { summary, ...p };
  },
  true,
);

// ---- timeline edits --------------------------------------------------------------------------

tool(
  "add_clip",
  "Place a project item on the timeline. Overwrites by default; set insert=true to ripple-insert. The picture goes to `track` and linked sound to `audioTrack`.",
  {
    project,
    item: z.number().int().describe("Project item id (from import_media / inspect_project)"),
    position: seconds("Timeline position").default(0),
    in: seconds("Source in point").default(0),
    out: z.number().min(0).optional().describe("Source out point in seconds; omit to use the rest of the media"),
    track: track.default("V1"),
    audioTrack: z.string().optional().describe('Audio destination, e.g. "A1"'),
    insert: z.boolean().default(false),
    video: z.boolean().default(true),
    audio: z.boolean().default(true),
  },
  async (a) => {
    if (a.out !== undefined && a.out <= a.in) throw new Error("`out` must be after `in`");
    return exec(a.project, "timeline.place", {
      item: a.item,
      track: a.track,
      ...(a.audioTrack && { audioTrack: a.audioTrack }),
      time: toTicks(a.position),
      sourceIn: toTicks(a.in),
      ...(a.out !== undefined && { duration: toTicks(a.out - a.in) }),
      insert: a.insert,
      video: a.video,
      audio: a.audio,
    });
  },
);

tool(
  "trim_clip",
  "Move a clip's in or out edge. Positive delta moves the edge later. Regular trim leaves a gap; ripple trim shifts later clips.",
  {
    project,
    clip: clipId,
    edge: z.enum(["in", "out"]),
    delta: z.number().optional().describe("Edge offset in seconds (negative = earlier)"),
    deltaFrames: z.number().int().optional().describe("Edge offset in frames, instead of delta"),
    ripple: z.boolean().default(false),
  },
  async (a) => {
    if ((a.delta === undefined) === (a.deltaFrames === undefined)) throw new Error("give exactly one of delta or deltaFrames");
    return exec(a.project, "timeline.trim", {
      clip: a.clip,
      edge: a.edge,
      mode: a.ripple ? "ripple" : "regular",
      ...(a.delta !== undefined ? { delta: toTicks(a.delta) } : { deltaFrames: a.deltaFrames }),
    });
  },
);

tool(
  "split_clip",
  "Razor: cut clips at a timeline time (on one track or clip, else on every track at that time).",
  { project, time: seconds("Cut time"), track: z.string().optional(), clip: clipId.optional() },
  async (a) =>
    exec(a.project, "timeline.razor", {
      time: toTicks(a.time),
      ...(a.track && { track: a.track }),
      ...(a.clip !== undefined && { clip: a.clip }),
    }),
);

tool(
  "delete_clips",
  "Delete clips from the timeline. ripple=true closes the gap.",
  { project, clips: z.array(clipId).min(1), ripple: z.boolean().default(false) },
  async (a) => exec(a.project, "timeline.delete", { clips: a.clips, ripple: a.ripple }),
);

tool(
  "move_clip",
  "Move a clip (and its linked audio) to a new time and optionally another track.",
  { project, clip: clipId, position: seconds("New start"), track: z.string().optional(), insert: z.boolean().default(false) },
  async (a) =>
    exec(a.project, "timeline.move", {
      moves: [{ clip: a.clip, time: toTicks(a.position), ...(a.track && { track: a.track }) }],
      insert: a.insert,
    }),
);

tool(
  "set_speed",
  "Change clip speed (percent, 100 = normal) and/or reverse it.",
  {
    project,
    clips: z.array(clipId).min(1),
    speed: z.number().positive().default(100),
    reverse: z.boolean().default(false),
    ripple: z.boolean().default(true),
    interpolation: z
      .enum(["frameSampling", "frameBlending", "opticalFlow"])
      .optional()
      .describe("How new frames are made; frameBlending at speed 100 smooths a 24 fps clip in a 30 fps sequence"),
  },
  async (a) =>
    exec(a.project, "clip.speedDuration", {
      clips: a.clips,
      speed: a.speed,
      reverse: a.reverse,
      ripple: a.ripple,
      ...(a.interpolation && { interpolation: a.interpolation }),
    }),
);

tool(
  "add_transition",
  "Apply a transition at a clip's edge (default: Cross Dissolve for video, Constant Power for audio). An edit point between two clips gets a two-sided transition.",
  {
    project,
    clip: clipId,
    edge: z.enum(["in", "out"]).optional().describe("Which edge; omit for the nearest edit"),
    frames: z.number().int().positive().optional().describe("Duration in frames (default: the app's default, 1 s)"),
    effect: z.string().optional().describe('e.g. "Cross Dissolve", "Dip to Black", "Film Dissolve"'),
    align: z.enum(["center", "start", "end"]).optional(),
    audio: z.boolean().default(false).describe("Apply an audio transition instead"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Transition parameters, e.g. {"color": [1, 0.5, 0.15, 1], "amount": 100} for light_leak'),
  },
  async (a) =>
    exec(a.project, a.audio ? "sequence.applyAudioTransition" : "sequence.applyVideoTransition", {
      clip: a.clip,
      ...(a.edge && { edge: a.edge }),
      ...(a.frames && { frames: a.frames }),
      ...(a.effect && { effect: a.effect }),
      ...(a.align && { align: a.align }),
      ...(a.params && { params: a.params }),
    }),
);

tool(
  "add_marker",
  "Add a sequence marker.",
  {
    project,
    time: seconds("Marker time"),
    name: z.string().optional(),
    comment: z.string().optional(),
    color: z.string().optional().describe('Label name ("green") or "#rrggbb"'),
    durationFrames: z.number().int().optional(),
  },
  async (a) =>
    exec(a.project, "markers.add", {
      target: "program",
      time: toTicks(a.time),
      ...(a.name && { name: a.name }),
      ...(a.comment && { comment: a.comment }),
      ...(a.color && { color: a.color }),
      ...(a.durationFrames && { durationFrames: a.durationFrames }),
    }),
);

tool(
  "add_text",
  "Add a text title (graphic clip) on the timeline.",
  {
    project,
    text: z.string(),
    time: seconds("Start time").default(0),
    duration: z.number().positive().default(5).describe("Seconds"),
    size: z.number().positive().default(100).describe("Font size in px"),
    position: z.tuple([z.number(), z.number()]).optional().describe("Anchor [x, y] in pixels on the first baseline; default frame centre"),
    align: z.enum(["left", "center", "right"]).default("center").describe("How the text sits around its anchor"),
    color: z.string().optional().describe("Fill colour, #rrggbb"),
    font: z.string().optional(),
    trackIndex: z.number().int().min(0).optional().describe("Video track index (0 = V1); default: the track above the clips"),
  },
  async (a) => {
    const created = (await exec(a.project, "graphics.newText", {
      text: a.text,
      time: toTicks(a.time),
      seconds: a.duration,
      size: a.size,
      ...(a.position && { position: a.position }),
      ...(a.font && { font: a.font }),
      ...(a.trackIndex !== undefined && { track: a.trackIndex }),
    })) as { clip: number; layer: number };
    await exec(a.project, "graphics.set", {
      clip: created.clip,
      layer: created.layer,
      props: { align: a.align, ...(a.color && { fill_color: a.color }) },
    });
    return created;
  },
);

// ---- effects, keyframes, fades, framing ------------------------------------------------------

const effectRef = z
  .union([z.string(), z.number().int()])
  .describe('Effect id ("lumetri", "gaussian_blur", "motion", "opacity"…) or its index in the clip\'s effect list');

tool(
  "apply_effect",
  "Add a video or audio effect to clips and optionally set its parameters (search ids with list_commands 'effects' or run_command effects.list).",
  {
    project,
    clips: z.array(clipId).min(1),
    effect: z.string().describe('Effect id, e.g. "lumetri", "vr_denoise", "gaussian_blur", "track_matte"'),
    params: z.record(z.string(), z.unknown()).optional().describe('Parameter values, e.g. {"amount": 45}'),
  },
  async (a) => {
    await exec(a.project, "effects.apply", { clips: a.clips, effect: a.effect });
    for (const clip of a.clips) {
      for (const [param, value] of Object.entries(a.params ?? {})) {
        await exec(a.project, "effects.setParam", { clip, effect: a.effect, param, value });
      }
    }
    return { clips: a.clips, effect: a.effect, params: a.params ?? {} };
  },
);

tool(
  "set_effect_param",
  "Set one effect parameter on a clip: a fixed value, or a keyframe at a timeline time (keyframe=true animates it). Motion: scale, position [x,y], rotation. Opacity: opacity, blend (\"Screen\", \"Multiply\"…). Lumetri: exposure, contrast, temperature, saturation, curve_red/green/blue [[x,y]…], vignette_amount…",
  {
    project,
    clip: clipId,
    effect: effectRef,
    param: z.string(),
    value: z.unknown().describe("Number, [x, y], #rrggbb, bool, option name, or curve points"),
    time: z.number().min(0).optional().describe("Timeline seconds for the keyframe"),
    keyframe: z.boolean().default(false).describe("Write a keyframe at `time` (and animate the parameter)"),
  },
  async (a) => {
    if (a.keyframe && a.time === undefined) throw new Error("a keyframe needs a time");
    return exec(a.project, "effects.setParam", {
      clip: a.clip,
      effect: a.effect,
      param: a.param,
      value: a.value,
      ...(a.time !== undefined && { time: toTicks(a.time) }),
      ...(a.keyframe && { keyframe: true }),
    });
  },
);

tool(
  "fade",
  "Fade a clip in from black or out to black over N frames with opacity keyframes (works at the very end of a sequence, where Dip to Black can cut instead of fade). Audio clips get a Constant Power fade.",
  {
    project,
    clip: clipId,
    edge: z.enum(["in", "out"]),
    frames: z.number().int().positive().default(30),
  },
  async (a) => {
    const c = await clipInfo(a.project, a.clip);
    if (c.kind === "audio") {
      return exec(a.project, "sequence.applyAudioTransition", {
        clip: a.clip,
        edge: a.edge,
        frames: a.frames,
        effect: "constant_power",
        align: a.edge === "in" ? "start" : "end",
      });
    }
    const n = Math.min(a.frames, c.endFrame - c.startFrame);
    const keys =
      a.edge === "in"
        ? [
            [c.startFrame, 0],
            [c.startFrame + n, 100],
          ]
        : [
            [c.endFrame - n, 100],
            [c.endFrame - 1, 0],
          ];
    for (const [frame, value] of keys) {
      await exec(a.project, "effects.setParam", {
        clip: a.clip,
        effect: "opacity",
        param: "opacity",
        value,
        time: Math.round((frame * TICKS_PER_SECOND) / c.fps),
        keyframe: true,
      });
    }
    return { clip: a.clip, edge: a.edge, frames: n };
  },
);

tool(
  "fit_clip",
  "Frame a clip in the sequence: fill (cover the frame, cropping) or fit (show it all), zoom further in, and choose which part of the source stays in view. Use it for portrait footage in a landscape sequence (focusY picks the slice) or to punch in on a subject.",
  {
    project,
    clip: clipId,
    mode: z.enum(["fill", "fit"]).default("fill"),
    zoom: z.number().min(10).default(100).describe("Percent on top of fill/fit; 150 = punch in 1.5x"),
    focusX: z.number().min(0).max(1).default(0.5).describe("0 = left edge, 1 = right edge of the source"),
    focusY: z.number().min(0).max(1).default(0.5).describe("0 = top, 1 = bottom of the source; e.g. 0.35 keeps heads in a portrait clip"),
  },
  async (a) => {
    const [seq, c] = await Promise.all([sequenceInfo(a.project), clipInfo(a.project, a.clip)]);
    const src = await mediaSize(a.project, c.item);
    const f = framing({ frameW: seq.width, frameH: seq.height, srcW: src.width, srcH: src.height, ...a });
    await exec(a.project, "effects.setParam", { clip: a.clip, effect: "motion", param: "scale", value: f.scale });
    await exec(a.project, "effects.setParam", { clip: a.clip, effect: "motion", param: "position", value: f.position });
    return { clip: a.clip, ...f, source: [src.width, src.height], frame: [seq.width, seq.height] };
  },
);

// ---- the live app ----------------------------------------------------------------------------

tool(
  "connect_app",
  "Drive the FilmCraft desktop app live: every edit then shows in its window as it happens. Launches a new FilmCraft window in control mode (an already open window is left alone), or attaches to one started with `--control PORT` and FILMCRAFT_CONTROL_TOKEN. While connected, tools without `project`, or with the project the app has open, edit the app; save with save_project.",
  {
    port: z.number().int().min(1024).max(65535).default(7878),
    launch: z.boolean().default(true).describe("Start the app if nothing answers on the port"),
    token: z.string().optional().describe("Control token of an app you started yourself (default: $FILMCRAFT_CONTROL_TOKEN, or a fresh one)"),
    open: z.string().optional().describe("A .fcproj to open in the app once connected"),
  },
  async (a) => {
    const app = await connect({ port: a.port, token: a.token, launch: a.launch });
    setLiveApp(app);
    if (a.open) await exec(undefined, "file.open", { path: abs(a.open) });
    return { connected: app.address, project: await liveProjectPath() };
  },
);

tool(
  "app_status",
  "Whether this server is driving the FilmCraft app, and which project the app has open.",
  {},
  async () => {
    const app = liveApp();
    return app ? { connected: app.address, project: await liveProjectPath() } : { connected: false };
  },
  true,
);

tool(
  "disconnect_app",
  "Stop driving the app; tools need a project file again. The app keeps running.",
  {},
  async () => {
    setLiveApp(null);
    return { connected: false };
  },
);

tool(
  "save_project",
  "Save the project open in the connected app (to its own file, or to `path`).",
  { path: z.string().optional().describe("Save As this .fcproj instead") },
  async (a) => (a.path ? exec(undefined, "file.saveAs", { path: abs(a.path) }) : exec(undefined, "file.save", {})),
);

// ---- reading the timeline --------------------------------------------------------------------

tool(
  "list_timeline",
  "The active sequence: tracks, clips (ids, timeline start/end and source in/out in seconds), transitions and markers. raw=true returns FilmCraft's full sequence.inspect JSON.",
  { project, raw: z.boolean().default(false) },
  async (a) => {
    const seq = await exec(a.project, "sequence.inspect", {}, false);
    return a.raw ? seq : summarizeSequence(seq);
  },
  true,
);

// ---- output ----------------------------------------------------------------------------------

tool(
  "render",
  "Export the active sequence to a media file and wait for it (H.264 .mp4 by default from the extension; also .mov ProRes/DNxHR, .gif, .png sequence, .wav…).",
  {
    project,
    output: z.string().describe("Output path; the extension picks the format unless format/preset is given"),
    preset: z.string().optional().describe('Export preset name, e.g. "YouTube 1080p Full HD"'),
    format: z.string().optional().describe("h264|hevc|prores|dnxhr|mjpeg|gif|png|wav|aac…"),
    start: z.number().min(0).optional().describe("Range start in seconds"),
    end: z.number().positive().optional().describe("Range end in seconds"),
    scale: z.number().positive().max(1).optional().describe("Render at a fraction of the frame size"),
    quality: z.number().int().min(0).max(100).optional().describe("For formats that take one; H.264/HEVC size is set by bitrateMbps"),
    bitrateMbps: z.number().positive().optional().describe("Target video bitrate for H.264/HEVC, e.g. 40"),
    bitrateMode: z.enum(["cbr", "vbr1Pass", "vbr2Pass", "crf"]).optional(),
    maxRenderQuality: z
      .boolean()
      .default(false)
      .describe("Turn on the sequence's Maximum Render Quality first: sharper scaling of large (e.g. 4K) sources"),
    noAudio: z.boolean().default(false),
    allowOffline: z.boolean().default(false).describe("Accept placeholder frames for missing media"),
  },
  async (a) => {
    if ((a.start === undefined) !== (a.end === undefined)) throw new Error("give both start and end");
    if (a.maxRenderQuality) await exec(a.project, "sequence.settings", { maxRenderQuality: true });
    const r = (await exec(
      a.project,
      "file.exportMedia",
      {
        path: abs(a.output),
        ...(a.preset && { preset: a.preset }),
        ...(a.format && { format: a.format }),
        ...(a.start !== undefined ? { range: "custom", startSeconds: a.start, endSeconds: a.end } : { range: "entire" }),
        ...(a.scale !== undefined && { scale: a.scale }),
        ...(a.quality !== undefined && { quality: a.quality }),
        ...(a.bitrateMbps !== undefined && { bitrateKbps: Math.round(a.bitrateMbps * 1000) }),
        ...(a.bitrateMode && { bitrateMode: a.bitrateMode }),
        audio: !a.noAudio,
        wait: true,
      },
      false,
    )) as { offlineMedia?: unknown[]; warnings?: unknown[] };
    if (r?.offlineMedia?.length && !a.allowOffline) {
      throw new Error(`rendered with offline media (placeholder frames): ${JSON.stringify(r.offlineMedia)}; pass allowOffline to accept`);
    }
    return { output: abs(a.output), result: r };
  },
);

tool(
  "render_frame",
  "Render one Program frame to an image, to look at the edit.",
  {
    project,
    time: seconds("Frame time"),
    output: z.string().describe(".png path (.jpg also works for the live app)"),
    scale: z.number().positive().max(1).optional().describe("Fraction of the frame size (project files only)"),
  },
  async (a) => {
    if (await useLive(a.project)) {
      await exec(undefined, "file.exportFrame", { target: "program", time: toTicks(a.time), path: abs(a.output) }, false);
      return { output: abs(a.output) };
    }
    const args = ["--project", abs(a.project!), "render", "--seconds", String(a.time), "--out", abs(a.output)];
    if (a.scale !== undefined) args.push("--scale", String(a.scale));
    const r = await cli(args);
    if (r.code !== 0) throw new Error(r.stderr || "render failed");
    return { output: abs(a.output) };
  },
  true,
);

tool(
  "export_frames",
  "Export stills to look at footage or the edit: from a source item (to pick moments) or the Program. Give times, or every N seconds over a range.",
  {
    project,
    item: z.number().int().optional().describe("Source item id; omit for the Program (the edit)"),
    times: z.array(z.number().min(0)).optional().describe("Seconds (source time for an item, timeline time for the Program)"),
    every: z.number().positive().optional().describe("Instead of times: one frame every N seconds"),
    start: z.number().min(0).default(0),
    end: z.number().positive().optional().describe("End of the range for `every` (default: the item's or sequence's duration)"),
    dir: z.string().describe("Folder to write the frames to"),
    format: z.enum(["jpeg", "png"]).default("jpeg"),
  },
  async (a) => {
    let times = a.times;
    if (!times) {
      if (!a.every) throw new Error("give times or every");
      let end = a.end;
      if (end === undefined) {
        end = a.item !== undefined ? (await mediaSize(a.project, a.item)).seconds : (await sequenceInfo(a.project)).seconds;
      }
      times = [];
      for (let t = a.start; t < end - 1e-6; t += a.every) times.push(Math.round(t * 1000) / 1000);
    }
    const ext = a.format === "jpeg" ? "jpg" : "png";
    const dir = abs(a.dir);
    const tag = a.item !== undefined ? `item${a.item}` : "program";
    const frames = times.map((t) => ({ time: t, path: `${dir}/${tag}_${t.toFixed(2).padStart(7, "0")}s.${ext}` }));
    await mkdir(dir, { recursive: true });
    await batch(
      frames.map((f) => ({
        id: "file.exportFrame",
        params: {
          target: a.item !== undefined ? "source" : "program",
          ...(a.item !== undefined && { item: a.item }),
          time: toTicks(f.time),
          format: a.format,
          path: f.path,
        },
      })),
      { project: a.project, save: false },
    );
    return { frames };
  },
  true,
);

tool(
  "export_timeline",
  "Export the active sequence as an interchange timeline for other editors (Premiere: xml / aaf; Resolve: xml / fcpxml / edl / otio).",
  { project, output: z.string(), format: z.enum(["xml", "fcpxml", "otio", "edl", "aaf", "omf"]).default("xml") },
  async (a) => exec(a.project, "file.exportInterchange", { format: a.format, path: abs(a.output) }, false),
);

// ---- escape hatches --------------------------------------------------------------------------

tool(
  "list_commands",
  "Search FilmCraft's 650+ engine commands (id, label, params). Use with run_command for anything without a dedicated tool (effects, color, audio, captions, keyframes…).",
  { filter: z.string().describe("Substring, e.g. 'effects' or 'lumetri'") },
  async (a) => {
    const r = await cli(["commands", a.filter, "--json", "--compact"]);
    if (r.code !== 0) throw new Error(r.stderr);
    return r.result;
  },
  true,
);

tool(
  "run_command",
  "Run any FilmCraft engine command on the project (times are ticks: 254016000000 per second, or {seconds: n}). Saved back unless save=false.",
  { project, id: z.string(), params: z.record(z.string(), z.unknown()).default({}), save: z.boolean().default(true) },
  async (a) => exec(a.project, a.id, a.params, a.save),
);

tool(
  "run_batch",
  "Run several engine commands in one session, in order, then save once. Faster than many single calls; stops at the first failure unless keepGoing.",
  {
    project,
    steps: z.array(z.object({ id: z.string(), params: z.record(z.string(), z.unknown()).optional() })).min(1),
    keepGoing: z.boolean().default(false),
  },
  async (a) => batch(a.steps, { project: a.project, keepGoing: a.keepGoing }),
);

// ---- ffmpeg fallback -------------------------------------------------------------------------

tool(
  "ffmpeg_convert",
  "Fallback for what FilmCraft can't do: transcode a file with ffmpeg (e.g. AV1/VP9/WebM output, DivX/DV input, audio extraction to mp3). Requires ffmpeg.",
  {
    input: z.string(),
    output: z.string(),
    args: z.array(z.string()).default([]).describe('Extra ffmpeg args placed between input and output, e.g. ["-c:v","libsvtav1"]'),
  },
  async (a) => {
    const r = await ffmpeg(["-i", abs(a.input), ...a.args, abs(a.output)]);
    if (r.code !== 0) throw new Error(r.log);
    return { output: abs(a.output), log: r.log };
  },
);

tool(
  "ffmpeg_run",
  "Run ffmpeg with raw arguments (-y and -hide_banner are added). Requires ffmpeg.",
  { args: z.array(z.string()).min(1) },
  async (a) => {
    const r = await ffmpeg(a.args);
    if (r.code !== 0) throw new Error(r.log);
    return r.log;
  },
);

await server.connect(new StdioServerTransport());
