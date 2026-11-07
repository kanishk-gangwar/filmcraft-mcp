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

export function run(
  bin: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((done) => {
    const child = execFile(
      bin,
      args,
      {
        maxBuffer: 256 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 0,
        ...(opts.env && { env: { ...process.env, ...opts.env } }),
      },
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

// ---- live app ------------------------------------------------------------------------------------

/** The running FilmCraft app this server drives over its control bridge, when connected. */
export interface LiveApp {
  address: string; // 127.0.0.1:PORT
  token: string; // FILMCRAFT_CONTROL_TOKEN shared with the app
}

let live: LiveApp | null = null;

export const liveApp = (): LiveApp | null => live;
export const setLiveApp = (app: LiveApp | null): void => {
  live = app;
};

/** A CLI call routed to the live app over the bridge. */
function bridge(args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  if (!live) throw new CliError("not connected to the FilmCraft app (call connect_app)");
  return run(cliPath(), ["--bridge", live.address, ...args], { ...opts, env: { FILMCRAFT_CONTROL_TOKEN: live.token } });
}

/** The project file the live app has open, or null when it is unsaved / not connected. */
export async function liveProjectPath(): Promise<string | null> {
  if (!live) return null;
  const r = await bridge(["--compact", "inspect", "project"]);
  if (r.code !== 0) throw new CliError(`the app did not answer: ${r.stderr.trim() || r.stdout.trim()}`);
  const p = (parseJson(r.stdout) as { path?: string | null } | null)?.path;
  return p ? resolve(p) : null;
}

/**
 * Where a command goes: the live app when connected and `project` is omitted or is the file the app
 * has open (editing that file headless would fight the app), else the project file.
 */
export async function useLive(project?: string): Promise<boolean> {
  if (!live) {
    if (!project) throw new CliError("no project given, and not connected to the FilmCraft app (pass project, or call connect_app)");
    return false;
  }
  if (!project) return true;
  return (await liveProjectPath()) === abs(project);
}

/**
 * Runs one engine command: in the live app (see useLive), or against a project file, saving the result
 * back to it unless save=false.
 */
export async function exec(project: string | undefined, id: string, params: object = {}, save = true): Promise<unknown> {
  let r: RunResult;
  if (await useLive(project)) {
    r = await bridge(["--compact", "exec", id, JSON.stringify(params)]);
  } else {
    const args = ["--project", abs(project!), "--compact"];
    if (save) args.push("--save");
    args.push("exec", id, JSON.stringify(params));
    r = await run(cliPath(), args);
  }
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
export async function batch(
  steps: Step[],
  opts: { project?: string; saveAs?: string; keepGoing?: boolean; save?: boolean },
): Promise<unknown[]> {
  const script = steps.map((s) => JSON.stringify({ id: s.id, params: s.params ?? {} })).join("\n") + "\n";
  const toApp = !opts.saveAs && (await useLive(opts.project));
  const args = ["--compact"];
  if (!toApp) {
    if (opts.project) args.push("--project", abs(opts.project));
    if (opts.saveAs) args.push("--save-as", abs(opts.saveAs));
    else if (opts.project && opts.save !== false) args.push("--save");
  }
  if (opts.keepGoing) args.push("--keep-going");
  args.push("run", "-");
  const r = toApp ? await bridge(args, { stdin: script }) : await run(cliPath(), args, { stdin: script });
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

/** Whether the app at `app` answers on its control bridge. */
export async function ping(app: LiveApp): Promise<boolean> {
  const r = await run(cliPath(), ["--bridge", app.address, "--compact", "inspect", "project"], {
    env: { FILMCRAFT_CONTROL_TOKEN: app.token },
    timeoutMs: 5000,
  });
  return r.code === 0 && !r.stdout.includes('"error"');
}
