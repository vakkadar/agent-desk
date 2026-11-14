# Agent Desk Build Spec (office)

As of Nov 14, 2026.

## Scope

Build a web cockpit over persistent coding-agent sessions: one Node server, one browser page, a git-backed data repo, Claude Code as the agent and herdr as the terminal multiplexer. It runs on office machines and is used from the same machine or the office LAN: everything agent-desk does today is in, except the Compute perspective (machines, power, Hostinger, GoDaddy, compute chat) and remote access from outside (Cloudflare, Tailscale).

| In | Out |
| --- | --- |
| Ask, Design, Code, Desk perspectives | Compute perspective and `compute.toml` |
| General questions, project Ask, live windows | Home Assistant, Wake-on-LAN, Hostinger, GoDaddy calls |
| Builder + reviewer pair, worktrees, review line, merge queue | Compute chat and its `compute[<machine>]:` tag |
| Approvals, notes, history, usage, schedules, alerts | `secrets.toml` sections for those providers |
| Terminal, named herdr sessions, Ask targets | Remote access: Cloudflare Tunnel + Access, Tailscale |
| Data repo sync, encrypted config vault, deploy, doctor | Guests, sanatana-hub and browser Ask targets |

This spec is a behaviour spec, not code. Names (message types, config keys) match agent-desk; a copy may rename them. Rules marked **Security** are kept whatever else changes.

## Architecture

_Diagram (architecture: page, server, agents, data repo) is in the Claude Doc version of this spec._

The page talks only to the desk server; the server runs agents through herdr (or plain child processes with `mux = "none"`) and commits all state to the data repo, which other hosts pull.

## Sources, threads and events

A source is a project folder or URL; each source holds threads, and every turn in a thread becomes a stream of numbered events that every page replays.

**Sources and threads**

- `ask` — the main conversation for a folder.
- `design-N`, `code-N` — threads forked from the base session (`--resume <id> --fork-session`); developer profile only. A code thread gets its own git worktree `<repo>/.desk/wt/<thread>` on branch `desk/<thread>`; `.desk/` goes in `.git/info/exclude`.
- **General** — built-in source in `general_dir` (default `<data>/general`). Each question starts a fresh Claude session as thread `q-N`, titled from its first \~80 characters. `c: <q1 | session id prefix | words>` continues one (forked if it is live elsewhere).
- Stored as `sources/<id>/source.json` with session ids, so threads resume after a reboot.
- Related threads are derived, not stored: `from` (forked from), `mail` (prompt starts `[mail from code-2]`), `mentions` (text names another thread).

**Agent adapter** — Claude Code headless: `claude -p … --output-format stream-json --verbose`, `--resume <id>` to continue. Interface: `start`, `resume`, `fork`, `send → async events`, `approve`, `transcripts`. One process per turn; the session lives in Claude's transcript store. Codex is a second adapter, used today as the reviewer.

**Mux adapter** — `mux = "herdr" | "none"`. With herdr, each turn runs in a pane of a dedicated session (`agent-desk`) as a script writing `out.jsonl`; the desk tails it. After a desk restart `recoverTurns()` resumes tailing. Missing herdr → falls back to `none` with a warning. herdr is AGPL: call its CLI, never link its code.

**Event bus** — every event has a monotonic `seq` and is appended to `<data>/.index/events.jsonl`.

| Event | Carries |
| --- | --- |
| `prompt` | text as sent, with tag |
| `text` | streamed answer chunk |
| `tool_call`, `tool_result` | what the agent ran and got |
| `approval_request`, `approval_result` | permission ask and decision |
| `usage`, `context` | tokens; context fill vs `context_limit` |
| `note` | desk notes (errors, decisions) |
| `done` | `outcome: ok \| error \| cancelled` |

**Prompt tag** — prompts go out as `browser[<threadId>]: <text>` (`keyword` configurable); slash commands are sent untagged. The page strips any `^\S*\[[^\]]+\]:\s*` prefix for display.

**WebSocket `/ws`**

- Page → desk first: `{type:"hello", token?, lastSeq}`.
- Desk → page: `{type:"welcome", role, profile, features, targets, guestAsk, sources}`, replay after `lastSeq`, then `{type:"event", e}`.
- Action-role messages: `prompt`, `cancel`, `approve`, `live_answer`, `thread`, `close`, `attach`, `ls`, `note`, `schedule_run`, `push_subscribe`, `push_unsubscribe`, `hsession_*`, `target_answer`, `target_models`, plus the pair, worktree, review and merge actions.
- Any role: `usage`, `search`, `schedules`, `hsessions`, `notes`.
- Errors: `{type:"error", error}`, shown under the composer; typed text is kept.

