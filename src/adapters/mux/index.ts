// Mux selection: config `mux = "herdr" | "none"`. "none" = direct child process.
// Falls back to "none" with a warning if herdr is missing/unusable.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { HerdrMux } from "./herdr.js";
import { hostedSpawn } from "./hosted.js";
import { directSpawn, type SpawnFn } from "./spawn.js";

export { recoverTurns, type RecoveredTurn } from "./hosted.js";
export type { SpawnFn, SpawnedProc } from "./spawn.js";

const run = promisify(execFile);

export interface MuxHandle {
  mode: "herdr" | "none";
  spawn: SpawnFn;
  herdr?: HerdrMux;
}

let current: { requested: string; handle: MuxHandle; note?: string } = {
  requested: "none",
  handle: { mode: "none", spawn: directSpawn },
};

export async function createMux(cfg: { mux: string; dataDir: string }, log = console.warn): Promise<MuxHandle> {
  let handle: MuxHandle = { mode: "none", spawn: directSpawn };
  let note: string | undefined;
  if (cfg.mux === "herdr") {
    try {
      await run("herdr", ["--version"], { timeout: 5_000 });
      const herdr = new HerdrMux("agent-desk", join(cfg.dataDir, ".index", "mux-panes.json"));
      await herdr.ensureServer();
      handle = { mode: "herdr", spawn: hostedSpawn(herdr, cfg.dataDir), herdr };
    } catch (e: any) {
      note = `herdr unavailable (${String(e?.message ?? e).split("\n")[0]}); falling back to mux=none`;
      log(`[mux] ${note}`);
    }
  } else if (cfg.mux !== "none") {
    note = `unknown mux "${cfg.mux}"; using none`;
    log(`[mux] ${note}`);
  }
  current = { requested: cfg.mux, handle, note };
  return handle;
}

/** Health probe for the doctor/health page. */
export async function muxStatus(): Promise<{ ok: boolean; detail: string }> {
  const { requested, handle, note } = current;
  if (handle.mode === "none") {
    return { ok: requested === "none", detail: note ?? "mux=none (direct spawn; turns do not survive agent-desk restart)" };
  }
  try {
    const h = handle.herdr!;
    const v = await h.version();
    const up = await h.available();
    return up
      ? { ok: true, detail: `${v}; server up; session "${h.session}" (attach: herdr --session ${h.session})` }
      : { ok: false, detail: `${v}; server for session "${h.session}" is down` };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e) };
  }
}
