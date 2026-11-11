// The desk's own code as a source ("Desk dev"), for the admin profile only.
//
//   self_dev = true                     # desk.toml: add the Desk dev source
//   self_dev_session = "agent-desk-dev" # herdr session its interactive Claude runs in
//
// Any local source inside the desk's repo counts, however it was attached, so a
// developer can't reach the desk's code by attaching the folder by hand.
// Every change a turn leaves behind is committed when the turn ends; pushing stays manual.
import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceRec } from "./threads.js";

export const DESK_DEV_ID = "desk-dev";

/** The repo the running desk was built from (dist/ or src/ → its parent). */
export const DESK_REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function insideRepo(location: string, repo = DESK_REPO): boolean {
  const p = resolve(location);
  return p === repo || p.startsWith(repo + sep);
}

export const isSelfSource = (rec: Pick<SourceRec, "kind" | "location"> | undefined, repo = DESK_REPO): boolean =>
  !!rec && rec.kind === "local" && insideRepo(rec.location, repo);

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) =>
    execFile("git", args, { cwd, maxBuffer: 16 << 20 }, (e, out, err) => (e ? rej(new Error(String(err || e.message).trim())) : res(String(out)))));
}

/** Commit whatever the turn changed in the repo. Returns the short hash, or null when nothing changed. */
export async function commitTurn(cwd: string, prompt: string, threadId: string): Promise<string | null> {
  if (!(await git(cwd, ["status", "--porcelain"])).trim()) return null;
  const subject = prompt.replace(/^\S+\[[^\]]*\]:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 72) || "change";
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", `Desk dev: ${subject}`, "-m", `Made from the desk (thread ${threadId}).`]);
  return (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
}
