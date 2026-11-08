import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Offsets, parseTranscript, type LiveClaude, type LivePane } from "../src/live.js";
import { LiveFollower, type Followed } from "../src/live-follow.js";
import { parsePermissionPrompt, promptSig } from "../src/live-prompt.js";

const screen = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", "screens", n), "utf8");

test("parsePermissionPrompt: bash command", () => {
  const p = parsePermissionPrompt(screen("bash.txt"))!;
  assert.equal(p.title, "Bash command");
  assert.equal(p.question, "Do you want to proceed?");
  assert.match(p.detail, /echo hello > \/tmp\/dl-proj\/x\.txt/);
  assert.doesNotMatch(p.detail, /Tip:/);
  assert.deepEqual(p.options.map((o) => [o.key, o.allow]), [["1", true], ["2", true], ["3", true], ["4", false]]);
  assert.match(p.options[1].label, /always allow access to \/tmp\/dl-proj/);
});

test("parsePermissionPrompt: edit and write", () => {
  const e = parsePermissionPrompt(screen("edit.txt"))!;
  assert.equal(e.title, "Edit file");
  assert.equal(e.question, "Do you want to make this edit to y.txt?");
  assert.match(e.detail, /1 -hi\n1 \+bye/);
  assert.deepEqual(e.options.map((o) => o.allow), [true, true, false]);
  assert.equal(e.options[2].label, "No");
  const w = parsePermissionPrompt(screen("write.txt"))!;
  assert.equal(w.title, "Create file");
  assert.equal(w.options.length, 3);
  assert.notEqual(promptSig(e), promptSig(w));
});

test("parsePermissionPrompt: not a prompt", () => {
  assert.equal(parsePermissionPrompt(""), null);
  assert.equal(parsePermissionPrompt("❯ \n  ⏸ manual mode on"), null);
  // numbered list in output, no footer
  assert.equal(parsePermissionPrompt("Do these?\n 1. a\n 2. b\n"), null);
  // trust dialog: no numbers
  assert.equal(parsePermissionPrompt(" ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel"), null);
  // numbering must start at 1
  assert.equal(parsePermissionPrompt("Proceed?\n 2. Yes\n 3. No\n Esc to cancel"), null);
});

test("parsePermissionPrompt: wrapped option, no box", () => {
  const p = parsePermissionPrompt("Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for\n      npm test commands\n   3. No, and tell Claude what to do differently (esc)\n\n Esc to cancel")!;
  assert.equal(p.options[1].label, "Yes, and don't ask again for npm test commands");
  assert.deepEqual(p.options.map((o) => o.allow), [true, true, false]);
  assert.equal(p.title, "");
});

test("Offsets: first sight starts at the end, then advances; shrink resets", () => {
  const o = new Offsets();
  assert.equal(o.get("f", 100), 100);
  o.set("f", 40);
  assert.equal(o.get("f", 100), 40);
  assert.equal(o.get("f", 30), 30);
});

const line = (o: unknown) => JSON.stringify(o) + "\n";
const user = (t: string) => line({ type: "user", message: { role: "user", content: t } });
const asst = (t: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });

test("parseTranscript: prompts, output, tool results; skips meta and notes", () => {
  const evs = parseTranscript(
    user("hello") + line({ type: "user", isMeta: true, message: { content: "meta" } }) + user("<command-name>/clear</command-name>") + asst("hi") +
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }) + "{bad json\n" + line({ type: "mode" }),
  );
  assert.deepEqual(evs, [
    { kind: "prompt", text: "hello" },
    { kind: "text", text: "hi" },
    { kind: "tool_result", id: "t1", output: "ok", isError: false },
  ]);
});

test("LiveFollower: publishes terminal turns once, skips desk-owned transcripts", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "follow-")), "s.jsonl");
  writeFileSync(file, user("old") + asst("old answer"));
  const pane: LivePane = { herdrSession: "x", paneId: "w1:p1", status: "idle", title: "", cwd: "/p", sessionId: "s" };
  const offsets = new Offsets();
  let owned = false;
  const fake = {
    offsets,
    listAll: async () => [{ ...pane }],
    info: async () => ({ status: pane.status, sessionId: "s" }),
    transcript: () => file,
    isOwned: () => owned,
    blockStep: async () => [],
  } as unknown as LiveClaude;
  const out: Followed[] = [];
  let wanted = true;
  const f = new LiveFollower(fake, () => [{ id: "src", location: "/p" }], (_s, ev) => out.push(ev), () => wanted);

  await f.tick(); // first sight: history not replayed
  assert.deepEqual(out, []);
  appendFileSync(file, user("typed in terminal") + asst("working on it"));
  pane.status = "working";
  await f.tick();
  await f.tick(); // nothing new: nothing again
  assert.deepEqual(out, [{ kind: "prompt", text: "typed in terminal" }, { kind: "text", text: "working on it" }]);
  pane.status = "idle";
  await f.tick();
  await f.tick();
  assert.deepEqual(out.slice(2), [{ kind: "done", outcome: "ok" }]); // once

  // desk-started turn: owned while running, then its read position is handed over
  owned = true;
  appendFileSync(file, user("from desk") + asst("desk answer"));
  await f.tick();
  assert.equal(out.length, 3);
  offsets.set(file, readFileSync(file).length); // what LiveClaude.send() does at its end
  owned = false;
  await f.tick();
  assert.equal(out.length, 3);

  // nobody connected: no reading at all
  wanted = false;
  appendFileSync(file, asst("later"));
  await f.tick();
  assert.equal(out.length, 3);
  wanted = true;
  await f.tick();
  assert.deepEqual(out.at(-1), { kind: "text", text: "later" });
});
