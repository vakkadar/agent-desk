// WebSocket actions behind the desk2 UI: the project pair in herdr (builder | reviewer per thread),
// and later the per-thread worktree, files and diff, review line, merge queue and related threads.
// server.ts calls desk2Action() before its own switch; it returns false for types it doesn't own.
import type { SourceRec, ThreadStore } from "./threads.js";
import type { Pairs } from "./pair.js";
import { changedFiles, fileDiff } from "./worktree.js";
import { readReview, reviewerBrief, verdictPath } from "./review.js";
import type { MergeQueue } from "./merge-queue.js";
import type { DeskEvent } from "./types.js";
import { links } from "./links.js";
import { isSelfSource } from "./self-dev.js";
import { DESK_CHECK, linkDeps, type DeskApplies } from "./desk-apply.js";
import type { DeskPreviews } from "./desk-preview.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Desk2Ctx {
  store: ThreadStore;
  pairs: Pairs;
  send: (m: unknown) => void;
  mergeQueue: MergeQueue;
  seesSelf: boolean; // may see the desk's own repo (Desk dev)
  events: () => Promise<DeskEvent[]>; // the event journal (prompts carry mentions and mail)
  applies?: DeskApplies; // Desk perspective (admin only; server gates desk_* types on "self")
  previews?: DeskPreviews;
}

/** What the Desk perspective shows: apply history (newest first) and running previews. */
export const deskState = (c: Pick<Desk2Ctx, "applies" | "previews">) => ({ type: "desk", applies: c.applies?.list() ?? [], previews: c.previews?.list() ?? [] });

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

const visibleQueue = (c: Desk2Ctx) => c.mergeQueue.list().filter((i) => c.seesSelf || !isSelfSource(c.store.get(i.sourceId)));

/** Command run before merging, from <project>/.desk/merge-check.json (a desk-local file, e.g. ["npm","test"]). */
async function mergeCheck(repo: string): Promise<string[] | undefined> {
  try {
    const j = JSON.parse(await readFile(join(repo, ".desk", "merge-check.json"), "utf8"));
    return Array.isArray(j) && j.length && j.every((x) => typeof x === "string") ? j : undefined;
  } catch { return undefined; }
}

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
    case "review": {
      // The one review line for the builder's turn, from the reviewer's verdict file.
      const rec = need(c.store.get(String(m.sourceId)), "source");
      const th = need(rec.threads[String(m.threadId)], "thread");
      c.send({ type: "review", sourceId: rec.id, threadId: th.id, review: await readReview(rec.location, th.id, th.worktree) });
      return true;
    }
    case "pair_review": {
      // Ask the thread's reviewer pane to (re)review: sends the brief with the verdict file path.
      const rec = need(c.store.get(String(m.sourceId)), "source");
      const th = need(rec.threads[String(m.threadId)], "thread");
      const path = verdictPath(rec.location, th.id, th.worktree);
      await c.pairs.sendTo(rec.id, th.id, "reviewer", reviewerBrief(th.id, path, th.lastSnap ?? th.base ?? "HEAD"));
      c.send({ type: "pair_review", sourceId: rec.id, threadId: th.id, path });
      return true;
    }
    case "merge_enqueue": {
      // Queue a finished code thread to merge into the project (review must be clean unless force).
      const rec = need(c.store.get(String(m.sourceId)), "source");
      const th = need(rec.threads[String(m.threadId)], "thread");
      if (!th.worktree || !th.branch) throw new Error(`${th.id} has no worktree to merge`);
      // The desk's own repo: build + tests always run before the merge, whatever the project files say.
      const self = isSelfSource(rec);
      if (self) linkDeps(rec.location, th.worktree);
      const check = self ? DESK_CHECK : await mergeCheck(rec.location);
      c.mergeQueue.enqueue({ sourceId: rec.id, threadId: th.id, repo: rec.location, worktree: th.worktree, branch: th.branch, force: m.force === true, check });
      c.send({ type: "merge_queue", items: visibleQueue(c) });
      return true;
    }
    case "merge_cancel": {
      c.mergeQueue.cancel(String(m.sourceId), String(m.threadId));
      c.send({ type: "merge_queue", items: visibleQueue(c) });
      return true;
    }
    case "desk_state": {
      c.send(deskState(c));
      return true;
    }
    case "desk_revert": {
      if (!c.applies) throw new Error("the Desk perspective is off");
      await c.applies.revert(Number(m.id));
      c.send(deskState(c));
      return true;
    }
    case "desk_preview": {
      if (!c.previews) throw new Error("the Desk perspective is off");
      const rec = need(c.store.get(String(m.sourceId)), "source");
      if (!isSelfSource(rec)) throw new Error("preview is for Desk threads (the desk's own repo)");
      const th = need(rec.threads[String(m.threadId)], "thread");
      if (m.stop === true) c.previews.stop(th.id);
      else {
        if (!th.worktree) throw new Error(`${th.id} has no worktree to preview`);
        void c.previews.start(th.id, th.worktree);
      }
      c.send(deskState(c));
      return true;
    }
    case "merge_list": {
      c.send({ type: "merge_queue", items: visibleQueue(c) });
      return true;
    }
    case "links": {
      // Related threads in a project: started from, mail, mentions.
      const rec = need(c.store.get(String(m.sourceId)), "source");
      c.send({ type: "links", sourceId: rec.id, links: links(rec, await c.events()) });
      return true;
    }
    case "pair_get": {
      c.send({ type: "pair", sourceId: String(m.sourceId), pair: c.pairs.get(String(m.sourceId)) ?? null });
      return true;
    }
  }
  return false;
}
