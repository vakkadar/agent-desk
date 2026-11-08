import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrSessions, canMove, checkName, checkPin, hashPin } from "../src/herdr-sessions.js";

const fresh = (now = () => Date.now()) => new HerdrSessions(mkdtempSync(join(tmpdir(), "hs-")), now);

test("state machine: initialized -> open -> closed -> open; closed can't go back to initialized", () => {
  assert.ok(canMove("initialized", "open"));
  assert.ok(canMove("initialized", "closed"));
  assert.ok(canMove("open", "closed"));
  assert.ok(canMove("closed", "open"));
  assert.ok(!canMove("closed", "initialized"));
  assert.ok(!canMove("open", "initialized"));
  assert.ok(!canMove("closed", "closed"));
});

test("names: safe characters only, desk's own sessions refused", () => {
  checkName("hora-raj");
  assert.throws(() => checkName("a b"), /bad session name/);
  assert.throws(() => checkName("x;rm"), /bad session name/);
  assert.throws(() => checkName("general"), /used by the desk/);
});

test("PIN hash round trip, salted", () => {
  const h = hashPin("4321");
  assert.ok(checkPin("4321", h));
  assert.ok(!checkPin("1234", h));
  assert.notEqual(hashPin("4321"), h);
  assert.ok(!checkPin("4321", "garbage"));
});

test("register, transitions, persisted and private, hash never shown to the web", () => {
  const r = fresh();
  r.register({ name: "hora-raj", dir: "/x", pin: "9999" });
  assert.throws(() => r.register({ name: "hora-raj", dir: "/y" }), /already registered/);
  assert.equal(r.get("hora-raj")!.state, "initialized");
  r.setState("hora-raj", "open");
  assert.deepEqual(r.openNames(), ["hora-raj"]);
  r.setState("hora-raj", "closed");
  assert.throws(() => r.setState("hora-raj", "initialized"), /can't go from closed to initialized/);
  assert.equal(statSync(r.file).mode & 0o777, 0o600);
  const again = new HerdrSessions(join(r.file, "..", ".."));
  assert.equal(again.get("hora-raj")!.state, "closed");
  const row = again.rows4web()[0] as any;
  assert.equal(row.pinned, true);
  assert.equal(row.pinHash, undefined);
});

test("verify: no PIN set passes; missing or wrong PIN throws; 5 wrong lock it for 5 minutes", () => {
  let t = 1_000_000;
  const r = fresh(() => t);
  r.register({ name: "open-one", dir: "/x" });
  r.verify("open-one");
  r.register({ name: "s", dir: "/x", pin: "1111" });
  assert.throws(() => r.verify("s"), /PIN required/);
  for (let i = 0; i < 4; i++) assert.throws(() => r.verify("s", "0000"), /wrong PIN/);
  r.verify("s", "1111"); // right PIN resets the count
  for (let i = 0; i < 5; i++) assert.throws(() => r.verify("s", "0000"), /wrong PIN/);
  assert.throws(() => r.verify("s", "1111"), /locked/);
  t += 5 * 60_000 + 1;
  r.verify("s", "1111");
});

test("setPin clears or replaces; remove drops the entry", () => {
  const r = fresh();
  r.register({ name: "s", dir: "/x", pin: "1" });
  r.setPin("s");
  r.verify("s");
  r.setPin("s", "2");
  assert.throws(() => r.verify("s", "1"), /wrong PIN/);
  r.remove("s");
  assert.equal(r.get("s"), undefined);
  assert.throws(() => r.remove("s"), /no session named/);
});
