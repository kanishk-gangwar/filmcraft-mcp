// Smoke test of the editing tools through a real MCP client.
//   node scripts/smoke.mjs <work dir> <portrait clip> <landscape clip> [<first still of an image sequence>] [--live]
// Without --live it edits a project file; with --live it launches a FilmCraft window and edits it live.
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const live = args.includes("--live");
const [dir, portrait, landscape, still] = args.filter((a) => a !== "--live");
mkdirSync(dir, { recursive: true });

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../dist/index.js", import.meta.url).pathname] }));

async function call(name, a = {}) {
  const r = await client.callTool({ name, arguments: a });
  const text = r.content.map((c) => c.text).join("\n");
  console.log(`${r.isError ? "FAIL" : "ok  "} ${name}${r.isError ? `: ${text}` : ""}`);
  if (r.isError) {
    await client.close();
    process.exit(1);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const project = `${dir}/${live ? "live" : "file"}.fcproj`;
// live: tools take no project and edit the app; file: every tool names the project
const p = live ? {} : { project };

if (live) await call("connect_app", { port: 7879 });
await call("create_project", { path: project, name: "smoke", width: 1920, height: 1080, fps: 30, videoTracks: 3 });
const { items } = await call("import_media", { ...p, paths: [portrait, landscape] });
const a = (await call("add_clip", { ...p, item: items[0], position: 0, in: 1, out: 3, audio: false })).clips[0];
const b = (await call("add_clip", { ...p, item: items[1], position: 2, in: 1, out: 5, audio: false })).clips[0];

const fit = await call("fit_clip", { ...p, clip: a, mode: "fill", focusY: 0.35 });
if (Math.abs(fit.scale - 88.889) > 0.01) throw new Error(`fill scale ${fit.scale}`);
await call("fit_clip", { ...p, clip: b, mode: "fill", zoom: 120, focusX: 0.3 });
await call("apply_effect", { ...p, clips: [a, b], effect: "lumetri", params: { exposure: 0.2, contrast: 10 } });
await call("set_effect_param", { ...p, clip: a, effect: "motion", param: "scale", value: 95, time: 0.5, keyframe: true });
await call("set_effect_param", { ...p, clip: a, effect: "opacity", param: "blend", value: "Screen" });
await call("set_speed", { ...p, clips: [b], speed: 100, interpolation: "frameBlending", ripple: false });
await call("add_transition", { ...p, clip: b, edge: "in", frames: 10, effect: "light_leak", params: { amount: 100 } });
await call("fade", { ...p, clip: b, edge: "out", frames: 20 });

const tl = await call("list_timeline", p);
const effects = tl.video.flatMap((t) => t.clips).flatMap((c) => c.effects ?? []);
if (!effects.includes("lumetri")) throw new Error("list_timeline does not show added effects");

const frames = await call("export_frames", { ...p, every: 1, dir: `${dir}/frames` });
if (frames.frames.length !== 6) throw new Error(`expected 6 program frames, got ${frames.frames.length}`);
await call("export_frames", { ...p, item: items[0], times: [0.5, 2], dir: `${dir}/frames` });
await call("render_frame", { ...p, time: 2.5, output: `${dir}/frame.png` });
await call("render", { ...p, output: `${dir}/out.mp4`, start: 0, end: 3, bitrateMbps: 30, maxRenderQuality: true, noAudio: true });
const probe = await call("probe_media", { path: `${dir}/out.mp4` });
console.log(`     render: ${probe.summary.seconds}s, ${Math.round(probe.video.bitrate / 1e5) / 10} Mbps`);

if (still) {
  const baked = await call("import_media", { ...p, paths: [still], imageSequence: true, bake: true });
  console.log(`     baked: ${baked.baked}`);
}
if (live) {
  console.log(`     app: ${JSON.stringify(await call("app_status"))}`);
  await call("save_project");
  await call("disconnect_app");
}
await client.close();
console.log("smoke test passed");
