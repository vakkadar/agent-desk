# agent-desk — Requirements

Status: draft v0.1 (2026-11-07)

## 1. Problem

Running coding agents (Claude Code, Codex, Cursor, …) in a terminal multiplexer works,
but the output is hard to read and everything — questions, design attempts, code
attempts — lands in one undifferentiated scrollback. There is no durable, analyzable
record of the work.

## 2. Vision

A local-first, open-source, single-page web app ("the desk") that is a readable,
segregated cockpit over persistent agent sessions:

- Agent-agnostic (Claude first; Codex, Cursor later).
- Multiplexer-agnostic (herdr first; tmux, zellij, none).
- Every activity (ask / design / code) lives in its own log.
- Every log and every activity record is plain files committed to git.

## 3. Core concepts

| Concept | Definition |
|---|---|
| **Source** | A thing being worked on: local path, git repo, or http(s) URL. |
| **Base session** | One agent session per source (1:1). Holds Ask history. |
| **Thread** | A unit of activity under a source: `ask`, `design-N`, `code-N`. |
| **Fork** | Each design/code thread forks the base session: inherits source context, not sibling attempts. |
| **Turn** | One prompt → response exchange inside a thread. |
| **Activity record** | Structured event (prompt, response summary, tools, files, tokens, timing) appended to Notes. |

## 4. Functional requirements

### 4.1 Sources
- FR-1 Attach a source: local path, git repo, http(s) URL.
- FR-2 One source ↔ one base agent session.
- FR-3 Source access (Drive, GitHub, web, …) is delegated to the agent and its own MCP
  servers. agent-desk never holds third-party credentials.
- FR-4 Adapter reports agent capabilities (available MCP servers/tools); UI warns when an
  attached source likely isn't reachable by the agent.

### 4.2 Modes
- FR-5 **Ask** — Q&A on the base session. Each question rendered as its own card.
- FR-6 **Design** — "New design" creates `design-N` by forking the base session.
  Each design attempt has its own log and artifacts.
- FR-7 **Code** — "New code" creates `code-N` by forking; optionally linked to a
  `design-N` whose output is fed as context. Each code thread gets its own git worktree
  + branch (when the source is a git repo).
- FR-8 **Notes** — automatic, append-only record of all my activity across sources and
  threads, structured for later analysis (see §5). Manual notes can be added too.
- FR-9 **Usage** — per agent/source/thread token and cost totals; reuse existing tools
  (e.g. ccusage) where possible.
- FR-10 **Search** — full-text search over all desk logs and agent transcripts;
  sub-mode "web" opens a regular browser search.
- FR-11 Modes are user-definable (YAML: prompt template, permissions, agent). Ask /
  Design / Code ship as defaults.

### 4.3 Messaging
- FR-12 Every prompt from the browser is prefixed `<keyword>[<thread>]: <text>`;
  keyword configurable, default `browser` (e.g. `browser[design-2]: …`).
- FR-13 Agent runs in the background (persistent across browser disconnects);
  output streams to the browser live.
- FR-14 Approval requests (tool permission prompts) surface in the UI with
  approve/deny; every decision is logged.

### 4.4 Readability
- FR-15 Each turn is a card: prompt header → rendered markdown response.
- FR-16 Tool calls, diffs, and long outputs collapsed by default.
- FR-17 Layout: sources (left) · tabs Ask | Design | Code | Notes | Usage | Search ·
  thread list · thread view. Single pane, no context switching.
- FR-18 Raw terminal view (xterm.js) available as fallback/debug per session.

### 4.5 Persistence & git
- FR-19 All logs, artifacts and notes stored as plain files in a **desk data repo**
  (default `~/agent-desk-data`, configurable), committed to git automatically
  (on turn completion, batched).
- FR-20 Optional mirror of a source's logs into the source repo (`.agent-desk/`), off
  by default.
- FR-21 Secret scan before commit; matches are redacted and flagged.
- FR-22 Remote push is opt-in; private remote recommended.

## 5. Notes / activity data (analysis-ready)

- Append-only JSONL, one file per day: `notes/activity/YYYY-MM-DD.jsonl`.
- Event fields (min): `ts, source_id, thread_id, mode, agent, kind
  (prompt|response|tool|approval|commit|note), prompt, summary, files_changed,
  tokens_in, tokens_out, cost, duration_ms, outcome`.
- Human view: `notes/YYYY-MM-DD.md` generated from the JSONL.
- Schema versioned (`schema: 1`) so later analysis survives format changes.

## 6. Network access & security

- NFR-1 Default bind `127.0.0.1` only.
- NFR-2 Two roles enforced server-side per connection:
  - **action** — send prompts, approve, create threads.
  - **read-only** — view logs and live streams only.
