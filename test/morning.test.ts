import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayBefore, morningNote, morningOf } from "../src/morning.js";
import type { NoteRow } from "../src/notes.js";

const row = (p: Partial<NoteRow>): NoteRow => ({ schema: 1, ts: "2026-11-13T10:00:00Z", source_id: "s1", thread_id: "code-1", mode: "code", agent: "claude", kind: "response", ...p });

test("morningOf digests threads, pick-ups, notes and commits", () => {
  const m = morningOf("2026-11-13", [
    row({ ts: "2026-11-13T09:00:00Z", prompt: "add login", summary: "added", files_changed: ["src/a.ts"], outcome: "ok", cost: 0.5 }),
    row({ ts: "2026-11-13T11:00:00Z", prompt: "fix tests", summary: "stuck", files_changed: ["src/a.ts", "test/a.ts"], outcome: "error: boom", cost: 0.25 }),
    row({ ts: "2026-11-13T10:30:00Z", thread_id: "code-2", prompt: "docs", summary: "done", outcome: "ok" }),
    row({ kind: "approval", approval_id: "a1", outcome: "requested", tool: "Bash", thread_id: "code-2" }),
    row({ kind: "approval", approval_id: "a2", outcome: "requested", tool: "Edit" }),
    row({ kind: "approval", approval_id: "a2", outcome: "allow" }),
    row({ kind: "commit", summary: "abc turn" }),
    row({ kind: "note", summary: "call the bank" }),
    row({ kind: "note", summary: "secrets redacted", outcome: "secret-redacted" }),
  ]);
  assert.equal(m.date, "2026-11-13");
  assert.deepEqual(m.threads.map((t) => [t.threadId, t.turns]), [["code-1", 2], ["code-2", 1]]);
  const t = m.threads[0];
  assert.equal(t.lastPrompt, "fix tests");
  assert.deepEqual(t.files, ["src/a.ts", "test/a.ts"]);
  assert.equal(t.cost, 0.75);
  assert.deepEqual(m.pickUp, ["s1/code-1: last turn ended error: boom", "s1/code-2: Bash approval never answered"]);
  assert.deepEqual(m.notes, ["call the bank"]);
  assert.equal(m.commits, 1);
});

test("morningNote looks back past empty days, up to a week", async () => {
  const dir = await mkdtemp(join(tmpdir(), "morning-"));
  assert.equal((await morningNote(dir, "2026-11-14")).date, null);
  await mkdir(join(dir, "notes", "activity"), { recursive: true });
  await writeFile(join(dir, "notes", "activity", "2026-11-11.jsonl"), JSON.stringify(row({ ts: "2026-11-11T08:00:00Z" })) + "\n");
  await writeFile(join(dir, "notes", "activity", "2026-11-14.jsonl"), JSON.stringify(row({ ts: "2026-11-14T08:00:00Z" })) + "\n"); // today: not digested
  const m = await morningNote(dir, "2026-11-14");
  assert.equal(m.date, "2026-11-11");
  assert.equal(m.threads.length, 1);
  assert.equal(dayBefore("2026-03-01"), "2026-02-28");
});
