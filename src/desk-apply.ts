// Desk perspective: changing the desk from inside the desk, safely.
//
// A Desk thread is an ordinary code thread on the desk's own repo (worktree, review, merge queue).
// What it adds:
//   check   - the merge check is always `npm run build && npm test` in the worktree; no file can turn it off
//   apply   - after the merge: keep the running build (dist -> dist.prev), build the merged source,
//             then restart the desk service and wait for /healthz. If the new build fails to build or
//             to come up healthy, the old build is put back and the merge is reverted (git revert), so
//             source and running desk agree again.
//   history - every apply, with a revert (a new revert commit, applied the same way).
//
// The restart and health wait run in deploy/desk-apply.sh under `systemd-run --user`: outside the
// desk's own cgroup, so they survive the restart they cause. The script leaves its verdict in
// <data>/.index/desk-apply-result.json and the restarted desk picks it up.
// Nothing is pushed.
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, cpSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./worktree.js";
import { DESK_REPO } from "./self-dev.js";

export const DESK_CHECK = ["sh", "-c", "npm run build && npm test"];

export type ApplyState = "building" | "restarting" | "live" | "built" | "rolled back" | "failed";

export interface ApplyRec {
  id: number;
  kind: "merge" | "revert";
  threadId?: string;
  commit: string; // what was applied (merge commit, or the revert commit)
  prev: string; // the commit the desk ran before
  subject?: string;
  state: ApplyState;
  reason?: string;
  reverts?: number; // revert: the apply it undid
  revertedBy?: number;
  at: string;
  doneAt?: string;
}

export type Run = (cmd: string[], cwd: string) => Promise<{ code: number; out: string }>;

export interface ApplyDeps {
  run?: Run;
  /** Start the detached restart + health check. false: no service manager here (restart by hand). */
  restart: (rec: ApplyRec, resultFile: string) => Promise<boolean>;
  onChange?: (items: ApplyRec[]) => void;
}

const GIT_ID = ["-c", "user.name=agent-desk", "-c", "user.email=agent-desk@localhost"];

export const runCmd: Run = (cmd, cwd) =>
  new Promise((res) =>
    execFile(cmd[0], cmd.slice(1), { cwd, timeout: 15 * 60_000, maxBuffer: 16 << 20 }, (err, out, errout) =>
      res({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, out: (out + errout).slice(-4000) })));

const tail = (s: string) => s.trim().split("\n").slice(-5).join(" | ");

/**
 * A worktree of the desk repo shares the repo's node_modules (build and tests need them).
 * The link is a file to git, so a `node_modules/` ignore rule misses it: it goes into
 * info/exclude too, or the merge queue's `git add -A` would commit it.
 */
export function linkDeps(repo: string, worktree: string): void {
  const src = join(repo, "node_modules"), dst = join(worktree, "node_modules");
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree }).toString().trim();
  const excl = join(common, "info", "exclude");
  const cur = existsSync(excl) ? readFileSync(excl, "utf8") : "";
  if (!/^\/?node_modules$/m.test(cur)) { mkdirSync(dirname(excl), { recursive: true }); appendFileSync(excl, (cur && !cur.endsWith("\n") ? "\n" : "") + "/node_modules\n"); }
  if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst, "dir");
}

