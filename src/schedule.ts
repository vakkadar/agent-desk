// Scheduled prompts ([[schedule]] in desk.toml): parse, next-run maths, and a small ticker.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validModel } from "./models.js";

export interface Schedule {
  name: string;
  at?: number; // minutes after local midnight (daily, or on `days`)
  days?: number[]; // 0=sun .. 6=sat; empty = every day
  every?: number; // ms between runs
  source: string; // "general" or a project source id
  prompt: string;
  model?: string; // Claude model for this run; else [model] schedule
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "30m", "6h", "2d" → ms. */
export function parseEvery(s: string): number {
  const m = /^(\d+)\s*([mhd])$/i.exec(s.trim());
  if (!m || !Number(m[1])) throw new Error(`bad every "${s}" (use 30m, 6h, 1d)`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "m"];
}

/** Validate the raw `schedule` array from desk.toml. Throws on the first bad entry. */
export function parseSchedules(raw: unknown): Schedule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("schedule must be [[schedule]] tables");
  const names = new Set<string>();
  return raw.map((r: any, i) => {
    const name = String(r?.name ?? "").trim();
    const where = `schedule #${i + 1}${name ? ` "${name}"` : ""}`;
    if (!name) throw new Error(`${where}: name required`);
    if (names.has(name)) throw new Error(`${where}: duplicate name`);
    names.add(name);
    const prompt = String(r.prompt ?? "").trim();
    if (!prompt) throw new Error(`${where}: prompt required`);
    if ((r.at === undefined) === (r.every === undefined)) throw new Error(`${where}: set exactly one of at / every`);
    const s: Schedule = { name, source: String(r.source ?? "general"), prompt };
    if (r.model !== undefined) {
      if (!validModel(String(r.model).trim())) throw new Error(`${where}: bad model "${r.model}"`);
      s.model = String(r.model).trim();
    }
    if (r.at !== undefined) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(r.at));
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`${where}: bad at "${r.at}" (use HH:MM)`);
      s.at = Number(m[1]) * 60 + Number(m[2]);
      s.days = (r.days ?? []).map((d: string) => {
        const n = DAYS.indexOf(String(d).slice(0, 3).toLowerCase());
        if (n < 0) throw new Error(`${where}: bad day "${d}"`);
        return n;
      });
    } else {
      if (r.days) throw new Error(`${where}: days only works with at`);
      s.every = parseEvery(String(r.every));
    }
    return s;
  });
}

/**
 * First run strictly after `after`. `at`: next matching local wall-clock time (built from
 * calendar fields, so DST shifts keep 07:30 at 07:30). `every`: after + interval.
 */
export function nextRun(s: Schedule, after: Date): Date {
  if (s.every) return new Date(after.getTime() + s.every);
  const h = Math.floor(s.at! / 60), min = s.at! % 60;
  for (let i = 0; i <= 8; i++) {
    const t = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i, h, min);
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i).getDay();
    if (t > after && (!s.days?.length || s.days.includes(day))) return t;
  }
  throw new Error("no next run"); // unreachable: a matching day is within 7 days
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Title for a General question: "⏰ morning · 2026-11-07" (with time for `every`). */
export function scheduleTitle(s: Schedule, now = new Date()): string {
  const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `⏰ ${s.name} · ${d}${s.every ? ` ${pad(now.getHours())}:${pad(now.getMinutes())}` : ""}`;
}

export interface ScheduleRow { name: string; source: string; next: string; last?: string; running: boolean }

export class Scheduler {
  private last: Record<string, string> = {};
  private next = new Map<string, Date>();
  private running = new Set<string>();
  private timer?: NodeJS.Timeout;
  constructor(
    private list: Schedule[],
    private stateFile: string,
    private run: (s: Schedule) => Promise<void>,
    private now: () => Date = () => new Date(),
  ) {}

  async start(tickMs = 15_000) {
    try { this.last = JSON.parse(await readFile(this.stateFile, "utf8")); } catch { /* first run */ }
    for (const s of this.list) this.next.set(s.name, this.plan(s));
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }

  /** First slot after now; for `every`, last+interval if still ahead. Missed slots are not caught up. */
  private plan(s: Schedule): Date {
    const now = this.now(), last = this.last[s.name] ? new Date(this.last[s.name]) : undefined;
    const due = s.every && last ? nextRun(s, last) : undefined;
    return due && due > now ? due : nextRun(s, now);
  }

  async tick() {
    const now = this.now();
    for (const s of this.list) {
      if (now < this.next.get(s.name)!) continue;
      this.next.set(s.name, nextRun(s, now));
      void this.fire(s);
    }
  }

  /** Run now (UI button). Returns false when the previous run is still busy. */
  runNow(name: string): boolean {
    const s = this.list.find((x) => x.name === name);
    if (!s) throw new Error(`no schedule "${name}"`);
    if (this.running.has(name)) return false;
    void this.fire(s);
    return true;
  }

  /** Start a run in the background (a long turn never blocks the ticker). */
  private async fire(s: Schedule) {
    if (this.running.has(s.name)) return console.warn(`[schedule] ${s.name}: previous run still busy, skipped`);
    this.running.add(s.name);
    this.last[s.name] = this.now().toISOString();
    try {
      await mkdir(dirname(this.stateFile), { recursive: true });
      await writeFile(this.stateFile, JSON.stringify(this.last, null, 1));
    } catch (e: any) {
      console.warn(`[schedule] ${s.name}: state not saved:`, e.message);
    }
    void this.run(s)
      .catch((e: any) => console.warn(`[schedule] ${s.name}:`, e.message))
      .finally(() => this.running.delete(s.name));
  }

  rows(): ScheduleRow[] {
    return this.list.map((s) => ({ name: s.name, source: s.source, next: this.next.get(s.name)!.toISOString(), last: this.last[s.name], running: this.running.has(s.name) }));
  }
}
