import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pairs, commands, sessionName, type Herdr } from "../src/pair.js";

/** In-memory herdr: workspaces, tabs, panes; records `pane run` commands. */
function fakeHerdr() {
  let ws: { id: string; label: string } | null = null;
  const tabs: { id: string; label: string }[] = [];
  const panes = new Set<string>();
  const runs: [string, string][] = [];
  let n = 0;
  const pane = () => { const id = `w1:p${++n}`; panes.add(id); return id; };
  const h: Herdr = async (_s, a) => {
    const k = a.slice(0, 2).join(" ");
    if (k === "workspace list") return { workspaces: ws ? [{ workspace_id: ws.id, label: ws.label }] : [] };
    if (k === "workspace create") {
      ws = { id: "w1", label: a[a.indexOf("--label") + 1] };
      tabs.push({ id: "w1:t1", label: "1" });
      return { workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t1" }, root_pane: { pane_id: pane() } };
    }
    if (k === "tab rename") { tabs.find((t) => t.id === a[2])!.label = a[3]; return null; }
    if (k === "tab list") return { tabs: tabs.map((t) => ({ tab_id: t.id, label: t.label })) };
    if (k === "tab create") {
      const t = { id: `w1:t${tabs.length + 1}`, label: a[a.indexOf("--label") + 1] };
      tabs.push(t);
      return { tab: { tab_id: t.id }, root_pane: { pane_id: pane() } };
    }
    if (k === "tab close") return null;
    if (k === "pane list") return { panes: [...panes].map((p) => ({ pane_id: p })) };
    if (k === "pane split") return { pane: { pane_id: pane() } };
    if (k === "pane run") { runs.push([a[2], a[3]]); return null; }
    if (k === "pane send-text" || k === "pane send-keys") { runs.push([a[2], `${a[1]}:${a[3]}`]); return null; }
    throw new Error("unexpected " + a.join(" "));
  };
  return { h, runs, panes, tabs };
}

const dir = () => mkdtempSync(join(tmpdir(), "pair-"));
const noServer = async () => {};

test("session name per project, herdr-safe", () => {
  assert.equal(sessionName("agent-desk"), "desk-agent-desk");
  assert.match(sessionName("a b/c"), /^[A-Za-z0-9._-]+$/);
});

const cc = () => ({ builder: "claude" as const, reviewer: "claude" as const, paths: {} });
const cx = () => ({ builder: "claude" as const, reviewer: "codex" as const, paths: {} });

test("commands: Claude gets its model, Codex and opencode run plain (full path when known)", () => {
  const m = { builder: "sonnet", reviewer: "opus" };
  assert.equal(commands("claude", "codex", m).reviewer, "codex");
  assert.deepEqual(commands("claude", "claude", m), { builder: "claude --model sonnet", reviewer: "claude --model opus" });
  assert.deepEqual(commands("opencode", "claude", m, { opencode: "/h/.opencode/bin/opencode" }), { builder: "/h/.opencode/bin/opencode", reviewer: "claude --model opus" });
});

test("open: the pair runs the agents picked in Settings; the record keeps them", async () => {
  const f = fakeHerdr();
  const p = new Pairs(dir(), f.h, noServer, () => ({ builder: "claude", reviewer: "opencode", paths: { opencode: "/o/opencode" } }));
  const r = await p.open("s", "/x");
  assert.deepEqual([r.builderAgent, r.reviewerAgent], ["claude", "opencode"]);
  assert.deepEqual(f.runs, [["w1:p1", "claude --model sonnet"], ["w1:p2", "/o/opencode"]]);
});

test("open: lead tab split builder | reviewer, both agents started; reopen reuses panes", async () => {
  const f = fakeHerdr();
  const p = new Pairs(dir(), f.h, noServer, cc);
  const r = await p.open("agent-desk", "/x");
  assert.deepEqual(r.tabs.lead, { tab: "w1:t1", builder: "w1:p1", reviewer: "w1:p2", builderAgent: "claude", reviewerAgent: "claude" });
  assert.equal(r.reviewerAgent, "claude");
  assert.deepEqual(f.runs, [["w1:p1", "claude --model sonnet"], ["w1:p2", "claude --model opus"]]);
  assert.equal(f.tabs[0].label, "lead");
  await p.open("agent-desk", "/x");
  assert.equal(f.runs.length, 2, "no second launch into live panes");
});

test("thread tab: its own builder | reviewer; closeTab forgets it", async () => {
  const f = fakeHerdr();
  const p = new Pairs(dir(), f.h, noServer, cx);
  await p.open("agent-desk", "/x");
  const r = await p.open("agent-desk", "/x/wt", "code-1");
  assert.equal(r.tabs["code-1"].tab, "w1:t2");
  assert.deepEqual(f.runs.slice(2), [["w1:p3", "claude --model sonnet"], ["w1:p4", "codex"]]);
  await p.closeTab("agent-desk", "code-1");
  assert.equal(p.get("agent-desk")!.tabs["code-1"], undefined);
});

test("reviewer pane died: re-split, builder not relaunched", async () => {
  const f = fakeHerdr();
  const p = new Pairs(dir(), f.h, noServer, cc);
  await p.open("s", "/x");
  await p.open("s", "/x", "code-1");
  f.panes.delete("w1:p4");
  const r = await p.open("s", "/x", "code-1");
  assert.equal(r.tabs["code-1"].builder, "w1:p3");
  assert.equal(r.tabs["code-1"].reviewer, "w1:p5");
  assert.deepEqual(f.runs.at(-1), ["w1:p5", "claude --model opus"]);
  assert.equal(f.runs.filter(([p]) => p === "w1:p3").length, 1);
});

test("sendTo types into the chosen pane, then Enter; unknown tab refused", async () => {
  const f = fakeHerdr();
  const p = new Pairs(dir(), f.h, noServer, cc);
  await p.open("s", "/x", "code-1");
  await p.sendTo("s", "code-1", "reviewer", "review please");
  assert.deepEqual(f.runs.slice(-2), [[p.get("s")!.tabs["code-1"].reviewer, "send-text:review please"], [p.get("s")!.tabs["code-1"].reviewer, "send-keys:enter"]]);
  await assert.rejects(p.sendTo("s", "code-9", "builder", "x"), /no code-9 pair/);
});
