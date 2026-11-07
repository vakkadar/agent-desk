// Event bus with monotonic seq + replay (RH-3). Persists to an append-only JSONL
// journal so seq and history survive restarts.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeskEvent } from "../types.js";

type Listener = (e: DeskEvent) => void;

export class EventBus {
  private seq = 0;
  private recent: DeskEvent[] = []; // in-memory tail for fast replay
  private listeners = new Set<Listener>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private journalPath: string, private keep = 5000) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.journalPath), { recursive: true });
    let text = "";
    try {
      text = await readFile(this.journalPath, "utf8");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      const ev = JSON.parse(line) as DeskEvent;
      this.seq = Math.max(this.seq, ev.seq);
      this.recent.push(ev);
    }
    this.recent = this.recent.slice(-this.keep);
  }

  publish(e: Omit<DeskEvent, "seq" | "ts">): DeskEvent {
    const ev: DeskEvent = { seq: ++this.seq, ts: new Date().toISOString(), ...e };
    this.recent.push(ev);
    if (this.recent.length > this.keep) this.recent.shift();
    // Serialize writes so journal order matches seq order.
    this.writing = this.writing.then(() => appendFile(this.journalPath, JSON.stringify(ev) + "\n"));
    for (const l of this.listeners) l(ev);
    return ev;
  }

  /** Events with seq > lastSeq still held in memory. */
  since(lastSeq: number): DeskEvent[] {
    return this.recent.filter((e) => e.seq > lastSeq);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  flush(): Promise<void> {
    return this.writing;
  }
}
