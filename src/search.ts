// Full-text search over the event journal (FR-10). In-memory scan.
import type { DeskEvent } from "./types.js";

export interface Hit { sourceId: string; threadId: string; seq: number; ts: string; kind: string; snippet: string; start: number; len: number }

function textOf(e: DeskEvent): { kind: string; text: string } | null {
  const ev: any = e.event;
  switch (ev.kind) {
    case "prompt": case "text": return { kind: ev.kind, text: String(ev.text ?? "") };
    case "tool_call": return { kind: "tool", text: `${ev.name} ${JSON.stringify(ev.input ?? "")}` };
    case "tool_result": return { kind: "tool", text: String(ev.output ?? "") };
    default: return null;
  }
}

/** Newest first, up to `limit`. snippet is plain text; match is [start, start+len) within it. */
export function searchEvents(events: DeskEvent[], q: string, limit = 100, ctx = 60): Hit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits: Hit[] = [];
  for (let i = events.length - 1; i >= 0 && hits.length < limit; i--) {
    const e = events[i];
    const t = textOf(e);
    if (!t) continue;
    const at = t.text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const from = Math.max(0, at - ctx);
    const to = Math.min(t.text.length, at + needle.length + ctx);
    const pre = from > 0 ? "…" : "";
    const snippet = pre + t.text.slice(from, to).replace(/\s+/g, " ") + (to < t.text.length ? "…" : "");
    const start = pre.length + t.text.slice(from, at).replace(/\s+/g, " ").length;
    hits.push({ sourceId: e.sourceId, threadId: e.threadId, seq: e.seq, ts: e.ts, kind: t.kind, snippet, start, len: needle.length });
  }
  return hits;
}
