import { toSeconds } from "./cli.js";

type Json = Record<string, unknown>;

const sec = (ticks: unknown): number | null => (typeof ticks === "number" ? Math.round(toSeconds(ticks) * 1000) / 1000 : null);

/** Effects every clip carries; only the ones added on top are worth listing. */
const INTRINSIC = new Set(["motion", "opacity", "time_remap", "volume", "channel_volume", "panner"]);

const clip = (c: Json) => ({
  clip: c.clip,
  name: c.name,
  item: c.item,
  start: sec(c.start),
  end: sec(c.end),
  sourceIn: sec(c.sourceIn),
  sourceOut: sec(c.sourceOut),
  ...(c.speed !== 1 && { speed: c.speed }),
  ...(c.reverse === true && { reverse: true }),
  ...(c.link != null && { link: c.link }),
  ...(c.enabled === false && { enabled: false }),
  ...(added(c).length > 0 && { effects: added(c) }),
});

function added(c: Json): string[] {
  return ((c.effects as Json[] | undefined) ?? []).map((e) => e.effect as string).filter((id) => !INTRINSIC.has(id));
}

const track = (t: Json) => ({
  name: t.name,
  id: t.id,
  clips: ((t.items as Json[] | undefined) ?? []).map(clip),
  ...(((t.transitions as Json[] | undefined) ?? []).length > 0 && {
    transitions: (t.transitions as Json[]).map((x) => ({ id: x.id, effect: x.effect, from: x.from, to: x.to, start: sec(x.start), duration: sec(x.duration), align: x.align })),
  }),
});

/** `sequence.inspect` cut down to what an editor reads: tracks, clips and markers, times in seconds. */
export function summarizeSequence(value: unknown): unknown {
  const s = value as Json;
  if (!s || typeof s !== "object" || !Array.isArray(s.video)) return value;
  const settings = s.settings as Json | undefined;
  const rate = settings?.frame_rate as { num: number; den: number } | undefined;
  return {
    sequence: s.id,
    name: s.name,
    duration: sec(s.duration),
    frameSize: settings ? `${settings.width}x${settings.height}` : undefined,
    fps: rate ? rate.num / rate.den : undefined,
    video: (s.video as Json[]).map(track).filter((t) => t.clips.length > 0),
    audio: ((s.audio as Json[]) ?? []).map(track).filter((t) => t.clips.length > 0),
    markers: ((s.markers as Json[]) ?? []).map((m) => ({ ...m, start: sec(m.start) })),
  };
}
