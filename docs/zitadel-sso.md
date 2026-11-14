# Zitadel login for Photos (Immich) and agent-desk

One identity for the family: Zitadel at `https://id.sanatanadharma.cloud` (Hostinger).

| App | Hostname | How it uses Zitadel | Who gets in |
|---|---|---|---|
| Immich | `photos.sanatanadharma.cloud` | Immich's own OIDC login (works in the phone app) | the 4 family users |
| agent-desk | `agent-desk.sanatanadharma.cloud` | Cloudflare Access with Zitadel as its login method | you only |

Path for both: Cloudflare Tunnel (sanatana-gateway) → Traefik → HP.
The desk's Photos perspective calls Immich on `http://127.0.0.1:2283` with an API key and is not affected.

## 1. Zitadel: projects and apps

In the Zitadel console:

1. **Project `family-photos`**
   - Turn on **Check authorization on authentication**: users without a grant are refused.
   - Role `member`, granted to the 4 family users.
   - Application, type **Web**, flow **Code**, auth **client secret (basic)**:
     - Redirect URIs:
       - `https://photos.sanatanadharma.cloud/auth/login`
       - `https://photos.sanatanadharma.cloud/user-settings`
       - `https://photos.sanatanadharma.cloud/api/oauth/mobile-redirect`
     - Post-logout URI: `https://photos.sanatanadharma.cloud`
2. **Project `agent-desk`**
   - Turn on **Check authorization on authentication**.
   - Role `owner`, granted to you only.
   - Application, type **Web**, flow **Code**, auth **client secret (basic)**:
     - Redirect URI: `https://sanatanadharma.cloudflareaccess.com/cdn-cgi/access/callback`

Keep each client secret in your password manager. Never commit a client secret.

## 2. Immich OAuth

Go to Immich → Administration → Settings → Authentication Settings → OAuth:

| Field | Value |
|---|---|
| Enable | on |
| Issuer URL | `https://id.sanatanadharma.cloud` |
| Client ID / Secret | from the `family-photos` app |
| Scope | `openid email profile` |
| Button text | `Login with Sanatana ID` |
| Auto register | on |
| Mobile redirect URI override | on, `https://photos.sanatanadharma.cloud/api/oauth/mobile-redirect` |

Immich matches accounts by email. An existing account links on its first OAuth login when the email is the same.

When all 4 family users can log in through Zitadel, turn **Password Authentication** off.

In the phone app, use server URL `https://photos.sanatanadharma.cloud` and tap the OAuth button.

## 3. Cloudflare Access for agent-desk

1. Go to Zero Trust → Settings → Authentication → Login methods → Add new → **OpenID Connect**:
   - App ID / Client secret: from the `agent-desk` app
   - Auth URL: `https://id.sanatanadharma.cloud/oauth/v2/authorize`
   - Token URL: `https://id.sanatanadharma.cloud/oauth/v2/token`
   - Certificate URL: `https://id.sanatanadharma.cloud/oauth/v2/keys`
   - Scopes: `openid email profile`
   - PKCE: on
   - Click **Test**. It should come back with your email.
2. Open Access → Applications → agent-desk:
   - Under Login methods, select only the Zitadel method and turn on instant auth.
   - Keep the Allow policy that includes your email.

Nothing changes in the desk. `src/net/cfaccess.ts` still checks the Access JWT (team, AUD, email), and the JWT carries the same email whichever login method issued it. The action token is still needed for prompts and approvals.

Other Access apps (dev, shell, grafana, …) can switch the same way.

## 4. Checks

```sh
# Immich: OAuth on; password login off once everyone has logged in
curl -s https://photos.sanatanadharma.cloud/api/server/features | tr , '\n' | grep -E 'oauth|passwordLogin'

# Desk logged out: 302 to the Access login, which hands over to Zitadel
curl -sI https://agent-desk.sanatanadharma.cloud | grep -i location

# Desk through the tunnel without a valid Access JWT: 403
# (see docs/cloudflare-tunnel.md, "Verify")
```

To check by hand:

- A Zitadel user without the `family-photos` grant is refused at login.
- A family user is refused on agent-desk.

## Rollback

- **Immich:** turn Password Authentication back on (as admin, before turning OAuth off), then turn OAuth off.
- **Access:** put the previous login method back on the agent-desk app.
