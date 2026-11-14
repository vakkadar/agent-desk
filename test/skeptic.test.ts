import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay } from "../src/relay.js";
import { SKEPTIC_WAIT_MS, askSkeptic, parseSkeptic, skepticBrief, skepticNote, skepticStep } from "../src/skeptic.js";

test("parseSkeptic keeps known fields, rejects junk", () => {
  assert.equal(parseSkeptic("nope"), null);
  assert.equal(parseSkeptic('{"state":"maybe"}'), null);
  assert.deepEqual(parseSkeptic('{"state":"done","fixed":["empty list",3],"extra":1}'), { state: "done", fixed: ["empty list"] });
});

test("skepticStep: waits while pending, goes when done or timed out, never twice", () => {
  const now = Date.parse("2026-11-14T10:00:00Z");
  const asked = new Date(now - 60_000).toISOString();
  assert.deepEqual(skepticStep(null, now), { go: false });
  assert.deepEqual(skepticStep({ state: "pending", askedAt: asked }, now), { go: false });
  assert.deepEqual(skepticStep({ state: "sent" }, now), { go: false });
  const done = skepticStep({ state: "done", fixed: ["off-by-one in median"] }, now);
  assert.ok(done.go && /off-by-one in median/.test(done.note) && /Do not take that on trust/.test(done.note));
  const late = skepticStep({ state: "pending", askedAt: asked }, now + SKEPTIC_WAIT_MS);
  assert.ok(late.go && /did not finish in time/.test(late.note));
  assert.match(skepticNote({ state: "done" }), /found nothing to fix/);
});

test("skepticBrief is one line naming the base and the file", () => {
  const b = skepticBrief("code-1", "/w/.desk/skeptic.json", "abcdef0123456789");
  assert.doesNotMatch(b, /\n/);
  assert.match(b, /git diff abcdef012345\)/);
  assert.match(b, /\/w\/\.desk\/skeptic\.json/);
});

test("Relay briefs the reviewer once after the builder's skeptic pass is done", async () => {
  const root = mkdtempSync(join(tmpdir(), "skeptic-"));
  const wt = join(root, "wt");
  mkdirSync(join(wt, ".desk"), { recursive: true });
  const sp = join(wt, ".desk", "skeptic.json");
  const sent: [string, string][] = [];
  const pairs: any = { list: () => [{ sourceId: "s1", tabs: { "code-1": {} } }], sendTo: async (_s: string, _t: string, role: string, text: string) => { sent.push([role, text]); } };
  const store: any = { get: () => ({ id: "s1", location: root, threads: { "code-1": { id: "code-1", worktree: wt, base: "abc123" } } }) };
  const r = new Relay(pairs, store, () => {});

  await askSkeptic(sp);
  await r.tick();
  assert.equal(sent.length, 0); // builder still checking

  writeFileSync(sp, JSON.stringify({ state: "done", fixed: ["null guard in parse"] }));
  await r.tick();
  await r.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "reviewer");
  assert.match(sent[0][1], /adversarial reviewer for code-1/);
  assert.match(sent[0][1], /null guard in parse/);
  assert.equal(JSON.parse(readFileSync(sp, "utf8")).state, "sent");
});
