# Upgrading the desk host to a new Fedora release

Example: Fedora 44 → 45 on the HP host (`hp-lan`). Do it while someone can reach the
machine: if it doesn't boot, it needs a keyboard and screen.

Run everything in a terminal on the host: `ssh -t hp-lan`.

## 1. Bring the current release fully up to date

```
sudo dnf upgrade --refresh -y && sudo reboot
```

## 2. Download the new release (after reconnecting)

```
sudo dnf system-upgrade download --releasever=45 -y
```

If a third-party repo has no packages for the new release yet (often `docker-ce-stable`),
skip it for the upgrade:

```
sudo dnf system-upgrade download --releasever=45 -y --disablerepo=docker-ce-stable
```

If it fails with `nodejs-docs ... requires nodejs = ...fc43` / `does not belong to a
distupgrade repository`: Node packages left over from an older release. Fedora 44+ names
them `nodejs22` / `nodejs24`; switch to `nodejs22` (what the desk host runs), then retry:

```
sudo dnf remove nodejs-docs nodejs-full-i18n
sudo dnf install --allowerasing nodejs22 nodejs22-npm nodejs22-bin
node -v   # v22.x
```

## 3. Install and reboot

```
sudo dnf offline reboot
```

SSH drops. The install runs offline (about 20–60 minutes), then the machine reboots by itself.

## 4. Check afterwards

```
ssh hp-lan 'cat /etc/fedora-release; systemctl --user is-active agent-desk'
```

- Open the desk through the tunnel (agent-desk.sanatanadharma.cloud) and check it loads.
- If the Node version changed, reinstall and rebuild the desk:

```
ssh hp-lan 'cd ~/projects/agent-desk && npm ci && npm run build && systemctl --user restart agent-desk'
```

sshd, tailscaled and the desk (user service with linger on) start by themselves after a reboot.
