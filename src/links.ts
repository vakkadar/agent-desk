// Related threads, from what the desk already records (no extra bookkeeping):
//   "started from" - a thread created from another (ThreadRec.from: design-1 -> code-2)
//   "mail"         - a thread sent mail to another (prompt that starts "[mail from code-2]")
//   "mentions"     - your message in one thread names another ("like design-1 said")
// Links are per project and undirected for display; each keeps its strongest reason.
import type { DeskEvent } from "./types.js";
import type { SourceRec } from "./threads.js";

export type LinkWhy = "started from" | "mail" | "mentions";
export interface Link { a: string; b: string; why: LinkWhy; count: number }

const RANK: Record<LinkWhy, number> = { "started from": 3, mail: 2, mentions: 1 };
const THREAD_REF = /\b((?:code|design)-\d+)\b/g;
export const MAIL = /^\[mail from ((?:code|design)-\d+|ask)\]/;

export const mailText = (from: string, text: string) => `[mail from ${from}] ${text}`;

export function links(rec: SourceRec, events: DeskEvent[]): Link[] {
  const out = new Map<string, Link>();
  const add = (x: string, y: string, why: LinkWhy) => {
    if (x === y || !rec.threads[x] || !rec.threads[y]) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const k = `${a}|${b}`;
    const cur = out.get(k);
    if (!cur) out.set(k, { a, b, why, count: 1 });
    else { cur.count++; if (RANK[why] > RANK[cur.why]) cur.why = why; }
  };
  for (const th of Object.values(rec.threads)) if (th.from) add(th.id, th.from, "started from");
  for (const e of events) {
    if (e.sourceId !== rec.id || e.event.kind !== "prompt") continue;
    const text = e.event.text.replace(/^\S*\[[^\]]+\]:\s*/, ""); // drop the desk's "<keyword>[code-1]: " routing tag
    const mail = text.match(MAIL);
    if (mail) { add(e.threadId, mail[1], "mail"); continue; }
    for (const m of text.matchAll(THREAD_REF)) add(e.threadId, m[1], "mentions");
  }
  return [...out.values()].sort((x, y) => RANK[y.why] - RANK[x.why] || y.count - x.count);
}

/** Threads related to one thread, strongest first. */
export function relatedOf(all: Link[], threadId: string): { id: string; why: LinkWhy; count: number }[] {
  return all.filter((l) => l.a === threadId || l.b === threadId).map((l) => ({ id: l.a === threadId ? l.b : l.a, why: l.why, count: l.count }));
}
