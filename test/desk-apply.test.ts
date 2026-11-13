import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeskApplies, revertCommit, type Run } from "../src/desk-apply.js";
import { git } from "../src/worktree.js";

const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];
/** A repo with a running build (dist/v = "old") and one merged change on top. */
async function repo(): Promise<{ d: string; merge: string }> {
  const d = mkdtempSync(join(tmpdir(), "apply-"));
  await git(d, ["init", "-q", "-b", "main"]);
  writeFileSync(join(d, "a.txt"), "old\n");
  writeFileSync(join(d, ".gitignore"), "dist/\ndist.prev/\n");
  await git(d, ["add", "-A"]);
  await git(d, [...ID, "commit", "-qm", "init"]);
  await git(d, ["checkout", "-qb", "desk/code-1"]);
  writeFileSync(join(d, "a.txt"), "new\n");
  await git(d, [...ID, "commit", "-qam", "change"]);
  await git(d, ["checkout", "-q", "main"]);
  await git(d, [...ID, "merge", "-q", "--no-ff", "-m", "Merge code-1", "desk/code-1"]);
  mkdirSync(join(d, "dist"));
  writeFileSync(join(d, "dist", "v"), "old\n");
  return { d, merge: (await git(d, ["rev-parse", "--short", "HEAD"])).trim() };
}
/** Fake npm: "build" copies a.txt into dist/v, or fails. */
const npm = (ok: boolean): Run => async (cmd, cwd) => {
  if (cmd.join(" ") !== "npm run build") return { code: 0, out: "" };
  if (!ok) return { code: 2, out: "src/x.ts(1,1): error TS1005\n" };
  writeFileSync(join(cwd, "dist", "v"), readFileSync(join(cwd, "a.txt")));
  return { code: 0, out: "" };
};

test("apply without a service manager: built from the merged source, old build kept as dist.prev", async () => {
  const { d, merge } = await repo();
  const a = new DeskApplies(mkdtempSync(join(tmpdir(), "ad-")), d, { run: npm(true), restart: async () => false });
  const r = await a.apply({ commit: merge, threadId: "code-1" });
  assert.equal(r.state, "built");
  assert.equal(r.subject, "Merge code-1");
  assert.equal(readFileSync(join(d, "dist", "v"), "utf8"), "new\n");
  assert.equal(readFileSync(join(d, "dist.prev", "v"), "utf8"), "old\n");
});

test("build failure: old build put back and the merge reverted", async () => {
  const { d, merge } = await repo();
  const a = new DeskApplies(mkdtempSync(join(tmpdir(), "ad-")), d, { run: npm(false), restart: async () => assert.fail("no restart on a failed build") });
  const r = await a.apply({ commit: merge, threadId: "code-1" });
  assert.equal(r.state, "rolled back");
  assert.match(r.reason!, /build failed: .*TS1005.*; reverted in [0-9a-f]+/);
  assert.equal(readFileSync(join(d, "dist", "v"), "utf8"), "old\n");
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "old\n");
  assert.equal((await git(d, ["status", "--porcelain"])).trim(), "");
});

test("restart: result file from the apply script settles the apply, also in a restarted desk; revert applies a revert commit", async () => {
  const { d, merge } = await repo();
  const data = mkdtempSync(join(tmpdir(), "ad-"));
  let started: any;
  const a = new DeskApplies(data, d, { run: npm(true), restart: async (rec, file) => { started = { rec, file }; return true; } });
  const r = await a.apply({ commit: merge, threadId: "code-1" });
  assert.equal(r.state, "restarting");
  assert.equal(started.rec.commit, merge);
  // The desk restarts: a new process reads the same files, then the script reports.
  writeFileSync(started.file, JSON.stringify({ id: r.id, state: "live", reason: "" }));
  const b = new DeskApplies(data, d, { run: npm(true), restart: async () => false });
  assert.equal(b.list()[0].state, "live");
  assert.ok(!existsSync(started.file));
  const rv = await b.revert(r.id);
  assert.equal(rv.kind, "revert");
  assert.equal(rv.reverts, r.id);
  assert.equal(readFileSync(join(d, "dist", "v"), "utf8"), "old\n");
  assert.equal(b.list().find((i) => i.id === r.id)!.revertedBy, rv.id);
  await assert.rejects(b.revert(r.id), /already reverted/);
});

test("revertCommit handles merge and plain commits", async () => {
  const { d, merge } = await repo();
  await revertCommit(d, merge);
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "old\n");
  writeFileSync(join(d, "a.txt"), "x\n");
  await git(d, [...ID, "commit", "-qam", "x"]);
  await revertCommit(d, "HEAD");
  assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "old\n");
});

// deploy/desk-apply.sh with stub systemctl and curl on PATH.
function runScript(d: string, merge: string, healthy: "new" | "never" | "old"): any {
  const bin = mkdtempSync(join(tmpdir(), "bin-"));
  const log = join(bin, "log");
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$@ $(cat ${d}/dist/v)" >> ${log}\ncp ${d}/dist/v ${bin}/running\n`);
  // healthy when the running build is the one we want
  const want = healthy === "new" ? "new" : healthy === "old" ? "old" : "nothing";
  writeFileSync(join(bin, "curl"), `#!/bin/sh\n[ "$(cat ${bin}/running 2>/dev/null)" = "${want}" ] && echo '{"ok":true}' || exit 7\n`);
  chmodSync(join(bin, "systemctl"), 0o755); chmodSync(join(bin, "curl"), 0o755);
  const result = join(bin, "result.json");
  execFileSync("sh", [join(process.cwd(), "deploy", "desk-apply.sh"), d, "agent-desk.service", "http://x/healthz", result, "7", merge],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DESK_APPLY_TRIES: "2" } });
  return { result: JSON.parse(readFileSync(result, "utf8")), log: readFileSync(log, "utf8") };
}

test("desk-apply.sh: healthy new build stays; unhealthy one is rolled back to the old build and reverted", async () => {
  {
    const { d, merge } = await repo();
    writeFileSync(join(d, "dist", "v"), "new\n");
    const { result } = runScript(d, merge, "new");
    assert.deepEqual([result.id, result.state], [7, "live"]);
  }
  {
    const { d, merge } = await repo();
    mkdirSync(join(d, "dist.prev"));
    writeFileSync(join(d, "dist.prev", "v"), "old\n");
    writeFileSync(join(d, "dist", "v"), "new\n");
    const { result, log } = runScript(d, merge, "old");
    assert.equal(result.state, "rolled back");
    assert.match(result.reason, /health check; reverted in [0-9a-f]+/);
    assert.equal(log, "--user restart agent-desk.service new\n--user restart agent-desk.service old\n");
    assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "old\n");
  }
});
