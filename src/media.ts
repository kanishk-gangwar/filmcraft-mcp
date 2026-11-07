import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { abs, batch, cli, exec, TICKS_PER_SECOND } from "./cli.js";

type Json = Record<string, any>;

/** Frame size, rate and length of the active sequence. */
export async function sequenceInfo(project?: string) {
  const s = (await exec(project, "sequence.inspect", {}, false)) as Json;
  const rate = s.settings.frame_rate as { num: number; den: number };
  return {
    width: s.settings.width as number,
    height: s.settings.height as number,
    fps: rate.num / rate.den,
    seconds: (s.duration as number) / TICKS_PER_SECOND,
  };
}

/** Where a timeline clip sits, what it plays, and whether it is picture or sound. */
export async function clipInfo(project: string | undefined, clip: number) {
  const s = (await exec(project, "sequence.inspect", {}, false)) as Json;
  const rate = s.settings.frame_rate as { num: number; den: number };
  for (const kind of ["video", "audio"] as const) {
    for (const t of (s[kind] as Json[]) ?? []) {
      const c = ((t.items as Json[]) ?? []).find((x) => x.clip === clip);
      if (c) {
        return {
          kind,
          item: c.item as number,
          startFrame: c.startFrame as number,
          endFrame: c.endFrame as number,
          fps: rate.num / rate.den,
        };
      }
    }
  }
  throw new Error(`no clip ${clip} in the active sequence (see list_timeline)`);
}

/** Pixel size and length of a project item's media. */
export async function mediaSize(project: string | undefined, item: number) {
  const [m] = (await exec(project, "file.mediaProperties", { items: [item] }, false)) as Json[];
  if (!m?.video) throw new Error(`item ${item} has no picture`);
  return { width: m.video.width as number, height: m.video.height as number, seconds: m.duration?.seconds as number };
}

/**
 * Motion scale and position that frame a source in the sequence. fill covers the frame (cropping),
 * fit shows all of it; zoom goes further in; focus picks which part of the source stays in view,
 * kept so a filled frame never shows an edge.
 */
export function framing(o: {
  frameW: number;
  frameH: number;
  srcW: number;
  srcH: number;
  mode: "fill" | "fit";
  zoom: number;
  focusX: number;
  focusY: number;
}) {
  const base = o.mode === "fill" ? Math.max(o.frameW / o.srcW, o.frameH / o.srcH) : Math.min(o.frameW / o.srcW, o.frameH / o.srcH);
  const s = (base * o.zoom) / 100;
  const shown = [o.srcW * s, o.srcH * s];
  const frame = [o.frameW, o.frameH];
  const focus = [o.focusX, o.focusY];
  const position = [0, 1].map((i) => {
    const centred = frame[i] / 2 + (0.5 - focus[i]) * shown[i];
    if (shown[i] <= frame[i]) return frame[i] / 2;
    // keep the source covering the frame on this axis
    const lo = frame[i] - shown[i] / 2;
    const hi = shown[i] / 2;
    return Math.round(Math.min(hi, Math.max(lo, centred)) * 10) / 10;
  });
  return { scale: Math.round(s * 100 * 1000) / 1000, position };
}

/**
 * Renders an image sequence (given its first numbered still) to a ProRes .mov beside it, through a
 * throwaway headless project, and returns the movie's path.
 */
export async function bakeImageSequence(firstFrame: string, fps: number): Promise<string> {
  const probe = await cli(["probe", abs(firstFrame), "--image-sequence", "--compact"]);
  if (probe.code !== 0) throw new Error(`not an image sequence: ${probe.stderr}`);
  const v = (probe.result as Json).video as { width: number; height: number };
  const out = join(dirname(abs(firstFrame)), `${basename(dirname(abs(firstFrame)))}.mov`);
  const dir = await mkdtemp(join(tmpdir(), "filmcraft-bake-"));
  const proj = join(dir, "bake.fcproj");
  try {
    const lines = (await batch(
      [
        { id: "file.newProject", params: { name: "bake" } },
        { id: "file.newSequence", params: { name: "bake", width: v.width, height: v.height, fps } },
        { id: "file.import", params: { paths: [abs(firstFrame)], imageSequence: true } },
      ],
      { saveAs: proj },
    )) as Json[];
    const item = lines[2]?.result?.items?.[0];
    if (item === undefined) throw new Error(`import failed: ${JSON.stringify(lines[2])}`);
    await exec(proj, "timeline.place", { item, track: "V1", frame: 0, audio: false });
    const r = await cli(["--project", proj, "--compact", "export", out, "--format", "prores", "--no-audio", "--range", "entire"]);
    if (r.code !== 0) throw new Error(`bake failed: ${r.stderr}`);
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
