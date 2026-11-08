#!/usr/bin/env bash
# Create (or restart) a named herdr session that opens in a project folder.
# Run on the desk host (HP).
#
#   herdr-session <name> [dir] [--claude] [--desk]
#
#   name      herdr session name, e.g. hora-raj
#   dir       working folder (default ~/projects/<name>); created if missing
#   --claude  start `claude` in the session's first pane
#   --desk    add the session to live_sessions in desk.toml and restart agent-desk,
#             so the desk can drive a Claude window open in it
#
# Safe to re-run: a running session is left as is, a stopped one is started again,
# and the workspace is only created when the session has none for that label.
#
# Install: install -m755 deploy/herdr-session.sh ~/.local/bin/herdr-session
# Open it: herdr session attach <name>   (from the laptop: herdr --remote hp --session <name>)
# Stop it: herdr session stop <name>     (then `herdr session delete <name>` to remove it)
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

claude=0 desk=0 args=()
for a in "$@"; do
  case "$a" in
    --claude) claude=1 ;;
    --desk) desk=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *) args+=("$a") ;;
  esac
done
[ ${#args[@]} -ge 1 ] || { sed -n '2,18p' "$0"; exit 2; }
name=${args[0]}
dir=${args[1]:-$HOME/projects/$name}
dir=${dir/#\~/$HOME}
[[ $name =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad session name: $name" >&2; exit 2; }
case "$name" in default|agent-desk|general) echo "$name is used by the desk; pick another name" >&2; exit 2 ;; esac

mkdir -p "$dir"
dir=$(cd "$dir" && pwd)

h() { herdr --session "$name" "$@"; }
status=$(herdr session list | awk -v n="$name" '$1 == n { print $2 }')

if [ "$status" != running ]; then
  echo "starting session $name"
  (cd "$dir" && setsid nohup herdr --session "$name" server >/dev/null 2>&1 &)
  for _ in $(seq 20); do h workspace list >/dev/null 2>&1 && break; sleep 0.5; done
  h workspace list >/dev/null 2>&1 || { echo "session $name did not start (see ~/.config/herdr/herdr-server.log)" >&2; exit 1; }
else
  echo "session $name already running"
fi

pane=$(h workspace list | python3 -c '
import json, sys
ws = [w for w in json.load(sys.stdin)["result"]["workspaces"] if w.get("label") == sys.argv[1]]
print(ws[0]["workspace_id"] + ":p1" if ws else "")' "$name")

if [ -z "$pane" ]; then
  pane=$(h workspace create --cwd "$dir" --label "$name" --focus | python3 -c '
import json, sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
  echo "workspace $name created in $dir"
else
  echo "workspace $name already exists"
fi

if [ $claude = 1 ]; then
  # Never type "claude" into a pane that already runs it.
  has=$(h agent list | python3 -c '
import json, sys; print(any(a.get("agent") == "claude" for a in json.load(sys.stdin)["result"]["agents"]))')
  if [ "$has" = True ]; then
    echo "claude already running in session $name"
  else
    h pane run "$pane" claude >/dev/null
    echo "claude started in $pane"
  fi
fi

if [ $desk = 1 ]; then
  data=${AGENT_DESK_DATA:-$HOME/agent-desk-data}
  toml="$data/desk.toml"
  [ -f "$toml" ] || touch "$toml"
  if grep -q '^live_sessions *=' "$toml"; then
    if grep '^live_sessions *=' "$toml" | grep -q "\"$name\""; then
      echo "desk already watches $name"
    else
      sed -i "/^live_sessions *=/ { s/^live_sessions *= *\[/live_sessions = [\"$name\", /; s/, *\]/]/ }" "$toml"
      changed=1
    fi
  else
    # Top-level key: must sit above the first [table]. "default" stays, as before.
    sed -i "1i live_sessions = [\"default\", \"$name\"]" "$toml"
    changed=1
  fi
  if [ "${changed:-0}" = 1 ]; then
    grep '^live_sessions' "$toml"
    git -C "$data" commit -qm "Desk watches herdr session $name" desk.toml 2>/dev/null || true
    systemctl --user restart agent-desk && echo "agent-desk restarted"
  fi
fi

echo
echo "open:  herdr session attach $name    (laptop: herdr --remote hp --session $name)"
echo "stop:  herdr session stop $name"
