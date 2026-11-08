# Scheduled prompts

Define in `<dataDir>/desk.toml`; restart the desk after editing.

```toml
[[schedule]]
name = "morning"            # unique; shown in the Schedules list
at = "07:30"                # daily, local time (HH:MM)
days = ["mon", "tue", "wed", "thu", "fri"]   # optional; default every day
source = "general"          # "general" (default) or a project source id
prompt = "Summarize what changed overnight."

[[schedule]]
name = "poll"
every = "6h"                # alternative to `at`: 30m, 6h, 1d (not with days)
source = "myproject"
prompt = "Check CI and report failures."
```

Rules:
- Same path as a typed prompt, same permission mode (`[permission_mode]`) for that source; approvals show in the browser as usual.
- General: each run starts a new question titled `⏰ morning · 2026-11-07` (`every` adds the time).
- Project: runs in the project's `ask` thread on the desk's own session, never your open herdr window.
- A run is skipped if the previous run of the same schedule is still going.
- Last run times live in `.index/schedule-state.json`. Slots missed while the desk was down are not caught up.
- `⋯` menu → Schedules shows next/last run and a "Run now" button (action role only).
