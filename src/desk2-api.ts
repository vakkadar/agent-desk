// WebSocket actions behind the desk2 UI: the project pair in herdr (builder | reviewer per thread),
// and later the per-thread worktree, files and diff, review line, merge queue and related threads.
// server.ts calls desk2Action() before its own switch; it returns false for types it doesn't own.
import type { SourceRec, ThreadStore } from "./threads.js";
import type { Pairs } from "./pair.js";
import { changedFiles, fileDiff } from "./worktree.js";

export interface Desk2Ctx {
  store: ThreadStore;
  pairs: Pairs;
  send: (m: unknown) => void;
}

const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`no such ${what}`);
  return v;
};

/** Folder a thread's agents work in: its worktree when it has one, else the project folder. */
export function threadDir(rec: SourceRec, threadId: string): string {
  const th = rec.threads[threadId];
  return th?.worktree ?? th?.session.cwd ?? rec.location;
}

const diffBase = (th: { base?: string; lastSnap?: string }, which: unknown) => (which === "last" ? th.lastSnap ?? th.base : th.base);

export async function desk2Action(m: any, c: Desk2Ctx): Promise<boolean> {
  switch (m.type) {
    case "pair_open": {
      // Open the project's herdr session and the thread's builder | reviewer tab ("lead" for the project).
      const rec = need(c.store.get(String(m.sourceId)), "source");
      if (rec.kind !== "local") throw new Error("a pair needs a local project folder");
      const tab = m.threadId && m.threadId !== "ask" ? String(m.threadId) : "lead";
      if (tab !== "lead") need(rec.threads[tab], "thread");
      const pair = await c.pairs.open(rec.id, tab === "lead" ? rec.location : threadDir(rec, tab), tab);
      c.send({ type: "pair", sourceId: rec.id, pair, attach: c.pairs.attachCommand(rec.id) });
      return true;
    }
    case "pair_close": {
      const rec = need(c.store.get(String(m.sourceId)), "source");
      await c.pairs.closeTab(rec.id, String(m.threadId));
      c.send({ type: "pair", sourceId: rec.id, pair: c.pairs.get(rec.id) ?? null });
      return true;
    }
    case "files": {
      // Files the thread touched, output product vs supporting. base: "start" (default) | "last".
      const rec = need(c.store.get(String(m.sourceId)), "source");
      const th = need(rec.threads[String(m.threadId)], "thread");
      const base = diffBase(th, m.base);
      const files = th.worktree && base ? await changedFiles(th.worktree, base) : [];
      c.send({ type: "files", sourceId: rec.id, threadId: th.id, base: m.base === "last" ? "last" : "start", files });
      return true;
    }
    case "file_diff": {
      const rec = need(c.store.get(String(m.sourceId)), "source");
      const th = need(rec.threads[String(m.threadId)], "thread");
      const base = diffBase(th, m.base);
      if (!th.worktree || !base) throw new Error("this thread has no worktree");
      const diff = await fileDiff(th.worktree, base, String(m.path));
      c.send({ type: "file_diff", sourceId: rec.id, threadId: th.id, path: String(m.path), diff });
      return true;
    }
    case "pair_get": {
      c.send({ type: "pair", sourceId: String(m.sourceId), pair: c.pairs.get(String(m.sourceId)) ?? null });
      return true;
    }
  }
  return false;
}
