# 🔐 Sessions, Refresh Tokens & API Docs Hosting

> **TL;DR** — Bearer tokens no longer live for 24 hours untouched, sessions actually die when you log out, email verification updates itself, and `/api/docs` finally moved off the public API host.

<br>

```
╔══════════════════════════════════════════════════════════════╗
║   BEFORE                        →        AFTER                ║
╠══════════════════════════════════════════════════════════════╣
║  🔓 24h JWT, never re-checked   →   ⏱️  15min access token     ║
║  🚪 "Logout" did nothing        →   🔒  Logout actually kills  ║
║                                       the session               ║
║  🔄 Manual refresh to verify    →   ✨  Live-updating badge     ║
║  📖 /api/docs on public host    →   🛡️  Isolated docs listener ║
╚══════════════════════════════════════════════════════════════╝
```

---

## 1️⃣ Session Model

### ⚠️ The problem it replaces

Previously, `/auth/login` issued **one JWT, valid for 24 hours**, and nothing ever rechecked it. That meant:

- 💥 an expired token surfaced as a random failure *mid-flow*
- 🚫 logout **could not actually end anything** — the token stayed valid
- 🔃 verification state was read once at page load → required a manual refresh

### ✅ The new two-token model

| 🎫 Token | ⏳ Lifetime | 🎯 Purpose |
|---|---|---|
| **Access token** *(JWT, HS256)* | `AUTH_ACCESS_TOKEN_TTL_MS` → **15 min** | Sent as `Authorization: Bearer`. Carries a `sid` claim binding it to a session row. |
| **Refresh token** *(opaque)* | `AUTH_REFRESH_TOKEN_TTL_MS` → **7 days** | `POST /auth/refresh` exchanges it for a new access token. **Single-use** — every call rotates it. |

Two independent deadlines end a session — **whichever fires first**:

```
   session start                                           
        │                                                   
        ├──────────────── 30 min idle ─────────► 💀 session_idle_timeout
        │        (resets on every /auth/refresh)             
        │                                                     
        └──────────────── 12 h absolute ───────► 💀 session_absolute_timeout
                 (fixed from sign-in, never resets)
```

> Both limits are enforced **server-side** on every `/auth/refresh`. The client-side countdown is a courtesy — not the control.

### 🗄️ Storage

- Sessions live in `auth_sessions` → `db/migrations/0009_auth_sessions.sql`
- `auth-service` also applies this DDL itself at boot (like the other security tables)
- Only the **SHA-256 hash** of the refresh secret is stored — a table dump can't be replayed 🔒

The refresh token itself is formatted:

```
<sessionId>.<secret>
```

The session id travels in the clear *on purpose*: if an already-rotated token shows up, the session can still be located and revoked.

### 🚨 Reuse detection

```
   Client A ──refresh──► [rotates] ──► ✅ new token issued
                                              │
   Client B (stolen copy) ──refresh (old token)──► ❌ 401
                                              │
                                     🔥 SESSION REVOKED IMMEDIATELY
                                     { reason: 'refresh_token_reuse' }
```

A successful refresh rotates the secret. If a **consumed** token is presented again — replay attack, or a stolen copy racing the real client — the session is nuked on the spot. This mirrors the **OAuth 2.0 Security BCP** behavior for public clients.

### 💀 What revokes a session

| Trigger | `revoked_reason` |
|---|---|
| `POST /auth/logout` | `logout` |
| `POST /auth/logout-all` | `logout_all` |
| Idle deadline passed | `session_idle_timeout` |
| Absolute deadline passed | `session_absolute_timeout` |
| Consumed refresh token replayed | `refresh_token_reuse` |
| Password reset via emailed link | `password_reset` |
| Password changed while signed in | `password_changed` |

> 🧠 **Honest limitation:** revocation kills the *refresh* token instantly — but an already-issued **access token stays valid** for its remaining minutes, because verifying it is stateless. That's exactly *why* the access TTL is 15 minutes instead of a day. Checking revocation on every request would mean a DB round-trip per API call; if you need that, bolt on a Redis deny-list keyed on `sid`.

### 🖥️ Browser behaviour

- 🔁 Renews the access token ~1 minute before expiry — **only if the user was active in the last 5 minutes**, otherwise the timer alone would keep the server session alive forever and idle timeout would never fire
- 🚦 **Single-flight**: concurrent requests share one refresh call (two parallel exchanges of a single-use token would *look like* a replay)
- ⏰ Shows a **"Still there?"** dialog 60 seconds before the idle cut-off → *Keep me signed in* / *Sign out now*
- 🙈 Returning to a background tab is **deliberately not** counted as activity — the whole point is catching a session that died while the tab sat idle
- 📡 `BroadcastChannel` + the `storage` event keep every open tab in sync — sign out (or verify) in one tab, it updates everywhere

