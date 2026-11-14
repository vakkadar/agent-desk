// WebSocket actions behind the desk2 UI: the project pair in herdr (builder | reviewer per thread),
// and later the per-thread worktree, files and diff, review line, merge queue and related threads.
// server.ts calls desk2Action() before its own switch; it returns false for types it doesn't own.
import type { SourceRec, ThreadStore } from "./threads.js";
import type { Pairs } from "./pair.js";
import { changedFiles, fileDiff } from "./worktree.js";
import { readReview, reviewerBrief, verdictPath } from "./review.js";
import { askSkeptic, skepticBrief, skepticPath } from "./skeptic.js";
import type { MergeQueue } from "./merge-queue.js";
import type { DeskEvent } from "./types.js";
import { links } from "./links.js";
import { isSelfSource } from "./self-dev.js";
import { DESK_CHECK, linkDeps, type DeskApplies } from "./desk-apply.js";
import type { DeskPreviews } from "./desk-preview.js";
import { excludeDesk } from "./relay.js";
import type { AskCards, CardAnswer } from "./ask-card.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pairModels, type ModelMap } from "./models.js";
import { deliverable, ensureResearchDir, openPr, readResearch, research } from "./branches.js";

export interface Desk2Ctx {
  store: ThreadStore;
  pairs: Pairs;
  send: (m: unknown) => void;
  mergeQueue: MergeQueue;
  seesSelf: boolean; // may see the desk's own repo (Desk dev)
  events: () => Promise<DeskEvent[]>; // the event journal (prompts carry mentions and mail)
  applies?: DeskApplies; // Desk perspective (admin only; server gates desk_* types on "self")
  previews?: DeskPreviews;
  cards?: AskCards; // questions agents in pair panes are waiting on
  models?: ModelMap; // [model] in desk.toml: builder/reviewer models per activity
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
      const dir = tab === "lead" ? rec.location : threadDir(rec, tab);
      const pair = await c.pairs.open(rec.id, dir, tab, pairModels(c.models ?? {}, rec.id, tab, rec.threads[tab]?.mode));
      await excludeDesk(rec.location); // verdict and relay files stay out of git status
      c.send({ type: "pair", sourceId: rec.id, pair, attach: c.pairs.attachCommand(rec.id) });
      // First Claude run in this folder: it waits on "trust this folder?" until the user says yes.
      const roles = await c.pairs.trustPending(rec.id, tab);
      if (roles.length) c.send({ type: "pair_trust", sourceId: rec.id, threadId: tab, dir, roles });
      return true;
    }
    case "pair_trust": {
      // The user tapped "Trust folder": answer Claude's first-run question in the pair's panes.
      const rec = need(c.store.get(String(m.sourceId)), "source");
      const tab = m.threadId && m.threadId !== "ask" ? String(m.threadId) : "lead";
      const roles = await c.pairs.acceptTrust(rec.id, tab);
      c.send({ type: "pair_trusted", sourceId: rec.id, threadId: tab, roles });
      return true;
    }
    case "pair_ask_answer": {
      // The user answered a question card: pick an option, type an answer, or move to the next question.
      if (!c.cards) throw new Error("question cards are off");
      const rec = need(c.store.get(String(m.sourceId)), "source");
      const role = m.role === "reviewer" ? "reviewer" : "builder";
      const a: CardAnswer = m.next === true ? { next: true } : typeof m.text === "string" ? { text: m.text } : { pick: Number(m.pick) };
      await c.cards.answer(rec.id, String(m.threadId), role, String(m.question), a);
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
      // Ask for a (re)review. By default the builder first does a skeptic pass on its own diff; the relay
      // briefs the reviewer when that is done (src/skeptic.ts). skeptic:false goes straight to the reviewer.
      const rec = need(c.store.get(String(m.sourceId)), "source");
      const th = need(rec.threads[String(m.threadId)], "thread");
      const path = verdictPath(rec.location, th.id, th.worktree);
      const base = th.lastSnap ?? th.base ?? "HEAD";
      const skeptic = m.skeptic !== false;
      if (skeptic) {
        const sp = skepticPath(path);
        await askSkeptic(sp);
        await c.pairs.sendTo(rec.id, th.id, "builder", skepticBrief(th.id, sp, base));
      } else {
        await c.pairs.sendTo(rec.id, th.id, "reviewer", reviewerBrief(th.id, path, base));
      }
      c.send({ type: "pair_review", sourceId: rec.id, threadId: th.id, path, skeptic });
      return true;
    }
    case "branch": {
      // Deliverable (branch, commits, PR) and Research notes of a code thread.
      const rec = need(c.store.get(String(m.sourceId)), "source");
      const th = need(rec.threads[String(m.threadId)], "thread");
      if (rec.kind !== "local") throw new Error("branches are for local projects");
      const [d, notes, dir] = await Promise.all([
        th.branch ? deliverable(rec.location, th).catch((e) => ({ error: String(e.message) })) : null,
        research(rec.location, th.id),
        ensureResearchDir(rec.location, th.id),
      ]);
      c.send({ type: "branch", sourceId: rec.id, threadId: th.id, deliverable: d, research: notes, researchDir: dir });
      return true;
    }
    case "research_read": {
      const rec = need(c.store.get(String(m.sourceId)), "source");
      const th = need(rec.threads[String(m.threadId)], "thread");
      c.send({ type: "research_note", sourceId: rec.id, threadId: th.id, name: String(m.name), text: await readResearch(rec.location, th.id, String(m.name)) });
      return true;
    }
    case "pr_open": {
      // Push the thread's branch and open a PR on the project's remote. Only on the user's click.
      const rec = need(c.store.get(String(m.sourceId)), "source");
      const th = need(rec.threads[String(m.threadId)], "thread");
      const pr = await openPr(rec.location, th, m.draft === true);
      c.send({ type: "pr_opened", sourceId: rec.id, threadId: th.id, pr });
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
