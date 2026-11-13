// Merge queue: finished code threads land in the project one at a time.
// Per item, in order:
//   1. gate   - the thread's review line must be clean (every finding verified); `force` skips it
//   2. commit - anything left uncommitted in the thread's worktree is committed on its branch
//   3. check  - optional command run in the worktree (e.g. npm test); non-zero blocks the merge
//   4. merge  - git merge --no-ff desk/<thread> into the project checkout's current branch;
//               the checkout must be clean; a conflict is aborted and reported, nothing half-merged
// Nothing is pushed. State in <data>/.index/merge-queue.json.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./worktree.js";
import type { ReviewLine } from "./review.js";

export type MergeState = "queued" | "merging" | "merged" | "blocked" | "conflict" | "failed";

export interface MergeItem {
  sourceId: string;
  threadId: string;
  repo: string;
  worktree: string;
  branch: string;
  force?: boolean;
  check?: string[];
  state: MergeState;
  reason?: string;
  commit?: string; // merge commit on success
  queuedAt: string;
  doneAt?: string;
}

export interface MergeDeps {
  review: (it: MergeItem) => Promise<ReviewLine>;
  run?: (cmd: string[], cwd: string) => Promise<{ code: number; out: string }>;
  onChange?: (items: MergeItem[]) => void;
}

const GIT_ID = ["-c", "user.name=agent-desk", "-c", "user.email=agent-desk@localhost"];

function runCmd(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((res) =>
    execFile(cmd[0], cmd.slice(1), { cwd, timeout: 15 * 60_000, maxBuffer: 16 << 20 }, (err, out, errout) =>
      res({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, out: (out + errout).slice(-4000) })));
}

export class MergeQueue {
  readonly file: string;
  private items: MergeItem[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, private deps: MergeDeps, private now = () => new Date().toISOString()) {
    this.file = join(dataDir, ".index", "merge-queue.json");
    try { this.items = JSON.parse(readFileSync(this.file, "utf8")); } catch { this.items = []; }
    // A desk that stopped mid-merge: those go back to the queue.
    for (const it of this.items) if (it.state === "merging") it.state = "queued";
    if (this.next()) this.kick();
  }

  list(sourceId?: string): MergeItem[] {
    return this.items.filter((i) => !sourceId || i.sourceId === sourceId).map((i) => ({ ...i }));
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(this.items, null, 2) + "\n");
    renameSync(this.file + ".tmp", this.file);
    this.deps.onChange?.(this.list());
  }

  /** Add a thread (or re-queue a blocked/failed one). Returns once queued; merging runs in order. */
  enqueue(o: Omit<MergeItem, "state" | "queuedAt">): MergeItem {
    const cur = this.items.find((i) => i.sourceId === o.sourceId && i.threadId === o.threadId && i.state !== "merged");
    if (cur && (cur.state === "queued" || cur.state === "merging")) throw new Error(`${o.threadId} is already in the merge queue`);
    const it: MergeItem = { ...o, state: "queued", queuedAt: this.now() };
    if (cur) this.items.splice(this.items.indexOf(cur), 1);
    this.items.push(it);
    this.save();
    this.kick();
    return { ...it };
  }

  /** Take a queued item out (not one that is merging). */
  cancel(sourceId: string, threadId: string): void {
    const it = this.items.find((i) => i.sourceId === sourceId && i.threadId === threadId && i.state === "queued");
    if (!it) throw new Error(`${threadId} is not waiting in the merge queue`);
    this.items.splice(this.items.indexOf(it), 1);
    this.save();
  }

  /** Resolves when everything queued so far has been processed (tests, shutdown). */
  idle(): Promise<void> { return this.chain; }

  private kick(): void {
    this.chain = this.chain.then(async () => {
      for (let it = this.next(); it; it = this.next()) await this.process(it);
    });
  }

  private next(): MergeItem | undefined { return this.items.find((i) => i.state === "queued"); }

  private finish(it: MergeItem, state: MergeState, reason?: string, commit?: string): void {
    it.state = state;
    it.reason = reason;
    it.commit = commit;
    it.doneAt = this.now();
    this.save();
  }

  private async process(it: MergeItem): Promise<void> {
    it.state = "merging";
    this.save();
    try {
      if (!it.force) {
        const r = await this.deps.review(it);
        if (r.state !== "clean") return this.finish(it, "blocked", r.state === "none" ? "not reviewed yet" : r.text);
      }
      if ((await git(it.worktree, ["status", "--porcelain"])).trim()) {
        await git(it.worktree, ["add", "-A"]);
        await git(it.worktree, [...GIT_ID, "commit", "-qm", `${it.threadId}: work from the desk thread`]);
      }
      if (it.check?.length) {
        const r = await (this.deps.run ?? runCmd)(it.check, it.worktree);
        if (r.code !== 0) return this.finish(it, "blocked", `check failed (${it.check.join(" ")}): ${r.out.trim().split("\n").slice(-5).join(" | ")}`);
      }
      const dirty = (await git(it.repo, ["status", "--porcelain", "--untracked-files=no"])).trim();
      if (dirty) return this.finish(it, "blocked", "project checkout has uncommitted changes");
      const ahead = Number((await git(it.repo, ["rev-list", "--count", `HEAD..${it.branch}`])).trim());
      if (!ahead) return this.finish(it, "merged", "nothing to merge");
      try {
        await git(it.repo, [...GIT_ID, "merge", "--no-ff", "--no-edit", "-m", `Merge ${it.threadId} (${it.branch}) from the desk`, it.branch]);
      } catch (e: any) {
        const files = (await git(it.repo, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).trim().split("\n").filter(Boolean);
        await git(it.repo, ["merge", "--abort"]).catch(() => {});
        return this.finish(it, "conflict", files.length ? `conflict in ${files.join(", ")}` : String(e.message).slice(0, 300));
      }
      this.finish(it, "merged", undefined, (await git(it.repo, ["rev-parse", "--short", "HEAD"])).trim());
    } catch (e: any) {
      this.finish(it, "failed", String(e?.message ?? e).slice(0, 300));
    }
  }
}