### 🧪 Testing it quickly

```bash
AUTH_SESSION_IDLE_TIMEOUT_MS=60000 docker compose up -d auth-service
```

Sign in, walk away, watch the warning fire at 60s. Full coverage — rotation, reuse detection, idle timeout, logout revocation, verification-status flip — lives in:

```bash
npm test   # services/auth-service
```

---

## 2️⃣ Email Verification — No More Manual Refresh

**Before:** no UI at all. Verification state was frozen at whatever the page happened to load with. 😬

**Now:**

```
  📧 POST /auth/verify-email/request
         │
         ▼
  ✉️  emails  <APP_BASE_URL>/?verify=<token>
         │
         ▼
  🖱️  user clicks link → SPA reads ?verify= on load
         │
         ├─► confirms it
         ├─► strips token via history.replaceState  (no replay via reload/Referer leak)
         └─► ✅ badge updates in place
```

- While the account panel is open **and** the address is unverified, it polls `GET /auth/verify-email/status` every `AUTH_VERIFY_POLL_INTERVAL_MS` — so clicking the link in a mail client flips the badge on its own, live.
- Polling deliberately uses the **non-renewing** request path, so it can't keep a session alive by itself.
- Bounded to **15 minutes per open** ⏳.

> ⚠️ **`APP_BASE_URL` must be set per environment**, or the emailed link points at the wrong stack.

| Environment | `APP_BASE_URL` |
|---|---|
| dev | `http://dev.bakery.local` |
| uat | `http://uat.bakery.local` |

---

## 3️⃣ API Docs — Now on Their Own Ingress 🛡️

**The risk before:** anything that could reach the API could read the *entire* API surface via `/api/docs` — and there was no way to protect the docs without also locking down `/api` itself.

### 🏗️ The new shape

```
                     ┌─────────────────────────┐
   Public traffic ──►│   api-gateway :80/443    │──► upstream services
                     │   (proxy routes only)     │
                     │   /api/docs → 404 (early!)│
                     └─────────────────────────┘

                     ┌─────────────────────────┐
   Docs traffic  ──►│  api-gateway :3100 (DOCS)│   independent Express app
                     │  /api/docs  /docs         │   ⚠️ NO proxy routes —
                     │  /openapi.json  /health   │   worst case leak = spec only
                     └─────────────────────────┘
```

- 🧱 **Second, independent Express app** on `DOCS_PORT` (**3100**) serving `/api/docs`, `/docs`, `/openapi.json`, its own `/health` — **zero proxy routes**, so a leak exposes only the spec, never an upstream service.
- 🚫 The main listener returns `404` for `/api/docs` and `/api/openapi.json`, registered **before** the `/api` proxy — those paths can *never* be forwarded upstream.
- 📦 Service `api-docs` (port 3100) + Ingress `bakery-docs-ingress` (`k8s/base/ingress/api-docs-ingress.yaml`) publish it on its own host.

### 🌐 Where to find it

| Environment | Docs host |
|---|---|
| 🧪 dev | `docs.dev.bakery.local` |
| 🔎 uat | `docs.uat.bakery.local` |
| 🚀 production | **not deployed** — prod overlay excludes `../../base/ingress` |
| 🐳 docker compose | `http://localhost:3100/api/docs` |

### 🔧 Managing it yourself

Want your own Ingress instead? Drop `api-docs-ingress.yaml` from `k8s/base/ingress/kustomization.yaml` and point your object at the `api-docs` Service on port `3100`. Nothing else changes.

Want it **off** entirely?

```bash
DOCS_SERVER_ENABLED=false   # on the gateway Deployment
```

→ the port stops listening and the Ingress 502s.

### 🔑 Protecting it

A Traefik `basicAuth` Middleware named `docs-basic-auth` ships alongside the Ingress (annotation commented out so the manifest applies cleanly with no secret required). To turn it on:

```bash
htpasswd -nb docs 'a-strong-password'
kubectl -n bakery-dev create secret generic docs-basic-auth \
  --from-literal=users='docs:$apr1$....'
```

Then uncomment the `router.middlewares` line in `api-docs-ingress.yaml` (adjust the namespace prefix: `bakery-dev-docs-basic-auth@kubernetescrd`).

> 💡 Prefer SSO? The `authelia-forwardauth` middleware already used for the Adminer Ingress is an equally good fit.

### 🚪 Escape hatch

```bash
API_DOCS_ON_GATEWAY=true
```

Restores the old inline `/api/docs` on the public listener for local work. The gateway **logs a warning at startup** whenever this is on. ⚠️

---

<div align="center">

**🔐 Shorter-lived tokens · 🚪 Logout that works · ✨ Live verification · 🛡️ Isolated docs**

</div>
