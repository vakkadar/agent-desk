// Named herdr sessions the desk can open and close (beyond the ones in live_sessions).
// Registry in <data>/.index/herdr-sessions.json (not in git: holds PIN hashes).
// State machine: initialized (created, Claude running, desk not attached)
//   -> open (desk drives its Claude window) -> closed (herdr session stopped) -> open ...
// persistent: restarted when the desk starts (after a reboot or restart) unless closed, with
// Claude resuming the folder's last conversation.
// The CLI (hsession-cli.ts) and the desk both write the file; reads reload it on change.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { projectDir } from "./claude-sessions.js";

export type HState = "initialized" | "open" | "closed";

export interface HSession {
  name: string;
  location: "hp"; // only the desk host for now
  dir: string;
  pinHash?: string;
  persistent?: boolean;
  state: HState;
  createdAt: string;
  updatedAt: string;
}

/** What browsers see: no hash. */
export type HSessionRow = Omit<HSession, "pinHash"> & { pinned: boolean; running?: boolean };

const NEXT: Record<HState, HState[]> = { initialized: ["open", "closed"], open: ["open", "closed"], closed: ["open"] };
export const canMove = (from: HState, to: HState) => NEXT[from].includes(to);

export const RESERVED = ["default", "agent-desk", "general"];
export function checkName(name: string): void {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) throw new Error(`bad session name "${name}" (letters, digits, . _ -)`);
  if (RESERVED.includes(name)) throw new Error(`${name} is used by the desk; pick another name`);
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

export function checkPin(pin: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = scryptSync(pin, Buffer.from(salt, "hex"), want.length);
  return timingSafeEqual(got, want);
}

const MAX_FAILS = 5;
const LOCK_MS = 5 * 60_000;

export class HerdrSessions {
  readonly file: string;
  private rows: HSession[] = [];
  private mtime = -1;
  private fails = new Map<string, { n: number; until: number }>();

  constructor(dataDir: string, private now = () => Date.now()) {
    this.file = join(dataDir, ".index", "herdr-sessions.json");
  }

  private load(): void {
    let m: number;
    try { m = statSync(this.file).mtimeMs; } catch { this.rows = []; this.mtime = -1; return; }
    if (m === this.mtime) return;
    try { this.rows = JSON.parse(readFileSync(this.file, "utf8")); } catch { this.rows = []; }
    this.mtime = m;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.rows, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    this.mtime = statSync(this.file).mtimeMs;
  }

  list(): HSession[] { this.load(); return this.rows.map((r) => ({ ...r })); }

  get(name: string): HSession | undefined { this.load(); return this.rows.find((r) => r.name === name); }

  rows4web(running?: Set<string>): HSessionRow[] {
    return this.list().map(({ pinHash, ...r }) => ({ ...r, pinned: !!pinHash, running: running ? running.has(r.name) : undefined }));
  }

  /** Session names the desk should look in for Claude windows. */
  openNames(): string[] { return this.list().filter((r) => r.state === "open").map((r) => r.name); }

  register(o: { name: string; dir: string; pin?: string; persistent?: boolean }): HSession {
    checkName(o.name);
    this.load();
    if (this.rows.some((r) => r.name === o.name)) throw new Error(`session ${o.name} already registered`);
    const ts = new Date(this.now()).toISOString();
    const s: HSession = { name: o.name, location: "hp", dir: o.dir, state: "initialized", createdAt: ts, updatedAt: ts };
    if (o.pin) s.pinHash = hashPin(o.pin);
    if (o.persistent) s.persistent = true;
    this.rows.push(s);
    this.save();
    return { ...s };
  }

  setPin(name: string, pin?: string): void {
    const s = this.need(name);
    if (pin) s.pinHash = hashPin(pin);
    else delete s.pinHash;
    s.updatedAt = new Date(this.now()).toISOString();
    this.save();
  }

  setPersistent(name: string, on: boolean): void {
    const s = this.need(name);
    if (on) s.persistent = true;
    else delete s.persistent;
    s.updatedAt = new Date(this.now()).toISOString();
    this.save();
  }

  /** Persistent sessions to bring back at desk start: not closed by the user. */
  toRestore(): HSession[] { return this.list().filter((r) => r.persistent && r.state !== "closed"); }

  setState(name: string, to: HState): void {
    const s = this.need(name);
    if (!canMove(s.state, to)) throw new Error(`session ${name} can't go from ${s.state} to ${to}`);
    s.state = to;
    s.updatedAt = new Date(this.now()).toISOString();
    this.save();
  }

  remove(name: string): void {
    this.need(name);
    this.rows = this.rows.filter((r) => r.name !== name);
    this.save();
  }

