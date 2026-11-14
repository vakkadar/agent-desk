import { test } from "node:test";
import assert from "node:assert/strict";
import { pairModels, parseModels, turnModel } from "../src/models.js";
import { parseSchedules } from "../src/schedule.js";
import { ClaudeAgent } from "../src/adapters/agent/claude.js";

test("parseModels keeps model names, drops junk", () => {
  assert.deepEqual(parseModels(undefined), {});
  assert.deepEqual(parseModels({ code: " sonnet ", design: "opus", bad: 3, worse: "a b; rm" }), { code: "sonnet", design: "opus" });
  assert.deepEqual(parseModels(["x"]), {});
});

test("turnModel: schedule's own > source > schedule > mode > unset", () => {
  const map = { design: "opus", code: "sonnet", schedule: "haiku", general: "claude-haiku-5-5" };
  assert.equal(turnModel(map, { sourceId: "p", mode: "design" }), "opus");
  assert.equal(turnModel(map, { sourceId: "p", mode: "ask" }), undefined);
  assert.equal(turnModel(map, { sourceId: "p", mode: "ask", scheduled: true }), "haiku");
  assert.equal(turnModel(map, { sourceId: "general", mode: "ask", scheduled: true }), "claude-haiku-5-5");
  assert.equal(turnModel(map, { sourceId: "general", mode: "ask", scheduled: true, own: "opus" }), "opus");
});

test("pairModels: per tab, with the old defaults", () => {
  assert.deepEqual(pairModels({}, "p", "lead"), { builder: "sonnet", reviewer: "opus" });
  const map = { design: "opus", lead: "haiku", reviewer: "sonnet" };
  assert.deepEqual(pairModels(map, "p", "lead"), { builder: "haiku", reviewer: "sonnet" });
  assert.deepEqual(pairModels(map, "p", "design-1", "design"), { builder: "opus", reviewer: "sonnet" });
  assert.deepEqual(pairModels(map, "p", "code-1", "code"), { builder: "sonnet", reviewer: "sonnet" });
});

test("schedule model and the claude --model flag", () => {
  const [s] = parseSchedules([{ name: "m", at: "07:00", prompt: "hi", model: "haiku" }]);
  assert.equal(s.model, "haiku");
  assert.throws(() => parseSchedules([{ name: "m", at: "07:00", prompt: "hi", model: "x y" }]), /bad model/);
  const c = new ClaudeAgent();
  const ref = { agent: "claude", sessionId: "abc", cwd: "/" };
  const a = c.argsFor(ref, "q", { sourceId: "p", threadId: "ask", model: "opus" });
  assert.equal(a[a.indexOf("--model") + 1], "opus");
  assert.ok(!c.argsFor(ref, "q", { sourceId: "p", threadId: "ask" }).includes("--model"));
});
