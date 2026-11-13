import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, classify, ensureWorktree, fileDiff, git, removeWorktree, snapshot } from "../src/worktree.js";

async function repo(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), "wt-"));
  await git(d, ["init", "-q", "-b", "main"]);
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src/app.ts"), "a\nb\n");
  writeFileSync(join(d, "README.md"), "hi\n");
  await git(d, ["add", "-A"]);
  await git(d, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return d;
}

test("classify: tests, docs, config are supporting; code is output", () => {
  assert.equal(classify("src/app.ts"), "output");
  assert.equal(classify("web/style.css"), "output");
  assert.equal(classify("test/app.test.ts"), "supporting");
  assert.equal(classify("src/app.spec.ts"), "supporting");
  assert.equal(classify("docs/x.html"), "supporting");
  assert.equal(classify("README.md"), "supporting");
  assert.equal(classify("package.json"), "supporting");
  assert.equal(classify("vite.config.ts"), "supporting");
});

test("worktree per thread: own branch, .desk excluded, idempotent, main checkout untouched", async () => {
  const d = await repo();
  const w = await ensureWorktree(d, "code-1");
  assert.equal(w.branch, "desk/code-1");
  assert.equal(w.worktree, join(d, ".desk/wt/code-1"));
  assert.match(readFileSync(join(d, ".git/info/exclude"), "utf8"), /^\.desk\/$/m);
  assert.equal((await git(d, ["status", "--porcelain"])).trim(), "", "main checkout stays clean");
  writeFileSync(join(w.worktree, "src/app.ts"), "a\nB\nc\n");
  const again = await ensureWorktree(d, "code-1");
  assert.equal(again.base, w.base);
  assert.equal(readFileSync(join(d, "src/app.ts"), "utf8"), "a\nb\n", "threads never write the main checkout");
  await assert.rejects(ensureWorktree(d, "../x"), /bad thread id/);
  await removeWorktree(d, "code-1");
});

test("changed files: modified + new, output first; diff shows additions; snapshot base for 'since my last message'", async () => {
  const d = await repo();
  const { worktree: wt, base } = await ensureWorktree(d, "code-2");
  writeFileSync(join(wt, "src/app.ts"), "a\nB\nc\n");
  mkdirSync(join(wt, "test"));
  writeFileSync(join(wt, "test/app.test.ts"), "t1\nt2\n");
  const files = await changedFiles(wt, base);
  assert.deepEqual(files.map((f) => [f.path, f.kind, f.status, f.added, f.removed]), [
    ["src/app.ts", "output", "modified", 2, 1],
    ["test/app.test.ts", "supporting", "added", 2, 0],
  ]);
  assert.match(await fileDiff(wt, base, "src/app.ts"), /^\+B$/m);
  assert.match(await fileDiff(wt, base, "test/app.test.ts"), /^\+t2$/m);
  await assert.rejects(fileDiff(wt, base, "../etc/passwd"), /bad path/);

  const snap = await snapshot(wt);
  assert.equal((await git(wt, ["status", "--porcelain"])).includes("test/"), true, "snapshot leaves the worktree as is");
  writeFileSync(join(wt, "src/app.ts"), "a\nB\nc\nd\n");
  const since = await changedFiles(wt, snap);
  assert.deepEqual(since.map((f) => [f.path, f.added, f.removed]), [["src/app.ts", 1, 0]]);
});
