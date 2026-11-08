import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "../src/doctor.js";

test("loadEnvFile reads KEY=VALUE, strips quotes, skips comments, keeps existing vars", () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-env-"));
  const f = join(dir, "env");
  writeFileSync(f, '# comment\nAGENT_DESK_TOKEN="abc123"\nexport AGENT_DESK_DATA=/data\nKEEP=file\n\nbad line\n');
  const env: NodeJS.ProcessEnv = { KEEP: "shell" };
  loadEnvFile(f, env);
  assert.equal(env.AGENT_DESK_TOKEN, "abc123");
  assert.equal(env.AGENT_DESK_DATA, "/data");
  assert.equal(env.KEEP, "shell");
});

test("loadEnvFile ignores a missing file", () => {
  const env: NodeJS.ProcessEnv = {};
  loadEnvFile("/nonexistent/agent-desk/env", env);
  assert.deepEqual(env, {});
});
