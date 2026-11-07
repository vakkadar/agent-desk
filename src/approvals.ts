// Pending tool-permission requests (FR-14, RH-4). State lives on the event bus so
// browser disconnects/reloads replay the open cards; resolution is also an event.
import { randomUUID } from "node:crypto";
import type { EventBus } from "./events/bus.js";

export interface Decision {
  allow: boolean;
  by: string;
}

interface Pending {
  sourceId: string;
  threadId: string;
  resolve: (d: Decision) => void;
  timer: NodeJS.Timeout;
}

export class Approvals {
  private pending = new Map<string, Pending>();

  /** timeoutMs(threadId) → ms before auto-deny (per-mode, from config). */
  constructor(private bus: EventBus, private timeoutMs: (threadId: string) => number) {}

  request(sourceId: string, threadId: string, tool: string, input: unknown): Promise<Decision> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolve(id, false, "timeout"), this.timeoutMs(threadId));
      timer.unref();
      this.pending.set(id, { sourceId, threadId, resolve, timer });
      this.bus.publish({ sourceId, threadId, event: { kind: "approval_request", id, tool, input } });
    });
  }

  /** Returns false if id unknown or already resolved. */
  resolve(id: string, allow: boolean, by: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    this.bus.publish({
      sourceId: p.sourceId,
      threadId: p.threadId,
      event: { kind: "approval_result", id, decision: allow ? "allow" : "deny", by },
    });
    p.resolve({ allow, by });
    return true;
  }
}
