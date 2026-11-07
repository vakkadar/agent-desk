# Serving agent-desk at desk.sanatanadharma.cloud (HP host)

Same pattern as `dev.sanatanadharma.cloud`: Cloudflare Tunnel from the HP desktop,
Cloudflare Access (Zero Trust) login in front. agent-desk keeps binding to
`127.0.0.1`; nothing is opened on the router.

Three layers:

| Layer | Who checks | What it gives |
|---|---|---|
| Cloudflare Access | Cloudflare edge | Only your Google login (+ MFA) reaches the host |
| Access JWT check | agent-desk (`src/net/cfaccess.ts`) | Tunnel traffic without a valid Access JWT for this app's AUD → 403, even if the Access policy is misconfigured |
| Action token | agent-desk | Access login alone = read-only; prompts/approvals need `AGENT_DESK_TOKEN` |

Tunnel traffic is detected by Cloudflare's `cf-ray` / `cf-connecting-ip` headers. It
never inherits localhost trust. If `[network.cloudflare_access]` is not configured,
all tunnel traffic is refused (fail closed).

## 1. Cloudflare Access application

Zero Trust → Access → Applications → Add an application → **Self-hosted**:

- Name: `agent-desk`
- Domain: `desk.sanatanadharma.cloud`
- Session duration: 24h (shorter is safer)
- Policy: Allow → Include → Emails → your email. Require MFA if available.
- Save, then copy the **Application Audience (AUD) Tag** from the app's Overview tab.

## 2. agent-desk config on HP

`~/agent-desk-data/desk.toml`:

```toml
[network]
bind = ["127.0.0.1"]

[network.cloudflare_access]
team = "sanatanadharma"            # sanatanadharma.cloudflareaccess.com
aud = "<AUD tag from step 1>"
emails = ["you@example.com"]       # optional, extra check on top of the Access policy
```

Token (required for action role over the tunnel), in `~/.config/agent-desk/env`:

```bash
AGENT_DESK_TOKEN=$(openssl rand -hex 24)
```

Restart: `systemctl --user restart agent-desk`.

## 3. Tunnel ingress

Add to the existing tunnel config on HP (`~/.cloudflared/config.yml`), **above** the
final `http_status:404` catch-all:

```yaml
  - hostname: desk.sanatanadharma.cloud
    service: http://localhost:7420
```

Then:

```bash
cloudflared tunnel route dns <tunnel-name> desk.sanatanadharma.cloud
sudo systemctl restart cloudflared
```

WebSockets work through the tunnel with no extra settings.

## 4. First login from a new browser

1. Open `https://desk.sanatanadharma.cloud/#token=<AGENT_DESK_TOKEN>`.
2. Cloudflare Access asks for login; after it, the page loads and stores the token
   in that browser's localStorage. The `#token` part never reaches the server logs.
3. The status pill should say **connected**. **read-only** means the token is missing or wrong.

## Verify

```bash
# On HP: direct = 200, fake tunnel request = 403
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7420/
curl -s -o /dev/null -w '%{http_code}\n' -H 'cf-ray: x' http://127.0.0.1:7420/
# From anywhere, logged out: 302 to sanatanadharma.cloudflareaccess.com
curl -sI https://desk.sanatanadharma.cloud | head -3
```

## Kill switch

Remove the `desk` ingress block and `sudo systemctl restart cloudflared`, or disable the
Access application. Tailscale access (`http://hp:7420` with allowlist) is unaffected.
