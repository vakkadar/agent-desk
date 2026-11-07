// FR-18: live terminal attach to a herdr session over WebSocket (/pty?session=<name>).
// Admission (sameOrigin + admitted) is done by the caller; role is resolved here from the first message.
// Protocol: client -> {type:"hello",token,cols,rows}, then {type:"input",data} | {type:"resize",cols,rows}.
// Server -> {type:"ready",role} text frame, then raw terminal output as text frames.
import type { IncomingMessage } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WebSocket } from "ws";
import * as nodePty from "node-pty";
import type { Role } from "./types.js";

const exec = promisify(execFile);
export const MAX_PTYS = 4;
const PING_MS = Number(process.env.AGENT_DESK_PTY_PING_MS) || 25_000;
let active = 0;

export function herdrBin(): string {
  return process.env.AGENT_DESK_HERDR_BIN || "herdr";
}

/** Session names from `herdr session list` (first column of the table). */
export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await exec(herdrBin(), ["session", "list"], { timeout: 5000 });
    return parseSessionList(stdout);
  } catch {
    return [];
  }
}

export function parseSessionList(out: string): string[] {
  return out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)[0]).filter((n) => n && /^[\w.-]+$/.test(n));
}

export function ptyCount(): number {
  return active;
}

export interface PtyDeps {
  resolveRole: (token?: string) => Role | null;
  sessions?: () => Promise<string[]>;
}

/** Handle one upgraded /pty socket. */
export function onPtyClient(ws: WebSocket, req: IncomingMessage, deps: PtyDeps) {
  const name = new URL(req.url ?? "", "http://x").searchParams.get("session") ?? "";
  let role: Role | null = null;
  let term: nodePty.IPty | null = null;
  let starting = false;
  const timer = setTimeout(() => role || ws.close(4003, "no hello"), 10_000);

  // Keepalive: Cloudflare drops idle sockets (~100s). Ping every 25s, terminate after 2 missed pongs.
  let missed = 0;
  ws.on("pong", () => (missed = 0));
  const ping = setInterval(() => {
    if (missed >= 2) return ws.terminate();
    missed++;
    try { ws.ping(); } catch { /* closing */ }
  }, PING_MS);

  const cleanup = () => {
    clearTimeout(timer);
    clearInterval(ping);
    if (term) {
      active--;
      try { term.kill(); } catch { /* already gone */ } // kills the attach client only, never the herdr session
      term = null;
    }
  };

  ws.on("message", async (raw) => {
    if (!role) {
      if (starting) return;
      starting = true;
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return ws.close(4003, "bad hello"); }
      if (m?.type !== "hello") return ws.close(4003, "hello first");
      role = deps.resolveRole(typeof m.token === "string" ? m.token : undefined);
      if (!role) return ws.close(4003, "forbidden");
      if (!(await (deps.sessions ?? listSessions)()).includes(name)) return ws.close(4004, "unknown session");
      if (active >= MAX_PTYS) return ws.close(4008, "too many terminals");
      if (ws.readyState !== ws.OPEN) return;
      try {
        term = nodePty.spawn(herdrBin(), ["session", "attach", name], {
          name: "xterm-256color", cols: clamp(m.cols, 80), rows: clamp(m.rows, 24),
          cwd: process.env.HOME, env: cleanEnv(),
        });
      } catch (e: any) {
        return ws.close(1011, String(e?.message ?? e).slice(0, 100));
      }
      active++;
      const t = term;
      ws.send(JSON.stringify({ type: "ready", role }));
      t.onData((d) => ws.readyState === ws.OPEN && ws.send(d));
      t.onExit(() => { if (term === t) { active--; term = null; } ws.close(1000, "attach exited"); });
      return;
    }
    if (!term) return;
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === "resize") term.resize(clamp(m.cols, 80), clamp(m.rows, 24));
    else if (m.type === "input" && role === "action" && typeof m.data === "string") term.write(m.data); // read-only: dropped
  });
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

function clamp(v: unknown, d: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 2 && n <= 500 ? n : d;
}

/** Env for the attach client: drop HERDR_* (herdr refuses to nest when it thinks it runs inside a pane). */
function cleanEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("HERDR_")) e[k] = v;
  e.TERM = "xterm-256color";
  return e;
}
