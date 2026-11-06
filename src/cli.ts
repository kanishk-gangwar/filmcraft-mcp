import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** FilmCraft time base: every time in the engine is an integer count of these per second. */
export const TICKS_PER_SECOND = 254_016_000_000;

export const toTicks = (seconds: number): number => Math.round(seconds * TICKS_PER_SECOND);
export const toSeconds = (ticks: number): number => ticks / TICKS_PER_SECOND;

const here = dirname(fileURLToPath(import.meta.url));

/** `FILMCRAFT_CLI`, else `bin/filmcraft-cli` next to this package, else `filmcraft-cli` on PATH. */
export function cliPath(): string {
  if (process.env.FILMCRAFT_CLI) return process.env.FILMCRAFT_CLI;
  const bundled = join(here, "..", "bin", "filmcraft-cli");
  return existsSync(bundled) ? bundled : "filmcraft-cli";
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(bin: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((done) => {
    const child = execFile(
      bin,
      args,
      { maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 0 },
      (err, stdout, stderr) => {
        if (!err) return done({ code: 0, stdout, stderr });
        const code = (err as { code?: unknown }).code;
        if (code === "ENOENT") {
          return done({ code: 127, stdout, stderr: `${bin} not found. Set FILMCRAFT_CLI or put it on PATH.` });
        }
        done({ code: typeof code === "number" ? code : 1, stdout, stderr: stderr || err.message });
      },
    );
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
  });
}

export class CliError extends Error {}

function parseJson(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export const abs = (p: string): string => resolve(p);

/** Runs one engine command against a project file and saves the result back to it. */
export async function exec(project: string, id: string, params: object = {}, save = true): Promise<unknown> {
  const args = ["--project", abs(project), "--compact"];
  if (save) args.push("--save");
  args.push("exec", id, JSON.stringify(params));
  const r = await run(cliPath(), args);
  if (r.code !== 0) throw new CliError(`${id} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return parseJson(r.stdout);
}

export interface Step {
  id: string;
  params?: object;
}

/**
 * Runs several commands in one engine session (`filmcraft-cli run -`), in order, stopping at the
 * first failure. `project` is opened first when given; the session is saved to `saveAs` or back to
 * `project`.
 */
export async function batch(steps: Step[], opts: { project?: string; saveAs?: string; keepGoing?: boolean }): Promise<unknown[]> {
  const args = ["--compact"];
  if (opts.project) args.push("--project", abs(opts.project));
  if (opts.saveAs) args.push("--save-as", abs(opts.saveAs));
  else if (opts.project) args.push("--save");
  if (opts.keepGoing) args.push("--keep-going");
  args.push("run", "-");
  const script = steps.map((s) => JSON.stringify({ id: s.id, params: s.params ?? {} })).join("\n") + "\n";
  const r = await run(cliPath(), args, { stdin: script });
  const lines = r.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => parseJson(l));
  if (r.code !== 0) {
    throw new CliError(`batch failed: ${r.stderr.trim()}\n${JSON.stringify(lines)}`);
  }
  return lines;
}

/** A raw CLI call (`export`, `render`, `probe`, `commands`, …); returns parsed stdout and stderr. */
export async function cli(args: string[], timeoutMs?: number): Promise<{ result: unknown; stderr: string; code: number }> {
  const r = await run(cliPath(), args, { timeoutMs });
  return { result: parseJson(r.stdout), stderr: r.stderr.trim(), code: r.code };
}
