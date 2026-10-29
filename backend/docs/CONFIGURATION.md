# Backend Configuration

This reference covers every environment setting read by `backend/src` and the
settings currently shown in [`../.env.example`](../.env.example). Set values in
the environment used by the backend process; restarting the process is required
after a change.

## Core runtime and database

| Variable | Required? | Default / behavior |
| --- | --- | --- |
| `DATABASE_URL` | Required for a working backend; production startup validates it. | None in code. `.env.example` shows a local PostgreSQL URL; use the URL for the environment's database. |
| `JWT_SECRET` | Required outside tests. | None. The server refuses to start without it; generate a private value, for example with `openssl rand -hex 32`. Tests generate an ephemeral process-local secret if unset. |
| `NODE_ENV` | Optional. Set explicitly in deployed environments. | Unset is treated as non-production by environment checks; `production` enables strict startup validation, and `test` enables test-only behavior. |
| `PORT` | Optional. | `4000`. |

## Browser access and proxy

| Variable | Required? | Default / behavior |
| --- | --- | --- |
| `CORS_ALLOWED_ORIGINS` | Optional; set for deployed browser frontends. | Empty. Comma-separated exact origins. Outside production, `https://localhost:3000`, `https://127.0.0.1:3000`, `http://localhost:3000` and `http://127.0.0.1:3000` are added automatically (the frontend's `npm run dev` serves HTTPS; `npm run dev:http` and Playwright use HTTP). Production allows no browser origins unless configured. |
| `TRUST_PROXY` | Optional; set when the API is behind a trusted reverse proxy. | Unset leaves Express's default. Set to the number of proxy hops (commonly `1` on Railway) so IP-based limits see the client address. |

## Profile images and social links

| Variable | Required? | Default / behavior |
| --- | --- | --- |
| `CLOUDINARY_CLOUD_NAME` | Required to save an avatar URL. | Unset rejects avatar writes. Must match the frontend upload signer's cloud name. Only HTTPS URLs on `res.cloudinary.com` whose first path segment is this exact cloud name are accepted. The backend does not need the Cloudinary API key or secret. |

Creation and update apply the same avatar policy. Other profile edits continue
to work without Cloudinary configured. Social links accept only absolute HTTP(S)
URLs without credentials, or handles expanded for the known platform keys:
`twitter`, `instagram`, `youtube`, `tiktok`, `github`, `linkedin`, `telegram`, and
`website`. Website entries require a complete URL; LinkedIn handles use
`in/username`. Unknown keys and non-HTTP schemes are rejected with HTTP 400.
Send an empty object to clear all social links.

## Public API rate limits

All values must be positive integers. Window values are milliseconds. Limits
are held in memory and apply per backend process; set `TRUST_PROXY` correctly so
per-IP limits use the caller's address behind a trusted proxy.

| Variable | Default | Scope |
| --- | --- | --- |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `60000` | Window for wallet challenge and verification limits. |
| `AUTH_RATE_LIMIT_IP_MAX` | `30` | Requests per IP, independently for each wallet-auth endpoint. |
| `AUTH_CHALLENGE_RATE_LIMIT_ACCOUNT_MAX` | `5` | Challenge requests per wallet. |
| `AUTH_VERIFY_RATE_LIMIT_ACCOUNT_MAX` | `10` | Verification attempts per wallet. |
| `DONATION_RATE_LIMIT_WINDOW_MS` | `60000` | Window for donation-creation limits. |
| `DONATION_RATE_LIMIT_IP_MAX` | `60` | Donation-creation requests per IP. |
| `DONATION_RATE_LIMIT_ACCOUNT_MAX` | `20` | Donation-creation requests per sender wallet. |
| `MAGIC_LINK_RATE_LIMIT_WINDOW_MS` | `900000` | Window for magic-link request limits. |
| `MAGIC_LINK_RATE_LIMIT_IP_MAX` | `30` | Magic-link requests per IP. |
| `MAGIC_LINK_RATE_LIMIT_ACCOUNT_MAX` | `5` | Magic-link requests per normalized email address. |

## Soroban event listener and RPC

| Variable | Required? | Default / behavior |
| --- | --- | --- |
| `STELLAR_NETWORK` | Optional; set explicitly outside testnet. | `testnet` (also accepts `mainnet`/`public`, `futurenet`). Selects the network passphrase used by the executor and boot validation. `NEXT_PUBLIC_STELLAR_NETWORK` is accepted as a fallback so frontend and backend share one value. At boot the server calls `getNetwork` on every RPC endpoint and refuses to start (production) if a passphrase disagrees, a configured contract is missing, or `EXECUTOR_SECRET_KEY` is unparseable (#281). |
| `NEXT_PUBLIC_DONATION_CONTRACT_ID` | Required for a normal backend startup and required by production configuration validation. | None. The event listener skips polling without it, and the subscription executor cannot start without it. |
| `NEXT_PUBLIC_CREATOR_REGISTRY_CONTRACT_ID` | Optional. | Unset; the listener watches the donation contract only. Set the registry address to include it in listener monitoring; it is also verified at boot. |
| `SOROBAN_RPC_URLS` | Optional; preferred for the RPC client pool. | If unset, endpoint selection falls through to `SOROBAN_RPC_ENDPOINTS`, then `SOROBAN_RPC_URL`, then the public testnet endpoint. Accepts a comma-separated priority list. |
| `SOROBAN_RPC_ENDPOINTS` | Optional compatibility alias. | Used only when `SOROBAN_RPC_URLS` is unset; comma-separated priority list. |
| `SOROBAN_RPC_URL` | Optional legacy/single endpoint. | `https://soroban-testnet.stellar.org`. It is the final fallback for the shared RPC client and is also read directly by the event listener. |
| `SOROBAN_RPC_TIMEOUT_MS` | Optional. | `10000` ms per endpoint when unset, invalid, or non-positive. |
| `SOROBAN_EVENTS_POLL_INTERVAL_MS` | Optional. | `5000` ms. |
| `SOROBAN_EVENTS_LOOKBACK_LEDGERS` | Optional. | `100` ledgers on the listener's initial scan. |
| `SOROBAN_USDC_ISSUER` | Not currently consumed by backend code. | No effect. This legacy example entry is retained here to make clear that setting it does not configure token classification. |
| `SOROBAN_USDC_TOKEN_ID` | Not currently consumed by backend code. | No effect. This legacy example entry is retained here to make clear that setting it does not configure token classification. |

The shared RPC pool supports failover for callers using `sorobanRpc`. The event
listener currently uses `SOROBAN_RPC_URL` directly, so configure that variable
as well if the listener needs a non-default endpoint.

## Recurring donations and scheduled work

| Variable | Required? | Default / behavior |
| --- | --- | --- |
| `EXECUTOR_SECRET_KEY` | Required for normal backend startup because the subscription executor is started with the server. | None. This operational Stellar key must be registered as the donation contract executor and funded for transaction fees. Do not reuse a user wallet or commit the secret. On testnet/futurenet a missing account is auto-funded via Friendbot at startup (#279). |
| `SUBSCRIPTION_EXECUTOR_POLL_INTERVAL_MS` | Optional. | `60000` ms. |
| `SUBSCRIPTION_EXECUTOR_EXPECTED_INTERVAL_MS` | Optional. | Three times the polling interval, or `180000` ms with the default poll interval. Used by executor health reporting. |
| `FRIENDBOT_URL` | Optional. | `https://friendbot.stellar.org`. Endpoint used to auto-fund a missing executor account on testnet/futurenet; never called on mainnet. |
| `EXECUTOR_LOW_BALANCE_XLM` | Optional. | `0.5`. XLM balance below which `/health/executor` reports `lowBalance: true`. |
| `GOAL_RESET_CHECK_INTERVAL_MS` | Optional. | `3600000` ms (one hour). |

## Admin access

| Variable | Required? | Default / behavior |
| --- | --- | --- |
| `ADMIN_WALLETS` | Optional; required to grant admin access. | Empty allowlist. Comma-separated Stellar wallet addresses. |

## Sign-in providers

| Variable | Required? | Default / behavior |
| --- | --- | --- |
| `TWITTER_CLIENT_ID` | Optional. | Unset. Twitter/X OAuth is unavailable unless all three Twitter variables are configured. |
| `TWITTER_CLIENT_SECRET` | Optional. | Unset. |
| `TWITTER_REDIRECT_URI` | Optional. | Unset; set to the exact callback URL registered with the provider (locally `https://localhost:3000/auth/twitter/callback`). |

## Email and application links

| Variable | Required? | Default / behavior |
| --- | --- | --- |
| `RESEND_API_KEY` | Optional. | Unset; outbound messages are logged instead of sent. |
| `EMAIL_FROM` | Optional. | `SupportMe <notifications@supportme.app>`. Use a sender verified with Resend in deployed environments. |
| `APP_URL` | Optional locally; set to the canonical public frontend URL in staging and production. | Context-dependent: some email/SEO paths fall back to `https://supportme.app`, while magic-link, notification and preview paths fall back to `https://localhost:3000` (the frontend's local HTTPS dev origin). Set it explicitly outside local development so generated links point to the right environment. |
| `RESEND_WEBHOOK_SECRET` | Optional for the app; required to accept Resend webhook requests. | Unset; webhook requests are rejected when no signing secret is configured. |
| `NEXT_PUBLIC_STELLAR_NETWORK` | Optional. | `TESTNET`; used to select the network label/link in email templates and as a fallback for the backend's `STELLAR_NETWORK`. |

## Observability

| Variable | Required? | Default / behavior |
| --- | --- | --- |
| `SENTRY_DSN` | Optional. | Unset disables backend Sentry initialization. |

## Environment checklist

- **Local development:** set `DATABASE_URL`, `JWT_SECRET`,
  `NEXT_PUBLIC_DONATION_CONTRACT_ID`, and `EXECUTOR_SECRET_KEY` for the normal
  server startup path. The example database URL and public testnet RPC are for
  local/testnet use only.
- **Staging:** use staging database and secret values, set the exact staging
  frontend origin in `CORS_ALLOWED_ORIGINS`, set `APP_URL`, and point the
  contract IDs and RPC endpoint pool at the intended Stellar network.
- **Production:** set all four core startup values above, use a unique strong
  `JWT_SECRET`, configure `CORS_ALLOWED_ORIGINS`, `APP_URL`, and `TRUST_PROXY`
  for the deployed topology, and provide verified email/Sentry settings if
  those services are enabled. Store secrets in the hosting provider's secret
  environment, not in the repository.

The root [README](../../README.md) contains the contract address table and
production promotion context. See also the
[contract deploy and promotion workflow](../../docs/contract-deploy-workflow.md).
