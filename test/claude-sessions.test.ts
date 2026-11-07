import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSessionId, listSessions, projectDir } from "../src/claude-sessions.js";

const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("projectDir encodes like Claude", () => {
  assert.equal(projectDir("/home/u/projects/agent-desk", "/r"), "/r/-home-u-projects-agent-desk");
  assert.equal(projectDir("/a/b.c_d", "/r"), "/r/-a-b-c-d");
});

test("isSessionId rejects paths and junk", () => {
  assert.ok(isSessionId(A));
  for (const bad of ["../x", "", A + "x", 42, undefined]) assert.equal(isSessionId(bad), false);
});

test("listSessions: newest first, first human prompt, live flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "cs-"));
  const dir = projectDir("/p/x", root);
  await mkdir(dir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  await writeFile(join(dir, `${A}.jsonl`),
    line({ type: "mode", mode: "normal" }) +
    line({ type: "user", message: { content: "<command-name>/clear</command-name>" } }) +
    line({ type: "user", isMeta: true, message: { content: "meta" } }) +
    line({ type: "user", message: { content: [{ type: "text", text: "fix   the\nbug" }] } }));
  await writeFile(join(dir, `${B}.jsonl`), line({ type: "user", message: { content: "older one" } }));
  await writeFile(join(dir, "notes.txt"), "ignored");
  const now = Date.now();
  await utimes(join(dir, `${B}.jsonl`), new Date(now - 3_600_000), new Date(now - 3_600_000));
  const got = await listSessions("/p/x", { root, now });
  assert.deepEqual(got.map((s) => [s.id, s.title, s.live]), [[A, "fix the bug", true], [B, "older one", false]]);
  assert.deepEqual(await listSessions("/nope", { root }), []);
});
