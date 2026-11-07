import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSession, parseExisting, routeGeneral } from "../src/general.js";
import type { SourceRec } from "../src/threads.js";
import type { AgentAdapter, SessionRef } from "../src/types.js";

let n = 0;
const agent = {
  id: "claude",
  start: async (o: { cwd: string }) => ({ agent: "claude", sessionId: `s${++n}`, cwd: o.cwd }),
  resume: async (r: SessionRef) => r,
  fork: async (r: SessionRef) => ({ agent: "claude", sessionId: "", cwd: r.cwd, forkFrom: r.sessionId }),
} as unknown as AgentAdapter;

const rec = (): SourceRec => ({
  id: "general", kind: "local", location: "/nonexistent-general", agent: "claude", builtin: true,
  threads: { ask: { id: "ask", mode: "ask", session: { agent: "claude", sessionId: "base", cwd: "/g" }, createdAt: "2026-01-01T00:00:00Z" } },
});

test("parseExisting: prefix on first line, message after", () => {
  assert.equal(parseExisting("what is x"), null);
  assert.deepEqual(parseExisting("existing: q-2\nand then?"), { query: "q-2", rest: "and then?" });
  assert.deepEqual(parseExisting("  Existing:  tax stuff \n\n more\nlines "), { query: "tax stuff", rest: "more\nlines" });
  assert.deepEqual(parseExisting("existing: q-1"), { query: "q-1", rest: "" });
  assert.deepEqual(parseExisting("c: q-3\nmore"), { query: "q-3", rest: "more" });
  assert.deepEqual(parseExisting("C:tax\nx"), { query: "tax", rest: "x" });
  assert.equal(parseExisting("calc: 2+2"), null);
  assert.deepEqual(parseExisting("c: q-1 its in Edge"), { query: "q-1", rest: "its in Edge" });
  assert.deepEqual(parseExisting("c: 6b4b0544 more"), { query: "6b4b0544", rest: "more" });
  assert.deepEqual(parseExisting("c: q1 hi"), { query: "q1", rest: "hi" });
  assert.deepEqual(parseExisting("c: india trip"), { query: "india trip", rest: "" }); // words need the next line
});

test("routeGeneral: every plain prompt gets a new session", async () => {
  const r = rec();
  const a = await routeGeneral(r, agent, "how do tides work");
  const b = await routeGeneral(r, agent, "how do tides work");
  assert.equal(a.thread.id, "q-1");
  assert.equal(b.thread.id, "q-2");
  assert.notEqual(a.thread.session.sessionId, b.thread.session.sessionId);
  assert.equal(a.thread.title, "how do tides work");
  assert.ok(a.created && b.created);
});

test("routeGeneral: existing: matches id or title words, no new thread", async () => {
  const r = rec();
  await routeGeneral(r, agent, "Plan the India trip itinerary");
  await routeGeneral(r, agent, "unrelated");
  const byId = await routeGeneral(r, agent, "existing: q-1\nadd Hyderabad");
  assert.equal(byId.thread.id, "q-1");
  assert.equal(byId.text, "add Hyderabad");
  assert.equal(byId.created, false);
  assert.equal((await routeGeneral(r, agent, "c: q1 more")).thread.id, "q-1");
  const byWords = await routeGeneral(r, agent, "c: india TRIP\nmore");
  assert.equal(byWords.thread.id, "q-1");
  assert.equal(Object.keys(r.threads).length, 3);
});

test("routeGeneral: existing: errors", async () => {
  const r = rec();
  await assert.rejects(routeGeneral(r, agent, "existing: q-1"), /next line/);
  await assert.rejects(routeGeneral(r, agent, "existing: nothing here\nhi"), /no General question matches/);
});

test("matchSession: id prefix (4+ chars) then title", () => {
  const ss = [
    { id: "abcd1234-0000-0000-0000-000000000000", mtime: "", title: "budget for december", live: false },
    { id: "ffff0000-0000-0000-0000-000000000000", mtime: "", title: "abc notes", live: true },
  ];
  assert.equal(matchSession(ss, "abcd")?.id, ss[0].id);
  assert.equal(matchSession(ss, "abc")?.id, ss[1].id); // too short for id: title match
  assert.equal(matchSession(ss, "December")?.id, ss[0].id);
  assert.equal(matchSession(ss, "zzz"), undefined);
});
