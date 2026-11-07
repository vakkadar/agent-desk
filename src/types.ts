// Core domain types and adapter contracts. See ARCHITECTURE.md §4–5.

export type Role = "action" | "readonly";
export type Mode = "ask" | "design" | "code";
export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";

export interface SessionRef {
  agent: string; // "claude" | "codex" | ...
  sessionId: string; // agent-native session id (used for --resume after reboot); "" until first turn of a fork
  forkFrom?: string; // parent session id; consumed on first send
  started?: boolean; // a turn has run; next send must --resume (set by the adapter)
  cwd: string;
  pane?: PaneRef; // set when a mux owns the process
}

export interface PaneRef {
  mux: string; // "herdr" | "tmux" | "none"
  id: string; // e.g. herdr "w1:p1"
  agentName?: string; // herdr live agent name
}

/** Normalized event emitted by agent adapters. */
export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; output: string; isError?: boolean }
  | { kind: "approval_request"; id: string; tool: string; input: unknown }
  | { kind: "approval_result"; id: string; decision: "allow" | "deny"; by: string }
  | { kind: "state"; state: AgentState }
  | { kind: "usage"; tokensIn: number; tokensOut: number; costUsd?: number }
  | { kind: "done"; outcome: "ok" | "error" | "cancelled"; error?: string };

/** Event as stored and broadcast: carries a monotonic seq for replay (RH-3). */
export interface DeskEvent {
  seq: number;
  ts: string; // ISO
  sourceId: string;
  threadId: string; // "ask" | "design-N" | "code-N"
  event: AgentEvent | { kind: "prompt"; text: string };
}

export interface StartOpts {
  cwd: string;
  name: string; // thread-scoped name, e.g. "src1-design-2"
}

export interface Capabilities {
  mcpServers: string[];
  canFork: boolean;
}

export interface AgentAdapter {
  id: string;
  capabilities(cwd: string): Promise<Capabilities>;
  start(opts: StartOpts): Promise<SessionRef>;
  resume(ref: SessionRef): Promise<SessionRef>;
  fork(ref: SessionRef, name: string): Promise<SessionRef>;
  send(ref: SessionRef, text: string, ctx?: { sourceId: string; threadId: string }): AsyncIterable<AgentEvent>;
  approve(ref: SessionRef, reqId: string, allow: boolean): Promise<void>;
}

export interface MuxAdapter {
  id: string;
  available(): Promise<boolean>;
  spawn(name: string, cmd: string[], cwd: string): Promise<PaneRef>;
  write(p: PaneRef, data: string): Promise<void>;
  read(p: PaneRef): Promise<string>;
  state?(p: PaneRef): Promise<AgentState>;
  list(): Promise<PaneRef[]>;
}
