import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compute, actionsOf, computeBrief, loadSecrets, magicPacket, parseMachines, type Exec, type Fetch } from "../src/compute.js";

const TOML = `
[[machine]]
id = "hp"
label = "HP desktop"
os = "linux"
tailscale = "hp"
ssh = "me@hp"
ha_power = "switch.hp_desktop"
[[machine.action]]
label = "Boot macOS next"
run = "sudo -n efibootmgr --bootnext 0080"
confirm = true

[[machine]]
id = "vps"
os = "vps"
tailscale = "srv1330230"
hostinger_vm = 1330230

[[machine]]
id = "gd"
os = "domains"
godaddy = true

[[machine]]
id = "iphone"
os = "ios"
tailscale = "iphone182"
`;
const SECRETS = { home_assistant: { url: "http://ha:8123/", token: "hatok" }, hostinger: { token: "htok" }, godaddy: { key: "k", secret: "s" } };
const TAILNET = JSON.stringify({ Self: { HostName: "hp-laptop", Online: true }, Peer: { a: { HostName: "hp", Online: true, TailscaleIPs: ["100.99.174.32"] }, b: { HostName: "iphone182", Online: false, LastSeen: "2026-11-10T00:00:00Z" }, c: { HostName: "srv1330230", Online: true } } });

function rig() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const execs: string[][] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    const body = url.endsWith("/api/states/switch.hp_desktop") ? { state: "on" } : url.endsWith("/virtual-machines/1330230") ? { id: 1330230, state: "running" } : url.includes("/v1/domains") ? [{ domain: "example.org" }] : {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const exec: Exec = async (cmd, args) => { execs.push([cmd, ...args]); return cmd === "tailscale" ? { code: 0, out: TAILNET } : { code: 0, out: " 10:00 up 3 days\n" }; };
  const c = new Compute("/nonexistent", { fetch, exec, secrets: () => SECRETS, machines: () => parseMachines(TOML) });
  return { c, calls, execs };
}

test("state: tailnet presence, Home Assistant and Hostinger power", async () => {
  const { c } = rig();
  const s = await c.state();
  const by = Object.fromEntries(s.machines.map((m) => [m.id, m]));
  assert.deepEqual([by.hp.online, by.hp.ip, by.hp.power], [true, "100.99.174.32", "on"]);
  assert.deepEqual([by.iphone.online, by.iphone.lastSeen, by.iphone.actions.length], [false, "2026-11-10T00:00:00Z", 0]);
  assert.equal(by.vps.power, "running");
  assert.equal(by.gd.note, undefined);
  assert.ok(by.hp.actions.some((a) => a.id === "cmd:0" && a.confirm));
});

test("run: HA power, Hostinger start and API menu, GoDaddy with sso-key, ssh", async () => {
  const { c, calls, execs } = rig();
  assert.equal((await c.run("hp", "ha:off")).ok, true);
  assert.equal(calls.at(-1)!.url, "http://ha:8123/api/services/switch/turn_off");
  assert.equal(JSON.parse(String(calls.at(-1)!.init!.body)).entity_id, "switch.hp_desktop");
  assert.equal((calls.at(-1)!.init!.headers as any).authorization, "Bearer hatok");

  await c.run("vps", "vps:start");
  assert.equal(calls.at(-1)!.url, "https://developers.hostinger.com/api/vps/v1/virtual-machines/1330230/start");
  assert.equal(calls.at(-1)!.init!.method, "POST");
  await c.run("vps", "hostinger:dns", "example.org");
  assert.equal(calls.at(-1)!.url, "https://developers.hostinger.com/api/dns/v1/zones/example.org");

  const g = await c.run("gd", "godaddy:domains");
  assert.match(g.out, /example\.org/);
  assert.equal((calls.at(-1)!.init!.headers as any).authorization, "sso-key k:s");

  const u = await c.run("hp", "ssh:uptime");
  assert.equal(u.ok, true);
  assert.deepEqual(execs.at(-1)!.slice(-2), ["me@hp", "uptime"]);
  await c.run("hp", "cmd:0");
  assert.equal(execs.at(-1)!.at(-1), "sudo -n efibootmgr --bootnext 0080");
});

test("run refuses what the machine doesn't offer and bad params", async () => {
  const { c, calls } = rig();
  assert.equal((await c.run("iphone", "ssh:reboot")).ok, false);
  assert.equal((await c.run("gd", "vps:stop")).ok, false);
  assert.match((await c.run("gd", "godaddy:dns", "x/../../v1/shoppers")).out, /needs a domain/);
  assert.equal(calls.length, 0);
});

test("missing secrets leave a note, not an error", async () => {
  const c = new Compute("/x", { exec: async () => ({ code: 1, out: "" }), secrets: () => ({}), machines: () => parseMachines(TOML) });
  const s = await c.state();
  assert.match(s.machines.find((m) => m.id === "hp")!.note!, /Home Assistant url\/token missing/);
  assert.match(s.machines.find((m) => m.id === "gd")!.note!, /GoDaddy key\/secret missing/);
  const r = await c.run("vps", "vps:stop");
  assert.equal(r.ok, false);
  assert.match(r.out, /Hostinger token missing/);
});

test("parseMachines validates; secrets file must be 0600; magic packet", () => {
  assert.throws(() => parseMachines(`[[machine]]\nid = "a b"`), /id must be/);
  assert.throws(() => parseMachines(`[[machine]]\nid = "a"\nos = "beos"`), /os must be/);
  assert.throws(() => parseMachines(`[[machine]]\nid = "a"\n[[machine]]\nid = "a"`), /duplicate/);
  assert.deepEqual(actionsOf(parseMachines(`[[machine]]\nid = "p"\nos = "ios"`)[0]), []);
  const d = mkdtempSync(join(tmpdir(), "sec-"));
  const f = join(d, "secrets.toml");
  writeFileSync(f, `[godaddy]\nkey = "k"\nsecret = "s"\n`);
  chmodSync(f, 0o644);
  assert.throws(() => loadSecrets(f), /chmod 600/);
  chmodSync(f, 0o600);
  assert.equal(loadSecrets(f).godaddy?.key, "k");
  assert.deepEqual(loadSecrets(join(d, "none.toml")), {});
  const p = magicPacket("aa:bb:cc:dd:ee:ff");
  assert.equal(p.length, 102);
  assert.equal(p.subarray(6, 12).toString("hex"), "aabbccddeeff");
});

test("computeBrief: every machine with how to reach it, and the ask-first rules", () => {
  const b = computeBrief(parseMachines(TOML));
  assert.match(b, /\*\*hp\*\* \(HP desktop, linux\) · ssh `me@hp` · tailnet name `hp` · power via Home Assistant entity `switch.hp_desktop`/);
  assert.match(b, /\*\*vps\*\*.*Hostinger VPS 1330230/);
  assert.match(b, /\*\*iphone\*\* \(iphone, ios\) · no ssh/);
  assert.match(b, /Ask in chat before anything that changes a machine/);
  assert.match(b, /Never print, copy or read secrets/);
  assert.match(computeBrief([]), /\(none configured\)/);
});
