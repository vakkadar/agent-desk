// Follow Claude windows in herdr as cards, also when the prompt was typed in the terminal.
// Read-only: `agent list`/`agent get`, `pane read` (to show a permission prompt), and transcript files.
// Turns the desk started itself are published by LiveClaude.send(); those transcripts are skipped here.
import type { AgentEvent } from "./types.js";
import { parseTranscript, readFrom, size, type BlockTrack, type LiveClaude, type LivePane } from "./live.js";

export type Followed = AgentEvent | { kind: "prompt"; text: string };

export class LiveFollower {
  private turn = new Map<string, boolean>(); // pane → output seen since last "done"
  private tracks = new Map<string, BlockTrack>();
  private running = false;

  constructor(
    private live: LiveClaude,
    private sources: () => { id: string; location: string }[],
    private publish: (sourceId: string, ev: Followed) => void,
    private wanted: (sourceId: string) => boolean, // false: nobody connected, or the desk is running a turn there
  ) {}

  start(ms = 4000): NodeJS.Timeout {
    const t = setInterval(() => void this.tick().catch(() => {}), ms);
    t.unref();
    return t;
  }

  async tick(): Promise<void> {
    const srcs = this.sources().filter((s) => this.wanted(s.id));
    if (this.running || !srcs.length) return;
    this.running = true;
    try {
      const panes = await this.live.listAll();
      for (const s of srcs)
        for (const p of panes.filter((x) => x.cwd === s.location)) await this.follow(s.id, p).catch(() => {});
    } finally {
      this.running = false;
    }
  }

  private async follow(sourceId: string, listed: LivePane): Promise<void> {
    const p: LivePane = { ...listed, ...(await this.live.info(listed)) };
    const file = this.live.transcript(p);
    if (!file || this.live.isOwned(file)) return;
    const key = `${sourceId}/${p.paneId}`;
    const sz = await size(file);
    const pos = this.live.offsets.get(file, sz);
    let seen = false;
    if (sz > pos) {
      const r = await readFrom(file, pos);
      this.live.offsets.set(file, pos + r.bytes);
      if (this.live.isOwned(file)) return; // a desk turn began while reading; it owns these lines now
      for (const ev of parseTranscript(r.text)) {
        this.publish(sourceId, ev);
        seen = true;
      }
    }
    if (seen) this.turn.set(key, true);
    const track = this.tracks.get(key) ?? {};
    this.tracks.set(key, track);
    for (const ev of await this.live.blockStep(p, p.status, track)) this.publish(sourceId, ev);
    // Idle again after output: the turn is over.
    if (!seen && (p.status === "idle" || p.status === "done") && this.turn.get(key)) {
      this.turn.set(key, false);
      this.publish(sourceId, { kind: "done", outcome: "ok" });
    }
  }
}
