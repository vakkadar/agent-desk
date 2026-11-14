# Compute perspective

Alt+5 in the desk (admin profile, signed in with the desk token). One place for the machines
and hosting accounts: who is online on the tailnet, power on/off, a few ssh commands, and a
fixed menu of Hostinger and GoDaddy API calls. The browser only names a machine and a menu
entry; every command and URL is fixed in `src/compute.ts`. Power-off, restart and reboot ask twice.

## Machines: `<data>/compute.toml` (no secrets here)

```toml
[[machine]]
id = "hp"
label = "HP desktop"
group = "Home"
tailscale = "hp"                  # online / last seen / IP from `tailscale status`
ssh = "vakkadar@hp"               # Uptime, Disk, Reboot, Shut down
ha_power = "switch.hp_desktop"    # Home Assistant entity: Power on / Power off (switch, script, input_boolean; button = on only)

[[machine]]
id = "imac-linux"
label = "iMac · Linux"
group = "iMac"
tailscale = "imac"
ssh = "vakkadar@imac"
wake_mac = "aa:bb:cc:dd:ee:ff"    # Wake-on-LAN from the desk's host (same LAN)
[[machine.action]]                # extra ssh commands
label = "Boot macOS next"
run = "sudo -n efibootmgr --bootnext 0080 && sudo -n systemctl reboot"   # check the entry with efibootmgr
confirm = true

[[machine]]
id = "imac-mac"
label = "iMac · macOS"
group = "iMac"
os = "macos"
tailscale = "imac-mac"            # whatever name macOS has on the tailnet
ssh = "vakkadar@imac-mac"

[[machine]]
id = "windows"
label = "Windows PC"
group = "Home"
os = "windows"                    # needs the OpenSSH Server feature on Windows
tailscale = "desktop-3pmk32r"
ssh = "vakkadar@desktop-3pmk32r"

[[machine]]
id = "sanatana-gateway"
group = "Home"
tailscale = "sanatana-gateway"
ssh = "vakkadar@sanatana-gateway"

[[machine]]
id = "iphone"
label = "iPhone"
group = "Devices"
os = "ios"                        # status only
tailscale = "iphone182"

[[machine]]
id = "hostinger"
label = "Hostinger VPS"
group = "Cloud"
os = "vps"
tailscale = "srv1330230"
hostinger_vm = 1330230            # VPS id from hPanel or the "Virtual machines" menu entry
ssh = "root@srv1330230"

[[machine]]
id = "godaddy"
label = "GoDaddy"
group = "Cloud"
os = "domains"
godaddy = true
```

`os`: linux (default), macos, windows, ios, vps, domains.

## Secrets: `~/.config/agent-desk/secrets.toml` (chmod 600, never in git)

```toml
[home_assistant]
url = "http://homeassistant.local:8123"
token = "…"          # HA profile → Security → Long-lived access tokens

[hostinger]
token = "…"          # hPanel → Profile → API

[godaddy]
key = "…"            # developer.godaddy.com/keys (Production)
secret = "…"
```

The desk refuses the file if group/others can read it. Another path: `AGENT_DESK_SECRETS`.

## Menus

| Source | Entries |
|---|---|
| Home Assistant | Power on, Power off (service call on `ha_power`); state shown as "power" |
| Wake-on-LAN | Wake (LAN) — magic packet from the desk's host |
| ssh | Uptime, Disk, Reboot, Shut down, plus `[[machine.action]]` |
| Hostinger | Start / Restart / Stop VPS; Virtual machines, This VPS, Metrics (24 h), Action log, Backups, Domains, DNS zone, Subscriptions |
| GoDaddy | Domains, Domain details, DNS records (read-only) |

Notes:
- ssh runs with `BatchMode=yes` (keys only). Reboot/Shut down on Linux and macOS use `sudo -n`:
  allow them in sudoers, e.g. `vakkadar ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff`.
- "Too many authentication failures": the ssh agent offers too many keys; add a `Host` block with
  `IdentityFile` and `IdentitiesOnly yes` in `~/.ssh/config`.
- GoDaddy limits its Domains/DNS API to accounts with 10+ domains (or Discount Domain Club); others get 403.
- Output is redacted for secrets and cut at 20 kB.
