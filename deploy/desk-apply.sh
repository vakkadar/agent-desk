#!/bin/sh
# Restart the desk on a new build and keep it only if it comes up healthy.
# Started by the desk (src/desk-apply.ts) through `systemd-run --user`, so it runs outside the
# desk's own cgroup and survives the restart it causes.
#
#   desk-apply.sh <repo> <unit> <health-url> <result-file> <apply-id> <commit>
#
# Healthy: /healthz answers {"ok":true...} within 60 s.        -> result "live"
# Not:     dist.prev goes back to dist, <commit> is reverted,
#          the desk restarts on the old build.                  -> result "rolled back"
# The result file is read by whichever desk process is up afterwards.
set -u
REPO=$1 UNIT=$2 URL=$3 RESULT=$4 ID=$5 COMMIT=$6
TRIES=${DESK_APPLY_TRIES:-30}

say() { # state reason
  r=$(printf '%s' "$2" | tr '"\\\n' "'/ ")
  printf '{"id":%s,"state":"%s","reason":"%s","at":"%s"}\n' "$ID" "$1" "$r" "$(date -Is)" > "$RESULT.tmp" && mv "$RESULT.tmp" "$RESULT"
}
healthy() {
  i=0
  while [ "$i" -lt "$TRIES" ]; do
    sleep 2
    curl -fsS -m 3 "$URL" 2>/dev/null | grep -q '"ok":true' && return 0
    i=$((i + 1))
  done
  return 1
}

systemctl --user restart "$UNIT"
if healthy; then say live ""; exit 0; fi

cd "$REPO" || { say failed "repo $REPO is gone"; exit 1; }
why="new build did not pass its health check"
if [ -d dist.prev ]; then rm -rf dist && mv dist.prev dist; else why="$why; no previous build to put back"; fi
m=""
[ "$(git rev-list --parents -n1 "$COMMIT" | wc -w)" -gt 2 ] && m="-m 1"
if h=$(git -c user.name=agent-desk -c user.email=agent-desk@localhost revert --no-edit $m "$COMMIT" >/dev/null 2>&1 && git rev-parse --short HEAD); then
  why="$why; reverted in $h"
else
  git revert --abort >/dev/null 2>&1
  why="$why; revert failed, source still has $COMMIT"
fi
systemctl --user restart "$UNIT"
if healthy; then say "rolled back" "$why"; else say failed "$why; the old build did not come up either"; fi
