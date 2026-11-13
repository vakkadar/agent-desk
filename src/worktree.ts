// A git worktree per code thread, so parallel threads never touch the same checkout.
//   <repo>/.desk/wt/<thread>   branch desk/<thread>, started from the repo's HEAD
// .desk/ is added to .git/info/exclude (never committed). Files a thread touched, split into
// output product vs supporting by path rules, and a per-file diff against a base:
//   "start" = the commit the thread started from, "last" = a snapshot taken at your last message.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((res, rej) =>
    execFile("git", args, { cwd, maxBuffer: 32 << 20, env: env ? { ...process.env, ...env } : process.env }, (err, out, errout) =>
      err && !(args[0] === "diff" && (err as any).code === 1) ? rej(new Error(`git ${args[0]}: ${(errout || err.message).trim()}`)) : res(out)));
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try { return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).trim() === "true"; } catch { return false; }
}

export const worktreePath = (repo: string, threadId: string) => join(repo, ".desk", "wt", threadId);
export const branchName = (threadId: string) => `desk/${threadId}`;

export interface Worktree { worktree: string; branch: string; base: string }

/** Create (or re-find) the thread's worktree on its own branch. */
export async function ensureWorktree(repo: string, threadId: string): Promise<Worktree> {
  if (!/^[a-z]+-\d+$/.test(threadId)) throw new Error(`bad thread id ${threadId}`);
  const top = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
  const wt = worktreePath(top, threadId);
  const branch = branchName(threadId);
  const excl = join((await git(top, ["rev-parse", "--git-common-dir"])).trim().replace(/^(?!\/)/, top + "/"), "info", "exclude");
  const cur = await readFile(excl, "utf8").catch(() => "");
  if (!/^\/?\.desk\/?$/m.test(cur)) {
    await mkdir(join(excl, ".."), { recursive: true });
    await appendFile(excl, (cur && !cur.endsWith("\n") ? "\n" : "") + ".desk/\n");
  }
  if (existsSync(join(wt, ".git"))) {
    const base = (await git(wt, ["merge-base", "HEAD", (await git(top, ["rev-parse", "HEAD"])).trim()])).trim();
    return { worktree: wt, branch, base };
  }
  const base = (await git(top, ["rev-parse", "HEAD"])).trim();
  const hasBranch = await git(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  await mkdir(join(top, ".desk", "wt"), { recursive: true });
  await git(top, hasBranch ? ["worktree", "add", wt, branch] : ["worktree", "add", "-b", branch, wt, base]);
  return { worktree: wt, branch, base };
}

export async function removeWorktree(repo: string, threadId: string): Promise<void> {
  const wt = worktreePath(repo, threadId);
  if (!existsSync(wt)) return;
  await git(repo, ["worktree", "remove", "--force", wt]);
}

/** Commit-like snapshot of the worktree as it is now (tracked + untracked), without touching it. */
export async function snapshot(wt: string): Promise<string> {
  const idx = join(tmpdir(), `desk-idx-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    await git(wt, ["read-tree", "HEAD"], env);
    await git(wt, ["add", "-A"], env);
    const tree = (await git(wt, ["write-tree"], env)).trim();
    return (await git(wt, ["-c", "user.name=agent-desk", "-c", "user.email=agent-desk@localhost", "commit-tree", tree, "-p", "HEAD", "-m", "desk snapshot"])).trim();
  } finally {
    await rm(idx, { force: true });
  }
}

// ---- files a thread touched ----

export type FileKind = "output" | "supporting";
export interface ChangedFile { path: string; kind: FileKind; status: "added" | "modified" | "deleted"; added: number; removed: number }

/** Supporting = tests, docs, config, lock files, CI, desk files. Everything else is the output product. */
export const SUPPORTING: RegExp[] = [
  /(^|\/)(test|tests|__tests__|spec|docs?|\.github|\.desk)\//,
  /\.(test|spec)\.[a-z]+$/,
  /\.(md|txt|lock|toml|ya?ml|ini|cfg)$/,
  /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|[^/]*\.config\.[a-z]+|\.gitignore|\.editorconfig|Makefile|Dockerfile)$/,
];

export function classify(path: string, rules: RegExp[] = SUPPORTING): FileKind {
  return rules.some((r) => r.test(path)) ? "supporting" : "output";
}

/** Files changed in the worktree since `base` (commits, uncommitted edits and new files). */
export async function changedFiles(wt: string, base: string): Promise<ChangedFile[]> {
  const now = await snapshot(wt); // covers untracked files too, same as tracked ones
  const out = new Map<string, ChangedFile>();
  for (const l of (await git(wt, ["diff", "--numstat", "--no-renames", base, now])).split("\n").filter(Boolean)) {
    const [a, r, ...p] = l.split("\t");
    const path = p.join("\t");
    out.set(path, { path, kind: classify(path), status: "modified", added: Number(a) || 0, removed: Number(r) || 0 });
  }
  for (const l of (await git(wt, ["diff", "--name-status", "--no-renames", base, now])).split("\n").filter(Boolean)) {
    const [st, ...p] = l.split("\t");
    const f = out.get(p.join("\t"));
    if (f) f.status = st === "A" ? "added" : st === "D" ? "deleted" : "modified";
  }
  return [...out.values()].sort((x, y) => (x.kind === y.kind ? x.path.localeCompare(y.path) : x.kind === "output" ? -1 : 1));
}

/** Unified diff of one file vs `base`, as the worktree is now; a new file shows as all additions. */
export async function fileDiff(wt: string, base: string, path: string): Promise<string> {
  if (path.includes("..") || path.startsWith("/")) throw new Error("bad path");
  return git(wt, ["diff", "--no-renames", base, await snapshot(wt), "--", path]);
}
