import { test } from "node:test";
import assert from "node:assert/strict";
import { links, mailText, relatedOf } from "../src/links.js";
import type { SourceRec } from "../src/threads.js";
import type { DeskEvent } from "../src/types.js";

const th = (id: string, from?: string) => ({ id, mode: id.split("-")[0] as any, session: { agent: "claude", sessionId: "", cwd: "/p" }, createdAt: "", from });
const rec: SourceRec = {
  id: "p", kind: "local", location: "/p", agent: "claude",
  threads: { ask: th("ask") as any, "design-1": th("design-1"), "code-1": th("code-1", "design-1"), "code-2": th("code-2"), "code-3": th("code-3") },
};
let seq = 0;
const prompt = (threadId: string, text: string, sourceId = "p"): DeskEvent => ({ seq: ++seq, ts: "", sourceId, threadId, event: { kind: "prompt", text } });

test("started-from, mail and mentions links; strongest reason wins; unknown threads and other projects ignored", () => {
  const ls = links(rec, [
    prompt("code-2", "desk[code-2]: do it like code-3 did, see code-3 and code-9"),
    prompt("code-1", `desk[code-1]: ${mailText("code-2", "I changed the API")}`),
    prompt("code-1", "desk[code-1]: design-1 wants rounder corners"),
    prompt("code-2", "desk[code-2]: code-1 also", "other"),
    prompt("code-3", "desk[code-3]: this is code-3"),
  ]);
  assert.deepEqual(ls, [
    { a: "code-1", b: "design-1", why: "started from", count: 2 },
    { a: "code-1", b: "code-2", why: "mail", count: 1 },
    { a: "code-2", b: "code-3", why: "mentions", count: 2 },
  ]);
  assert.deepEqual(relatedOf(ls, "code-1"), [{ id: "design-1", why: "started from", count: 2 }, { id: "code-2", why: "mail", count: 1 }]);
  assert.deepEqual(relatedOf(ls, "ask"), []);
});
