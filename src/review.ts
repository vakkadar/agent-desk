// Review line from the reviewer's verdict file. The reviewer (the pair's second pane) writes
//   <thread worktree>/.desk/review.json     (or <project>/.desk/<thread>/review.json without one)
// and the builder's turn shows one expandable line built from it. Rules:
//   - a finding counts as fixed only when the reviewer re-checked it ("verified"); the builder
//     saying it fixed something ("claimed") is not enough
//   - only disputed findings come to you (Needs you)
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type FindingStatus = "open" | "claimed" | "verified" | "disputed" | "wontfix";
export type Severity = "high" | "medium" | "low";

export interface Finding { id: string; severity: Severity; file?: string; line?: number; text: string; status: FindingStatus; note?: string }
export interface Verdict { round: number; reviewer: string; updatedAt?: string; findings: Finding[] }

export interface ReviewLine {
  state: "none" | "clean" | "open" | "disputed";
  round: number;
  reviewer: string;
  total: number;
  fixed: number; // verified by the reviewer
  claimed: number; // builder says fixed, reviewer hasn't re-checked
  open: number;
  disputed: number;
  text: string; // the one line shown in the builder's turn
  needsYou: Finding[]; // disputed ones
  findings: Finding[]; // the expanded list
}

export function verdictPath(location: string, threadId: string, worktree?: string): string {
  return worktree ? join(worktree, ".desk", "review.json") : join(location, ".desk", threadId, "review.json");
}

const STATUSES: FindingStatus[] = ["open", "claimed", "verified", "disputed", "wontfix"];
const SEVERITIES: Severity[] = ["high", "medium", "low"];
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** Parse an untrusted verdict file: unknown fields dropped, bad values coerced, never throws. */
export function parseVerdict(raw: string): Verdict | null {
  let j: any;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || !Array.isArray(j.findings)) return null;
  const findings: Finding[] = j.findings.slice(0, 200).filter((f: any) => f && typeof f === "object").map((f: any, i: number) => ({
    id: str(f.id, 20) || `F${i + 1}`,
    severity: SEVERITIES.includes(f.severity) ? f.severity : "medium",
    file: str(f.file, 300),
    line: Number.isInteger(f.line) && f.line > 0 ? f.line : undefined,
    text: str(f.text, 2000) ?? "",
    status: STATUSES.includes(f.status) ? f.status : "open",
    note: str(f.note, 2000),
  }));
  return { round: Number.isInteger(j.round) && j.round > 0 ? j.round : 1, reviewer: str(j.reviewer, 40) || "reviewer", updatedAt: str(j.updatedAt, 40), findings };
}

export function reviewLine(v: Verdict | null): ReviewLine {
  if (!v) return { state: "none", round: 0, reviewer: "", total: 0, fixed: 0, claimed: 0, open: 0, disputed: 0, text: "Review: not started", needsYou: [], findings: [] };
  const live = v.findings.filter((f) => f.status !== "wontfix");
  const n = (s: FindingStatus) => live.filter((f) => f.status === s).length;
  const fixed = n("verified"), claimed = n("claimed"), open = n("open"), disputed = n("disputed");
  const state = disputed ? "disputed" : open + claimed ? "open" : "clean";
  const parts = [
    fixed && `${fixed} fixed`,
    claimed && `${claimed} to re-check`,
    open && `${open} open`,
    disputed && `${disputed} disputed → you`,
  ].filter(Boolean);
  const text = live.length === 0 ? `Review r${v.round} (${v.reviewer}): no findings`
    : state === "clean" ? `Review r${v.round} (${v.reviewer}): ${live.length} found, all fixed and re-checked`
    : `Review r${v.round} (${v.reviewer}): ${live.length} found · ${parts.join(" · ")}`;
  return { state, round: v.round, reviewer: v.reviewer, total: live.length, fixed, claimed, open, disputed, text, needsYou: live.filter((f) => f.status === "disputed"), findings: v.findings };
}

export async function readReview(location: string, threadId: string, worktree?: string): Promise<ReviewLine> {
  const raw = await readFile(verdictPath(location, threadId, worktree), "utf8").catch(() => null);
  return reviewLine(raw == null ? null : parseVerdict(raw));
}

/** What the reviewer pane is told: review the builder's changes adversarially and keep the verdict file. */
export function reviewerBrief(threadId: string, path: string, base: string): string {
  return [
    `You are the adversarial reviewer for ${threadId}. Review the builder's changes since ${base.slice(0, 12)} (git diff ${base.slice(0, 12)}).`,
    `Write your verdict to ${path} as JSON: {"round": N, "reviewer": "<you>", "findings": [{"id": "F1", "severity": "high|medium|low", "file": "...", "line": 1, "text": "...", "status": "open"}]}.`,
    `The desk passes your open findings to the builder and tells you when the builder marks one "claimed"; re-check it yourself and only then set "verified".`,
    `If you and the builder disagree after one exchange, set "disputed" with a short "note" for the user. Never edit code yourself.`,
  ].join(" "); // one line: a newline typed into the pane's TUI would submit early
}
