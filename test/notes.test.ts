import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/events/bus.js";
import { NotesRecorder, readNotes } from "../src/notes.js";
import { DeskGit } from "../src/git.js";
import { redact } from "../src/secrets.js";

test("secrets: redact common tokens", () => {
  const src = [
    "aws AKIAIOSFODNN7EXAMPLE",
    "gh ghp_" + "a".repeat(36),
    "ant sk-ant-api03-" + "x".repeat(30),
    "oai sk-" + "y".repeat(40),
    "password=hunter22!",
    "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const r = redact(src);
  for (const h of ["aws-access-key", "github-token", "anthropic-key", "openai-key", "password", "private-key"]) assert.ok(r.hits.includes(h), h);
  assert.ok(!/AKIAIOSFODNN7EXAMPLE|hunter22|abc\n/.test(r.text));
  assert.equal(redact(r.text).hits.length, 0, "idempotent");
});

test("notes: turn aggregation, md, git commit + redact + push", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ad-notes-"));
  const remote = await mkdtemp(join(tmpdir(), "ad-remote-"));
  execFileSync("git", ["init", "--bare", "-q", remote]);
  const bus = new EventBus(join(dir, ".index", "events.jsonl"));
  await bus.init();
  const rec = new NotesRecorder(dir);
  rec.attach(bus);
  const g = new DeskGit(dir, { push: true, remote: "origin" }, 20);
  await g.init();
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  g.onFlag = (hits) => rec.record("note", "redacted " + hits.join(","));
  rec.onTurnEnd = () => g.schedule("turn");

  const p = { sourceId: "s1", threadId: "code-1" };
  bus.publish({ ...p, event: { kind: "prompt", text: "fix it" } });
  bus.publish({ ...p, event: { kind: "text", text: "Working. key=" } });
  bus.publish({ ...p, event: { kind: "tool_call", id: "1", name: "Edit", input: { file_path: "/a/b.ts" } } });
  bus.publish({ ...p, event: { kind: "text", text: "AKIAIOSFODNN7EXAMPLE done" } });
  bus.publish({ ...p, event: { kind: "usage", tokensIn: 10, tokensOut: 5, costUsd: 0.01 } });
  bus.publish({ ...p, event: { kind: "done", outcome: "ok" } });
  await rec.flush();

  const date = new Date().toISOString().slice(0, 10);
  const rows = await readNotes(dir, date);
  assert.deepEqual(rows.map((r) => r.kind), ["prompt", "tool", "response"]);
  const resp = rows[2];
  assert.equal(resp.schema, 1);
  assert.equal(resp.mode, "code");
  assert.equal(resp.tokens_in, 10);
  assert.deepEqual(resp.files_changed, ["/a/b.ts"]);
  assert.ok(resp.summary!.includes("done"));
  assert.ok((await readFile(join(dir, "notes", `${date}.md`), "utf8")).includes("fix it"));

  await g.commitNow();
  await rec.flush();
  assert.ok(!(await readFile(join(dir, "notes", "activity", `${date}.jsonl`), "utf8")).includes("AKIAIOSFODNN7EXAMPLE"));
  const s = g.status();
  assert.equal(s.lastPushOk, true);
  assert.ok(s.lastCommit);
  assert.ok(execFileSync("git", ["log", "--oneline"], { cwd: remote }).toString().includes("Notes:"));
  assert.ok(!execFileSync("git", ["ls-files"], { cwd: dir }).toString().includes(".index"));

  // push failure is non-fatal
  execFileSync("git", ["remote", "set-url", "origin", "/nonexistent/x"], { cwd: dir });
  await writeFile(join(dir, "x.md"), "hi");
  await g.commitNow();
  assert.equal(g.status().lastPushOk, false);
});
