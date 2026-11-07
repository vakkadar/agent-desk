// Claude Code adapter via headless stream-json. One process per turn; the session
// lives in Claude's own transcript store, so it survives restarts/reboots (RH-2).
import { randomUUID } from "node:crypto";
import { directSpawn, type SpawnFn } from "../mux/spawn.js";
import type { AgentAdapter, AgentEvent, Capabilities, SessionRef, StartOpts } from "../../types.js";

export interface ClaudeOpts {
  bin?: string;
  permissionMode?: string; // e.g. "acceptEdits"; interactive approvals are TODO (FR-14)
  extraArgs?: string[];
  spawnFn?: SpawnFn; // mux hook (RH-2); default = direct child process
}

export class ClaudeAgent implements AgentAdapter {
  id = "claude";
  private started = new Set<string>(); // session ids that already have a turn

  constructor(private opts: ClaudeOpts = {}) {}

  async capabilities(): Promise<Capabilities> {
    return { mcpServers: [], canFork: true }; // TODO: parse `claude mcp list`
  }

  async start(o: StartOpts): Promise<SessionRef> {
    return { agent: this.id, sessionId: randomUUID(), cwd: o.cwd };
  }

  async resume(ref: SessionRef): Promise<SessionRef> {
    this.started.add(ref.sessionId);
    return ref;
  }

  async fork(ref: SessionRef): Promise<SessionRef> {
    return { agent: this.id, sessionId: "", cwd: ref.cwd, forkFrom: ref.sessionId };
  }

  /** Builds argv for one turn. Exported for tests. */
  argsFor(ref: SessionRef, text: string): string[] {
    const a = ["-p", text, "--output-format", "stream-json", "--verbose"];
    if (ref.forkFrom) a.push("--resume", ref.forkFrom, "--fork-session");
    else if (this.started.has(ref.sessionId)) a.push("--resume", ref.sessionId);
    else a.push("--session-id", ref.sessionId);
    if (this.opts.permissionMode) a.push("--permission-mode", this.opts.permissionMode);
    return a.concat(this.opts.extraArgs ?? []);
  }

  async *send(ref: SessionRef, text: string): AsyncIterable<AgentEvent> {
    const child = (this.opts.spawnFn ?? directSpawn)(this.opts.bin ?? "claude", this.argsFor(ref, text), {
      cwd: ref.cwd,
      key: ref.sessionId || ref.forkFrom || randomUUID(),
    });
    const exited = child.exited;

    yield { kind: "state", state: "working" };
    let sawResult = false;
    for await (const line of child.lines) {
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        // Fork gets its new id here; mutate ref so caller can persist it.
        ref.sessionId = msg.session_id;
        delete ref.forkFrom;
        this.started.add(ref.sessionId);
      }
      for (const ev of mapClaudeMessage(msg)) {
        if (ev.kind === "done") sawResult = true;
        yield ev;
      }
    }
    const code = await exited;
    if (!sawResult) {
      yield { kind: "done", outcome: "error", error: `claude exited ${code}: ${child.stderr().slice(-500)}` };
    }
    yield { kind: "state", state: "idle" };
  }

  async approve(): Promise<void> {
    throw new Error("interactive approvals not implemented (FR-14)");
  }
}

/** Map one stream-json message to normalized events. Exported for tests. */
export function mapClaudeMessage(msg: any): AgentEvent[] {
  const out: AgentEvent[] = [];
  const content = msg?.message?.content;
  if (msg.type === "assistant" && Array.isArray(content)) {
    for (const c of content) {
      if (c.type === "text") out.push({ kind: "text", text: c.text });
      else if (c.type === "tool_use") out.push({ kind: "tool_call", id: c.id, name: c.name, input: c.input });
    }
  } else if (msg.type === "user" && Array.isArray(content)) {
    for (const c of content) {
      if (c.type !== "tool_result") continue;
      const output = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
      out.push({ kind: "tool_result", id: c.tool_use_id, output, isError: !!c.is_error });
    }
  } else if (msg.type === "result") {
    const u = msg.usage ?? {};
    out.push({ kind: "usage", tokensIn: u.input_tokens ?? 0, tokensOut: u.output_tokens ?? 0, costUsd: msg.total_cost_usd });
    out.push(msg.is_error
      ? { kind: "done", outcome: "error", error: String(msg.result ?? msg.subtype) }
      : { kind: "done", outcome: "ok" });
  }
  return out;
}