  /** Throws unless the PIN is right (or the session has none). 5 wrong in a row lock it for 5 min. */
  verify(name: string, pin?: string): void {
    const s = this.need(name);
    if (!s.pinHash) return;
    const f = this.fails.get(name);
    if (f && f.until > this.now()) throw new Error(`session ${name} is locked after ${MAX_FAILS} wrong PINs; try again in a few minutes`);
    if (!pin) throw new Error(`PIN required for session ${name}`);
    if (checkPin(pin, s.pinHash)) { this.fails.delete(name); return; }
    const expired = !!f && f.until !== 0 && f.until <= this.now(); // a lock that ran out starts a fresh count
    const n = (f && !expired ? f.n : 0) + 1;
    this.fails.set(name, { n, until: n >= MAX_FAILS ? this.now() + LOCK_MS : 0 });
    throw new Error(`wrong PIN for session ${name}`);
  }

  private need(name: string): HSession {
    this.load();
    const s = this.rows.find((r) => r.name === name);
    if (!s) throw new Error(`no session named ${name}`);
    return s;
  }
}

// ---- herdr side: start (via deploy/herdr-session.sh) and stop ----

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../deploy/herdr-session.sh", import.meta.url));

/** Env without HERDR_*: herdr refuses some calls when it thinks it runs inside its own pane. */
function cleanEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("HERDR_")) e[k] = v;
  return e;
}

export async function runningSessions(bin = process.env.AGENT_DESK_HERDR_BIN || "herdr"): Promise<Set<string>> {
  try {
    const { stdout } = await run(bin, ["session", "list"], { env: cleanEnv(), timeout: 10_000 });
    return new Set(stdout.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c[1] === "running").map((c) => c[0]));
  } catch {
    return new Set();
  }
}

/** Claude has a past conversation in this folder (so `claude --continue` has something to resume). */
export function hasConversation(dir: string): boolean {
  const d = projectDir(dir);
  return existsSync(d) && readdirSync(d).some((f) => f.endsWith(".jsonl"));
}

/** Start the herdr session if needed, in its folder, with Claude running in it (resuming if asked and possible). */
export async function startSession(s: HSession, o: { resume?: boolean } = {}): Promise<string> {
  const args = [SCRIPT, s.name, s.dir, "--claude"];
  if (o.resume && hasConversation(s.dir)) args.push("--continue");
  const { stdout } = await run("bash", args, { env: cleanEnv(), timeout: 60_000 });
  return stdout;
}

const TRUST = /Yes, I trust this folder/;

async function claudePane(name: string, bin: string): Promise<string | null> {
  const { stdout } = await run(bin, ["--session", name, "agent", "list"], { env: cleanEnv(), timeout: 10_000 });
  const a = (JSON.parse(stdout)?.result?.agents ?? []).find((x: any) => x.agent === "claude");
  return a?.pane_id ?? null;
}

async function screen(name: string, pane: string, bin: string): Promise<string> {
  const { stdout } = await run(bin, ["--session", name, "pane", "read", pane, "--source", "visible"], { env: cleanEnv(), timeout: 10_000 });
  return stdout;
}

/** Claude's "trust this folder?" screen is up in the session (new folder). Polls briefly: Claude takes a moment to draw it. */
export async function trustPending(name: string, waitMs = 6000, bin = process.env.AGENT_DESK_HERDR_BIN || "herdr"): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    const pane = await claudePane(name, bin).catch(() => null);
    if (pane && TRUST.test(await screen(name, pane, bin).catch(() => ""))) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Answer "Yes, I trust this folder" (the user tapped Trust). Only acts while that screen is showing. */
export async function acceptTrust(name: string, bin = process.env.AGENT_DESK_HERDR_BIN || "herdr"): Promise<void> {
  const pane = await claudePane(name, bin);
  if (!pane) throw new Error(`no Claude window in session ${name}`);
  const sc = await screen(name, pane, bin);
  if (!TRUST.test(sc)) throw new Error(`session ${name} is not asking to trust its folder`);
  // Options: "❯ No, exit" then "Yes, I trust this folder". Move to Yes unless already there.
  const onYes = /❯\s*Yes, I trust this folder/.test(sc);
  await run(bin, ["--session", name, "pane", "send-keys", pane, ...(onYes ? [] : ["down"]), "enter"], { env: cleanEnv(), timeout: 10_000 });
}

export async function stopSession(name: string, bin = process.env.AGENT_DESK_HERDR_BIN || "herdr"): Promise<void> {
  if (!(await runningSessions(bin)).has(name)) return;
  await run(bin, ["session", "stop", name], { env: cleanEnv(), timeout: 30_000 });
}
