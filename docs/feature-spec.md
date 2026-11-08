# agent-desk feature spec (for building the same features in another copy)

This describes what agent-desk does, written so a coding agent can add the same
features to a different codebase without seeing this one. It is a behaviour spec,
not code. Names (message types, config keys) are the ones used here; keep them
if your copy has none of its own, rename freely if it does.

**How to use this document (instructions for the agent):**

1. Read your copy's code first and mark each feature below as *have*, *partly*,
   or *missing*. Report that table before changing anything.
2. Build missing features in the order of the "Build order" section. Each feature
   is self-contained and has acceptance checks; write a test for each check.
3. Keep your copy's existing structure, style and naming. Where this spec and your
   code disagree on details, keep yours unless the spec's rule is a security rule
   (marked **Security**).
4. Some features depend on tools that may not exist or be allowed at your site
   (herdr, Cloudflare Tunnel, Web Push, systemd). Each says so under *Depends on*.
   Ask before adding a network-facing feature at a workplace.

---

## 0. Core model (everything else builds on this)

- **Server**: Node 22 + TypeScript. One HTTP server serves the web page and a
  WebSocket at `/ws`. Binds to `127.0.0.1` by default.
- **Agent**: Claude Code CLI, driven headless (`claude -p … --output-format stream-json
  --verbose`, `--resume <id>` to continue, `--resume <id> --fork-session` to fork).
  Wrap it behind an adapter interface (`start`, `resume`, `fork`, `send` → async
  stream of events) so other agents can be added later.
- **Source** = a project folder (or a URL). Each source has threads:
  - `ask` — the main conversation for that folder;
  - `design-N`, `code-N` — extra threads forked from the base session (developer profile only).
- **General** = a built-in source for questions not tied to a project. Its folder is
  `general_dir` (default `<data>/general`). Every question starts a new Claude session
  and becomes its own thread `q-1`, `q-2`, …
- **Event bus**: every turn produces events, each with a monotonic `seq`:
  `prompt`, `text`, `tool_call`, `tool_result`, `approval_request`, `approval_result`,
  `usage`, `context`, `note`, `done{outcome: ok|error|cancelled}`.
  Events are appended to `<data>/.index/events.jsonl` and fanned out to all
  connected pages.
- **Prompt tag**: the desk prefixes prompts it sends as `browser[<threadId>]: <text>`
  (the word `browser` is the configurable `keyword`). Slash commands (`/compact`)
  are sent exactly as typed, never tagged.
- **Data repo**: `<data>` (default `~/agent-desk-data`) is a git repo holding
  `desk.toml` (config, no secrets), `sources/<id>/source.json`, per-thread markdown
  logs, and notes. Secrets live in `~/.config/agent-desk/env` (mode 600), never in git.

### WebSocket protocol (core)

- Page → desk, first message: `{type:"hello", token?, lastSeq}`.
- Desk → page: `{type:"welcome", role, profile, features, targets, guestAsk, sources}`,
  then replays every event after `lastSeq`, then streams new ones as `{type:"event", e}`.
- Page → desk actions (action role only, see §1): `prompt`, `cancel`, `approve`,
  `thread`, `close`, `attach`, `ls`, `notes`, `note`, `sessions`, `schedule_run`,
  `push_subscribe`, `push_unsubscribe`, `hsession_*`, `target_answer`, `target_models`.
- Read-only queries allowed for any role: `usage`, `search`, `schedules`, `hsessions`.
- Errors come back as `{type:"error", error}` and are shown under the message box;
  the typed text is kept so nothing is lost.
- On reconnect the page sends `hello` with its last seen `seq`, so nothing is missed
  across desk restarts.

**Acceptance:** two pages open on the same thread see the same events; closing and
reopening a page replays history; restarting the desk and reconnecting loses nothing.

---

## 1. Access control: roles, token, owners  (**Security**)

- Two roles per connection: `action` (can send prompts, approve, change things) and
  `readonly` (can watch, search, see usage).
- **The server enforces roles.** It drops every mutating message from a read-only
  connection with `error: "read-only connection"`. Never trust the page to hide buttons.
- Role rules:
  - Connections from addresses in `network.action_allow` (default `127.0.0.1`, `::1`)
    get `action` only with the right token; without it, `readonly`.
  - `network.readonly_allow` (CIDRs) may connect read-only. Anything else is refused.
  - Token: `AGENT_DESK_TOKEN` from the env file. Compare in constant time.
  - The page reads a token from `#token=…` in the URL once, stores it in
    localStorage, and removes it from the URL. Tapping the "read-only" status pill
    opens a small password box to paste the token (needed for phone home-screen apps,
    which have their own storage).