**Acceptance:** two pages on one thread see the same events; a closed and reopened page replays history; a desk restart plus reconnect loses nothing; a turn running in herdr during a restart finishes and its events arrive.

## Desk UI

One page (`desk2.html`, served at `/`) with four perspectives over the same sources: a left list of places and threads, the conversation in the middle, a right panel for files, diff and review. The page only hides what a profile lacks; the server enforces it.

| Perspective | Key | Profile | What it shows |
| --- | --- | --- | --- |
| Ask | Alt+1 | everyday | Projects' `ask` threads and General questions; Run on picker; attachments |
| Design | Alt+2 | developer | `design-N` threads forked from the base session |
| Code | Alt+3 | developer | `code-N` threads: builder \| reviewer pair, worktree files, per-file diff, review line, merge queue, related threads |
| Desk | Alt+4 | admin, `self_dev = true` | Desk threads on the desk's own repo: preview, apply, apply history with revert |

**Shell**

- Command palette (Ctrl/Cmd+K): threads by id or title, commands, `?words` web search or URL, falls back to History search.
- Ctrl+B toggles the list; `/` focuses the composer; Esc closes overlays; panels resize by drag.
- Views: Notes (today), History, Usage, Schedules, Add a project (folder with server-side folder browser via `ls`, or URL), Terminal, Sessions, Health.
- Turn cards: question, then answer; while running, "working…" plus tool cards; when done, steps, notes and approvals fold into one line.
- Composer: Ctrl/Cmd+Enter sends; ⋯ menu for `/compact`, Stop, close or reopen thread, `c: <id> message`, `new: message`, `attach: <name>`, `/<command>`.
- A `/compact` hint when context passes 70% of `context_limit`.
- Light, dark, auto theme; phone layout with safe-area padding and 16px inputs; installable PWA.
- Bundling: the page's own UI is inline; `desk2-extras.ts` (vite) bundles terminal, alerts, Run on, schedules, sessions, health, attachments and exposes them as `window.deskExtras`; `desk2-live.js` connects `/ws` and drives everything.

**Acceptance:** an everyday profile sees only Ask and cannot reach Design or Code by palette, key or hand-sent message; palette finds a thread by words in its title; a reload keeps the selected perspective and thread.

## Live windows and approvals

A project prompt goes into the Claude window already open in that folder, and every permission ask — headless or in a window — can be answered from the page.

**Live windows** (depends on herdr)

- Watch the user's own herdr sessions (`live_sessions`, default `default`). The desk only types text, presses Enter or Esc, and reads; it never opens, closes or kills their panes.
- One window open in the folder → the prompt is typed into it. Several → error listing them (`w3 "title"`); `c: w3 message` picks one. `new: message` skips the window and uses the desk's own session. Busy (working or blocked) → error: wait or use `new:`.
- Turns typed straight into the terminal show as cards too, read from `~/.claude/projects/<cwd-slug>/<session>.jsonl`. Turns the desk started itself are not published twice.
- A permission prompt in a window is parsed from `herdr pane read` (title, detail, question, numbered options). The page renders one button per option; a click sends `{type:"live_answer", sourceId, threadId, id, key}` and the desk types the option number.
- Strip `HERDR_*` from the environment before calling herdr from outside a pane.

**Headless approvals**

- Turns run with `--permission-prompt-tool mcp__desk__approve`. The desk serves a minimal MCP server (streamable HTTP, JSON) at `/mcp/<random secret>/<source>/<thread>` with one tool, `approve`.
- Claude asks → `approval_request` event → Approve / Deny on the page → the answer is the tool result. Open requests live on the event bus, so a reload shows them again.
- `[approval_timeout_min]` per mode; timeout denies. Decisions go to notes.
- `[permission_mode]` per source id or thread mode; General defaults to `auto`, the Desk dev source to `default`.
- Read-only pages see "waiting for approval (read-only view)" with no buttons.
- Stop (`cancel`) kills the agent process and denies open approvals.
- A needs-attention list collects every open approval across sources; allow and deny shortcuts map to the matching option.

**Acceptance:** a Bash tool call in a headless turn waits until Approve; Deny returns a denial to Claude; a timeout denies; a window prompt answered from the page moves the window on; a read-only page cannot answer either kind.

## Code threads, sessions and terminal

Each code thread is a builder and a reviewer working in their own worktree, and nothing lands in the project until the reviewer has verified every finding. Developer profile; depends on herdr and git.

**Pair in herdr**

