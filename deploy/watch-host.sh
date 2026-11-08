#!/usr/bin/env bash
# Host-down alert. Run on ANOTHER machine (a laptop), not on the desk host.
# Fetches the desk's /healthz every 5 min and alerts only when it changes:
#   ok -> down (after 2 failed checks in a row), or down -> ok.
# Alerts: notify-send (if installed) and, if NTFY_TOPIC is set, https://ntfy.sh/$NTFY_TOPIC
# (install the ntfy app on the phone and subscribe to the same topic).
#
# Install:
#   mkdir -p ~/.config/agent-desk ~/.config/systemd/user
#   cp deploy/watch-host.sh ~/.local/bin/agent-desk-watch && chmod +x ~/.local/bin/agent-desk-watch
#   cp deploy/systemd/agent-desk-watch.{service,timer} ~/.config/systemd/user/
#   printf 'WATCH_URL=http://hp-lan:7420/healthz\nNTFY_TOPIC=pick-a-long-random-name\n' > ~/.config/agent-desk/watch.env
# If the desk port is firewalled from this machine, check over ssh instead (needs key auth):
#   WATCH_SSH=hp  -> runs `curl http://127.0.0.1:7420/healthz` on that host
#   systemctl --user daemon-reload && systemctl --user enable --now agent-desk-watch.timer
# Test: run agent-desk-watch by hand; logs: journalctl --user -u agent-desk-watch
set -u

STATE="$HOME/.cache/agent-desk-watch.state"   # "<ok|down> <consecutive failures>"
ENV="${WATCH_ENV:-$HOME/.config/agent-desk/watch.env}"
[ -f "$ENV" ] && . "$ENV"
URL="${WATCH_URL:-http://hp-lan:7420/healthz}"

read -r last fails 2>/dev/null < "$STATE" || { last=ok; fails=0; }

check() {
  if [ -n "${WATCH_SSH:-}" ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$WATCH_SSH" "curl -fsS --max-time 10 -o /dev/null http://127.0.0.1:7420/healthz" 2>/dev/null
  else
    curl -fsS --max-time 10 -o /dev/null "$URL" 2>/dev/null
  fi
}
[ -n "${WATCH_SSH:-}" ] && URL="ssh $WATCH_SSH (127.0.0.1:7420/healthz)"

if check; then
  now=ok; fails=0
else
  now=$last; fails=$((fails + 1))
  [ "$fails" -ge 2 ] && now=down
fi

alert() {
  command -v notify-send >/dev/null && notify-send -u critical "agent-desk host" "$1"
  [ -n "${NTFY_TOPIC:-}" ] && curl -fsS --max-time 10 -H "Title: agent-desk host" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null
  echo "$1"
}

if [ "$now" != "$last" ]; then
  if [ "$now" = down ]; then alert "DOWN: $URL failed $fails checks in a row"; else alert "back UP: $URL"; fi
fi

mkdir -p "$(dirname "$STATE")"
echo "$now $fails" > "$STATE"
exit 0
