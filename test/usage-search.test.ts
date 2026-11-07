import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage } from "../src/usage.js";
import { searchEvents } from "../src/search.js";
import type { DeskEvent } from "../src/types.js";

const now = new Date("2026-11-07T12:00:00");
const ev = (seq: number, ts: string, sourceId: string, threadId: string, event: any): DeskEvent => ({ seq, ts: new Date(ts).toISOString(), sourceId, threadId, event });
const evs = [
  ev(1, "2026-11-07T09:00:00", "a", "ask", { kind: "prompt", text: "Hello World" }),
  ev(2, "2026-11-07T09:00:05", "a", "ask", { kind: "usage", tokensIn: 10, tokensOut: 5, costUsd: 0.01 }),
  ev(3, "2026-11-03T09:00:00", "a", "code-1", { kind: "usage", tokensIn: 100, tokensOut: 50, costUsd: 0.5 }),
  ev(4, "2026-10-01T09:00:00", "b", "ask", { kind: "usage", tokensIn: 1, tokensOut: 1 }),
  ev(5, "2026-11-07T10:00:00", "a", "ask", { kind: "text", text: "the quick brown fox\njumps over" }),
  ev(6, "2026-11-07T10:00:01", "a", "ask", { kind: "tool_call", id: "t", name: "Bash", input: { command: "ls FOX" } }),
];

test("usage: range filters and totals", () => {
  assert.equal(aggregateUsage(evs, "today", now).total.tokensIn, 10);
  const w = aggregateUsage(evs, "7d", now);
  assert.equal(w.rows.length, 2);
  assert.equal(w.total.tokensIn, 110);
  const all = aggregateUsage(evs, "all", now);
  assert.equal(all.rows.length, 3);
  assert.equal(all.total.turns, 3);
  assert.ok(Math.abs(all.total.costUsd - 0.51) < 1e-9);
});

test("search: case-insensitive, newest first, highlight offsets", () => {
  const h = searchEvents(evs, "FOX");
  assert.deepEqual(h.map((x) => x.seq), [6, 5]);
  assert.equal(h[1].snippet.substr(h[1].start, h[1].len).toLowerCase(), "fox");
  assert.equal(searchEvents(evs, "hello")[0].kind, "prompt");
  assert.equal(searchEvents(evs, "").length, 0);
  assert.equal(searchEvents(evs, "o", 2).length, 2);
});
