import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPayload, addSub, removeSub, validSub, loadSubs, saveSubs, Push } from "../src/push.js";
import type { DeskEvent } from "../src/types.js";

const ev = (event: DeskEvent["event"]): DeskEvent => ({ seq: 1, ts: "t", sourceId: "proj", threadId: "ask", event });
const sub = (n: string) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "p", auth: "a" } });

test("push: payload for done / approval / cancelled", () => {
  const long = "word ".repeat(60);
  const d = buildPayload(ev({ kind: "done", outcome: "ok" }), `Hello\n\n${long}`)!;
  assert.equal(d.title, "proj/ask");
  assert.ok(d.body.startsWith("Hello word") && d.body.length <= 100);
  assert.equal(d.url, "#source=proj&thread=ask");
  assert.equal(buildPayload(ev({ kind: "done", outcome: "ok" }))!.body, "Turn finished");
  assert.equal(buildPayload(ev({ kind: "done", outcome: "error", error: "boom" }))!.body, "Error: boom");
  assert.equal(buildPayload(ev({ kind: "done", outcome: "cancelled" }), "x"), null);
  assert.equal(buildPayload(ev({ kind: "approval_request", id: "i", tool: "Bash", input: {} }))!.body, "Approval: Bash");
  assert.equal(buildPayload(ev({ kind: "text", text: "hi" })), null);
});

test("push: subscription list helpers", () => {
  assert.ok(validSub(sub("a")));
  assert.ok(!validSub({ endpoint: "http://x", keys: { p256dh: "p", auth: "a" } }));
  assert.ok(!validSub({ endpoint: "https://x" }));
  let l = addSub([], sub("a"));
  l = addSub(l, sub("b"));
  l = addSub(l, sub("a"));
  assert.equal(l.length, 2);
  assert.deepEqual(removeSub(l, sub("a").endpoint).map((s) => s.endpoint), [sub("b").endpoint]);
});

test("push: files are mode 600, survive reload, junk ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ad-push-"));
  const p = new Push(dir);
  await p.init();
  await p.subscribe(sub("a"));
  await assert.rejects(p.subscribe({ endpoint: "nope" }));
  const vf = join(dir, ".index", "vapid.json");
  const sf = join(dir, ".index", "push-subs.json");
  assert.equal((await stat(vf)).mode & 0o777, 0o600);
  assert.equal((await stat(sf)).mode & 0o777, 0o600);
  const key = p.publicKey;
  const p2 = new Push(dir);
  await p2.init();
  assert.equal(p2.publicKey, key);
  assert.equal((await loadSubs(sf)).length, 1);
  await p2.unsubscribe(sub("a").endpoint);
  assert.equal((await loadSubs(sf)).length, 0);
  await saveSubs(sf, [sub("z"), { bad: 1 } as any]);
  assert.equal((await loadSubs(sf)).length, 1);
  assert.equal((await loadSubs(join(dir, "missing.json"))).length, 0);
  assert.ok((await readFile(sf, "utf8")).includes("push.example/z"));
});
