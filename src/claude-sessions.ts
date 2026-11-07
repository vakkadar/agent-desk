// Past Claude Code sessions for a working dir, read from ~/.claude/projects/<encoded cwd>/<id>.jsonl.
// Lets the desk resume sessions started elsewhere (e.g. in a terminal) — FR-3.
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeSession {
  id: string;
  mtime: string; // ISO
  title: string; // first human prompt, trimmed
  live: boolean; // written to recently: likely still open in a terminal
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const LIVE_MS = 2 * 60_000;

/** Claude's project dir naming: every non-alphanumeric char becomes "-". */
export function projectDir(cwd: string, root = join(homedir(), ".claude", "projects")): string {
  return join(root, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export function isSessionId(s: unknown): s is string {
  return typeof s === "string" && UUID.test(s);
}

/** Newest first. Missing dir → []. */
export async function listSessions(cwd: string, opts: { root?: string; limit?: number; now?: number } = {}): Promise<ClaudeSession[]> {
  const dir = projectDir(cwd, opts.root);
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const now = opts.now ?? Date.now();
  const rows = await Promise.all(
    names.filter((n) => n.endsWith(".jsonl") && UUID.test(n.slice(0, -6))).map(async (n) => {
      const file = join(dir, n);
      const st = await stat(file).catch(() => null);
      if (!st) return null;
      return { id: n.slice(0, -6), file, ms: st.mtimeMs };
    }),
  );
  const top = rows.filter((r) => r !== null).sort((a, b) => b.ms - a.ms).slice(0, opts.limit ?? 30);
  return Promise.all(top.map(async (r) => ({
    id: r.id, mtime: new Date(r.ms).toISOString(), title: await firstPrompt(r.file), live: now - r.ms < LIVE_MS,
  })));
}

/** First human-typed prompt in the transcript head (skips command caveats/tool results). */
async function firstPrompt(file: string): Promise<string> {
  const fh = await open(file, "r").catch(() => null);
  if (!fh) return "";
  try {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line.includes('"type":"user"')) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; } // torn last line
      if (m.type !== "user" || m.isMeta || m.isSidechain) continue;
      const c = m.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((x: any) => x?.type === "text")?.text : undefined;
      if (typeof text !== "string" || !text.trim() || text.trimStart().startsWith("<")) continue;
      const t = text.replace(/\s+/g, " ").trim();
      return t.length > 120 ? t.slice(0, 119) + "…" : t;
    }
    return "";
  } finally {
    await fh.close();
  }
}
