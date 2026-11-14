# Agents: builder and reviewer

Every project thread runs as a pair in herdr: a builder pane and a reviewer pane. Which coding
agents fill them is set in the desk: command palette → **Settings: agents**, or a thread's
menu → **Builder and reviewer agents**.

Known agents, found on `PATH` or in their usual install folder:

| Agent | Binary | Also looked for in |
|---|---|---|
| Claude Code | `claude` | `~/.local/bin`, `~/.claude/local` |
| Codex | `codex` | `~/.npm-global/bin`, `~/.local/bin` |
| opencode | `opencode` | `~/.opencode/bin`, `~/.local/bin` |

Tick the agents this desk may use (any number), then pick the builder and the reviewer from
them. The same agent twice is fine. Claude runs with the desk's model (builder `sonnet`,
reviewer `opus`); Codex and opencode use their own config.

Saved in `<data>/agents.json`:

```json
{ "enabled": ["claude", "opencode"], "builder": "claude", "reviewer": "opencode" }
```

The data repo is shared by the hosts, so a pick that is not installed on this host is dropped
there: the builder falls back to Claude, the reviewer to the first other installed agent (else
the builder). With no file, the desk uses what is installed the same way.

New pair tabs use the current pick. Panes already running keep their agents; close the thread's
tab (or the pane) to restart it with the new one.

The panes are terminal programs; the desk types into them and reads the reviewer's verdict file.
No Agent Client Protocol (ACP) is needed for this.
