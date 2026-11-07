// On startup: re-attach to turns that were running in herdr when agent-desk
// stopped, and publish their remaining events (RH-2).
import { mapClaudeMessage } from "../agent/claude.js";
import type { AgentEvent } from "../../types.js";
import type { MuxHandle } from "./index.js";
import { recoverTurns } from "./hosted.js";

export async function recoverInto(
  mux: MuxHandle,
  dataDir: string,
  /** map agent session id -> where to publish; undefined = orphan (dropped) */
  locate: (sessionId: string) => { sourceId: string; threadId: string } | undefined,
  publish: (where: { sourceId: string; threadId: string }, ev: AgentEvent) => void,
): Promise<number> {
  if (!mux.herdr) return 0;
  const turns = await recoverTurns(mux.herdr, dataDir);
  for (const t of turns) {
    const where = locate(t.meta.key);
    if (!where) {
      await t.cleanup();
      continue;
    }
    void (async () => {
      let sawResult = false;
      publish(where, { kind: "state", state: "working" });
      for await (const line of t.proc.lines) {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        for (const ev of mapClaudeMessage(msg)) {
          if (ev.kind === "done") sawResult = true;
          publish(where, ev);
        }
      }
      const code = await t.proc.exited;
      if (!sawResult) {
        publish(where, { kind: "done", outcome: "error", error: `turn interrupted by restart (exit ${code}); send a message to resume the session` });
      }
      publish(where, { kind: "state", state: "idle" });
      await t.cleanup();
    })().catch((e) => console.warn("[mux] recovery failed", e));
  }
  return turns.length;
}
