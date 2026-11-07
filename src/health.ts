// Health provider registry (RH-7). Other modules plug in via registerHealth().
import { statfs } from "node:fs/promises";
import { execFile } from "node:child_process";

export type HealthLevel = "ok" | "warn" | "fail" | "unknown";
export interface HealthItem { level: HealthLevel; detail?: string; [k: string]: unknown }
export type HealthFn = () => Promise<HealthItem | Record<string, unknown>> | HealthItem | Record<string, unknown>;

const providers = new Map<string, HealthFn>();
export function registerHealth(name: string, fn: HealthFn): void { providers.set(name, fn); }

function sh(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((res, rej) => execFile(cmd, args, { timeout }, (e, out) => (e ? rej(e) : res(out))));
}

export function registerBuiltinHealth(dataDir: string): void {
  registerHealth("disk", async () => {
    const s = await statfs(dataDir);
    const free = s.bavail * s.bsize, total = s.blocks * s.bsize;
    const pct = total ? Math.round(((total - free) / total) * 100) : 0;
    return { level: free < 2 * 1024 ** 3 ? "warn" : "ok", detail: `${(free / 1024 ** 3).toFixed(1)} GB free, ${pct}% used`, free, total };
  });
  registerHealth("auth", async () => {
    try {
      const j = JSON.parse(await sh("claude", ["auth", "status"]));
      return j.loggedIn ? { level: "ok", detail: `claude logged in (${j.authMethod ?? "?"})` } : { level: "fail", detail: "claude not logged in" };
    } catch { return { level: "unknown", detail: "claude auth status unavailable" }; }
  });
  registerHealth("usageLimit", () => ({ level: "unknown", detail: "unknown" }));
}

export async function collectHealth(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await Promise.all([...providers].map(async ([name, fn]) => {
    try { out[name] = await fn(); } catch (e: any) { out[name] = { level: "unknown", detail: String(e?.message ?? e) }; }
  }));
  return out;
}
