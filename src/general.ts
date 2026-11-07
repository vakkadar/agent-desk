// General source: questions not tied to any project. Built in, always present.
// Every prompt starts a fresh Claude session, unless the first line is
// `existing: <thread id | session id prefix | words from its first prompt>`,
// which continues that session (forked if it is still live elsewhere).
// With mux=herdr, a dedicated herdr session "general" keeps an interactive
// Claude open in the same folder, so its sessions are matchable too.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HerdrMux } from "./adapters/mux/herdr.js";
import { listSessions, type ClaudeSession } from "./claude-sessions.js";
import type { SourceRec, ThreadRec, ThreadStore } from "./threads.js";
import type { AgentAdapter, SessionRef } from "./types.js";

export const GENERAL_ID = "general";
export const generalDir = (dataDir: string) => join(dataDir, "general");

/** Create the built-in source on first boot. */
export async function ensureGeneral(store: ThreadStore, agent: AgentAdapter, dataDir: string): Promise<SourceRec> {
  const cwd = generalDir(dataDir);
  await mkdir(cwd, { recursive: true });
  const have = store.get(GENERAL_ID);
  if (have) return have;
  const session = await agent.start({ cwd, name: "general" });
  const rec: SourceRec = {
    id: GENERAL_ID, kind: "local", location: cwd, agent: agent.id, builtin: true,
    threads: { ask: { id: "ask", mode: "ask", session, createdAt: new Date().toISOString() } },
  };
  await store.save(rec);
  return rec;
}

/** `existing: foo\nrest` → { query: "foo", rest: "rest" }. No prefix → null. */
export function parseExisting(text: string): { query: string; rest: string } | null {
  const m = /^\s*existing:[ \t]*([^\n]*)(?:\n([\s\S]*))?$/i.exec(text);
  if (!m) return null;
  return { query: m[1].trim(), rest: (m[2] ?? "").trim() };
}

export function nextQuestionId(rec: SourceRec): string {
  let n = 1;
  while (rec.threads[`q-${n}`]) n++;
  return `q-${n}`;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Desk threads first (exact id, then title words), newest first. */
export function matchThread(rec: SourceRec, query: string): ThreadRec | undefined {
  const q = norm(query);
  if (!q) return undefined;
  const qs = Object.values(rec.threads).filter((t) => t.id !== "ask").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return qs.find((t) => t.id === q) ?? qs.find((t) => t.title && norm(t.title).includes(q));
}

/** Claude transcripts in the folder: session id prefix, then title words. Already newest first. */
export function matchSession(sessions: ClaudeSession[], query: string): ClaudeSession | undefined {
  const q = norm(query);
  if (!q) return undefined;
  return sessions.find((s) => q.length >= 4 && s.id.startsWith(q)) ?? sessions.find((s) => norm(s.title).includes(q));
}

export interface Routed { thread: ThreadRec; text: string; created: boolean }

/**
 * Pick (or create) the thread a General prompt goes to.
 * Throws when `existing:` matches nothing or has no message after it.
 */
export async function routeGeneral(rec: SourceRec, agent: AgentAdapter, text: string, title = (t: string) => t): Promise<Routed> {
  const ex = parseExisting(text);
  const body = ex ? ex.rest : text.trim();
  if (!body) throw new Error("existing: put your message on the next line");
  if (ex) {
    const th = matchThread(rec, ex.query);
    if (th) return { thread: th, text: body, created: false };
    const s = matchSession(await listSessions(rec.location, { limit: 200 }), ex.query);
    if (!s) throw new Error(`no General session matches "${ex.query}"`);
    // A session already adopted by a desk thread → reuse that thread.
    const adopted = Object.values(rec.threads).find((t) => t.session.sessionId === s.id);
    if (adopted) return { thread: adopted, text: body, created: false };
    const base: SessionRef = { agent: agent.id, sessionId: s.id, cwd: rec.location, started: true };
    const session = s.live ? await agent.fork(base, "general") : await agent.resume(base);
    return { thread: add(rec, session, title(s.title || s.id.slice(0, 8))), text: body, created: true };
  }
  const session = await agent.start({ cwd: rec.location, name: "general" });
  return { thread: add(rec, session, title(body)), text: body, created: true };
}

function add(rec: SourceRec, session: SessionRef, title: string): ThreadRec {
  const id = nextQuestionId(rec);
  const th: ThreadRec = { id, mode: "ask", session, createdAt: new Date().toISOString(), title };
  rec.threads[id] = th;
  return th;
}

/** herdr session "general" with an interactive Claude in the General folder. Never touches other sessions. */
export async function ensureGeneralHerdr(dataDir: string, bin = "herdr", claude = "claude"): Promise<string> {
  const mux = new HerdrMux("general", join(dataDir, ".index", "general-panes.json"), bin);
  const p = await mux.ensurePane("claude", generalDir(dataDir));
  if (p.fresh) await mux.cli(["pane", "run", p.id, claude]);
  return p.id;
}
