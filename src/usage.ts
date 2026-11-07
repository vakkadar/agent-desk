// Usage aggregation (FR-9) over journal events.
import { readFile } from "node:fs/promises";
import type { DeskEvent } from "./types.js";

export type UsageRange = "today" | "7d" | "all";
export interface UsageRow { sourceId: string; threadId: string; tokensIn: number; tokensOut: number; costUsd: number; turns: number }

export async function readJournal(path: string): Promise<DeskEvent[]> {
  let text = "";
  try { text = await readFile(path, "utf8"); } catch { return []; }
  const out: DeskEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}

function since(range: UsageRange, now: Date): number {
  if (range === "7d") return now.getTime() - 7 * 86_400_000;
  if (range === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return 0;
}

export function aggregateUsage(events: DeskEvent[], range: UsageRange = "all", now = new Date()) {
  const min = since(range, now);
  const map = new Map<string, UsageRow>();
  const total = { tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 };
  for (const e of events) {
    if (e.event.kind !== "usage" || Date.parse(e.ts) < min) continue;
    const key = `${e.sourceId}\0${e.threadId}`;
    let r = map.get(key);
    if (!r) map.set(key, (r = { sourceId: e.sourceId, threadId: e.threadId, tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 }));
    for (const t of [r, total]) {
      t.tokensIn += e.event.tokensIn;
      t.tokensOut += e.event.tokensOut;
      t.costUsd += e.event.costUsd ?? 0;
      t.turns++;
    }
  }
  const rows = [...map.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.threadId.localeCompare(b.threadId));
  return { range, rows, total };
}
