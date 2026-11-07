// Notes recorder (FR-8, §5): EventBus -> notes/activity/YYYY-MM-DD.jsonl + notes/YYYY-MM-DD.md
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventBus } from "./events/bus.js";
import type { DeskEvent } from "./types.js";

export type NoteKind = "prompt" | "response" | "tool" | "approval" | "commit" | "note";

export interface NoteRow {
  schema: 1;
  ts: string;
  source_id: string;
  thread_id: string;
  mode: string;
  agent: string;
  kind: NoteKind;
  prompt?: string;
  summary?: string;
  files_changed?: string[];
  tokens_in?: number;
  tokens_out?: number;
  cost?: number;
  duration_ms?: number;
  outcome?: string;
  tool?: string;
  approval_id?: string;
  detail?: string;
}

interface Turn {
  prompt: string; start: number; text: string; files: Set<string>;
  tin: number; tout: number; cost?: number;
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const day = (ts: string) => ts.slice(0, 10);
const modeOf = (t: string) => (t === "ask" ? "ask" : t.split("-")[0]);

export function summarize(text: string, max = 280): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export class NotesRecorder {
  private turns = new Map<string, Turn>();
  private queue: Promise<void> = Promise.resolve();
  onTurnEnd: (row: NoteRow) => void = () => {};
  private unsub = () => {};

  constructor(private dataDir: string, private agent = "claude") {}

  attach(bus: EventBus): void { this.unsub = bus.subscribe((e) => this.handle(e)); }
  detach(): void { this.unsub(); }
  flush(): Promise<void> { return this.queue; }

  private base(e: DeskEvent, kind: NoteKind): NoteRow {
    return { schema: 1, ts: e.ts, source_id: e.sourceId, thread_id: e.threadId, mode: modeOf(e.threadId), agent: this.agent, kind };
  }

  handle(e: DeskEvent): void {
    const key = `${e.sourceId}/${e.threadId}`;
    const ev = e.event;
    let t = this.turns.get(key);
    if (ev.kind === "prompt") {
      this.turns.set(key, { prompt: ev.text, start: Date.parse(e.ts), text: "", files: new Set(), tin: 0, tout: 0 });
      this.write({ ...this.base(e, "prompt"), prompt: ev.text });
      return;
    }
    if (!t) { t = { prompt: "", start: Date.parse(e.ts), text: "", files: new Set(), tin: 0, tout: 0 }; this.turns.set(key, t); }
    switch (ev.kind) {
      case "text": t.text += ev.text; break;
      case "tool_call": {
        const inp: any = ev.input;
        const f = inp?.file_path ?? inp?.path ?? inp?.notebook_path;
        if (FILE_TOOLS.has(ev.name) && typeof f === "string") t.files.add(f);
        this.write({ ...this.base(e, "tool"), tool: ev.name, detail: summarize(typeof inp === "string" ? inp : JSON.stringify(inp ?? {}), 200) });
        break;
      }
      case "approval_request":
        this.write({ ...this.base(e, "approval"), tool: ev.tool, detail: summarize(JSON.stringify(ev.input ?? {}), 200), approval_id: ev.id, outcome: "requested" });
        break;
      case "approval_result":
        this.write({ ...this.base(e, "approval"), approval_id: ev.id, detail: `by ${ev.by}`, outcome: ev.decision });
        break;
      case "usage":
        t.tin += ev.tokensIn; t.tout += ev.tokensOut;
        if (ev.costUsd !== undefined) t.cost = (t.cost ?? 0) + ev.costUsd;
        break;
      case "done": {
        const row: NoteRow = {
          ...this.base(e, "response"), prompt: t.prompt, summary: summarize(t.text), files_changed: [...t.files],
          tokens_in: t.tin, tokens_out: t.tout, cost: t.cost, duration_ms: Math.max(0, Date.parse(e.ts) - t.start),
          outcome: ev.outcome + (ev.error ? `: ${summarize(ev.error, 120)}` : ""),
        };
        this.turns.delete(key);
        this.write(row, true);
        break;
      }
    }
  }

  /** Record a free-form note/commit row (not tied to a bus event). */
  record(kind: "note" | "commit", summary: string, extra: Partial<NoteRow> = {}): void {
    this.write({ schema: 1, ts: new Date().toISOString(), source_id: "", thread_id: "", mode: "", agent: this.agent, kind, summary, ...extra });
  }

  private write(row: NoteRow, turnEnd = false): void {
    this.queue = this.queue
      .then(async () => {
        const dir = join(this.dataDir, "notes", "activity");
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, `${day(row.ts)}.jsonl`), JSON.stringify(row) + "\n");
        if (turnEnd) await this.renderMarkdown(day(row.ts));
      })
      .catch((e) => console.error("[notes]", e.message))
      .then(() => { if (turnEnd) this.onTurnEnd(row); });
  }

  async renderMarkdown(date: string): Promise<void> {
    const rows = await readNotes(this.dataDir, date);
    await writeFile(join(this.dataDir, "notes", `${date}.md`), toMarkdown(date, rows));
  }
}

export async function readNotes(dataDir: string, date: string): Promise<NoteRow[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("bad date");
  let text = "";
  try { text = await readFile(join(dataDir, "notes", "activity", `${date}.jsonl`), "utf8"); }
  catch (e: any) { if (e.code !== "ENOENT") throw e; }
  const out: NoteRow[] = [];
  for (const l of text.split("\n")) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* skip torn line */ } }
  return out;
}

export function toMarkdown(date: string, rows: NoteRow[]): string {
  const lines = [`# Activity ${date}`, ""];
  for (const r of rows) {
    const time = r.ts.slice(11, 19);
    const where = r.source_id ? `${r.source_id}/${r.thread_id}` : "desk";
    switch (r.kind) {
      case "response": {
        const meta = [r.outcome, r.duration_ms !== undefined ? `${(r.duration_ms / 1000).toFixed(1)}s` : "",
          `${r.tokens_in ?? 0}/${r.tokens_out ?? 0} tok`, r.cost !== undefined ? `$${r.cost.toFixed(4)}` : ""].filter(Boolean).join(", ");
        lines.push(`## ${time} ${where}`, "", `**Prompt:** ${summarize(r.prompt ?? "", 400)}`, "", `**Response:** ${r.summary ?? ""}`, "");
        if (r.files_changed?.length) lines.push(`Files: ${r.files_changed.map((f) => "`" + f + "`").join(", ")}`, "");
        lines.push(`_${meta}_`, "");
        break;
      }
      case "commit": case "note": lines.push(`- ${time} **${r.kind}**: ${r.summary ?? ""}`, ""); break;
      default: break; // prompt/tool/approval live in JSONL; the md is the digest
    }
  }
  return lines.join("\n");
}
