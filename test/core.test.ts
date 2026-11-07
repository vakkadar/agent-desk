import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guard } from "../src/net/guard.js";
import { EventBus } from "../src/events/bus.js";
import { ClaudeAgent, mapClaudeMessage } from "../src/adapters/agent/claude.js";

test("guard: roles by IP/CIDR and token", () => {
  const g = new Guard({ actionAllow: ["127.0.0.1", "100.64.0.0/10"], readonlyAllow: ["192.168.1.0/24"], actionToken: "s3cret" });
  assert.equal(g.roleFor("127.0.0.1", "s3cret"), "action");
  assert.equal(g.roleFor("::ffff:100.90.34.14", "s3cret"), "action");
  assert.equal(g.roleFor("100.90.34.14", "wrong"), "readonly"); // allowed IP, bad token → downgrade
  assert.equal(g.roleFor("192.168.1.20"), "readonly");
  assert.equal(g.roleFor("8.8.8.8", "s3cret"), null);
});

test("bus: seq survives restart and replays", async () => {
  const p = join(await mkdtemp(join(tmpdir(), "desk-")), "events.jsonl");
  const a = new EventBus(p);
  await a.init();
  a.publish({ sourceId: "s", threadId: "ask", event: { kind: "prompt", text: "hi" } });
  a.publish({ sourceId: "s", threadId: "ask", event: { kind: "text", text: "yo" } });
  await a.flush();
  const b = new EventBus(p);
  await b.init();
  assert.deepEqual(b.since(1).map((e) => e.seq), [2]);
  assert.equal(b.publish({ sourceId: "s", threadId: "ask", event: { kind: "text", text: "x" } }).seq, 3);
});

test("claude: argv for new, resumed, forked", async () => {
  const c = new ClaudeAgent();
  const ref = await c.start({ cwd: "/tmp", name: "x" });
  assert.ok(c.argsFor(ref, "q").includes("--session-id"));
  await c.resume(ref);
  assert.deepEqual(c.argsFor(ref, "q").slice(-2), ["--resume", ref.sessionId]);
  const f = await c.fork(ref);
  assert.deepEqual(c.argsFor(f, "q").slice(-3), ["--resume", ref.sessionId, "--fork-session"]);
});

test("claude: maps stream-json", () => {
  assert.deepEqual(mapClaudeMessage({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }), [{ kind: "text", text: "hi" }]);
  const r = mapClaudeMessage({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 7 } });
  assert.deepEqual(r.at(-1), { kind: "done", outcome: "ok" });
});

test("ClaudeAgent: aborting the signal kills the turn and reports cancelled", async () => {
  const { directSpawn } = await import("../src/adapters/mux/spawn.js");
  const c = new ClaudeAgent({ spawnFn: (_b, _a, o) => directSpawn("sleep", ["30"], o) });
  const ac = new AbortController();
  const t0 = Date.now();
  const kinds: string[] = [];
  let outcome = "";
  for await (const ev of c.send({ agent: "claude", sessionId: "x", cwd: tmpdir() }, "hi", { sourceId: "s", threadId: "t", signal: ac.signal })) {
    kinds.push(ev.kind);
    if (ev.kind === "state" && ev.state === "working") ac.abort();
    if (ev.kind === "done") outcome = ev.outcome;
  }
  assert.equal(outcome, "cancelled");
  assert.deepEqual(kinds, ["state", "done", "state"]);
  assert.ok(Date.now() - t0 < 5000);
});

test("ClaudeAgent: per-turn permission mode overrides the approvals default", () => {
  const c = new ClaudeAgent({ approvalBase: "http://x" });
  const ref = { agent: "claude", sessionId: "s", cwd: "/" };
  const at = (a: string[]) => a[a.indexOf("--permission-mode") + 1];
  assert.equal(at(c.argsFor(ref, "hi", { sourceId: "p", threadId: "ask" })), "default");
  const a = c.argsFor(ref, "hi", { sourceId: "general", threadId: "q-1", permissionMode: "auto" });
  assert.equal(at(a), "auto");
  assert.ok(a.includes("--permission-prompt-tool")); // anything auto would ask still reaches the browser
});
