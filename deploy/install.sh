#!/usr/bin/env bash
# Idempotent install of agent-desk + herdr as user services:
#   Linux: systemd user units (deploy/systemd), linger on so they run without a login.
#   macOS: launchd agents (deploy/launchd) in ~/Library/LaunchAgents; they start at login,
#          so turn on automatic login for this user if the Mac should come back by itself.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
OS="$(uname -s)"
ENVF="$HOME/.config/agent-desk/env"

cd "$REPO"
npm ci
npm run build

mkdir -p "$(dirname "$ENVF")"

if [ ! -f "$ENVF" ]; then
  umask 077
  cat > "$ENVF" <<EOT
AGENT_DESK_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
AGENT_DESK_DATA=$HOME/agent-desk-data
EOT
  echo "created $ENVF (edit token/data dir as needed)"
fi

# Named herdr sessions: herdr-session (start one in a folder) and agent-desk-session (register, PIN, list).
mkdir -p "$HOME/.local/bin"
install -m 755 deploy/herdr-session.sh "$HOME/.local/bin/herdr-session"
printf '#!/bin/sh\nexec "%s" "%s/dist/hsession-cli.js" "$@"\n' "$NODE" "$REPO" > "$HOME/.local/bin/agent-desk-session"
chmod 755 "$HOME/.local/bin/agent-desk-session"

if [ "$OS" = Darwin ]; then
  AGENTS="$HOME/Library/LaunchAgents"
  mkdir -p "$AGENTS" "$HOME/Library/Logs/agent-desk"
  for l in com.agent-desk.herdr com.agent-desk.server; do
    sed -e "s#@NODE@#$NODE#g" -e "s#@NODEDIR@#$(dirname "$NODE")#g" -e "s#@REPO@#$REPO#g" -e "s#@HOME@#$HOME#g" \
      "deploy/launchd/$l.plist" > "$AGENTS/$l.plist"
    launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true # reload a changed plist
    launchctl bootstrap "gui/$(id -u)" "$AGENTS/$l.plist"
    launchctl enable "gui/$(id -u)/$l"
  done
  echo "logs: ~/Library/Logs/agent-desk/"
else
  UNITS="$HOME/.config/systemd/user"
  mkdir -p "$UNITS"
  install -m 644 deploy/systemd/herdr.service "$UNITS/herdr.service"
  sed -e "s#@NODE@#$NODE#g" -e "s#@REPO@#$REPO#g" deploy/systemd/agent-desk.service > "$UNITS/agent-desk.service"
  systemctl --user daemon-reload
  systemctl --user enable --now herdr.service agent-desk.service
  loginctl enable-linger "$USER"
fi
echo "done. next: npm run doctor"
