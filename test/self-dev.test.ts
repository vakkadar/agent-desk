import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitTurn, insideRepo, isSelfSource } from "../src/self-dev.js";
import { featuresOf, needFeature, parseProfiles } from "../src/profiles.js";

test("self-dev: only paths inside the desk repo count, only admin has the feature", () => {
  assert.ok(insideRepo("/r/desk", "/r/desk"));
  assert.ok(insideRepo("/r/desk/src", "/r/desk"));
  assert.ok(!insideRepo("/r/desk-other", "/r/desk"));
  assert.ok(!insideRepo("/r", "/r/desk"));
  assert.ok(isSelfSource({ kind: "local", location: "/r/desk/web" }, "/r/desk"));
  assert.ok(!isSelfSource({ kind: "url", location: "/r/desk" }, "/r/desk"));
  assert.ok(featuresOf("admin").has("self"));
  assert.ok(!featuresOf("developer").has("self"));
  assert.throws(() => needFeature(featuresOf("developer"), "self"), /admin profile only/);
  assert.equal(parseProfiles({ profile: "admin" }).profile, "admin");
});

test("self-dev: a turn's changes are committed, nothing to commit is fine", async () => {
  const d = mkdtempSync(join(tmpdir(), "selfdev-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: d }).toString().trim();
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "a.txt"), "1");
  g("add", "."); g("commit", "-qm", "init");
  assert.equal(await commitTurn(d, "browser[ask]: nothing", "ask"), null);
  writeFileSync(join(d, "a.txt"), "2");
  writeFileSync(join(d, "b.txt"), "new");
  const h = await commitTurn(d, "browser[ask]: fix the   PIN box\nmore", "ask");
  assert.ok(h);
  assert.equal(g("log", "-1", "--format=%s"), "Desk dev: fix the PIN box more");
  assert.equal(g("status", "--porcelain"), "");
});