- Check the WebSocket `Origin` header against the desk's own origin.

**Acceptance:** no token → read-only, every action refused by the server; wrong token
→ read-only; right token → action.

### 1a. Remote access through Cloudflare Tunnel + Access  *(Depends on: Cloudflare)*

- Tunnel traffic is recognised by the `cf-ray` / `cf-connecting-ip` headers. It
  **never** gets localhost trust.
- Every tunnel request must carry a valid Cloudflare Access JWT
  (`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie): verify the signature
  against the team's JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`),
  the `aud` tag, and expiry. Optional `emails` list narrows further. No config → refuse
  all tunnel traffic (fail closed). Invalid → HTTP 403.
- `owners = ["…"]`: Access emails listed here get the `action` role **without** the
  token. Everyone else over the tunnel needs the token for `action`.
- Remember the verified email per request (e.g. a `WeakMap<IncomingMessage,string>`)
  for profiles (§2).
- Config:
  ```toml
  [network.cloudflare_access]
  team = "yourteam"
  aud = "<Access application AUD tag>"
  emails = ["you@example.com"]     # optional extra check
  owners = ["you@example.com"]     # optional: full access without the token
  ```

**Acceptance:** a request with `cf-ray` but no JWT → 403; valid JWT for a non-owner →
read-only; valid JWT for an owner → action.

---

## 2. Profiles: everyday vs developer

- Profiles decide which *features* someone gets; roles still decide read vs act.
  - `everyday`: Ask, General, Notes, History, Web tabs; Settings → Usage.
  - `developer`: also Design and Code threads, the terminal, named sessions (§12).
- Config:
  ```toml
  profile = "everyday"          # default for localhost/LAN connections
  guest_profile = "everyday"    # tunnel logins that are not owners and not listed
  [profile_by_email]
  "you@example.com" = "developer"
  "guest@example.com" = "everyday"
  ```
- Resolution: email listed in `[profile_by_email]` → that; else if the connection is a
  guest (tunnel, not an owner) → `guest_profile`; else `profile`.
- The welcome message sends `profile` and `features`. The page hides tabs and menu
  items that are not in `features`.
- **Security:** the server refuses `design`/`code` thread creation, `hsession_*`
  messages and the terminal WebSocket for a profile without them, with
  "`<feature>` is not part of your profile (developer profile needed)".
- Unknown profile names in config are a startup error.

**Acceptance:** an everyday connection gets no Design/Code/terminal and the server
refuses them even if sent by hand; an unlisted guest gets `guest_profile`.

---

## 3. Page layout

- Main tabs always visible: **Ask**, **General**, **Notes**, **History** (search),
  **Web**. A **Settings ▸** tab reveals Design, Code (developer only) and Usage;
  whether it is open is remembered in localStorage.
- Left list: project sources only (General has its own tab). Attach form: a folder
  path with a server-side folder browser (`ls` message lists sub-folders) and
  autocomplete, or a URL.
- Message box on top, newest turn first.
- **Turn cards**: question, then answer under it. While running: "working…" and
  tool cards showing what the agent is running. When done, steps, notes and approvals
  fold into one line; long cards scroll instead of being cut.
- Markdown rendering with sanitising (marked + DOMPurify).
- Light / dark / auto theme toggle. Phone layout: sidebar toggle, safe-area padding,
  no zoom on input focus (16px inputs).
- Web tab: a box that opens a Google search, or the URL if one was typed, in a new tab.
- `⋯` menu next to Send: `/compact`, Stop, Close/reopen thread, `c: <id> message`,
  `new: message`, Sessions (developer), Schedules, `/<command>`.
- A `/compact` hint appears when context use passes 70% (`context` event vs
  `context_limit`).

---

## 4. General questions

- Each new question in General starts a fresh Claude session in `general_dir` and
  becomes thread `q-N`, titled from the first ~80 characters.
- Picking a question in the list and typing continues it, no prefix needed.
- `c: <match> message` (also on two lines) continues an earlier question or any Claude
  session in that folder: `q1` matches `q-1`, or match by title/session id. No match →
  error listing the five most recent questions.
- General runs in Claude's auto permission mode by default; per-source/mode override:
  ```toml
  [permission_mode]
  general = "auto"
  design = "default"
  ```

**Acceptance:** two questions → two threads with separate sessions; `c: q1 more`
continues the first.

---

## 5. Project Ask into the already-open Claude window  *(Depends on: herdr or another terminal multiplexer)*

- If a Claude window is already open in the project's folder, Project Ask types the
  prompt into it instead of starting another session (one conversation per folder).
