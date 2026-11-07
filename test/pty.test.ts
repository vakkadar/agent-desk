import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "adpty-"));
const fake = join(dir, "herdr");
writeFileSync(fake, '#!/bin/sh\nif [ "$2" = "list" ]; then printf "name status\\nfoo running\\nbar running\\n"; else exec cat; fi\n');
chmodSync(fake, 0o755);
process.env.AGENT_DESK_HERDR_BIN = fake;
const { onPtyClient, parseSessionList, ptyCount } = await import("../src/pty.js");

test("parseSessionList", () => {
  assert.deepEqual(parseSessionList("name status\nfoo running x\nbar running\n"), ["foo", "bar"]);
});

async function server() {
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer();
  http.on("upgrade", (req, s, h) =>
    wss.handleUpgrade(req, s, h, (ws) => onPtyClient(ws, req, { resolveRole: (t) => (t === "a" ? "action" : t === "r" ? "readonly" : null) })));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return { http, port: (http.address() as any).port as number };
}
function client(port: number, session: string, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?session=${session}`);
  let out = "";
  const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
  ws.on("message", (d) => (out += String(d)));
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, cols: 80, rows: 24 })));
  return { ws, closed, out: () => out };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("action role: input echoes; socket close frees pty", async () => {
  const { http, port } = await server();
  const c = client(port, "foo", "a");
  await wait(600);
  c.ws.send(JSON.stringify({ type: "input", data: "hi\r" }));
  await wait(400);
  assert.match(c.out(), /ready/);
  assert.match(c.out(), /hi/);
  assert.equal(ptyCount(), 1);
  c.ws.close();
  await wait(400);
  assert.equal(ptyCount(), 0);
  http.close();
});

test("readonly role: input dropped; bad token / unknown session closed", async () => {
  const { http, port } = await server();
  const c = client(port, "foo", "r");
  await wait(600);
  c.ws.send(JSON.stringify({ type: "input", data: "secret\r" }));
  await wait(400);
  assert.doesNotMatch(c.out(), /secret/);
  c.ws.close();
  assert.equal(await client(port, "foo", "bad").closed, 4003);
  assert.equal(await client(port, "nope", "a").closed, 4004);
  await wait(300);
  http.close();
});
