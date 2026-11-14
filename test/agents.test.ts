import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, agentCommand, detectAgents, findAgent, resolveSettings, validateSettings, type AgentInfo } from "../src/agents.js";

const has = (...ids: string[]): AgentInfo[] => (["claude", "codex", "opencode"] as const).map((id) => ({ id, label: id, installed: ids.includes(id), ...(ids.includes(id) ? { path: `/bin/${id}` } : {}) }));

test("findAgent: PATH first, then the usual install folder", () => {
  const home = mkdtempSync(join(tmpdir(), "ag-"));
  mkdirSync(join(home, ".opencode/bin"), { recursive: true });
  writeFileSync(join(home, ".opencode/bin/opencode"), "");
  chmodSync(join(home, ".opencode/bin/opencode"), 0o755);
  assert.equal(findAgent("opencode", "/nonexistent", home), join(home, ".opencode/bin/opencode"));
  assert.equal(findAgent("codex", "/nonexistent", home), undefined);
  assert.deepEqual(detectAgents((id) => (id === "claude" ? "/c" : undefined)).map((a) => a.installed), [true, false, false]);
});

test("resolveSettings: defaults from what is installed; stale picks fall back", () => {
  assert.deepEqual(resolveSettings(undefined, has("claude", "opencode")), { enabled: ["claude", "opencode"], builder: "claude", reviewer: "opencode" });
  assert.deepEqual(resolveSettings(undefined, has("claude")), { enabled: ["claude"], builder: "claude", reviewer: "claude" });
  // codex picked on another host, not installed here: dropped
  assert.deepEqual(resolveSettings({ enabled: ["codex", "claude"], builder: "codex", reviewer: "codex" }, has("claude", "opencode")), { enabled: ["claude"], builder: "claude", reviewer: "claude" });
  assert.deepEqual(resolveSettings({ enabled: ["opencode", "claude"], builder: "opencode", reviewer: "claude" }, has("claude", "opencode")), { enabled: ["opencode", "claude"], builder: "opencode", reviewer: "claude" });
});

test("validateSettings and save", () => {
  const a = has("claude", "opencode");
  assert.throws(() => validateSettings({ enabled: [] }, a), /at least one/);
  assert.throws(() => validateSettings({ enabled: ["codex"], builder: "codex", reviewer: "codex" }, a), /not installed/);
  assert.throws(() => validateSettings({ enabled: ["claude"], builder: "claude", reviewer: "opencode" }, a), /reviewer must be/);
  assert.throws(() => validateSettings({ enabled: ["rm -rf"], builder: "x", reviewer: "x" }, a), /unknown agent/);
  const st = new AgentStore(mkdtempSync(join(tmpdir(), "ags-")), () => a);
  st.save({ enabled: ["claude", "opencode"], builder: "opencode", reviewer: "claude" });
  assert.deepEqual(st.settings(), { enabled: ["claude", "opencode"], builder: "opencode", reviewer: "claude" });
  assert.equal((st.view().agents[0] as any).path, undefined, "paths stay on the server");
});

test("agentCommand quotes odd paths", () => {
  assert.equal(agentCommand("claude", undefined, "opus"), "claude --model opus");
  assert.equal(agentCommand("opencode", "/a b/opencode", "opus"), "'/a b/opencode'");
});
