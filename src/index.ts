#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { abs, batch, cli, exec, toTicks } from "./cli.js";
import { ffmpeg } from "./ffmpeg.js";
import { summarizeSequence } from "./timeline.js";

const server = new McpServer({ name: "filmcraft", version: "0.1.0" });

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

const project = z.string().describe("Path to the .fcproj project file");
const seconds = (what: string) => z.number().min(0).describe(`${what}, in seconds`);
const clipId = z.number().int().describe("Timeline clip id (from list_timeline)");
const track = z.string().describe('Track name such as "V1", "V2", "A1"');

// ---- project & media -------------------------------------------------------------------------

tool(
  "create_project",
  "Create a new FilmCraft project file with one empty sequence. The file opens in the FilmCraft desktop app.",
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
    return { project: abs(a.path), results };
  },
);

tool(
  "import_media",
  "Import media files (video, audio, stills, or EDL/FCP XML/FCPXML/OTIO/AAF timelines) into the project. Returns the new project item ids used by add_clip.",
  {
    project,
    paths: z.array(z.string()).min(1),
    imageSequence: z.boolean().optional().describe("Treat the first numbered still as an image sequence"),
  },
  async (a) =>
    exec(a.project, "file.import", {
      paths: a.paths.map(abs),
      ...(a.imageSequence !== undefined && { imageSequence: a.imageSequence }),
    }),
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
  "Media info for a file (codecs, size, rate, duration, streams) as FilmCraft decodes it.",
  { path: z.string() },
  async (a) => {
    const r = await cli(["probe", abs(a.path), "--compact"]);
    if (r.code !== 0) throw new Error(r.stderr || "probe failed");
    return r.result;
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
  },
  async (a) => exec(a.project, "clip.speedDuration", { clips: a.clips, speed: a.speed, reverse: a.reverse, ripple: a.ripple }),
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
  },
  async (a) =>
    exec(a.project, a.audio ? "sequence.applyAudioTransition" : "sequence.applyVideoTransition", {
      clip: a.clip,
      ...(a.edge && { edge: a.edge }),
      ...(a.frames && { frames: a.frames }),
      ...(a.effect && { effect: a.effect }),
      ...(a.align && { align: a.align }),
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
    quality: z.number().int().min(0).max(100).optional(),
    noAudio: z.boolean().default(false),
    allowOffline: z.boolean().default(false).describe("Accept placeholder frames for missing media"),
  },
  async (a) => {
    const args = ["--project", abs(a.project), "--compact", "export", abs(a.output)];
    if (a.preset) args.push("--preset", a.preset);
    if (a.format) args.push("--format", a.format);
    if (a.start !== undefined || a.end !== undefined) {
      if (a.start === undefined || a.end === undefined) throw new Error("give both start and end");
      args.push("--start", String(a.start), "--end", String(a.end));
    } else {
      args.push("--range", "entire");
    }
    if (a.scale !== undefined) args.push("--scale", String(a.scale));
    if (a.quality !== undefined) args.push("--quality", String(a.quality));
    if (a.noAudio) args.push("--no-audio");
    if (a.allowOffline) args.push("--allow-offline");
    const r = await cli(args);
    if (r.code !== 0) throw new Error(`export failed (exit ${r.code}): ${r.stderr}\n${JSON.stringify(r.result)}`);
    return { output: abs(a.output), result: r.result, warnings: r.stderr || undefined };
  },
);

tool(
  "render_frame",
  "Render one Program frame to PNG, to look at the edit.",
  { project, time: seconds("Frame time"), output: z.string().describe(".png path"), scale: z.number().positive().max(1).optional() },
  async (a) => {
    const args = ["--project", abs(a.project), "render", "--seconds", String(a.time), "--out", abs(a.output)];
    if (a.scale !== undefined) args.push("--scale", String(a.scale));
    const r = await cli(args);
    if (r.code !== 0) throw new Error(r.stderr || "render failed");
    return { output: abs(a.output) };
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
