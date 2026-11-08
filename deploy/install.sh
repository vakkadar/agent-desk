#!/usr/bin/env bash
# Idempotent install of agent-desk + herdr as systemd user units.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
UNITS="$HOME/.config/systemd/user"
ENVF="$HOME/.config/agent-desk/env"

cd "$REPO"
npm ci
npm run build

mkdir -p "$UNITS" "$(dirname "$ENVF")"
install -m 644 deploy/systemd/herdr.service "$UNITS/herdr.service"
sed -e "s#@NODE@#$NODE#g" -e "s#@REPO@#$REPO#g" deploy/systemd/agent-desk.service > "$UNITS/agent-desk.service"

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

systemctl --user daemon-reload
systemctl --user enable --now herdr.service agent-desk.service
loginctl enable-linger "$USER"
echo "done. next: npm run doctor"
