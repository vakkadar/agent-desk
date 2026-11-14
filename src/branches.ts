// Issue branches: what a code thread delivers and what it found out.
//   Deliverable: the thread's branch (desk/<thread>), its commits since the thread started, uncommitted
//                edits, and the pull request on the project's remote when there is one (gh).
//   Research:    notes the agents write while working, <project>/.desk/research/<thread>/*.md.
//                .desk/ is never committed, and the notes outlive the worktree.
// "Open PR" pushes the branch and runs `gh pr create --fill`; it only runs when the user asks for it.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./worktree.js";

export interface Commit { sha: string; subject: string; at: string }
export interface PullRequest { number: number; url: string; state: string; title: string; draft: boolean }
export interface Deliverable {
  branch: string;
  base: string; // short sha the thread started from
  commits: Commit[]; // newest first, at most MAX_COMMITS
  ahead: number;
  dirty: number; // uncommitted paths in the worktree
  remote: string | null; // "origin" when the project has one
  pr: PullRequest | null;
  prError?: string; // gh missing or not signed in: shown, never fatal
}
export interface ResearchNote { name: string; title: string; size: number; at: string }

const MAX_COMMITS = 20;
const MAX_NOTE = 256 << 10;

export const researchDir = (repo: string, threadId: string) => join(repo, ".desk", "research", threadId);

const NAME = /^[A-Za-z0-9._-]{1,80}\.md$/;

/** gh in `cwd`; resolves stdout, rejects with a one-line reason. */
function gh(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((res, rej) =>
    execFile("gh", args, { cwd, timeout, maxBuffer: 4 << 20, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (err, out, errout) =>
      err ? rej(new Error((errout || err.message).trim().split("\n")[0].slice(0, 200))) : res(out)));
}

/** Parse `git log --format=%h%x09%cI%x09%s`. */
export function parseLog(out: string): Commit[] {
  return out.split("\n").filter(Boolean).map((l) => {
    const [sha, at, ...s] = l.split("\t");
    return { sha, at, subject: s.join("\t") };
  });
}

/** Parse `gh pr view --json number,url,state,title,isDraft`; null when it is not a PR. */
export function parsePr(out: string): PullRequest | null {
  try {
    const j = JSON.parse(out);
    if (typeof j?.number !== "number" || typeof j.url !== "string") return null;
    return { number: j.number, url: j.url, state: String(j.state ?? "").toLowerCase(), title: String(j.title ?? ""), draft: j.isDraft === true };
  } catch { return null; }
}

async function remoteOf(repo: string): Promise<string | null> {
  const rs = (await git(repo, ["remote"]).catch(() => "")).split("\n").map((s) => s.trim()).filter(Boolean);
  return rs.includes("origin") ? "origin" : rs[0] ?? null;
}

const NO_PR = /no pull requests found|could not find/i;

export async function deliverable(repo: string, th: { worktree?: string; branch?: string; base?: string }): Promise<Deliverable> {
  if (!th.worktree || !th.branch || !th.base) throw new Error("this thread has no branch");
  const range = `${th.base}..${th.branch}`;
  const [log, ahead, status, remote] = await Promise.all([
    git(repo, ["log", `--max-count=${MAX_COMMITS}`, "--format=%h%x09%cI%x09%s", range]).catch(() => ""),
    git(repo, ["rev-list", "--count", range]).then((s) => Number(s.trim()) || 0, () => 0),
    git(th.worktree, ["status", "--porcelain"]).catch(() => ""),
    remoteOf(repo),
  ]);
  const d: Deliverable = {
    branch: th.branch, base: th.base.slice(0, 12), commits: parseLog(log), ahead,
    dirty: status.split("\n").filter(Boolean).length, remote, pr: null,
  };
  if (remote) {
    try { d.pr = parsePr(await gh(th.worktree, ["pr", "view", th.branch, "--json", "number,url,state,title,isDraft"])); }
    catch (e: any) { if (!NO_PR.test(e.message)) d.prError = e.message; }
  }
  return d;
}

/** Push the branch and open a PR from its commits (title/body from them). Returns the new PR. */
export async function openPr(repo: string, th: { worktree?: string; branch?: string; base?: string }, draft = false): Promise<PullRequest> {
  const d = await deliverable(repo, th);
  if (!d.remote) throw new Error("the project has no git remote");
  if (d.pr && d.pr.state === "open") return d.pr;
  if (!d.ahead) throw new Error(`${d.branch} has no commits yet${d.dirty ? " (commit the edits first)" : ""}`);
  await git(th.worktree!, ["push", "-u", d.remote, `${d.branch}:${d.branch}`]);
  await gh(th.worktree!, ["pr", "create", "--fill", "--head", d.branch, ...(draft ? ["--draft"] : [])], 60_000);
  const pr = parsePr(await gh(th.worktree!, ["pr", "view", d.branch, "--json", "number,url,state,title,isDraft"]));
  if (!pr) throw new Error("the PR was created but could not be read back");
  return pr;
}

/** First markdown heading, else the file name. */
export const noteTitle = (text: string, name: string) => text.match(/^#{1,3}\s+(.+)$/m)?.[1].trim().slice(0, 120) || name.replace(/\.md$/, "");

export async function research(repo: string, threadId: string): Promise<ResearchNote[]> {
  const dir = researchDir(repo, threadId);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => NAME.test(n));
  const out = await Promise.all(names.map(async (name) => {
    const p = join(dir, name);
    const [s, text] = await Promise.all([stat(p), readFile(p, "utf8").then((t) => t.slice(0, 4096), () => "")]);
    return { name, title: noteTitle(text, name), size: s.size, at: s.mtime.toISOString() };
  }));
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export async function readResearch(repo: string, threadId: string, name: string): Promise<string> {
  if (!NAME.test(name)) throw new Error("bad note name");
  const text = await readFile(join(researchDir(repo, threadId), name), "utf8");
  return text.length > MAX_NOTE ? text.slice(0, MAX_NOTE) + "\n\n… (cut)" : text;
}

/** Make sure the folder exists so agents can write into it; returns its path. */
export async function ensureResearchDir(repo: string, threadId: string): Promise<string> {
  const d = researchDir(repo, threadId);
  await mkdir(d, { recursive: true });
  return d;
}

