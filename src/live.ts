// Live windows: interactive Claude sessions the user already has open in herdr
// (their own sessions, default "default"). A project prompt goes into the one
// open in that folder instead of starting a separate headless session, so there is
// one conversation per folder. We only ever type text, press Enter or Esc, and read;
// we never open, close or kill the user's panes.
import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { mapClaudeMessage } from "./adapters/agent/claude.js";
import { projectDir } from "./claude-sessions.js";
import type { AgentEvent, AgentState } from "./types.js";

const run = promisify(execFile);

export interface LivePane {
  herdrSession: string;
  paneId: string; // e.g. "w3:p1"
  status: AgentState;
  sessionId?: string; // Claude session id, as herdr reports it
  title: string;
  cwd: string;
}

/** Env without HERDR_*: herdr refuses some calls when it thinks it runs inside its own pane. */
function cleanEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("HERDR_")) e[k] = v;
  return e;
}

export class LiveClaude {
  constructor(private sessions: string[] = ["default"], private bin = process.env.AGENT_DESK_HERDR_BIN || "herdr", private root?: string) {}

  async cli(session: string, args: string[]): Promise<any> {
    const { stdout } = await run(this.bin, ["--session", session, ...args], { timeout: 15_000, env: cleanEnv() });
    const t = stdout.trim();
    try { return JSON.parse(t); } catch { return t; }
  }

  /** Claude windows whose folder is exactly `cwd`. Herdr down or session missing → none. */
  async find(cwd: string): Promise<LivePane[]> {
    const out: LivePane[] = [];
    for (const s of this.sessions) {
      let r: any;
      try { r = await this.cli(s, ["agent", "list"]); } catch { continue; }
      for (const a of r?.result?.agents ?? []) {
        if (a.agent !== "claude" || (a.cwd !== cwd && a.foreground_cwd !== cwd)) continue;
        out.push({ herdrSession: s, paneId: a.pane_id, status: a.agent_status ?? "unknown", title: a.terminal_title_stripped ?? a.terminal_title ?? "", cwd });
      }
    }
    // agent list has no session id; agent get does.
    await Promise.all(out.map(async (p) => Object.assign(p, await this.info(p).catch(() => ({})))));
    return out;
  }

  async info(p: LivePane): Promise<Partial<LivePane>> {
    const a = (await this.cli(p.herdrSession, ["agent", "get", p.paneId]))?.result?.agent;
    return { status: a?.agent_status ?? "unknown", sessionId: a?.agent_session?.value };
  }

  transcript(p: LivePane): string | undefined {
    return p.sessionId ? join(projectDir(p.cwd, this.root), `${p.sessionId}.jsonl`) : undefined;
  }

  /**
   * Type `text` into the window, then follow its transcript until the agent is idle again.
   * Approvals happen in that terminal; we report "blocked" while it waits.
   */
  async *send(p: LivePane, text: string, signal?: AbortSignal, pollMs = 700): AsyncIterable<AgentEvent> {
    let file = this.transcript(p);
    let pos = file ? await size(file) : 0;
    await this.cli(p.herdrSession, ["agent", "prompt", p.paneId, text]);
    const cancel = () => void this.cli(p.herdrSession, ["pane", "send-keys", p.paneId, "esc"]).catch(() => {});
    signal?.addEventListener("abort", cancel, { once: true });
    yield { kind: "state", state: "working" };

    const t0 = Date.now();
    let last: AgentState = "working";
    let sawWork = false;
    try {
      for (;;) {
        await sleep(pollMs);
        const now = await this.info(p).catch(() => ({ status: "unknown" as AgentState, sessionId: p.sessionId }));
        if (now.sessionId && now.sessionId !== p.sessionId) { // /clear or /resume in the window: follow the new file
          p.sessionId = now.sessionId;
          file = this.transcript(p);
          pos = 0;
        }
        if (file) {
          const r = await readFrom(file, pos);
          pos += r.bytes;
          for (const line of r.text.split("\n")) {
            let m: any;
            try { m = JSON.parse(line); } catch { continue; }
            if (m.isSidechain || m.isMeta) continue;
            for (const ev of mapClaudeMessage(m)) { sawWork = true; yield ev; }
          }
        }
        const st = now.status ?? "unknown";
        if (st === "working") sawWork = true;
        if (st !== last && (st === "blocked" || (st === "working" && last === "blocked"))) yield { kind: "state", state: st };
        last = st;
        // Done when idle again after it started working (or after 5s with no sign of work).
        if ((st === "idle" || st === "done") && (sawWork || Date.now() - t0 > 5_000)) break;
        if (signal?.aborted && st !== "working" && st !== "blocked") break;
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    yield signal?.aborted ? { kind: "done", outcome: "cancelled" } : { kind: "done", outcome: "ok" };
    yield { kind: "state", state: "idle" };
  }
}

/** Which window a project prompt goes to. */
export type LivePick =
  | { kind: "none" } // no window open in the folder: use the desk's own session
  | { kind: "one"; pane: LivePane }
  | { kind: "many"; panes: LivePane[] };

/** `query` (from `c:`) picks by pane id ("w3" or "w3:p1") or title words. */
export function pickLive(panes: LivePane[], query?: string): LivePick {
  if (query) {
    const q = query.toLowerCase().trim();
    const hit = panes.filter((p) => p.paneId.toLowerCase() === q || p.paneId.toLowerCase().split(":")[0] === q || p.title.toLowerCase().includes(q));
    if (hit.length === 1) return { kind: "one", pane: hit[0] };
    return hit.length ? { kind: "many", panes: hit } : { kind: "none" };
  }
  if (!panes.length) return { kind: "none" };
  return panes.length === 1 ? { kind: "one", pane: panes[0] } : { kind: "many", panes };
}

export function listPanes(panes: LivePane[]): string {
  return panes.map((p) => `c: ${p.paneId.split(":")[0]} <message>  (${p.title || p.sessionId?.slice(0, 8) || "?"}, ${p.status})`).join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function size(f: string): Promise<number> {
  return (await stat(f).catch(() => null))?.size ?? 0;
}

async function readFrom(f: string, pos: number): Promise<{ text: string; bytes: number }> {
  const fh = await open(f, "r").catch(() => null);
  if (!fh) return { text: "", bytes: 0 };
  try {
    const len = Math.max(0, (await fh.stat()).size - pos);
    if (!len) return { text: "", bytes: 0 };
    const buf = Buffer.alloc(Math.min(len, 4 << 20));
    const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a) + 1; // whole lines only: never split a UTF-8 char
    return { text: buf.subarray(0, end).toString("utf8"), bytes: end };
  } finally {
    await fh.close();
  }
}