- Several open → error listing them (`w3 "title"`); `c: w3 message` picks one.
  `new: message` skips the open window and uses the desk's own session.
- Busy window (working/blocked) → error, ask to wait or use `new:`.
- Turns typed directly in that terminal are followed and shown as cards too, read from
  Claude's transcript JSONL (`~/.claude/projects/<cwd-slug>/<session>.jsonl`).
- Approval prompts showing in that window can be answered from the page.

---

## 6. Approvals

- Headless turns run with `--permission-prompt-tool mcp__desk__approve`. The desk
  serves a minimal MCP server (streamable HTTP, JSON) at `/mcp/<random secret>/<source>/<thread>`
  with one tool, `approve`. When Claude asks, the desk publishes `approval_request`,
  the page shows Approve / Deny, the answer goes back as the tool result.
- Timeout `approval_timeout_min` (deny on timeout). Decisions are logged in notes.
- Read-only pages see "waiting for approval (read-only view)" without buttons.
- Stop (`cancel`) kills the running agent process and denies open approvals.

---

## 7. Notes, logs and git

- Every event is also written as human-readable markdown per thread
  (`sources/<id>/<thread>/log.md`) and as activity JSONL
  (`notes/activity/YYYY-MM-DD.jsonl`), with a generated daily view.
- Notes tab: shows the activity and lets you add manual notes (`note` message).
- **Security:** a secret scanner redacts likely secrets (API keys, tokens, private keys)
  before anything is written, and flags the event.
- Git: debounced auto-commit of the data repo (~10 s after the last event); push only if
  `[git] push = true` and `remote` is set.

---

## 8. History (search) and Usage

- History: full-text search over all events (`search` message), results link to the
  thread.
- Usage: token totals from `usage` events, with a range picker (`today`, `7d`, `all`;
  message `usage{range}`).

---

## 9. Attachments and Share to Desk

- Paperclip button (camera/photos/files on phones), paste and drag-and-drop on desktop.
  Uploaded over HTTP (token required) to `<thread folder>/.desk-uploads/<date>/`;
  `.desk-uploads/` is added to `.gitignore` in git repos. Limits: 5 files, 20 MB each.
  The prompt gets the absolute paths appended so Claude reads them.
- **Security:** reject paths outside the source folder; never trust client paths.
- Share prefill: `#q=<text>&source=<id>` prefills the message box once (never auto-sends)
  and is removed from the URL. Android/desktop: `share_target` in the web manifest
  (`?title=&text=&url=`). iPhone: a Shortcut that opens the `#q=` link.

---

## 10. Install as an app (PWA) and push alerts  *(Web Push depends on: HTTPS origin)*

- Web manifest + icons + service worker so Chrome/Edge/Safari can install the desk as
  an app window. The manifest fetch must send cookies (`crossorigin="use-credentials"`)
  so it passes an auth proxy.
- Push alerts (Web Push, VAPID keys generated on first run and kept in the data dir):
  notify subscribed devices when a turn finishes or an approval is requested.
  VAPID `subject` must be a real `mailto:` or https URL (Apple rejects `localhost`).
  The Alerts toggle asks permission directly from the tap (iOS requirement) and
  says why it failed.

---

## 11. Scheduled prompts

```toml
[[schedule]]
name = "morning"
at = "07:30"                       # daily, local time; or every = "6h" (30m, 6h, 1d)
days = ["mon","tue","wed","thu","fri"]   # optional, only with `at`
source = "general"                 # or a project source id
prompt = "Summarize what changed overnight."
```

- Same path as a typed prompt and same permission mode. General runs become a new
  question titled `⏰ morning · <date>`; project runs go to the `ask` thread on the
  desk's own session (never the open window).
- Skip a run if the previous run of that schedule is still going. Missed slots while
  down are not caught up. State in `.index/schedule-state.json`.
- A bad entry is skipped with a warning, not fatal. Schedules dialog: next/last run,
  Run now (action role).

---

## 12. Terminal and named sessions  *(developer profile; Depends on: herdr)*

- Terminal panel: xterm.js over a second WebSocket `/pty` that attaches to a herdr
  session via node-pty. Same role/token check; refused without the `terminal` feature.
- Named sessions registry: a CLI (`agent-desk-session`) registers a herdr session with a
  folder, an optional PIN (stored hashed, scrypt) and states
  `initialized → open → closed`; `persistent` sessions are restarted with
  `claude --continue` when the desk starts.
- Sessions dialog in the page (⋯ menu): open/close, Trust folder (answers Claude's
  first-run trust question), and `attach: <name>` in the message box. A read-only
  connection sees a note explaining it needs the token.
