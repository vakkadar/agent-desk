import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrMux } from "../src/adapters/mux/herdr.js";
import { hostedSpawn, recoverTurns } from "../src/adapters/mux/hosted.js";
import { createMux, muxStatus } from "../src/adapters/mux/index.js";

let haveHerdr = true;
try {
  execFileSync("herdr", ["--version"], { stdio: "ignore" });
} catch {
  haveHerdr = false;
}

test("mux=none uses direct spawn and reports status", async () => {
  const h = await createMux({ mux: "none", dataDir: tmpdir() });
  assert.equal(h.mode, "none");
  assert.equal((await muxStatus()).ok, true);
});

test("missing herdr falls back to none", async () => {
  const old = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const h = await createMux({ mux: "herdr", dataDir: tmpdir() }, () => {});
    assert.equal(h.mode, "none");
    assert.equal((await muxStatus()).ok, false);
  } finally {
    process.env.PATH = old;
  }
});

test("herdr: turn runs in pane, survives consumer restart", { skip: !haveHerdr }, async () => {
  const session = `adtest-${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), "adtest-"));
  const bin = join(dir, "fakeclaude");
  writeFileSync(bin, '#!/bin/bash\nfor i in 1 2 3 4; do echo "{\\"n\\":$i,\\"a\\":\\"$1\\"}"; sleep 0.5; done\n');
  chmodSync(bin, 0o755);
  const mux = new HerdrMux(session, join(dir, "panes.json"));
  try {
    const spawnFn = hostedSpawn(mux, dir);
    const p = spawnFn(bin, ["it's $HOME;x"], { cwd: dir, key: "sess-1" });
    const it = p.lines[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(JSON.parse(first.value).n, 1);
    // "restart": drop the consumer, recover from disk, get the remaining lines only.
    const turns = await recoverTurns(mux, dir);
    assert.equal(turns.length, 1);
    const rest: any[] = [];
    for await (const l of turns[0].proc.lines) rest.push(JSON.parse(l));
    assert.deepEqual(rest.map((r) => r.n), [2, 3, 4]);
    assert.equal(rest[0].a, "it's $HOME;x");
    assert.equal(await turns[0].proc.exited, 0);
    await turns[0].cleanup();
  } finally {
    try {
      execFileSync("herdr", ["session", "stop", session], { stdio: "ignore" });
      execFileSync("herdr", ["session", "delete", session], { stdio: "ignore" });
    } catch {}
  }
});
