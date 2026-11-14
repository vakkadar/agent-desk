// Skeptic pass: before the reviewer sees a diff, the builder re-reads its own changes as a skeptic
// and fixes what is really wrong. The reviewer then starts from a diff with the cheap bugs gone.
//   "Review now"  → desk writes .desk/skeptic.json {"state":"pending"} and briefs the builder
//   builder done  → sets "state":"done" (+ "checked", "fixed")
//   desk (relay)  → briefs the reviewer, with the builder's own list, and sets "state":"sent"
// A builder that never finishes does not block the review: after SKEPTIC_WAIT_MS it goes on anyway.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SKEPTIC_WAIT_MS = 20 * 60_000;

export interface Skeptic { state: "pending" | "done" | "sent"; askedAt?: string; checked?: string[]; fixed?: string[]; note?: string }

export const skepticPath = (verdict: string) => join(dirname(verdict), "skeptic.json");

const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.slice(0, 300)).slice(0, 20) : undefined);

/** Parse the builder-written file; never throws. */
export function parseSkeptic(raw: string): Skeptic | null {
  let j: any;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || !["pending", "done", "sent"].includes(j.state)) return null;
  const s: Skeptic = { state: j.state };
  if (typeof j.askedAt === "string") s.askedAt = j.askedAt.slice(0, 40);
  const c = list(j.checked), f = list(j.fixed);
  if (c) s.checked = c;
  if (f) s.fixed = f;
  if (typeof j.note === "string") s.note = j.note.slice(0, 500);
  return s;
}

const one = (s: string) => s.replace(/\s+/g, " ").trim(); // typed into a TUI: a newline would submit early

/** What the builder pane is told. */
export function skepticBrief(threadId: string, path: string, base: string): string {
  const b = base.slice(0, 12);
  return one(`Before the reviewer sees ${threadId}, do a skeptic pass on your own changes (git diff ${b}).
    Assume there is at least one bug: check edge cases (empty, missing, huge, concurrent), error paths, what callers expect,
    and whether the tests really exercise the change. Fix what is really wrong and run the tests; do not refactor or add features.
    When finished, write ${path} as JSON: {"state": "done", "checked": ["what you looked at"], "fixed": ["what you changed and why"]}.
    The desk then hands the diff to the reviewer.`);
}

/** What the reviewer is told about the builder's pass (empty when there was none). */
export function skepticNote(s: Skeptic | null, timedOut = false): string {
  if (timedOut) return "The builder's self-check did not finish in time; review everything.";
  if (!s || s.state === "pending") return "";
  const fixed = s.fixed?.length ? `it says it fixed: ${s.fixed.join("; ")}` : "it says it found nothing to fix";
  return one(`The builder already did a self-check (${fixed}). Do not take that on trust: check those fixes too and review the whole diff.`);
}

export async function askSkeptic(path: string, now = new Date()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ state: "pending", askedAt: now.toISOString() }) + "\n");
}

export async function readSkeptic(path: string): Promise<Skeptic | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
  return raw == null ? null : parseSkeptic(raw);
}

/** Should the reviewer be briefed now? "go" with the note to add, or "wait". */
export function skepticStep(s: Skeptic | null, now = Date.now()): { go: false } | { go: true; note: string } {
  if (!s || s.state === "sent") return { go: false };
  if (s.state === "done") return { go: true, note: skepticNote(s) };
  const at = s.askedAt ? Date.parse(s.askedAt) : NaN;
  if (Number.isFinite(at) && now - at >= SKEPTIC_WAIT_MS) return { go: true, note: skepticNote(s, true) };
  return { go: false };
}

export async function markSkepticSent(path: string, s: Skeptic): Promise<void> {
  await writeFile(path, JSON.stringify({ ...s, state: "sent" }) + "\n");
}
