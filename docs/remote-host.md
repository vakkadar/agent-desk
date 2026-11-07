# Remote host guide (December unattended operation)

Host: HP desktop at home, Fedora, reached over Tailscale. Nobody is physically present for ~4 weeks.

## 1. Install

```bash
git clone <repo> && cd agent-desk
deploy/install.sh        # npm ci, build, install user units, enable --now, enable-linger
$EDITOR ~/.config/agent-desk/env   # AGENT_DESK_TOKEN, AGENT_DESK_DATA
systemctl --user restart agent-desk
npm run doctor           # must exit 0
```

The installer is idempotent. It renders `agent-desk.service` with the absolute node and repo paths
(works with nvm). Units: `herdr.service` (`herdr server`, headless) and `agent-desk.service`
(After/Wants herdr, `Restart=on-failure`, env from `~/.config/agent-desk/env`).

To bind to the tailnet, set `[network] bind = ["<tailscale ip>"]` and `readonly_allow`/`action_allow`
in `desk.toml`. Avoid `0.0.0.0`.

## 2. Hardening checklist (RH-6) — `npm run doctor` checks all but the BIOS item

- [ ] BIOS: "Restore on AC power loss" = On (manual; cannot be detected).
- [ ] Mask sleep: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`
      (screen lock is fine).
- [ ] Auto-updates must not reboot unattended: no `dnf-automatic` timer, or `reboot = never`
      in `/etc/dnf/automatic.conf`. If a reboot happens, linger + enabled units bring everything back.
- [ ] Tailscale: `sudo systemctl enable --now tailscaled`; disable key expiry for this host in the
      admin console; enable Tailscale SSH (`sudo tailscale set --ssh`).
- [ ] `claude auth status` shows logged in; confirm the login stays valid 30+ days.
- [ ] `loginctl enable-linger $USER`.
- [ ] Free disk >= 5 GB on the data dir (`AGENT_DESK_MIN_FREE_GB` overrides).
- [ ] Data repo has a private `origin` remote and `git ls-remote origin` works (RH-8 backup).
- [ ] `AGENT_DESK_TOKEN` set, bind is not `0.0.0.0`.

## 3. Recovery path (RH-5)

From the laptop, when the web UI is unreachable:

1. `tailscale ssh <host>` (or plain `ssh` over the tailnet).
2. `systemctl --user status agent-desk herdr`
3. `systemctl --user restart agent-desk` (herdr sessions persist; agent-desk re-attaches).
   If herdr is wedged: `systemctl --user restart herdr` (sessions resume via `claude --resume`).
4. `journalctl --user -u agent-desk -e`
5. Raw TUI: `herdr --remote <host>` attaches to the live herdr session.
6. Run `npm run doctor` on the host.
7. Whole host down and no power-restore: nothing remote can fix it; ask someone at home.

## 4. Health page (RH-7)

Header "Health" button, or `GET /healthz` (JSON, available to the read-only role): uptime, herdr,
agent, last git push, disk, auth, usage limit. Items are `{level: ok|warn|fail|unknown, detail}`.
Modules add rows with `registerHealth(name, fn)` from `src/health.ts`.

## 5. Soak test plan (RH-9)

Freeze features ~2026-11-24. Soak 2026-11-25 to 2026-11-30 (>= 5 days) on the HP host.

- Day 0: install, `npm run doctor` clean, start long-running threads in several modes.
- Daily: check Health page from phone over tailnet with ~250 ms latency (throttle if needed),
  confirm last git push is recent, disk stable, approvals reconnect after dropping the link.
- Day 2: `systemctl --user restart agent-desk` mid-turn; confirm nothing lost.
- Day 3: `kill` the agent-desk process; confirm systemd restarts it. Restart herdr; confirm threads resume.
- Day 4: full host reboot with nobody logged in; confirm services return, threads resume, doctor passes.
- Day 4: power-cycle test (BIOS restore on AC loss) if someone is home.
- Exit criteria: 5 days without manual intervention beyond the planned tests; no data loss;
  doctor exits 0; memory and disk flat.
