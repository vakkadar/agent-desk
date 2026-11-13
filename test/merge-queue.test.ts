import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MergeQueue } from "../src/merge-queue.js";
import { ensureWorktree, git } from "../src/worktree.js";
import { reviewLine } from "../src/review.js";

const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];
async function repo(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), "mq-"));
  await git(d, ["init", "-q", "-b", "main"]);
  writeFileSync(join(d, "a.txt"), "1\n2\n3\n");
  await git(d, ["add", "-A"]);
  await git(d, [...ID, "commit", "-qm", "init"]);
  return d;
}
const clean = async () => reviewLine({ round: 1, reviewer: "r", findings: [{ id: "F1", severity: "low", text: "x", status: "verified" }] });
const open = async () => reviewLine({ round: 1, reviewer: "r", findings: [{ id: "F1", severity: "low", text: "x", status: "open" }] });
const item = async (d: string, t: string) => ({ sourceId: "s", threadId: t, repo: d, ...(await ensureWorktree(d, t)) });

test("clean review: uncommitted work committed on the branch, merged --no-ff, nothing pushed", async () => {
  const d = await repo();
  const it = await item(d, "code-1");
  writeFileSync(join(it.worktree, "b.txt"), "new\n");
  const q = new MergeQueue(mkdtempSync(join(tmpdir(), "mqd-")), { review: clean });
  q.enqueue(it);
  await q.idle();
  const [r] = q.list();
  assert.equal(r.state, "merged", r.reason);
  assert.equal(readFileSync(join(d, "b.txt"), "utf8"), "new\n");
  assert.match(await git(d, ["log", "-1", "--format=%s"]), /Merge code-1 \(desk\/code-1\)/);
});

test("gate: open findings or no review block; force skips the gate; check failure blocks", async () => {
  const d = await repo();
  const dataDir = mkdtempSync(join(tmpdir(), "mqd-"));
  const it = await item(d, "code-2");
  writeFileSync(join(it.worktree, "c.txt"), "c\n");
  const q = new MergeQueue(dataDir, { review: open, run: async () => ({ code: 1, out: "1 test failed\n" }) });
  q.enqueue(it);
  await q.idle();
  assert.equal(q.list()[0].state, "blocked");
  assert.match(q.list()[0].reason!, /1 open/);
  q.enqueue({ ...it, force: true, check: ["npm", "test"] });
  await q.idle();
  assert.equal(q.list()[0].state, "blocked");
  assert.match(q.list()[0].reason!, /check failed \(npm test\): 1 test failed/);
  assert.throws(() => { q.enqueue({ ...it, force: true }); q.enqueue({ ...it, force: true }); }, /already in the merge queue/);
  await q.idle();
  assert.equal(q.list()[0].state, "merged");
});

test("conflict is aborted and reported; project checkout left clean; one at a time in order", async () => {
  const d = await repo();
  const a = await item(d, "code-3");
  const b = await item(d, "code-4");
  writeFileSync(join(a.worktree, "a.txt"), "1\nA\n3\n");
  writeFileSync(join(b.worktree, "a.txt"), "1\nB\n3\n");
  const q = new MergeQueue(mkdtempSync(join(tmpdir(), "mqd-")), { review: clean });
  q.enqueue(a);
  q.enqueue(b);
  await q.idle();
  const [ra, rb] = q.list();
  assert.equal(ra.state, "merged");
  assert.equal(rb.state, "conflict");
  assert.equal(rb.reason, "conflict in a.txt");
  assert.equal((await git(d, ["status", "--porcelain", "--untracked-files=no"])).trim(), "");
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "1\nA\n3\n");
});

test("dirty project checkout blocks; restart puts a 'merging' item back in the queue", async () => {
  const d = await repo();
  const it = await item(d, "code-5");
  writeFileSync(join(it.worktree, "e.txt"), "e\n");
  writeFileSync(join(d, "a.txt"), "dirty\n");
  const dataDir = mkdtempSync(join(tmpdir(), "mqd-"));
  const q = new MergeQueue(dataDir, { review: clean });
  q.enqueue(it);
  await q.idle();
  assert.equal(q.list()[0].reason, "project checkout has uncommitted changes");
  const f = join(dataDir, ".index", "merge-queue.json");
  writeFileSync(f, readFileSync(f, "utf8").replace('"blocked"', '"merging"'));
  assert.equal(new MergeQueue(dataDir, { review: clean }).list()[0].state, "queued");
});
