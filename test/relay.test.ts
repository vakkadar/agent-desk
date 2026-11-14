import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BOUNCES, Relay, excludeDesk, relaySteps, type RelayState } from "../src/relay.js";
import type { Verdict } from "../src/review.js";

const v = (findings: any[]): Verdict => ({ round: 1, reviewer: "opencode", findings });
const fresh = (): RelayState => ({ sent: [], bounces: {} });

test("open findings go to the builder once, claimed ones to the reviewer once", () => {
  const st = fresh();
  const a = relaySteps(v([{ id: "F1", severity: "high", file: "m.ts", line: 3, text: "median([]) is NaN", status: "open" }]), "/r.json", st);
  assert.equal(a.length, 1);
  assert.equal(a[0].to, "builder");
  assert.match(a[0].text, /F1 \[high\] \(m\.ts:3\) median\(\[\]\) is NaN/);
  assert.match(a[0].text, /\/r\.json/);
  assert.doesNotMatch(a[0].text, /\n/);
  assert.deepEqual(relaySteps(v([{ id: "F1", severity: "high", text: "median([]) is NaN", status: "open" }]), "/r.json", st), []);

  const b = relaySteps(v([{ id: "F1", severity: "high", text: "x", status: "claimed", note: "throws on empty" }]), "/r.json", st);
  assert.deepEqual(b.map((m) => [m.to, m.ids]), [["reviewer", ["F1"]]]);
  assert.match(b[0].text, /F1 \(throws on empty\)/);
});

test("verified, disputed and wontfix are not relayed; a bouncing finding stops after MAX_BOUNCES", () => {
  const st = fresh();
  assert.deepEqual(relaySteps(v([
    { id: "F1", severity: "low", text: "a", status: "verified" },
    { id: "F2", severity: "low", text: "b", status: "disputed", note: "n" },
    { id: "F3", severity: "low", text: "c", status: "wontfix" },
  ]), "/r.json", st), []);
  let sentToBuilder = 0;
  for (let i = 0; i < MAX_BOUNCES + 2; i++) {
    sentToBuilder += relaySteps(v([{ id: "F1", severity: "low", text: "a", status: "open", note: `still wrong ${i}` }]), "/r.json", st).length;
    relaySteps(v([{ id: "F1", severity: "low", text: "a", status: "claimed", note: `fix ${i}` }]), "/r.json", st);
  }
  assert.equal(sentToBuilder, MAX_BOUNCES);
});

test("Relay.tick reads each thread's verdict, types into the right pane, and does not repeat after a restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-"));
  const wt = join(root, "wt");
  mkdirSync(join(wt, ".desk"), { recursive: true });
  const path = join(wt, ".desk", "review.json");
  writeFileSync(path, JSON.stringify(v([{ id: "F1", severity: "medium", text: "bug", status: "open" }])));
  const sent: string[] = [];
  const pairs: any = { list: () => [{ sourceId: "s1", tabs: { lead: {}, "code-1": {} } }], sendTo: async (_s: string, tab: string, role: string) => { sent.push(`${tab}:${role}`); } };
  const store: any = { get: () => ({ id: "s1", location: root, threads: { "code-1": { id: "code-1", worktree: wt } } }) };
  const quiet = () => {};

  assert.equal((await new Relay(pairs, store, quiet).tick()).length, 1);
  assert.deepEqual(sent, ["code-1:builder"]);
  assert.equal((await new Relay(pairs, store, quiet).tick()).length, 0); // restarted desk: relay.json remembers
  writeFileSync(path, JSON.stringify(v([{ id: "F1", severity: "medium", text: "bug", status: "claimed", note: "fixed" }])));
  await new Relay(pairs, store, quiet).tick();
  assert.deepEqual(sent, ["code-1:builder", "code-1:reviewer"]);
});

test("Relay.tick: when the second send fails, the first is not resent on the next tick", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-"));
  const wt = join(root, "wt");
  mkdirSync(join(wt, ".desk"), { recursive: true });
  writeFileSync(join(wt, ".desk", "review.json"), JSON.stringify(v([
    { id: "F1", severity: "low", text: "a", status: "open" },
    { id: "F2", severity: "low", text: "b", status: "claimed", note: "done" },
  ])));
  const sent: string[] = [];
  let failReviewer = true;
  const pairs: any = { list: () => [{ sourceId: "s1", tabs: { "code-1": {} } }], sendTo: async (_s: string, _t: string, role: string) => {
    if (role === "reviewer" && failReviewer) throw new Error("pane at shell");
    sent.push(role);
  } };
  const store: any = { get: () => ({ id: "s1", location: root, threads: { "code-1": { id: "code-1", worktree: wt } } }) };
  const r = new Relay(pairs, store, () => {});
  await r.tick();
  assert.deepEqual(sent, ["builder"]);
  failReviewer = false;
  await r.tick();
  assert.deepEqual(sent, ["builder", "reviewer"]);
});

test("excludeDesk adds .desk/ to the repo's local exclude once", async () => {
  const repo = mkdtempSync(join(tmpdir(), "relay-git-"));
  execFileSync("git", ["init", "-q", repo]);
  await excludeDesk(repo);
  await excludeDesk(repo);
  const ex = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  assert.equal(ex.split("\n").filter((l) => l === ".desk/").length, 1);
  await excludeDesk(join(repo, "nope")); // not a repo: no throw
});
