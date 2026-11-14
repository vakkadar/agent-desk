import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverable, noteTitle, parseLog, parsePr, readResearch, research, researchDir } from "../src/branches.js";
import { ensureWorktree } from "../src/worktree.js";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }).toString();

test("parseLog and parsePr", () => {
  assert.deepEqual(parseLog("abc1234\t2026-11-14T10:00:00+00:00\tfix: a\tb\n"), [{ sha: "abc1234", at: "2026-11-14T10:00:00+00:00", subject: "fix: a\tb" }]);
  assert.deepEqual(parsePr('{"number":7,"url":"https://x/pull/7","state":"OPEN","title":"T","isDraft":true}'), { number: 7, url: "https://x/pull/7", state: "open", title: "T", draft: true });
  assert.equal(parsePr("nope"), null);
  assert.equal(parsePr("{}"), null);
  assert.equal(noteTitle("intro\n## Options for X\n", "a.md"), "Options for X");
  assert.equal(noteTitle("no heading", "cache-plan.md"), "cache-plan");
});

test("deliverable counts branch commits and dirty files; no remote means no PR lookup", async () => {
  const repo = await mkdtemp(join(tmpdir(), "branches-"));
  sh(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "a.txt"), "1\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const wt = await ensureWorktree(repo, "code-1");
  await writeFile(join(wt.worktree, "b.txt"), "2\n");
  sh(wt.worktree, "add", "."); sh(wt.worktree, "commit", "-qm", "add b");
  await writeFile(join(wt.worktree, "c.txt"), "3\n");
  const d = await deliverable(repo, wt);
  assert.equal(d.branch, "desk/code-1");
  assert.equal(d.ahead, 1);
  assert.equal(d.commits[0].subject, "add b");
  assert.equal(d.dirty, 1);
  assert.equal(d.remote, null);
  assert.equal(d.pr, null);
  await assert.rejects(deliverable(repo, {}), /no branch/);
});

test("research lists notes newest first and refuses bad names", async () => {
  const repo = await mkdtemp(join(tmpdir(), "research-"));
  assert.deepEqual(await research(repo, "code-1"), []);
  const dir = researchDir(repo, "code-1");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "old.md"), "# Old note\n");
  await new Promise((r) => setTimeout(r, 15));
  await writeFile(join(dir, "new.md"), "# New note\nbody\n");
  await writeFile(join(dir, "skip.txt"), "x");
  const notes = await research(repo, "code-1");
  assert.deepEqual(notes.map((n) => [n.name, n.title]), [["new.md", "New note"], ["old.md", "Old note"]]);
  assert.match(await readResearch(repo, "code-1", "new.md"), /body/);
  await assert.rejects(readResearch(repo, "code-1", "../x.md"), /bad note name/);
});