/** git revert that also handles merge commits (undo against the first parent). */
export async function revertCommit(repo: string, commit: string): Promise<string> {
  const parents = (await git(repo, ["rev-list", "--parents", "-n1", commit])).trim().split(/\s+/).length - 1;
  await git(repo, [...GIT_ID, "revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), commit]);
  return (await git(repo, ["rev-parse", "--short", "HEAD"])).trim();
}

export class DeskApplies {
  readonly file: string;
  readonly resultFile: string;
  private items: ApplyRec[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private poll?: NodeJS.Timeout;

  constructor(dataDir: string, readonly repo: string, private deps: ApplyDeps, private now = () => new Date().toISOString()) {
    this.file = join(dataDir, ".index", "desk-applies.json");
    this.resultFile = join(dataDir, ".index", "desk-apply-result.json");
    try { this.items = JSON.parse(readFileSync(this.file, "utf8")); } catch { this.items = []; }
    // Stopped mid-build: that build never finished; nothing was restarted.
    for (const it of this.items) if (it.state === "building") Object.assign(it, { state: "failed", reason: "the desk stopped during the build", doneAt: this.now() });
    this.pickUpResult();
  }

  list(): ApplyRec[] { return this.items.map((i) => ({ ...i })).reverse(); }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(this.items.slice(-100), null, 2) + "\n");
    renameSync(this.file + ".tmp", this.file);
    this.deps.onChange?.(this.list());
  }

  private finish(it: ApplyRec, state: ApplyState, reason?: string): void {
    Object.assign(it, { state, reason, doneAt: this.now() });
    this.save();
  }

  /** Resolves when queued applies are done (tests). */
  idle(): Promise<unknown> { return this.chain; }

  /** Apply a commit that is already on the repo's checked-out branch. Runs one at a time. */
  apply(o: { commit: string; threadId?: string; kind?: "merge" | "revert"; reverts?: number }): Promise<ApplyRec> {
    const p = this.chain.then(() => this.process(o));
    this.chain = p.catch(() => {});
    return p;
  }

  /** Undo an earlier apply with a revert commit, then apply that like any other change. */
  async revert(id: number): Promise<ApplyRec> {
    const it = this.items.find((i) => i.id === id);
    if (!it) throw new Error(`no apply #${id}`);
    if (it.revertedBy) throw new Error(`#${id} was already reverted by #${it.revertedBy}`);
    if (it.state !== "live" && it.state !== "built") throw new Error(`#${id} is ${it.state}; only a live change can be reverted`);
    if ((await git(this.repo, ["status", "--porcelain", "--untracked-files=no"])).trim()) throw new Error("the desk checkout has uncommitted changes");
    const commit = await revertCommit(this.repo, it.commit);
    const rec = await this.apply({ commit, kind: "revert", threadId: it.threadId, reverts: id });
    it.revertedBy = rec.id;
    this.save();
    return rec;
  }

  private async process(o: { commit: string; threadId?: string; kind?: "merge" | "revert"; reverts?: number }): Promise<ApplyRec> {
    const run = this.deps.run ?? runCmd;
    const g = (a: string[]) => git(this.repo, a);
    const commit = (await g(["rev-parse", "--short", o.commit])).trim();
    const it: ApplyRec = {
      id: Math.max(0, ...this.items.map((i) => i.id)) + 1, kind: o.kind ?? "merge", threadId: o.threadId, reverts: o.reverts,
      commit, prev: (await g(["rev-parse", "--short", `${commit}^1`])).trim(),
      subject: (await g(["log", "-1", "--format=%s", commit])).trim().slice(0, 120), state: "building", at: this.now(),
    };
    this.items.push(it);
    this.save();
    const dist = join(this.repo, "dist"), prev = join(this.repo, "dist.prev");
    try {
      rmSync(prev, { recursive: true, force: true });
      if (existsSync(dist)) cpSync(dist, prev, { recursive: true, verbatimSymlinks: true });
      const changed = (await g(["diff", "--name-only", it.prev, commit])).split("\n");
      if (changed.includes("package-lock.json")) {
        const r = await run(["npm", "ci"], this.repo);
        if (r.code !== 0) return await this.undo(it, `npm ci failed: ${tail(r.out)}`);
      }
      const b = await run(["npm", "run", "build"], this.repo);
      if (b.code !== 0) return await this.undo(it, `build failed: ${tail(b.out)}`);
      it.state = "restarting";
      this.save();
      if (!(await this.deps.restart({ ...it }, this.resultFile))) this.finish(it, "built", "built; restart the desk to load it (no service manager here)");
      else this.watchResult();
    } catch (e: any) {
      this.finish(it, "failed", String(e?.message ?? e).slice(0, 300));
    }
    return { ...it };
  }

  /** The new build never ran: put the old one back and revert the source. */
  private async undo(it: ApplyRec, why: string): Promise<ApplyRec> {
    const dist = join(this.repo, "dist"), prev = join(this.repo, "dist.prev");
    if (existsSync(prev)) { rmSync(dist, { recursive: true, force: true }); renameSync(prev, dist); }
    let note = "";
    await revertCommit(this.repo, it.commit).then((h) => (note = `; reverted in ${h}`), (e) => (note = `; revert failed (${String(e.message).slice(0, 120)}), source still has ${it.commit}`));
    this.finish(it, "rolled back", why + note);
    return { ...it };
  }

  /** The apply script's verdict, left for whichever desk process is running when it finishes. */
  pickUpResult(): boolean {
    let r: { id?: number; state?: string; reason?: string };
    try { r = JSON.parse(readFileSync(this.resultFile, "utf8")); } catch { return false; }
    const it = this.items.find((i) => i.id === r.id && i.state === "restarting");
    try { unlinkSync(this.resultFile); } catch {}
    if (!it) return false;
    const state = (["live", "rolled back", "failed"] as const).find((s) => s === r.state) ?? "failed";
    this.finish(it, state, r.reason || undefined);
    return true;
  }

  private watchResult(): void {
    if (this.poll) return;
    const t0 = Date.now();
    this.poll = setInterval(() => {
      this.pickUpResult();
      const waiting = this.items.filter((i) => i.state === "restarting");
      if (!waiting.length) { clearInterval(this.poll); this.poll = undefined; }
      else if (Date.now() - t0 > 5 * 60_000) {
        for (const i of waiting) this.finish(i, "failed", "no word from the apply script after 5 minutes");
      }
    }, 2000);
    this.poll.unref();
  }

  /** On startup: an apply still "restarting" means this process is the restarted desk. */
  resume(): void { if (this.items.some((i) => i.state === "restarting")) this.watchResult(); }
}

/** Default restart: a transient systemd user unit runs deploy/desk-apply.sh outside our cgroup. */
export function systemdRestart(healthUrl: string, unit = process.env.AGENT_DESK_UNIT ?? "agent-desk.service") {
  return async (rec: ApplyRec, resultFile: string): Promise<boolean> => {
    if (!process.env.INVOCATION_ID) return false; // not started by systemd
    const r = await runCmd(["systemd-run", "--user", "--collect", "--quiet", `--unit=agent-desk-apply-${rec.id}-${Date.now()}`,
      "sh", join(DESK_REPO, "deploy", "desk-apply.sh"), DESK_REPO, unit, healthUrl, resultFile, String(rec.id), rec.commit], DESK_REPO);
    if (r.code !== 0) throw new Error(`systemd-run failed: ${tail(r.out)}`);
    return true;
  };
}

