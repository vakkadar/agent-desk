#!/usr/bin/env bash
# Upgrade this machine to the next Fedora release (or the one given), in safe steps.
# Works on the desk host (HP) and on a laptop. Run it again after each reboot: it checks
# where it is and carries on.
#
#   bash deploy/fedora-upgrade.sh            # next release (e.g. 44 → 45)
#   bash deploy/fedora-upgrade.sh 45
#   bash deploy/fedora-upgrade.sh 45 --disablerepo=docker-ce-stable   # extra args go to dnf download
#
# Steps: 1) swap leftover old-release Node packages for nodejs22, 2) bring the current release
# fully up to date (reboot if the kernel changed), 3) download the new release, 4) offline
# reboot to install it, 5) after it: rebuild agent-desk if Node changed and restart it.
# See deploy/fedora-upgrade.md for the same steps by hand.
set -euo pipefail

cur=$(rpm -E %fedora)
target="${1:-$((cur + 1))}"
shift || true
extra=("$@")
desk="$(cd "$(dirname "$0")/.." && pwd)"

ask() { read -rp "$1 [y/N] " a; [[ "$a" == [yY]* ]]; }
say() { printf '\n== %s\n' "$*"; }

say "This machine: Fedora $cur, kernel $(uname -r), node $(node -v 2>/dev/null || echo none)"

# 5) Already on the target release: finish up.
if (( cur >= target )); then
  say "Already on Fedora $cur. Finishing up."
  if [[ -f "$desk/package.json" ]]; then
    say "Rebuilding agent-desk for this Node ($(node -v))"
    (cd "$desk" && npm ci && npm run build)
    if systemctl --user cat agent-desk >/dev/null 2>&1; then
      systemctl --user restart agent-desk
      sleep 2
      systemctl --user is-active agent-desk >/dev/null && echo "agent-desk restarted." \
        || echo "agent-desk did not come back: journalctl --user -u agent-desk -n 30" >&2
    else
      echo "No agent-desk service here; start it as usual (npm start)."
    fi
  fi
  sudo dnf system-upgrade clean -y >/dev/null 2>&1 || true
  echo "Done."
  exit 0
fi

say "Upgrade plan: Fedora $cur → $target"
ask "Continue?" || exit 0

# 1) Old-release Node packages (named nodejs, nodejs-libs, ...) can't be carried over;
#    Fedora 44+ ships nodejs22 / nodejs24. Remove first: installing over them is a file conflict.
old=$(rpm -qa 'nodejs' 'nodejs-libs' 'nodejs-npm' 'nodejs-docs' 'nodejs-full-i18n' --qf '%{name}\n' | sort -u | tr '\n' ' ')
if [[ -n "${old// }" ]]; then
  say "Swapping old Node packages ($old) for nodejs22"
  sudo dnf remove -y $old
  sudo dnf install -y nodejs22 nodejs22-npm nodejs22-bin
  node -v
fi

# 2) Fully update the current release first.
say "Updating Fedora $cur"
sudo dnf upgrade --refresh -y
if ! sudo dnf needs-restarting -r >/dev/null 2>&1; then
  say "A reboot is needed before upgrading. Run this script again afterwards."
  ask "Reboot now?" && sudo reboot
  exit 0
fi

# 3) Download the new release.
say "Downloading Fedora $target"
if ! sudo dnf system-upgrade download --releasever="$target" -y "${extra[@]}"; then
  echo
  echo "Download failed. Common fixes:" >&2
  echo "  - a third-party repo has no Fedora $target packages yet: run again with" >&2
  echo "      --disablerepo=<repo>   (list: dnf repolist)" >&2
  echo "  - 'does not belong to a distupgrade repository': remove or swap that package, then rerun" >&2
  exit 1
fi

# 4) Install offline.
say "Ready. The machine reboots, installs Fedora $target offline (20–60 min), then reboots again."
echo "Afterwards run this script once more to rebuild and restart agent-desk."
ask "Reboot and install now?" && sudo dnf offline reboot
