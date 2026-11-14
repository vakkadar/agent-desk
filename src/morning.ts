// Morning note: what the last working day left behind, read from its notes (notes/activity/<day>.jsonl).
// No model is asked: it is a digest of the rows, so it is free, instant and never invents anything.
//   per thread: turns, last ask, last answer, files touched, whether the last turn failed
//   pick up:    threads whose last turn did not end ok, approvals asked and never answered
//   plus:       desk commits and hand-written notes of that day
import { readNotes, summarize, type NoteRow } from "./notes.js";

export interface MorningThread {
  sourceId: string; threadId: string; turns: number; lastAt: string;
  lastPrompt: string; lastSummary: string; files: string[]; outcome: string; cost: number;
}
export interface Morning {
  date: string | null; // the day digested; null when nothing in the look-back window
  threads: MorningThread[];
  pickUp: string[];
  notes: string[];
  commits: number;
  cost: number;
}

const LOOK_BACK = 7;

export const dayBefore = (d: string, n = 1) => {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() - n);
  return x.toISOString().slice(0, 10);
};

/** Digest one day's rows. */
export function morningOf(date: string, rows: NoteRow[]): Morning {
  const by = new Map<string, MorningThread>();
  const asked = new Map<string, NoteRow>();
  const notes: string[] = [];
  let commits = 0, cost = 0;
  for (const r of rows) {
    if (r.kind === "note") { if (r.outcome !== "secret-redacted" && r.summary) notes.push(summarize(r.summary, 200)); continue; }
    if (r.kind === "commit") { commits++; continue; }
    if (r.kind === "approval" && r.approval_id) {
      if (r.outcome === "requested") asked.set(r.approval_id, r); else asked.delete(r.approval_id);
      continue;
    }
    if (r.kind !== "response") continue;
    const k = `${r.source_id}/${r.thread_id}`;
    const t = by.get(k) ?? { sourceId: r.source_id, threadId: r.thread_id, turns: 0, lastAt: r.ts, lastPrompt: "", lastSummary: "", files: [], outcome: "", cost: 0 };
    t.turns++;
    t.lastAt = r.ts;
    t.lastPrompt = summarize(r.prompt ?? "", 160);
    t.lastSummary = summarize(r.summary ?? "", 240);
    t.outcome = r.outcome ?? "";
    for (const f of r.files_changed ?? []) if (!t.files.includes(f)) t.files.push(f);
    t.cost += r.cost ?? 0;
    cost += r.cost ?? 0;
    by.set(k, t);
  }
  const threads = [...by.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  for (const t of threads) t.files = t.files.slice(-12);
  const pickUp: string[] = [];
  for (const t of threads) {
    const o = t.outcome.split(":")[0].trim();
    if (o && o !== "ok") pickUp.push(`${t.sourceId}/${t.threadId}: last turn ended ${summarize(t.outcome, 100)}`);
  }
  for (const a of asked.values()) pickUp.push(`${a.source_id}/${a.thread_id}: ${a.tool ?? "tool"} approval never answered`);
  return { date, threads, pickUp, notes: notes.slice(-10), commits, cost };
}

/** The note for `today`: the most recent day before it that has any rows, within a week. */
export async function morningNote(dataDir: string, today: string): Promise<Morning> {
  for (let n = 1; n <= LOOK_BACK; n++) {
    const d = dayBefore(today, n);
    const rows = await readNotes(dataDir, d);
    if (rows.length) return morningOf(d, rows);
  }
  return { date: null, threads: [], pickUp: [], notes: [], commits: 0, cost: 0 };
}
