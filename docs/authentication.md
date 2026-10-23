# Authentication

SupportMe supports three ways to sign in. Whichever method a user picks, the
backend ends the flow the same way: it finds or creates a `User`, then issues a
JWT session in the same response shape. That means the frontend can treat every
sign-in identically once it has the token.

| Method | Backend endpoints | What proves identity |
| --- | --- | --- |
| Stellar wallet | `POST /api/auth/challenge`, `POST /api/auth/verify` | Signature over a server-issued nonce (SEP-0043/SEP-0053) |
| Twitter / X | `GET /api/auth/twitter`, `GET /api/auth/twitter/callback` | OAuth 2.0 Authorization Code + PKCE |
| Magic link | `POST /api/auth/magic-link`, `POST /api/auth/magic-link/verify` | Possession of a single-use, time-limited emailed token |

> The sign-in buttons and callback pages that drive the Twitter and magic-link
> flows live in the frontend and are tracked separately (issues #10 and #11).
> Until those land, you can exercise the backend flows directly with the
> `curl` walkthroughs below.

## Session shape

Every successful sign-in returns:

```json
{
  "user": { "id": 42, "walletAddress": "G...", "email": "creator@example.com" },
  "token": "<jwt>",
  "hasProfile": false,
  "username": "sammie"
}
```

`walletAddress` and `email` are nullable — an account created through one method
may not have the other identifier set yet. `hasProfile`/`username` tell the
frontend whether to send the user to profile creation or straight to the
dashboard. JWTs are signed with `JWT_SECRET` and expire after 7 days.

## 1. Stellar wallet sign-in

The wallet flow proves control of the private key for a Stellar public address;
the address alone is not sufficient to sign in. The frontend orchestration is
in [`AuthContext.tsx`](../frontend/context/AuthContext.tsx), wallet signing is
wrapped by [`wallet.js`](../frontend/lib/wallet.js), and the backend endpoints
are implemented in [`auth.ts`](../backend/src/routes/auth.ts).

### End-to-end flow

1. The user chooses a wallet in the Stellar Wallets Kit. The frontend obtains
  its public address and sends it to `POST /api/auth/challenge` as
  `{ walletAddress }`.
2. The backend validates the address, creates a cryptographically random
  16-byte nonce, and builds a message containing the SupportMe sign-in text,
  address, nonce, and issue time. It stores that message with a five-minute
  expiry and returns `{ message }`. Challenge creation is rate-limited by IP
  and wallet address.
3. The frontend passes the exact message and address to the wallet's
  `signMessage` method. The wallet prompts the user and returns
  `signedMessage` (base64 encoded); the private key does not leave the wallet.
4. The frontend posts `{ walletAddress, signedMessage }` to
  `POST /api/auth/verify`. The backend looks up the unexpired challenge for
  that address, prepends `Stellar Signed Message:\n` to the stored message,
  hashes the resulting bytes with SHA-256, and verifies the decoded signature
  against the public key. A missing or expired challenge and an invalid
  signature are rejected.
5. After a valid signature, the backend deletes the challenge so it cannot be
  used again, upserts the wallet user, checks whether that user has a creator
  profile, and issues a JWT. The response contains `{ user, token,
  hasProfile, username }`.
6. The frontend keeps the session user in the auth context and writes `authUser`
  to `localStorage`. The session JWT is issued as an `httpOnly`, `Secure`
  (in production), `SameSite=Lax` cookie and is not stored in `localStorage`
  (#366). Authenticated API calls send credentials (`credentials: 'include'`)
  or the JWT as a Bearer token; the backend verifies either in
  [`auth.ts`](../backend/src/middleware/auth.ts). State-changing requests using
  cookie authentication require matching `Origin` or `Referer` headers to
  protect against CSRF attacks. Logging out (`POST /api/auth/logout`) clears the
  session cookie server-side, clears local storage, and disconnects the wallet.

```mermaid
sequenceDiagram
   actor User
   participant Frontend as AuthContext
   participant Wallet as Stellar Wallets Kit
   participant API as Backend auth routes
   participant Store as ChallengeStore
   participant DB as Database

   User->>Frontend: Choose wallet and sign in
   Frontend->>Wallet: Connect wallet
   Wallet-->>Frontend: Public address
   Frontend->>API: POST /api/auth/challenge { walletAddress }
   API->>Store: Save nonce-bearing message (5-minute expiry)
   API-->>Frontend: { message }
   Frontend->>Wallet: signMessage(message, address)
   Wallet-->>User: Request signature approval
   User->>Wallet: Approve
   Wallet-->>Frontend: Base64 signedMessage
   Frontend->>API: POST /api/auth/verify { walletAddress, signedMessage }
   API->>Store: Get unexpired challenge
   API->>API: Verify SHA-256 signed-message signature
   API->>Store: Delete challenge after successful verification
   API->>DB: Upsert user and find creator profile
   API-->>Frontend: { user, token, hasProfile, username } + Set-Cookie (HttpOnly, SameSite=Lax)
   Frontend->>Frontend: Store session in context and authUser in localStorage (no token in localStorage)
```

Challenges are held in the backend process's bounded in-memory
[`ChallengeStore`](../backend/src/services/challengeStore.ts). With more than
one backend instance, the challenge request and verification must reach the
same instance (for example, through sticky sessions), or the store must be
replaced with a shared TTL-backed store. The signed message is single-use once
verification succeeds and expires after five minutes.

No extra environment variables are required beyond `JWT_SECRET`.

## 2. Twitter / X OAuth 2.0

### How the flow works

SupportMe uses OAuth 2.0 **Authorization Code with PKCE (S256)**, Twitter's
recommended flow for public clients:

1. `GET /api/auth/twitter` creates an opaque, single-use `state` value plus a
   PKCE verifier/challenge pair. The verifier is held **server-side only**
   (in memory, 10-minute TTL) and is never sent to the browser or to Twitter.
2. The endpoint returns `{ redirectUrl }`; the frontend sends the user there.
3. The user approves on Twitter and is redirected back with `code` and `state`.
4. `GET /api/auth/twitter/callback` checks the `state`, exchanges the `code` for
   a token (using the server-held PKCE verifier), fetches the user's Twitter
   profile, and links or creates a SupportMe account.

The requested scopes are `users.read` and `tweet.read`. Twitter's profile
response for those scopes does **not** include a verified email, so accounts are
matched on `(provider, providerAccountId)` — Twitter's numeric user id — never on
email.

### Required environment variables

All three are required to enable Twitter sign-in. If any one is missing, the two
endpoints return **`503`** ("Twitter sign-in is not configured") instead of
failing at startup — the same graceful-degradation pattern used by the Soroban
executor.

| Variable | Example | Description |
| --- | --- | --- |
| `TWITTER_CLIENT_ID` | `abcd1234...` | OAuth 2.0 **Client ID** from the Twitter/X developer app |
| `TWITTER_CLIENT_SECRET` | `efgh5678...` | OAuth 2.0 **Client Secret** for the same app (server-side only) |
| `TWITTER_REDIRECT_URI` | `https://localhost:3000/auth/twitter/callback` | Callback URL; must match a URL registered on the Twitter app **exactly** |

### Create a Twitter/X developer app for local use

1. Sign in at [developer.x.com](https://developer.x.com) (the Twitter developer
   portal) and create a Project + App on the free tier.
2. Open the app's **User authentication settings** and click **Set up**:
   - **App permissions**: Read.
   - **Type of App**: Web App, Automated App or Bot.
   - **App info**: set a Website URL (any valid URL is accepted for local dev)
     and a **Callback URI / Redirect URL**.
   - **Request email address from users**: leave off — SupportMe does not request
     the `users.read.email` scope.
3. Set the callback URL to your local frontend origin plus the callback path:
   `https://localhost:3000/auth/twitter/callback`. The frontend's `npm run dev`
   serves `https://localhost:3000` (see the README's Frontend Setup). If you
   run the frontend with `npm run dev:http`, register
   `http://localhost:3000/auth/twitter/callback` instead. Twitter allows
   `http://localhost` for development, but any non-localhost callback must be
   **HTTPS**. You can register both callback URLs on the same app.
4. Copy the app's **OAuth 2.0 Client ID** and **Client Secret** into
   `backend/.env`:

   ```env
   TWITTER_CLIENT_ID="..."
   TWITTER_CLIENT_SECRET="..."
   TWITTER_REDIRECT_URI="https://localhost:3000/auth/twitter/callback"
   ```

5. Restart the backend so the new values are picked up.

### Endpoints

- `GET /api/auth/twitter` — returns `{ redirectUrl }`. `503` if unconfigured.
- `GET /api/auth/twitter/callback?code=...&state=...` — returns a session.
  - `400` when `code` or `state` is missing.
  - `401` when the `state` is unknown, expired (over 10 minutes), or already
    used.
  - `503` when the provider is unconfigured.

### Local walkthrough

```bash
# 1. Get the URL the browser should be sent to
curl -s http://localhost:4000/api/auth/twitter
# → {"redirectUrl":"https://twitter.com/i/oauth2/authorize?...&state=...&code_challenge=..."}

# 2. Open redirectUrl in a browser, approve the app, and copy `code` and
#    `state` from the URL Twitter redirects you to.

# 3. Complete the exchange (POST also works; the route accepts the query params)
curl -s "http://localhost:4000/api/auth/twitter/callback?code=<CODE>&state=<STATE>"
# → {"user":{...},"token":"<jwt>","hasProfile":false}
```

Because the `state` value is single-use and expires after 10 minutes, start the
flow again if you wait too long between steps 1 and 3.

## 3. Magic link (email) sign-in

### How the flow works

1. `POST /api/auth/magic-link` accepts an email address and stores only the
   **SHA-256 hash** of a random 32-byte token, with a **15-minute** expiry.
2. The raw token is emailed as a link to
   `${APP_URL}/auth/magic-link/verify?token=<token>`.
3. `POST /api/auth/magic-link/verify` looks the token up by hash, marks it
   **used**, and creates or attaches the account — all in one transaction, so a
   double-submit (or an email client prefetching the link) can't issue two
   sessions.

The request endpoint always answers with the same generic message, so it can't
be used to discover which emails already have an account. Requests are
rate-limited to **5 per email per 15 minutes**.

### Required environment variables

Magic link needs `JWT_SECRET`, the email provider settings below, and the public
origin used to build the link.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `RESEND_API_KEY` | Recommended | — | API key for [Resend](https://resend.com), the transactional email provider. Without it, mail is **logged instead of sent** (see below). |
| `EMAIL_FROM` | Optional | `SupportMe <notifications@supportme.app>` | `From` address on magic-link (and notification) emails. Must be a domain/address verified in Resend. |
| `APP_URL` | Optional | `https://localhost:3000` | Public origin used to build the magic-link verification URL. Set this to your deployed frontend origin in production (or to `http://localhost:3000` if you run the frontend with `npm run dev:http`). |

### Email provider setup (Resend)

1. Create a [Resend](https://resend.com) account and an API key.
2. Verify the sending domain (or use Resend's onboarding `onboarding@resend.dev`
   address for a quick local test), then set `EMAIL_FROM` to an address on that
   domain.
3. Put the key in `backend/.env`:

   ```env
   RESEND_API_KEY="re_..."
   EMAIL_FROM="SupportMe <no-reply@your-domain.example>"
   APP_URL="https://localhost:3000"
   ```

4. Restart the backend.

**Running without an email provider:** if `RESEND_API_KEY` is unset, the mailer
prints the message (including the magic link) to the backend log instead of
sending it, so every flow still works end to end in local dev and CI:

```
Email (not sent, RESEND_API_KEY unset) to you@example.com: Sign in to SupportMe
```

Copy the token out of that logged link to complete the sign-in.

### Endpoints

- `POST /api/auth/magic-link` — body `{ email }`, returns
  `{ message: "If that email is valid, a sign-in link has been sent." }`.
  - `400` for an invalid email address.
  - `429` when the per-email rate limit is exceeded.
- `POST /api/auth/magic-link/verify` — body `{ token }`, returns a session.
  - `400` when `token` is missing.
  - `401` when the token is unknown, expired, or already used.

### Local walkthrough

```bash
# 1. Request a link
curl -s -X POST http://localhost:4000/api/auth/magic-link \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'

# 2. Grab the token. With RESEND_API_KEY unset, read it from the backend log:
#    .../auth/magic-link/verify?token=<TOKEN>

# 3. Verify it (single-use, 15-minute window)
curl -s -X POST http://localhost:4000/api/auth/magic-link/verify \
  -H 'Content-Type: application/json' \
  -d '{"token":"<TOKEN>"}'
# → {"user":{"id":42,"email":"you@example.com","walletAddress":null},"token":"<jwt>","hasProfile":false}
```

## Backend environment variable summary

| Variable | Method | Required | Notes |
| --- | --- | --- | --- |
| `JWT_SECRET` | all | Yes | Signs session tokens (7-day expiry) |
| `TWITTER_CLIENT_ID` | Twitter | Yes (for Twitter) | OAuth 2.0 client id |
| `TWITTER_CLIENT_SECRET` | Twitter | Yes (for Twitter) | Server-side only; never expose to the browser |
| `TWITTER_REDIRECT_URI` | Twitter | Yes (for Twitter) | Must exactly match the registered callback URL |
| `RESEND_API_KEY` | Magic link | Recommended | Without it, emails are logged, not sent |
| `EMAIL_FROM` | Magic link | Optional | Defaults to `SupportMe <notifications@supportme.app>` |
| `APP_URL` | Magic link | Optional | Defaults to `https://localhost:3000`; set to the deployed origin |

See [`backend/.env.example`](../backend/.env.example) for a copy-paste template.

The backend's CORS allowlist (`CORS_ALLOWED_ORIGINS`) automatically includes
`https://localhost:3000`, `http://localhost:3000` and the matching
`127.0.0.1` origins outside production. A deployed frontend must be listed
explicitly, for example
`CORS_ALLOWED_ORIGINS="https://your-frontend.example"`. See
[`backend/docs/CONFIGURATION.md`](../backend/docs/CONFIGURATION.md).

## Security notes

- **Session cookies and CSRF protection**: session JWTs are delivered as `httpOnly`,
  `Secure` (in production), `SameSite=Lax` cookies, preventing JavaScript and
  third-party scripts from reading session tokens via XSS (#366). State-changing
  requests (`POST`, `PUT`, `DELETE`, `PATCH`) authenticated via cookies verify the
  request's `Origin` or `Referer` against the allowed frontend origins to guard
  against CSRF attacks. Signing out (`POST /api/auth/logout`) and account deletion
  invalidate and clear the cookie server-side.
- **OAuth state** is opaque, single-use, checked server-side, and expires after
  10 minutes; the PKCE verifier never leaves the backend.
- **Twitter identities** are linked by Twitter's numeric user id, not by email,
  and the app never requests the email scope.
- **Magic-link tokens** are stored only as SHA-256 hashes (a database read alone
  cannot sign anyone in), are single-use, and expire after 15 minutes. Marking a
  token used and creating the account happen in one transaction.
- **Account enumeration** is avoided: the request endpoint returns the same
  message for new and existing addresses, and the per-email rate limit (5 per
  15 minutes) bounds abuse. A `429` is returned separately because it doesn't
  reveal anything about the address.
- **Graceful degradation**: unconfigured providers return `503` rather than
  breaking startup, so a deployment only needs the methods it actually enables.
- **Production**: use HTTPS callback URLs, keep `TWITTER_CLIENT_SECRET` and
  `RESEND_API_KEY` on the server only, set `APP_URL` to the public frontend
  origin, and rotate any secret that has been committed by accident.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `503` "Twitter sign-in is not configured" | One of `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` / `TWITTER_REDIRECT_URI` is missing, or the backend wasn't restarted after setting it |
| `401` "Invalid or expired OAuth state" | More than 10 minutes passed, or the `state` was already used — start the flow again |
| Twitter shows a callback/redirect mismatch error | `TWITTER_REDIRECT_URI` must match the app's registered callback URL exactly (scheme, host, port, and path) |
| Magic link email never arrives | `RESEND_API_KEY` is unset (check the backend log), or `EMAIL_FROM` uses a domain that isn't verified in Resend |
| `401` "This magic link has already been used" | The link is single-use — request a new one |
| `429` "Too many magic link requests" | Rate limit is 5 per email per 15 minutes; wait and retry |
| Magic link opens a page that 404s locally | The frontend verification page is tracked in issue #11; until then, POST the token to `/api/auth/magic-link/verify` directly |
