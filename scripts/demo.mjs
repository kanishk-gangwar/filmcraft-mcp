// End-to-end demo through the MCP server: node scripts/demo.mjs [samples-dir]
// Needs samples/sample.mp4 (see README: scripts/make_sample.py + the master render).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "samples");
const project = `${dir}/demo.fcproj`;
rmSync(project, { force: true });

const client = new Client({ name: "demo", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../dist/index.js", import.meta.url).pathname] }));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: { project, ...args } });
  const text = r.content.map((c) => c.text).join("\n");
  if (r.isError) throw new Error(`${name}: ${text}`);
  console.log(`✓ ${name}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

await client.callTool({ name: "create_project", arguments: { path: project, name: "Demo Edit", width: 640, height: 360, fps: 30 } });
const [item] = (await call("import_media", { paths: [`${dir}/sample.mp4`] })).items;
// two segments: 0–3 s and 4–6 s of the source (second 4 is cut out)
const [first] = (await call("add_clip", { item, in: 0, out: 3, position: 0, audioTrack: "A1" })).clips;
const [second] = (await call("add_clip", { item, in: 4, out: 6, position: 3, audioTrack: "A1" })).clips;
await call("trim_clip", { clip: first, edge: "out", delta: -0.5, ripple: true });
await call("add_transition", { clip: second, edge: "in", frames: 10 });
await call("add_text", { text: "FilmCraft MCP demo", time: 0, duration: 2, size: 48, position: [320, 80], trackIndex: 1 });
await call("add_marker", { time: 2.5, name: "Jump cut", comment: "second 4 removed", color: "green" });
console.log(JSON.stringify(await call("list_timeline", {}), null, 2));
await call("render", { output: `${dir}/demo.mp4` });
await call("render_frame", { time: 1, output: `${dir}/frame_1s.png` });
await call("export_timeline", { output: `${dir}/demo.xml`, format: "xml" });
console.log(`\nProject: ${project}\nRender:  ${dir}/demo.mp4`);
await client.close();