- NFR-3 Allowlists in config, by IP or CIDR:
  ```toml
  [network]
  bind = ["127.0.0.1", "100.x.y.z"]   # tailscale IP optional
  action_allow   = ["127.0.0.1", "100.101.102.103"]
  readonly_allow = ["0.0.0.0/0"]
  ```
- NFR-4 **Tailscale** supported: bind to the tailnet interface; optionally authorize by
  tailnet identity (`tailscale whois` / `tailscale serve` identity headers) instead of
  raw IP.
- NFR-5 Action role also requires a token (IPs can be shared behind NAT/proxy);
  read-only token optional.
- NFR-6 WebSocket Origin check; `X-Forwarded-For` never trusted unless from a configured
  proxy.
- NFR-7 UI warns that read-only exposure reveals code and transcripts.

## 6a. Unattended remote host (milestone M1: Dec 2026 travel)

Use case: all of December the user is in India and uses agent-desk remotely. The host is
an HP desktop at home running herdr. The client is a laptop or phone on the tailnet.
Nobody is physically at the host for about 4 weeks.

- RH-1 **Always on.** `herdr server` (headless) and agent-desk run as systemd *user*
  services with `loginctl enable-linger`. They start on boot with no login and restart
  on failure.
- RH-2 **Sessions persist.**
  - Agent processes live in herdr, not in agent-desk. Restarting agent-desk re-attaches
    and nothing is lost.
  - On host reboot, each thread is resumed from its stored agent session id
    (`claude --resume <id>`). The thread → session id mapping is in `source.json`, which
    lives in git.
- RH-3 **Reconnect without loss.** Every event has a monotonic sequence number. The
  browser reconnects with its last sequence number and the server replays what it
  missed. This handles high latency (~250 ms RTT India↔home) and dropped mobile links.
- RH-4 **Pending approvals don't block forever.** Approval requests survive browser
  disconnects. A notification is optional (ntfy or Tailscale-reachable push). There is
  a per-mode policy for auto-deny after a timeout.
- RH-5 **Recovery path besides the web UI.**
  - Tailscale SSH to the host.
  - `herdr --remote <host>` attaches the raw TUI.
  - `systemctl --user restart agent-desk` is available.
- RH-6 **Host hardening checklist.** agent-desk ships it as `docs/remote-host.md`, and
  `agent-desk doctor` checks it:
  - BIOS "restore on AC power loss" = on;
  - suspend/hibernate masked; screen lock is fine;
  - OS auto-updates must not auto-reboot, or the host must come back cleanly if they do;
  - Tailscale enabled at boot, with key expiry disabled for the host;
  - agent CLI auth valid for 30+ days (check `claude` login before leaving);
  - free disk space and the data repo's git remote (off-site backup) are reachable.
- RH-7 **Health page.** Shows:
  - uptime;
  - herdr and agent status;
  - last git push;
  - disk usage;
  - auth status;
  - usage-limit status.
  It is read-only and allowed to the read-only role.
- RH-8 **Data backup.** Push to a private remote, opt-in but recommended for M1. The
  host losing its disk must not lose the logs or notes.
- RH-9 **Deadline.** M1 must be soak-tested on the HP host for ≥ 5 days before departure.
  Freeze features about 2026-11-24 and soak from 2026-11-25 to 2026-11-30.

## 7. Adapters

- Agent adapter: start, resume, fork, send, stream, approve, state, transcripts, usage,
  capabilities. Prefer **ACP (Agent Client Protocol)**; fall back to agent headless
  JSON streams (`claude -p --output-format stream-json`, `codex exec --json`).
- Mux adapter: persistence + raw attach. herdr (socket API) first, then tmux, zellij,
  `none` (direct PTY).

## 8. Scope

**M1 (by 2026-11-24, see §6a):** a v1 subset good enough for December remote use:
- Claude adapter;
- herdr adapter (headless server);
- Ask, Design and Code threads with forks;
- card UI;
- Notes JSONL;
- git auto-commit and push;
- Tailscale and token auth;
- reconnect and replay;
- systemd units;
- health page;
- `doctor`.

A phone-usable layout is promoted into M1. Search, Usage and worktree polish are allowed
to slip.

**v1:** Claude adapter (ACP or stream-json), herdr adapter, sources (local/git/URL),
Ask + Design + Code threads with forking, worktrees, Notes JSONL, git auto-commit,
network roles + allowlists + tailscale, card UI.

**Later:** Codex, Cursor, tmux/zellij, Usage dashboard, Search UI polish,
user-defined modes UI, mobile layout.

## 9. Non-goals

- Not an MCP host / credential broker.
- Not a hosted/cloud service.
- Not a replacement for the agent's own TUI.

## 10. Open questions

- ACP adapter maturity for Claude Code and Codex — verify before locking transport.
- herdr socket API surface (session/pane create, send, read, state events) — verify.
- Commit granularity: per turn vs batched interval.
- Fork semantics for agents without native fork (replay summary into new session?).
