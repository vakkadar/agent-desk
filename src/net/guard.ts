// Network guard: maps a connection to a role, or rejects it. See NFR-1..6.
import { BlockList, isIPv4 } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { Role } from "../types.js";

function toBlockList(entries: string[]): BlockList {
  const bl = new BlockList();
  for (const e of entries) {
    const [addr, bits] = e.split("/");
    const type = isIPv4(addr) ? "ipv4" : "ipv6";
    if (bits !== undefined) bl.addSubnet(addr, Number(bits), type);
    else bl.addAddress(addr, type);
  }
  return bl;
}

/** Strip IPv4-mapped IPv6 prefix ("::ffff:1.2.3.4" → "1.2.3.4"). */
export function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

export interface GuardOpts {
  actionAllow: string[];
  readonlyAllow: string[];
  actionToken?: string;
}

export class Guard {
  private action: BlockList;
  private readonly: BlockList;
  constructor(private opts: GuardOpts) {
    this.action = toBlockList(opts.actionAllow);
    this.readonly = toBlockList(opts.readonlyAllow);
  }

  private has(bl: BlockList, ip: string): boolean {
    return bl.check(ip, isIPv4(ip) ? "ipv4" : "ipv6");
  }

  /**
   * Resolve role for a remote address. Action requires IP match AND a valid token
   * (when a token is configured). Falls back to read-only if allowed; else null.
   */
  roleFor(remoteIp: string, token?: string): Role | null {
    const ip = normalizeIp(remoteIp);
    if (this.has(this.action, ip) && this.tokenOk(token)) return "action";
    if (this.has(this.readonly, ip) || this.has(this.action, ip)) return "readonly";
    return null;
  }

  /**
   * Role for Cloudflare-Tunnel traffic that already passed Access. Action needs the
   * token, and a token must be configured: Access login alone gives read-only.
   */
  tunnelRole(token?: string): Role {
    return this.opts.actionToken && this.tokenOk(token) ? "action" : "readonly";
  }

  private tokenOk(token?: string): boolean {
    const want = this.opts.actionToken;
    if (!want) return true; // no token configured: IP allowlist alone (localhost default)
    if (!token) return false;
    const a = Buffer.from(token), b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
