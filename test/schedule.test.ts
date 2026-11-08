import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { parseSchedules, nextRun, scheduleTitle, Scheduler } from "../src/schedule.js";

const settle = () => new Promise((r) => setTimeout(r, 30));
const one =(t: string) => parseSchedules((parse(t) as any).schedule)[0];

test("schedule: parse toml", () => {
  const s = one('[[schedule]]\nname="m"\nat="07:30"\ndays=["Mon","fri"]\nprompt="hi"');
  assert.deepEqual(s, { name: "m", source: "general", prompt: "hi", at: 450, days: [1, 5] });
  assert.equal(one('[[schedule]]\nname="p"\nevery="6h"\nsource="x"\nprompt="hi"').every, 6 * 3_600_000);
  assert.deepEqual(parseSchedules(undefined), []);
});

test("schedule: parse errors", () => {
  const bad = (t: string, re: RegExp) => assert.throws(() => one(t), re);
  bad('[[schedule]]\nname="a"\nprompt="x"', /exactly one/);
  bad('[[schedule]]\nname="a"\nat="7:30"\nevery="1h"\nprompt="x"', /exactly one/);
  bad('[[schedule]]\nname="a"\nat="25:00"\nprompt="x"', /bad at/);
  bad('[[schedule]]\nname="a"\nat="07:00"\ndays=["xyz"]\nprompt="x"', /bad day/);
  bad('[[schedule]]\nname="a"\nevery="soon"\nprompt="x"', /bad every/);
  bad('[[schedule]]\nat="07:00"\nprompt="x"', /name required/);
  bad('[[schedule]]\nname="a"\nat="07:00"', /prompt required/);
  assert.throws(() => parseSchedules([{ name: "a", at: "07:00", prompt: "x" }, { name: "a", at: "08:00", prompt: "x" }]), /duplicate/);
});

test("schedule: nextRun daily and day filter (local time)", () => {
  const s = one('[[schedule]]\nname="m"\nat="07:30"\nprompt="x"');
  assert.deepEqual(nextRun(s, new Date(2026, 10, 7, 6, 0)), new Date(2026, 10, 7, 7, 30));
  assert.deepEqual(nextRun(s, new Date(2026, 10, 7, 7, 30)), new Date(2026, 10, 8, 7, 30)); // strictly after
  const wk = one('[[schedule]]\nname="w"\nat="07:30"\ndays=["mon"]\nprompt="x"');
  const fri = new Date(2026, 10, 6, 9, 0); // 2026-11-06 is a Friday
  assert.equal(fri.getDay(), 5);
  assert.deepEqual(nextRun(wk, fri), new Date(2026, 10, 9, 7, 30));
  assert.deepEqual(nextRun(wk, new Date(2026, 10, 9, 7, 0)), new Date(2026, 10, 9, 7, 30));
  assert.deepEqual(nextRun(wk, new Date(2026, 10, 9, 8, 0)), new Date(2026, 10, 16, 7, 30));
});

test("schedule: nextRun keeps wall-clock time across DST and month/year ends", () => {
  const s = one('[[schedule]]\nname="m"\nat="07:30"\nprompt="x"');
  const cases: [Date, Date][] = [
    [new Date(2026, 2, 7, 8, 0), new Date(2026, 2, 8, 7, 30)],
    [new Date(2026, 2, 28, 8, 0), new Date(2026, 2, 29, 7, 30)],
    [new Date(2026, 9, 31, 8, 0), new Date(2026, 10, 1, 7, 30)],
    [new Date(2026, 11, 31, 8, 0), new Date(2027, 0, 1, 7, 30)],
  ];
  for (const [a, b] of cases) {
    const n = nextRun(s, a);
    assert.deepEqual(n, b);
    assert.equal(n.getHours(), 7);
  }
  const ev = one('[[schedule]]\nname="e"\nevery="90m"\nprompt="x"');
  assert.equal(nextRun(ev, new Date(2026, 0, 1)).getTime() - new Date(2026, 0, 1).getTime(), 90 * 60_000);
});

test("schedule: title", () => {
  const s = one('[[schedule]]\nname="morning"\nat="07:30"\nprompt="x"');
  assert.equal(scheduleTitle(s, new Date(2026, 10, 7, 7, 30)), "⏰ morning · 2026-11-07");
});

test("scheduler: runs due slot once, skips while busy, records last, no catch-up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ad-sched-"));
  const file = join(dir, ".index", "schedule-state.json");
  const s = one('[[schedule]]\nname="m"\nat="07:30"\nprompt="x"');
  let now = new Date(2026, 10, 7, 7, 0);
  let calls = 0;
  let release!: () => void;
  const run = () => { calls++; return new Promise<void>((r) => (release = r)); };
  const sc = new Scheduler([s], file, run, () => now);
  await sc.start(3_600_000);
  await sc.tick();
  assert.equal(calls, 0);
  now = new Date(2026, 10, 7, 7, 31);
  await sc.tick();
  await settle();
  assert.equal(calls, 1);
  assert.equal(sc.runNow("m"), false); // busy
  now = new Date(2026, 10, 8, 7, 31);
  await sc.tick(); // next slot while still busy: skipped
  assert.equal(calls, 1);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!sc.rows()[0].running);
  assert.equal(sc.runNow("m"), true);
  await settle();
  assert.equal(calls, 2);
  release();
  sc.stop();
  await new Promise((r) => setTimeout(r, 20));
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.ok(saved.m);
  // restart long after: next slot is in the future, nothing runs at start
  now = new Date(2026, 10, 20, 9, 0);
  const sc2 = new Scheduler([s], file, run, () => now);
  await sc2.start(3_600_000);
  await sc2.tick();
  assert.equal(calls, 2);
  assert.deepEqual(new Date(sc2.rows()[0].next), new Date(2026, 10, 21, 7, 30));
  sc2.stop();
});