- A source bound to a named session asks for the PIN on every prompt; wrong PINs are
  rate-limited: 5 wrong in a row lock that session for 5 minutes. PIN box: password input with full keyboard
  (`autocomplete=off autocapitalize=off`, no numeric-only inputmode).

---

## 13. Ask targets: run a question somewhere else

The **Run on** picker above the message box lists "This host" (local Claude) plus each
`[[ask_target]]`. Slash commands always run on this host.

```toml
# Server side: the desk calls any OpenAI-compatible API with a key from its env file.
[[ask_target]]
id = "openrouter"            # letters, digits, - _ ; not "local"
label = "OpenRouter"
kind = "openai"
url = "https://openrouter.ai/api/v1"
key_env = "OPENROUTER_API_KEY"     # in ~/.config/agent-desk/env, never sent to the page
default_model = "deepseek/deepseek-chat"
# models = ["…"]                   # else GET {url}/models
# system = "Answer briefly."       # never sent to the page

# Browser side: the page calls the service with the reader's own sign-in (cookies + CORS).
[[ask_target]]
id = "myapi"
kind = "browser"
url = "https://api.example.com"
ask_path = "/v1/ask"               # POST JSON
input_field = "input"
history_field = "history"          # optional [{role, content}]
model_field = "model"              # optional
output_field = "result.text"       # dotted path in the reply
models_path = "/v1/models"         # optional GET
models_field = "models"
credentials = "include"            # or "omit"
```

Flow:

- The prompt is logged as `<target>:<detail>[<thread>]: <text>` (detail = agent/model),
  so history and notes show it like any other turn. The answer gets a signature line
  `\n\n_— <label> · <model>_`.
- **History sent to a target = only that target's earlier turns in this thread**
  (signature stripped, unanswered questions dropped, roles alternating, last 20).
  Answers from local Claude or another target are never sent to a third party.
  (**Security/privacy**)
- `openai` kind: desk calls `{url}/chat/completions` with `system + history + user`,
  300 s timeout, publishes a `usage` event, errors as `<id>: <status> <message>`.
- Browser kinds: desk publishes the prompt, sends `{type:"target_go", sourceId,
  threadId, target, text, agent, model}` **to the asking page only**, and waits up to
  330 s for `{type:"target_answer", text|error, model}`. Only that same connection may
  answer (**Security**: no one else can inject an answer). A 401 shows a Sign in link.
- The page never receives `key_env` or `system` (only `id, label, kind, url, models,
  defaultModel, browser spec, browserSide`).
- Picker choice and per-target model remembered in localStorage.

**Acceptance:** second question to the same target carries the first as history; a
local-Claude answer in the same thread is not included; a missing key gives
"`<KEY>` is not set"; a second page cannot answer the first page's turn.

### 13a. Guests may ask browser-side targets  (`guest_ask = true`, default off)

- A read-only connection may send `prompt` only when: source is General, the target is a
  browser kind, the text is not a `/` command and not `c:`. Attachments are dropped.
  It may also send `target_answer` for its own turn. Everything else stays refused.
- The page, for a read-only guest, defaults Run on to the first browser target.
- Their turns are stored in the desk's history like any other (say so to guests).

---

## 14. Operations

- `agent-desk doctor`: checks host readiness and prints PASS/WARN/FAIL per check:
  sleep targets masked, BIOS power restore (reminder), auto-update reboots, tailscale,
  Claude auth, herdr, linger, systemd units, free disk, data repo remote, token, bind.
  Checks are pluggable (`registerCheck`).
- Health page: pluggable providers (`registerHealth`), e.g. mux status and git status.
- systemd user units for the desk and herdr, `loginctl enable-linger`; install script
  is idempotent and creates the env file with a random token if missing.
- A host-down watcher on another machine (timer + desktop notification / ntfy) is
  optional.

---

## Build order

1. Core model + protocol (§0), access control (§1), page layout (§3).
2. General (§4), approvals (§6), notes/logs/git (§7), History/Usage (§8).
3. Profiles (§2), attachments/share (§9), PWA (§10), schedules (§11).
4. Ask targets (§13), then guests (§13a).
5. Only if the tools exist and are allowed: remote access (§1a), project Ask into open
   windows (§5), terminal and named sessions (§12), push alerts (§10).

## Security rules to keep whatever else changes

- The server enforces role and profile on every message; the page only hides things.
- Secrets only in the env file (600), never in git, never sent to a page.
- Tunnel/proxy traffic never inherits localhost trust; fail closed without auth config.
- A third-party target never receives another agent's answers.
- Only the page that was asked can answer a browser-side target turn.
- Redact secrets before writing logs/notes; reject upload paths outside the source.