- One herdr session per opened project (`desk-<sourceId>`), one tab per thread, split builder | reviewer.
- Builder: Claude. Reviewer: Codex when installed, else Claude on a stronger model.
- Pane ids kept in `<data>/.index/pairs.json`, so a restarted desk finds the same panes. Closing a view stops nothing.

**Worktree, files, diff**

- `<repo>/.desk/wt/<thread>` on branch `desk/<thread>` from the repo's HEAD.
- Files the thread touched, split into output product vs supporting by path rules.
- Per-file diff against `start` (the thread's first commit) or `last` (snapshot at your last message).

**Review line**

- The reviewer writes `<worktree>/.desk/review.json`: `{round, reviewer, findings:[{id, severity, file, line, text, status}]}`.
- Status: `open`, `claimed`, `verified`, `disputed`, `wontfix`. Only `verified` counts as fixed; the builder's `claimed` is not enough.
- The builder's turn shows one expandable line: `none`, `clean`, `open` or `disputed`. Only disputed findings come to you (Needs you).

**Merge queue** — one thread at a time, state in `<data>/.index/merge-queue.json`, nothing pushed:

1. Gate: review line clean; `force` skips it.
2. Commit: leftover changes in the worktree are committed on its branch.
3. Check: optional command in the worktree (e.g. `npm test`); non-zero blocks.
4. Merge: `git merge --no-ff desk/<thread>` into a clean checkout; a conflict is aborted and reported.

**Desk threads** (admin, `self_dev = true`) — code threads on the desk's own repo.

- Check is always `npm run build && npm test`; no file can turn it off.
- Preview: build the worktree and run it as a second desk on a spare port, bound to 127.0.0.1, with an empty data folder.
- Apply after merge: keep `dist` as `dist.prev`, build, restart the service under `systemd-run --user`, wait for `/healthz`. Build or health fails → old build back and `git revert` of the merge.
- Apply history with revert (a new revert commit, applied the same way).

**Terminal** — xterm.js over a second WebSocket `/pty?session=<name>`, attached to a herdr session through node-pty. Client sends `hello{token, cols, rows}`, then `input` and `resize`; server answers `ready{role}` and raw output. Same role and token check; refused without the `terminal` feature.

**Named sessions** — CLI `agent-desk-session create <name> [dir] [--pin | --pin-stdin] [--persistent]`, plus `persist` and `pin`.

- Registry `<data>/.index/herdr-sessions.json` (not in git: PIN hashes, scrypt).
- States `initialized → open → closed → open`. `persistent` sessions restart with `claude --continue` when the desk starts.
- Sessions dialog: open, close, Trust folder (answers Claude's first-run trust question); `attach: <name>` in the composer.
- A PIN-bound source asks for the PIN on each prompt; 5 wrong in a row lock it for 5 minutes. PIN box: password input, full keyboard, `autocomplete=off autocapitalize=off`.

**Acceptance:** two code threads edit the same file without touching each other's checkout; a merge with an open finding is blocked unless forced; a conflicting merge leaves the checkout clean; a failed Desk apply leaves the old build running and the merge reverted; 5 wrong PINs lock the session.

## Ask targets, schedules, alerts, attachments

Questions can run on other models, run on a clock, notify a phone, and carry files — all through the same turn path as a typed prompt.

**Ask targets** — a Run on picker lists "This host" plus each `[[ask_target]]`; slash commands always run on this host.

| Kind | Who calls | Config |
| --- | --- | --- |
| `openai` | desk, server side | `url`, `key_env` (env file), `default_model`, `models?`, `system?` |

- Prompt logged as `<target>:<detail>[<thread>]: <text>`; answer gets `_— <label> · <model>_`.
- **Security:** history sent to a target = only that target's earlier turns in this thread (signature stripped, unanswered dropped, last 20). Answers from local Claude or another target never go to a third party.
- `openai`: `{url}/chat/completions`, 300 s timeout, `usage` event, errors `<id>: <status> <message>`.
- The page never receives `key_env` or `system`.

**Schedules** — `[[schedule]] name, at = "07:30" | every = "6h", days?, source, prompt`.

- Same path and permission mode as a typed prompt. General runs become `⏰ <name> · <date>`; project runs go to `ask` on the desk's own session, never the open window.
- Skip if the previous run is still going; no catch-up of missed slots. State in `.index/schedule-state.json`. A bad entry warns, never fatal. Dialog: next, last, Run now.

**Alerts and PWA** (Web Push needs localhost or an HTTPS origin)

- Manifest, icons, service worker.
- VAPID keys made on first run under `<data>/.index` (mode 600). Notify on turn done and approval requested. `subject` must be a real `mailto:` or https URL.
- The Alerts toggle asks permission from the tap itself (iOS) and says why it failed.

**Attachments and Share to Desk**

- Paperclip, paste, drag-and-drop. Uploaded over HTTP (token required) to `<thread folder>/.desk-uploads/<date>/`, added to `.gitignore`. 5 files, 20 MB each. Absolute paths appended to the prompt.
- **Security:** reject paths outside the source folder.
- `#q=<text>&source=<id>` prefills once, never auto-sends, then leaves the URL. Android and desktop: manifest `share_target`.

**Acceptance:** a second question to a target carries the first as history and not a Claude answer; a missing key says "`<KEY>` is not set"; a second page cannot answer the first page's target turn; a schedule still running is skipped; an upload path with `..` is refused.

## Access: roles, profiles, network

A role decides whether a connection may act; a profile decides which features it gets. **Security:** the server checks both on every message; the page only hides things.

**Roles**

- `action` sends prompts, approves, changes things; `readonly` watches, searches, sees usage. Mutating messages from read-only are dropped with `error: "read-only connection"`.
- Addresses in `network.action_allow` (default `127.0.0.1`, `::1`) get `action` only with the token; `network.readonly_allow` (CIDRs) may connect read-only; anything else is refused. Bind `127.0.0.1` by default.
- Token `AGENT_DESK_TOKEN` from `~/.config/agent-desk/env` (mode 600), compared in constant time. The page reads `#token=…` once, stores it in localStorage and removes it from the URL; tapping the read-only pill opens a password box to paste it (home-screen apps have their own storage).
- Check the WebSocket `Origin` against the desk's own origin.

**Profiles** (Compute removed)

| Profile | Features | Gets |
| --- | --- | --- |
| `everyday` | none | Ask, General, Notes, History, Usage |
| `developer` | `design`, `code`, `terminal`, `sessions` | also Design and Code threads, terminal, named sessions |
| `admin` | developer + `self` | also the Desk perspective (`self_dev`) |

- `desk.toml`: `profile` (default `everyday`). Unknown profile names are a startup error.
- Refusals read "`<feature>` is not part of your profile (developer profile needed)"; `self` reads "the desk's own code is for the admin profile only".
- The `self` source and its events are hidden from profiles without `self`.

**Acceptance:** no token or a wrong one → read-only and every action refused by the server; an everyday connection hand-sending `thread{mode:"code"}` is refused.

## Data repo and moving between hosts

`<data>` (default `~/agent-desk-data`) is a git repo the hosts share through a **private** remote; it holds config, threads, logs and notes, and is how a project's sessions move from one host to another.

```
~/agent-desk-data/
  desk.toml                      config, no secrets
  sources/<id>/source.json       kind, location, agent, session ids
  sources/<id>/<thread>/log.md   readable log per thread
  general/                       General's working folder
  notes/activity/YYYY-MM-DD.jsonl   append-only, schema-versioned
  notes/YYYY-MM-DD.md            generated daily view
  notes/manual/                  hand-written notes
  vault/<host>.tar.gpg           encrypted config, one per host
  .index/                        events.jsonl, push keys, registries (gitignored)
```

- **Git sync:** debounced commit \~10 s after the last turn (`git add -A`). Push only with `[git] push = true` and `remote` (default `origin`); a failed push logs and does not stop the desk.
- `.gitignore` gets `.index/`, `desk.log`, `*.bak`, added idempotently. Never untrack files automatically: a pull would delete them on the other hosts.
- **Security:** a secret scanner redacts likely keys, tokens and private keys before anything is written, and flags the event.
- **Notes:** every event also goes to activity JSONL and the daily markdown view; the Notes view shows them and takes manual notes (`note`).
- **History:** full-text search over the event journal (`search`); results link to the thread.
- **Usage:** token totals from `usage` events by range `today`, `7d`, `all`.
- **Context:** fill read from the transcript's last assistant usage; drives the `/compact` hint.

**Move a project to another host** (in agent-desk only as a palette placeholder today: "Save → kill → move → copy sessions → start"):

1. Save: wait for idle turns, commit and push the data repo.
2. Stop: close the project's live windows and pair panes on the old host.
3. Move: the project folder by git (push its branches) or copy.
4. Copy sessions: Claude transcripts `~/.claude/projects/<cwd-slug>/*.jsonl` and Codex sessions, re-slugged when the folder path differs.
5. Start: pull on the new host, reopen the pair, resume with the stored session ids.

**Acceptance:** a turn produces a commit within \~15 s; a fake API key in a prompt is redacted in `log.md` and the notes; with push off nothing leaves the host; a project moved to a second host resumes its `ask` session with the earlier context.

## Config, secrets and the vault

Config lives in the data repo in the clear; secrets live outside it, mode 600, and reach git only inside a passphrase-encrypted vault.

| File | Holds | In git |
| --- | --- | --- |
| `<data>/desk.toml` | network, profiles, `[permission_mode]`, `[approval_timeout_min]`, `[[ask_target]]`, `[[schedule]]`, `[git]`, `mux`, `keyword`, `general_dir`, `live_sessions`, `self_dev` | yes |
| `~/.config/agent-desk/env` (600) | `AGENT_DESK_TOKEN`, Ask target keys (`key_env`) | only in the vault |
| `~/.config/agent-desk/secrets.toml` (600) | other provider tokens; empty values count as missing | only in the vault |
| `<data>/.index/` | events, VAPID keys, subscriptions, PIN hashes, pairs, merge queue | never |

- The desk refuses a secrets file that group or others can read. Override path: `AGENT_DESK_SECRETS`.
- Secrets are never sent to a page, never logged, never in argv.

**Vault** — `deploy/secrets-vault.sh seal | open | list [vault-file]`

- `seal` packs the secrets files and `desk.toml` into `<data>/vault/$(hostname -s).tar.gpg`, one per host, committed with the data repo.
- Cipher: OpenPGP symmetric AES-256, passphrase stretched with iterated+salted SHA-512 at count 65011712, MDC, no compression, `--no-symkey-cache`.
- gpg asks for the passphrase itself (pinentry): never through argv, env or a file. Run from a real terminal. Use 6+ random words — anyone with the repo can try passphrases offline.
- `open` restores with mode 600 and keeps a changed old file as `.bak`; `list` shows names only. A new host opens another host's vault: `open <data>/vault/<other>.tar.gpg`.
- Temp files under `umask 077` in a `mktemp -d` removed on exit.

**Acceptance:** seal then open on a throwaway `GNUPGHOME` round-trips every file byte for byte; a wrong passphrase is refused and writes nothing; a 0644 secrets file stops the desk with a chmod hint.

## Deploy and ops

The desk runs unattended on one host as systemd user units (Linux) or launchd agents (macOS), restartable at any time without losing turns, with a doctor and a health page to prove it is ready.

- **Stack:** Node ≥ 22.13, TypeScript, `ws`, `node-pty`, `smol-toml`, `web-push`, xterm.js; vite for the page. `npm run build` = `tsc` + vite; `npm test` = `tsx --test test/*.test.ts`.
- **Units** (`systemd --user`, `loginctl enable-linger`): `herdr.service` owns agent processes; `agent-desk.service` is stateless and re-attaches on start.
- **Install:** `deploy/install.sh`, idempotent: `npm ci`, build, units, and the env file with a random token if missing. On macOS it writes `com.agent-desk.herdr` and `com.agent-desk.server` to `~/Library/LaunchAgents` (logs in `~/Library/Logs/agent-desk/`); they start at login, so the Mac needs automatic login, no system sleep (`pmset -a sleep 0`) and `pmset -a autorestart 1` to come back alone. Doctor checks all three.
- **Claude login:** `deploy/claude-token.sh` on the host in a real terminal gives the desk a long-lived token. Start the desk with no stray `ANTHROPIC_API_KEY` in its environment.
- **Doctor** (`agent-desk doctor`): PASS / WARN / FAIL per check — sleep targets masked, BIOS power restore (reminder), auto-update reboots, Claude auth, herdr, linger, units, free disk, data repo remote, token, bind. Pluggable `registerCheck()`.
- **Health:** `/healthz` plus a Health panel; pluggable `registerHealth()` providers (mux, git).
- **Host-down watch:** `deploy/watch-host.sh` on another machine, every 5 min via `agent-desk-watch.timer`; alerts on change only (2 failures in a row) via `notify-send` and optional ntfy.
- **Recovery:** on boot, for each open thread, ensure its herdr pane or resume the stored session id; replay events from the journal on `resume{lastSeq}`.
- **Tests:** one test file per module; each acceptance line in this spec is a test.

**Acceptance:** `install.sh` run twice changes nothing the second time; killing `agent-desk.service` mid-turn and restarting it finishes the turn; doctor FAILs with no token; the watcher alerts once on down and once on up.

## Build order

_Diagram (build order: 5 phases, 5 gates) is in the Claude Doc version of this spec._

Start with phase 1 and do not open a phase until the gate before it passes as an automated test. Phases 3 to 5 need herdr, Web Push or systemd; skip any the target site does not allow.
