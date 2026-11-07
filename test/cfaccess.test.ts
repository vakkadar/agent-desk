import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { CfAccess, viaTunnel } from "../src/net/cfaccess.js";
import { Guard } from "../src/net/guard.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
const team = "acme", aud = "aud-123";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function jwt(payload: Record<string, unknown>, kid = "k1"): string {
  const h = b64({ alg: "RS256", kid }), p = b64(payload);
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: `https://${team}.cloudflareaccess.com`, aud: [aud], exp: now() + 600, email: "Me@x.com" });
const req = (headers: Record<string, string>) => ({ headers } as unknown as IncomingMessage);

test("cfaccess: verifies Access JWT from header or cookie", async () => {
  const cf = new CfAccess({ team, aud }, async () => [jwk]);
  assert.equal(await cf.verify(req({ "cf-access-jwt-assertion": jwt(good()) })), "me@x.com");
  assert.equal(await cf.verify(req({ cookie: `a=1; CF_Authorization=${jwt(good())}` })), "me@x.com");
});

test("cfaccess: rejects bad aud, issuer, expiry, signature, missing token", async () => {
  const cf = new CfAccess({ team, aud }, async () => [jwk]);
  const v = (t: string) => cf.verify(req({ "cf-access-jwt-assertion": t }));
  assert.equal(await v(jwt({ ...good(), aud: ["other"] })), null);
  assert.equal(await v(jwt({ ...good(), iss: "https://evil.cloudflareaccess.com" })), null);
  assert.equal(await v(jwt({ ...good(), exp: now() - 10 })), null);
  assert.equal(await v(jwt(good(), "unknown-kid")), null);
  const t = jwt(good());
  assert.equal(await v(t.slice(0, -4) + "AAAA"), null);
  assert.equal(await cf.verify(req({})), null);
});

test("cfaccess: optional email allowlist; certs failure denies", async () => {
  const only = new CfAccess({ team, aud, emails: ["you@x.com"] }, async () => [jwk]);
  assert.equal(await only.verify(req({ "cf-access-jwt-assertion": jwt(good()) })), null);
  const down = new CfAccess({ team, aud }, async () => { throw new Error("offline"); });
  assert.equal(await down.verify(req({ "cf-access-jwt-assertion": jwt(good()) })), null);
});

test("tunnel detection and role: Access alone is read-only", () => {
  assert.equal(viaTunnel(req({ "cf-ray": "abc" })), true);
  assert.equal(viaTunnel(req({})), false);
  assert.equal(new Guard({ actionAllow: ["127.0.0.1"], readonlyAllow: [] }).tunnelRole(), "readonly");
  const g = new Guard({ actionAllow: ["127.0.0.1"], readonlyAllow: [], actionToken: "s3cret" });
  assert.equal(g.tunnelRole("s3cret"), "action");
  assert.equal(g.tunnelRole("nope"), "readonly");
});
