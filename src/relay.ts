// Relay between a thread's builder and reviewer panes, through the verdict file.
// The two agents never talk to each other; the desk carries each change of a finding to the other side:
//   reviewer writes "open"      → builder is told to fix it, then mark it "claimed" (or "disputed")
//   builder marks "claimed"     → reviewer is told to re-check it, then "verified" or back to "open"
// Each (finding, status, note) is relayed once; a finding bounces at most MAX_BOUNCES times, after
// that it stays where it is for the user. What was relayed is kept next to the verdict (relay.json),
// so a restarted desk does not repeat itself.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseVerdict, verdictPath, type Finding, type Verdict } from "./review.js";
import type { Pairs } from "./pair.js";
import type { ThreadStore } from "./threads.js";

const exec = promisify(execFile);
export const MAX_BOUNCES = 3;

export interface RelayState { sent: string[]; bounces: Record<string, number> }
export interface RelayMsg { to: "builder" | "reviewer"; ids: string[]; text: string }

const key = (f: Finding) => `${f.id}:${f.status}:${f.note ?? ""}`;
const where = (f: Finding) => (f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "");
const one = (s: string) => s.replace(/\s+/g, " ").trim(); // typed into a TUI: a newline would submit early

/** Messages for findings that changed since the last relay; updates `st` for what they cover. */
export function relaySteps(v: Verdict, path: string, st: RelayState): RelayMsg[] {
  const fresh = (s: Finding["status"]) => v.findings.filter((f) => f.status === s && !st.sent.includes(key(f)) && (st.bounces[f.id] ?? 0) < MAX_BOUNCES);
  const out: RelayMsg[] = [];
  const open = fresh("open"), claimed = fresh("claimed");
  if (open.length) out.push({
    to: "builder", ids: open.map((f) => f.id),
    text: one(`The reviewer found ${open.length} issue${open.length > 1 ? "s" : ""} in your changes: ${open.map((f) => `${f.id} [${f.severity}]${where(f)} ${f.text}${f.note ? ` (reviewer: ${f.note})` : ""}`).join("; ")}.
      Fix each one, then in ${path} set that finding's "status" to "claimed" with a short "note" saying what you changed.
      If you think a finding is wrong, set "disputed" with a "note" explaining why. Change nothing else in that file.`),
  });
  if (claimed.length) out.push({
    to: "reviewer", ids: claimed.map((f) => f.id),
    text: one(`The builder says these are fixed: ${claimed.map((f) => `${f.id}${f.note ? ` (${f.note})` : ""}`).join("; ")}.
      Re-check each in the code yourself. In ${path} set "verified" when it really is fixed, or back to "open" with a "note" saying what is still wrong
      (after a second failed round use "disputed" for the user). Increase "round" by one.`),
  });
  for (const m of out) markSent(v, m, st);
  return out;
}

/** Record one message as relayed (so it is not sent again, and a builder bounce counts). */
export function markSent(v: Verdict, m: RelayMsg, st: RelayState): void {
  for (const id of m.ids) {
    const f = v.findings.find((x) => x.id === id)!;
    st.sent.push(key(f));
    if (m.to === "builder") st.bounces[id] = (st.bounces[id] ?? 0) + 1;
  }
  st.sent = st.sent.slice(-500);
}

const statePath = (verdict: string) => join(dirname(verdict), "relay.json");

async function loadState(verdict: string): Promise<RelayState> {
  try {
    const j = JSON.parse(await readFile(statePath(verdict), "utf8"));
    return { sent: Array.isArray(j.sent) ? j.sent.map(String) : [], bounces: j.bounces && typeof j.bounces === "object" ? j.bounces : {} };
  } catch { return { sent: [], bounces: {} }; }
}

/** Keep the desk's per-thread files (.desk/) out of the project's git status, locally (.git/info/exclude). */
export async function excludeDesk(repo: string): Promise<void> {
  try {
    const { stdout } = await exec("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5_000 });
    const file = join(stdout.trim(), "info", "exclude");
    const cur = await readFile(file, "utf8").catch(() => "");
    if (cur.split("\n").some((l) => l.trim() === ".desk/")) return;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + ".desk/\n");
  } catch { /* not a git repo: nothing to keep clean */ }
}

/** Every few seconds: look at each open pair tab's verdict file and relay what changed. */
export class Relay {
  private seen = new Map<string, string>(); // verdict path → last content handled
  private busy = false;
  private errs = new Map<string, string>(); // last error per verdict, logged once until it changes
  constructor(private pairs: Pairs, private store: ThreadStore, private log: (s: string) => void = console.log) {}

  start(everyMs = 5_000): void {
    setInterval(() => void this.tick(), everyMs).unref();
  }

  private async one(sourceId: string, tab: string, path: string): Promise<RelayMsg[]> {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw == null || this.seen.get(path) === raw) return [];
    const v = parseVerdict(raw);
    if (!v) return []; // half-written: try again next tick
    const st = await loadState(path);
    const msgs = relaySteps(v, path, structuredClone(st));
    for (const m of msgs) { // saved after each send: a later failure must not resend an earlier message
      await this.pairs.sendTo(sourceId, tab, m.to, m.text);
      markSent(v, m, st);
      await writeFile(statePath(path), JSON.stringify(st) + "\n");
      this.log(`[relay] ${sourceId}/${tab} → ${m.to}: ${m.ids.join(", ")}`);
    }
    this.seen.set(path, raw);
    return msgs;
  }

  async tick(): Promise<RelayMsg[]> {
    if (this.busy) return [];
    this.busy = true;
    const all: RelayMsg[] = [];
    try {
      for (const pr of this.pairs.list()) {
        const rec = this.store.get(pr.sourceId);
        if (!rec) continue;
        for (const tab of Object.keys(pr.tabs)) {
          const th = rec.threads[tab];
          if (!th) continue; // "lead" has no verdict
          const path = verdictPath(rec.location, th.id, th.worktree);
          try { all.push(...await this.one(rec.id, tab, path)); this.errs.delete(path); }
          catch (e: any) { // not marked seen: retried next tick
            if (this.errs.get(path) !== e.message) this.log(`[relay] ${rec.id}/${tab}: ${e.message}`);
            this.errs.set(path, e.message);
          }
        }
      }
    } catch (e: any) {
      this.log(`[relay] ${e.message}`);
    } finally {
      this.busy = false;
    }
    return all;
  }
}
