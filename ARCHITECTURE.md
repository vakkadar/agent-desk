# agent-desk — Architecture

Status: draft v0.1 (2026-11-07). See REQUIREMENTS.md.

## 1. Overview

```
Browser SPA (Vite + TS, xterm.js fallback)
   │  HTTPS/WS  (role: action | read-only)
agent-desk server (Node + TS)
   ├─ Net guard        bind, IP/CIDR allowlists, tailscale identity, tokens, Origin
   ├─ Thread manager   sources, base sessions, forks, worktrees
   ├─ Mode registry    YAML modes → prompt template + permissions
   ├─ Event bus        every turn/tool/approval → event
   │    ├─ Log writer  markdown logs per thread
   │    ├─ Notes       activity JSONL
   │    ├─ Indexer     SQLite FTS (search, usage)
   │    └─ Git sync    batched auto-commit to desk data repo
   ├─ Agent adapters   claude (v1) │ codex │ cursor
   └─ Mux adapters     herdr (v1) │ tmux │ zellij │ none
```

## 2. Data flow (one turn)

1. Browser (action role) sends `{source, thread, text}` over WS.
2. Server prefixes `browser[design-2]: text` (keyword configurable).
3. Thread manager resolves agent session (base or fork); agent adapter sends prompt.
4. Adapter streams structured events (text chunk, tool call, approval request, done).
5. Event bus fans out: WS clients (all roles), log writer, notes, indexer.
6. On turn done: git sync commits (batched).

## 3. Desk data repo layout

```
~/agent-desk-data/              (git repo)
  desk.toml                     config (no secrets)
  sources/<source-id>/
    source.json                 kind, location, agent, base session id
    ask/log.md
    design/<design-N>/log.md
    design/<design-N>/artifacts/
    code/<code-N>/log.md        + branch/worktree ref, linked design
  notes/
    activity/YYYY-MM-DD.jsonl   append-only, schema-versioned
    YYYY-MM-DD.md               generated human view
    manual/                     hand-written notes
  .index/                       SQLite (gitignored, rebuildable)
```

## 4. Agent adapter interface

```ts
interface AgentAdapter {
  id: string;                                   // "claude" | "codex" | ...
  capabilities(cwd: string): Promise<Capabilities>; // tools, MCP servers
  start(opts: StartOpts): Promise<SessionRef>;
  resume(ref: SessionRef): Promise<SessionRef>;
  fork(ref: SessionRef): Promise<SessionRef>;
  send(ref: SessionRef, text: string): AsyncIterable<AgentEvent>;
  approve(ref: SessionRef, reqId: string, allow: boolean): Promise<void>;
  transcripts(): AsyncIterable<TranscriptRecord>;  // for search/usage backfill
}
```

Transport preference: ACP → agent headless JSON stream → (last resort) mux screen read.
Claude fork: `--resume <id> --fork-session`.

## 5. Mux adapter interface

```ts
interface MuxAdapter {
  id: string;                                   // "herdr" | "tmux" | "none"
  ensureSession(name: string): Promise<void>;
  spawn(name: string, cmd: string[], cwd: string): Promise<PaneRef>;
  attachStream(p: PaneRef): AsyncIterable<Uint8Array>;  // raw terminal view
  write(p: PaneRef, data: string): Promise<void>;
  state?(p: PaneRef): Promise<"idle"|"working"|"blocked"|"done">;
  list(): Promise<PaneRef[]>;
}
```

Mux gives persistence + raw attach; structured data comes from the agent adapter.
The herdr 0.9.1 CLI was checked on 2026-11-07. It returns JSON and uses opaque, stable IDs (`w1`, `w1:t1`, `w1:p1`):

- `workspace` / `tab` / `pane` handle layout: `pane split --cwd`, list, read and write.
- `agent start|prompt [--wait --timeout]|list` work with live agent names. Agent state is one of `idle|working|blocked|done|unknown`, where `blocked` means an approval or question UI is showing.
- `worktree` manages git worktrees, which fits code-N threads.
- `--machine <profile>` controls a remote herdr server over SSH. This is a fallback way to drive the HP from the laptop.

Plan:

- herdr owns the process and the persistence.
- `agent` state drives the badges in the UI.
- Structured turn content comes from Claude's transcript JSONL or stream-json, not from scraping the screen.
- The calls need a running `herdr server`. The `HERDR_ENV` check applies only to agents inside panes, not to an outside controller like agent-desk.

## 6. Network guard

- Listeners from `network.bind` (default `127.0.0.1`; add tailscale IP explicitly).
- Per connection: remote IP → match `action_allow` / `readonly_allow` (CIDR).
- Tailscale identity optional: `tailscale whois <ip>` → login → allow list by user.
- Action role requires token; read-only token optional.
- Read-only connections: server drops any mutating message; never trust client.

## 6a. Deployment (remote host)

```
HP desktop (home, tailnet)
  systemd --user (linger)
    herdr-server.service    herdr server        ← owns agent processes
    agent-desk.service      node server         ← restartable, stateless re-attach
  tailscaled (boot)  ── tailnet ──  laptop/phone (India)
```

- Event log has a monotonic `seq`. The client sends `resume{lastSeq}` and the server
  replays from SQLite or JSONL.
- On boot, agent-desk reads `source.json` and does the following for each open thread:
  - ensures a herdr pane exists;
  - otherwise resumes the agent with the stored session id.
- `agent-desk doctor` validates the RH-6 checklist.

## 7. Git sync

- Debounced commit (e.g. 10 s after last event, or on thread close).
- Pre-commit secret scan (gitleaks-style rules); redact + flag event.
- Push only if `git.remote` configured.

## 8. Stack

Node 22 + TypeScript, `ws`, `node-pty`, `better-sqlite3`, Vite SPA, xterm.js,
markdown-it. License: Apache-2.0 (proposed).
