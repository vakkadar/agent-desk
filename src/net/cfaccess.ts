// Cloudflare Access check for requests arriving through a Cloudflare Tunnel.
// cloudflared connects from loopback, so tunnel traffic must not inherit localhost trust:
// it is admitted only with a valid Access JWT (RS256, signed by the team's certs).
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface CfAccessOpts {
  team: string; // <team>.cloudflareaccess.com
  aud: string; // Access application AUD tag
  emails?: string[]; // optional extra allowlist on top of the Access policy
  owners?: string[]; // verified Access emails that get full (action) access without the desk token
}

type Jwk = { kid: string } & Record<string, unknown>;

/** Cloudflare adds these headers to every proxied request; direct clients don't. */
export function viaTunnel(req: IncomingMessage): boolean {
  return req.headers["cf-ray"] !== undefined || req.headers["cf-connecting-ip"] !== undefined;
}

export class CfAccess {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private emails: string[];
  private owners: string[];

  constructor(private o: CfAccessOpts, private certs: () => Promise<Jwk[]> = () => fetchCerts(o.team)) {
    this.emails = (o.emails ?? []).map((e) => e.toLowerCase());
    this.owners = (o.owners ?? []).map((e) => e.toLowerCase());
  }

  private get issuer() {
    return `https://${this.o.team}.cloudflareaccess.com`;
  }

  /** Look up a signing key; refetch certs on unknown kid (key rotation), at most once a minute. */
  private async key(kid: string): Promise<KeyObject | undefined> {
    if (!this.keys.has(kid) && Date.now() - this.fetchedAt > 60_000) {
      const keys = await this.certs();
      this.keys = new Map(keys.map((k) => [k.kid, createPublicKey({ key: k as any, format: "jwk" })]));
      this.fetchedAt = Date.now();
    }
    return this.keys.get(kid);
  }

  /** A verified identity from verify() that is one of the owners. */
  isOwner(identity: string | null): boolean {
    return !!identity && this.owners.includes(identity);
  }

  /** Verified identity (email, or "service-token"), or null if the request isn't authorized. */
  async verify(req: IncomingMessage): Promise<string | null> {
    const jwt = String(req.headers["cf-access-jwt-assertion"] ?? cookie(req, "CF_Authorization") ?? "");
    const [h, p, s] = jwt.split(".");
    if (!h || !p || !s) return null;
    try {
      const header = JSON.parse(b64(h));
      const payload = JSON.parse(b64(p));
      if (header.alg !== "RS256") return null;
      const k = await this.key(header.kid);
      if (!k || !verify("RSA-SHA256", Buffer.from(`${h}.${p}`), k, Buffer.from(s, "base64url"))) return null;
      const now = Date.now() / 1000;
      const aud = ([] as string[]).concat(payload.aud ?? []);
      if (payload.iss !== this.issuer || !aud.includes(this.o.aud)) return null;
      if (typeof payload.exp !== "number" || payload.exp < now || (payload.nbf ?? 0) > now + 60) return null;
      const email = String(payload.email ?? "").toLowerCase();
      if (this.emails.length && !this.emails.includes(email)) return null;
      return email || "service-token";
    } catch {
      return null; // malformed token or certs unreachable → deny
    }
  }
}

async function fetchCerts(team: string): Promise<Jwk[]> {
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`certs ${res.status}`);
  return ((await res.json()) as { keys: Jwk[] }).keys;
}

const b64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
