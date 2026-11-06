import { run } from "./cli.js";

/** `FFMPEG_PATH`, else `ffmpeg` on PATH. */
export const ffmpegPath = (): string => process.env.FFMPEG_PATH ?? "ffmpeg";

export async function ffmpeg(args: string[]): Promise<{ code: number; log: string }> {
  const r = await run(ffmpegPath(), ["-hide_banner", "-y", ...args]);
  if (r.code === 127) {
    throw new Error("ffmpeg is not installed. Install it (e.g. `brew install ffmpeg`) or set FFMPEG_PATH.");
  }
  // ffmpeg logs to stderr; keep the tail, which holds the summary or the error
  return { code: r.code, log: r.stderr.split("\n").slice(-40).join("\n") };
}
