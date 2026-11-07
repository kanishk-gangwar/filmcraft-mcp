import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type LiveApp, ping } from "./cli.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The FilmCraft desktop app: `$FILMCRAFT_APP`, else the platform's install location. On macOS this
 * may be an app name or a .app bundle (launched with `open`); elsewhere an executable.
 */
function appLocation(): string {
  if (process.env.FILMCRAFT_APP) return process.env.FILMCRAFT_APP;
  if (process.platform === "darwin") return "FilmCraft";
  if (process.platform === "win32") {
    const exe = join(process.env.LOCALAPPDATA ?? "", "Programs", "ArtCraft", "FilmCraft", "FilmCraft.exe");
    return existsSync(exe) ? exe : "FilmCraft.exe";
  }
  return "filmcraft";
}

/** Starts a new FilmCraft window listening on `port`, sharing a fresh control token with it. */
function spawnApp(port: number, token: string): void {
  const app = appLocation();
  if (process.platform === "darwin") {
    // -n: a new instance, so a FilmCraft window the user already has open is left alone
    spawn("open", ["-n", "-a", app, "--env", `FILMCRAFT_CONTROL_TOKEN=${token}`, "--args", "--control", String(port)], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  spawn(app, ["--control", String(port)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FILMCRAFT_CONTROL_TOKEN: token },
  }).unref();
}

/**
 * Connects to a FilmCraft app on its control bridge: an app already running with `token`, or one this
 * call launches. Resolves once the app answers.
 */
export async function connect(opts: { port: number; token?: string; launch: boolean; timeoutMs?: number }): Promise<LiveApp> {
  const address = `127.0.0.1:${opts.port}`;
  const token = opts.token ?? process.env.FILMCRAFT_CONTROL_TOKEN;
  if (token && (await ping({ address, token }))) return { address, token };
  if (!opts.launch) {
    throw new Error(
      `no FilmCraft app answers on ${address}` +
        (token ? "" : " (no token: pass token or set FILMCRAFT_CONTROL_TOKEN)") +
        ". Start it with `filmcraft --control <port>` and the same FILMCRAFT_CONTROL_TOKEN, or call with launch=true.",
    );
  }
  const app = { address, token: token ?? randomBytes(32).toString("hex") };
  spawnApp(opts.port, app.token);
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  while (Date.now() < deadline) {
    await sleep(1000);
    if (await ping(app)) return app;
  }
  throw new Error(`launched FilmCraft but it did not answer on ${address} in time (is ${appLocation()} the app?)`);
}
