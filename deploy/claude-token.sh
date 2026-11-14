#!/usr/bin/env bash
# Give agent-desk on this machine a long-lived Claude login (about a year), so desk
# turns keep working without anyone logging in with a browser on this box.
#
# Run it ON the host, in a real terminal (it is interactive), e.g. from your laptop:
#   ssh -t hp-lan 'bash ~/projects/agent-desk/deploy/claude-token.sh'
#
# Steps: `claude setup-token` prints a URL; open it on any device where you are logged
# in to claude.ai, approve, paste the code back. It then prints a token; paste that when
# asked. The token goes into ~/.config/agent-desk/env (mode 600) as
# CLAUDE_CODE_OAUTH_TOKEN, and the desk restarts to pick it up.
set -euo pipefail

# The desk runs as a systemd user unit on Linux, a launchd agent on macOS (deploy/install.sh).
restart_desk() {
  if [ "$(uname -s)" = Darwin ]; then launchctl kickstart -k "gui/$(id -u)/com.agent-desk.server"; else systemctl --user restart agent-desk; fi
}
desk_up() {
  if [ "$(uname -s)" = Darwin ]; then launchctl print "gui/$(id -u)/com.agent-desk.server" 2>/dev/null | grep -q "state = running"
  else systemctl --user is-active agent-desk >/dev/null; fi
}

ENV_FILE="${HOME}/.config/agent-desk/env"
HERDR="${AGENT_DESK_HERDR_BIN:-herdr}"

command -v claude >/dev/null || { echo "claude not on PATH" >&2; exit 1; }

echo "== 1/3  claude setup-token (open the URL it shows, approve, paste the code back)"
claude setup-token
echo
read -rsp "== 2/3  Paste the token it printed (starts with sk-ant-), then Enter: " TOKEN
# A long token may be copied as several wrapped lines: take any lines that follow at once.
while IFS= read -rs -t 0.5 more; do TOKEN+="$more"; done
echo
TOKEN="${TOKEN//[[:space:]]/}"
if [[ "$TOKEN" != sk-ant-* ]]; then
  echo "That does not look like a Claude token (got ${#TOKEN} chars, starting '${TOKEN:0:4}'); nothing changed." >&2
  echo "Copy the whole line starting sk-ant- from the output above and run this again." >&2
  exit 1
fi

echo "== Checking the token works"
if ! out=$(env -u ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" claude -p "Reply with the single word: ok" 2>&1); then
  echo "Token check failed; nothing changed:" >&2
  echo "$out" | tail -5 >&2
  exit 1
fi

echo "== 3/3  Saving to ${ENV_FILE} and restarting the desk"
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
tmp="$(mktemp "${ENV_FILE}.XXXX")"
grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" > "$tmp" || true
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$TOKEN" >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"

# The desk's own herdr session was started by the old desk process and kept its env;
# stop it so the restarted desk starts it again with the token. (Your own herdr
# sessions are untouched.)
env $(env | grep -o '^HERDR_[A-Z_]*' | sed 's/^/-u /') "$HERDR" --session agent-desk server stop >/dev/null 2>&1 || true
restart_desk
sleep 2
desk_up && echo "Done. Desk restarted with the long-lived login." || {
  echo "Desk did not come back up: journalctl --user -u agent-desk -n 30" >&2; exit 1; }
