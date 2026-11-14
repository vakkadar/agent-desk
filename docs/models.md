# Model per activity

Which Claude model runs a turn or a pair pane. Set in `<dataDir>/desk.toml`; restart the desk after editing.

```toml
[model]
design   = "opus"      # design threads (headless turns and their builder pane)
code     = "sonnet"    # code threads
ask      = "sonnet"    # project Ask and General questions
schedule = "haiku"     # scheduled prompts
lead     = "sonnet"    # a project's lead builder pane
reviewer = "opus"      # every reviewer pane that runs Claude
general  = "haiku"     # any source id: wins over its activity
```

Headless turns (the desk's own Claude, `claude -p`), first match wins:
1. the `[[schedule]]` entry's own `model` (scheduled runs only)
2. the source id
3. `schedule` (scheduled runs only)
4. the thread's mode: `ask`, `design` or `code`
5. nothing: Claude picks its own default

Pair panes (herdr builder | reviewer):
- builder: the source id, else `lead` for the lead tab or the thread's mode; default `sonnet`
- reviewer: `reviewer`; default `opus`
- A pane already running keeps its model; the new one applies when the pane's agent next starts.
- Codex and opencode panes ignore this and use their own config.

Not affected: a prompt sent into your own open Claude window (live sessions) and Ask targets
(`[[ask_target]]`, which have their own model picker).

Values: any name `claude --model` accepts (`opus`, `sonnet`, `haiku`, or a full id such as
`claude-opus-5-5`). A value with spaces or shell characters is skipped with a warning.
