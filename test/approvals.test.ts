import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/events/bus.js";
import { Approvals } from "../src/approvals.js";
import { rpc } from "../src/mcp/permission.js";
import { ClaudeAgent } from "../src/adapters/agent/claude.js";

async function setup(timeout = 60_000) {
  const bus = new EventBus(join(await mkdtemp(join(tmpdir(), "ad-")), "e.jsonl"));
  await bus.init();
  return { bus, ap: new Approvals(bus, () => timeout) };
}

test("approve flow publishes request and result events", async () => {
  const { bus, ap } = await setup();
  const p = ap.request("s", "code-1", "Write", { file_path: "x" });
  const req = bus.since(0)[0].event as any;
  assert.equal(req.kind, "approval_request");
  assert.ok(ap.resolve(req.id, true, "browser"));
  assert.equal(ap.resolve(req.id, false, "browser"), false); // already resolved
  assert.deepEqual(await p, { allow: true, by: "browser" });
  assert.equal((bus.since(0)[1].event as any).decision, "allow");
});

test("auto-deny on timeout", async () => {
  const { bus, ap } = await setup(10);
  const d = await ap.request("s", "ask", "Bash", {});
  assert.deepEqual(d, { allow: false, by: "timeout" });
  assert.equal((bus.since(0)[1].event as any).by, "timeout");
});

test("mcp rpc: initialize, list, call", async () => {
  const { bus, ap } = await setup();
  const init: any = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "s", "ask", ap);
  assert.equal(init.result.serverInfo.name, "agent-desk");
  const list: any = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "s", "ask", ap);
  assert.equal(list.result.tools[0].name, "approve");
  const call = rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" } } } }, "s", "ask", ap);
  ap.resolve((bus.since(0)[0].event as any).id, true, "browser");
  const r: any = await call;
  assert.deepEqual(JSON.parse(r.result.content[0].text), { behavior: "allow", updatedInput: { command: "ls" } });
  assert.equal(await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, "s", "ask", ap), null);
});

test("claude argv: approval flags, resume after restart", () => {
  const a = new ClaudeAgent({ approvalBase: "http://127.0.0.1:1/mcp/k" });
  const argv = a.argsFor({ agent: "claude", sessionId: "abc", cwd: "/", started: true }, "hi", { sourceId: "s", threadId: "ask" });
  assert.ok(argv.includes("--resume") && !argv.includes("--session-id"));
  assert.equal(argv[argv.indexOf("--permission-prompt-tool") + 1], "mcp__desk__approve");
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "default");
});
