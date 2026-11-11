# Profiles and Ask targets

Two settings in `~/agent-desk-data/desk.toml` shape the desk for the people using it.

## Profiles: who gets which features

| Profile | Tabs | Also |
|---|---|---|
| `everyday` (default) | Ask, General, Notes, History, Web; Settings → Usage | — |
| `developer` | the same, plus Settings → Design, Code | Terminal, herdr Sessions (`attach:`) |
| `admin` | the same as developer, plus the **desk-dev** source | the desk's own code (`self_dev`) |

```toml
profile = "everyday"                 # everyone, unless listed below
guest_profile = "everyday"           # tunnel logins that are not owners and not listed (default everyday)
guest_ask = true                     # read-only guests may ask browser-side targets (default false)

[profile_by_email]                   # Cloudflare Access logins (see cloudflare-tunnel.md)
"you@example.com" = "developer"
"guest@example.com" = "everyday"
```

Connections without an Access login (localhost, LAN) get `profile`. A login over the
tunnel that is not in `owners` and not listed gets `guest_profile`, so a newly admitted
guest never gets more than you meant.

### Admin: working on the desk itself (`self_dev`)

```toml
self_dev = true                      # add the desk-dev source (default false)
self_dev_session = "agent-desk-dev"  # optional: herdr session its interactive Claude runs in
[profile_by_email]
"you@example.com" = "admin"
```

With `self_dev = true` the desk adds a **desk-dev** source for the repo it runs from, so
you can ask, follow and approve Claude working on the desk's own code from the page.
Each desk gets its own machine's copy of the repo.

- Admin only: any source inside the desk's repo (desk-dev, or the folder attached by
  hand) and the `self_dev_session` herdr session are hidden from other profiles, and the
  desk refuses their prompts, attachments, terminal and sessions there.
- Every tool use asks for approval (`permission_mode` `default`), unless
  `[permission_mode] desk-dev = "…"` says otherwise.
- When a turn ends, the desk commits whatever it changed (`Desk dev: <question>`) and
  says so under the answer. It does not push: push from that machine when you are happy,
  then pull elsewhere. Changes take effect after `npm run build` and a desk restart.

### Guests asking on a hub

With `guest_ask = true`, a read-only connection (a guest without the desk token) may ask
questions in General on a browser-side target (`sanatana-hub` or `browser`, below). The page
makes that call with the guest's own sign-in there, so it never uses this host's Claude or
an API key. Everything else stays read-only: Claude on this host, `openai` targets, `/`
commands, `c:`, attachments, other sources. Only the page that asked can answer its own
turn. Guests' questions and answers are saved in the desk's history like any other.
The desk enforces the profile: it refuses Design/Code threads, the terminal and
sessions for a profile without them. The page only hides what can't be used.
A profile is not a permission level for the rest: read-only vs. full access is
still decided by the desk token or `owners` (cloudflare-tunnel.md).

## Ask targets: where a question runs

Ask runs on Claude on this host by default. Each `[[ask_target]]` adds a choice to the
**Run on** picker above the message box. Every target's turns are kept in the thread,
history and notes the same way. When you ask a target again in the same thread, it gets
its own earlier turns as conversation history, and only those: answers from local
Claude or another target are never sent to it. `/` commands always run on this host.

### `openai`: any OpenAI-compatible API (called by the desk)

```toml
[[ask_target]]
id = "openrouter"                    # letters, digits, - _
label = "OpenRouter"
kind = "openai"
url = "https://openrouter.ai/api/v1"
key_env = "OPENROUTER_API_KEY"       # set in ~/.config/agent-desk/env; never sent to the page
default_model = "deepseek/deepseek-chat"
# models = ["deepseek/deepseek-chat", "anthropic/claude-sonnet-5-5"]  # else GET {url}/models
# system = "Answer briefly."
```

Works with OpenRouter, OpenAI, Ollama (`http://127.0.0.1:11434/v1`, no key),
LM Studio, vLLM, llama.cpp server, and others that speak `/chat/completions`.

### `sanatana-hub`: a Sanatana hub ask box (called by the page)

```toml
[[ask_target]]
id = "hub"
label = "Sanatana hub"
kind = "sanatana-hub"
url = "https://hub.example.com"
```

The page calls the hub's `/api/ask` with your own hub sign-in, so no secret is stored on
the desk. The hub must allow the desk's address (`HUB_ASK_CORS_ORIGINS`) and share its
site (same registrable domain) so the sign-in cookie is sent. The picker offers the
hub's agents and models. The older `[hub] url = "…"` still works and means this.

### `browser`: any other service the page can call with its own sign-in

```toml
[[ask_target]]
id = "myapi"
label = "My API"
kind = "browser"
url = "https://api.example.com"
ask_path = "/v1/ask"                 # POST, JSON
input_field = "input"                # request field for the question (default "input")
history_field = "history"            # optional: [{role, content}] earlier turns
model_field = "model"                # optional: request field for the chosen model
output_field = "result.text"         # reply field with the answer, dotted path (default "output")
reply_model_field = "model"          # optional
models_path = "/v1/models"           # optional GET; or a fixed list: models = ["a", "b"]
models_field = "models"
credentials = "include"              # send cookies (default); "omit" for public APIs
```

The service must allow the desk's origin with CORS (with credentials, if it uses cookies).
A 401 shows a **Sign in** link to `url`.
