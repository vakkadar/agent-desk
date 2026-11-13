import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVerdict, readReview, reviewLine, reviewerBrief, verdictPath } from "../src/review.js";

const v = (findings: any[]) => ({ round: 2, reviewer: "codex", findings });

test("no verdict file: not started", async () => {
  const r = await readReview(mkdtempSync(join(tmpdir(), "rv-")), "code-1");
  assert.equal(r.state, "none");
  assert.equal(r.text, "Review: not started");
});

test("fixed counts only after the reviewer re-checks (claimed is not fixed)", () => {
  const r = reviewLine(parseVerdict(JSON.stringify(v([
    { id: "F1", severity: "high", text: "x", status: "verified" },
    { id: "F2", text: "y", status: "claimed" },
    { id: "F3", text: "z", status: "open" },
  ]))));
  assert.equal(r.state, "open");
  assert.equal(r.fixed, 1);
  assert.equal(r.claimed, 1);
  assert.equal(r.text, "Review r2 (codex): 3 found · 1 fixed · 1 to re-check · 1 open");
  assert.deepEqual(r.needsYou, []);
});

test("only disputed findings come to you; wontfix drops out; all verified = clean", () => {
  const d = reviewLine(parseVerdict(JSON.stringify(v([
    { id: "F1", text: "x", status: "disputed", note: "builder says by design" },
    { id: "F2", text: "y", status: "wontfix" },
  ]))));
  assert.equal(d.state, "disputed");
  assert.equal(d.needsYou.map((f) => f.id).join(), "F1");
  assert.match(d.text, /1 disputed → you/);
  const c = reviewLine(parseVerdict(JSON.stringify(v([{ text: "x", status: "verified" }]))));
  assert.equal(c.state, "clean");
  assert.equal(c.text, "Review r2 (codex): 1 found, all fixed and re-checked");
});

test("untrusted file: bad JSON is null, bad fields coerced", () => {
  assert.equal(parseVerdict("{nope"), null);
  assert.equal(parseVerdict('{"findings": 3}'), null);
  const p = parseVerdict('{"round": -1, "findings": [{"severity": "huge", "status": "done", "line": "7", "text": 5}, null]}')!;
  assert.deepEqual(p.findings, [{ id: "F1", severity: "medium", file: undefined, line: undefined, text: "", status: "open", note: undefined }]);
  assert.equal(p.round, 1);
});

test("verdict lives in the thread's worktree, else under the project's .desk/<thread>", async () => {
  const d = mkdtempSync(join(tmpdir(), "rv-"));
  assert.equal(verdictPath("/p", "code-1", "/p/.desk/wt/code-1"), "/p/.desk/wt/code-1/.desk/review.json");
  mkdirSync(join(d, ".desk", "code-3"), { recursive: true });
  writeFileSync(join(d, ".desk", "code-3", "review.json"), JSON.stringify(v([])));
  assert.equal((await readReview(d, "code-3")).text, "Review r2 (codex): no findings");
  assert.match(reviewerBrief("code-3", "/x/review.json", "abcdef0123456789"), /git diff abcdef012345/);
});
