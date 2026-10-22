# SupportMe

[![CI](https://github.com/ssupportme/support-me/actions/workflows/ci.yml/badge.svg)](https://github.com/ssupportme/support-me/actions/workflows/ci.yml)

SupportMe is a creator tipping and donation platform. This enables creators on Stellar to receive donations and tips easily through embedded widgets or shareable links.

**Live demo**: [https://support-mee.vercel.app/](https://support-mee.vercel.app/) · **Demo video**: [Loom](https://www.loom.com/share/4468e89fd67745d39fb64033e6660b16) · **Testnet Quickstart**: [`docs/testnet-quickstart.md`](docs/testnet-quickstart.md) · **Testnet demo walkthrough**: [docs/testnet-demo-walkthrough.md](docs/testnet-demo-walkthrough.md)

## Architecture

```mermaid
flowchart LR
    Supporter(["Supporter / Creator<br/>(browser + Stellar wallet)"])
    FE["Frontend<br/>Next.js"]
    BE["Backend<br/>Express + Prisma"]
    DB[("PostgreSQL")]
    Donation["donation contract<br/>(Soroban)"]
    Registry["creator-registry contract<br/>(Soroban)"]
    Listener["Soroban event listener<br/>(in backend)"]
    Executor["Subscription executor<br/>(in backend)"]
    Anchor["SEP-24 anchor<br/>(testanchor.stellar.org or local anchor/)"]

    Supporter --> FE
    FE -- "REST + SSE" --> BE
    BE --> DB

    %% One-off donations
    FE -- "donate (signed by wallet)" --> Donation
    Donation -- "record_donation" --> Registry
    Donation -. "donation events" .-> Listener
    Listener --> DB
    Listener -. "live update" .-> BE

    %% Recurring subscriptions
    FE -- "subscribe + approve allowance" --> Donation
    Executor -- "charge_subscription (executor key)" --> Donation
    BE --- Executor

    %% Cash-out
    FE -- "SEP-10 auth + SEP-24 withdraw" --> Anchor
    Anchor -- "fiat payout" --> Supporter
```

- **Donations:** the frontend submits `donate` to the donation contract (signed by the user's wallet). The contract moves the funds to the creator and reports the donation to the registry. The backend's event listener picks the event up, stores it in Postgres and pushes it to open profile pages over SSE.
- **Subscriptions:** the supporter subscribes and grants the donation contract an allowance. The backend's subscription executor calls `charge_subscription` when a charge is due; the contract draws on the allowance.
- **Cash-outs:** the creator withdraws from the frontend through a SEP-24 anchor (SEP-10 sign-in, hosted KYC/bank form, on-chain transfer, status polling). See [`anchor/README.md`](anchor/README.md) to run a local anchor.

For the full picture see [`docs/architecture.md`](docs/architecture.md).
Backend environment variables, defaults, and service-specific requirements are
documented in [`backend/docs/CONFIGURATION.md`](backend/docs/CONFIGURATION.md).

## Smart Contracts (Stellar Testnet)

Donations are split across two independently deployed Soroban contracts that
talk to each other exclusively through cross-contract calls
(`env.invoke_contract`):

- **`donation`** moves the donated XLM from donor to creator via the native
  Stellar Asset Contract, keeps an append-only on-chain log of donations, and
  reports every settled donation to the registry. `DonatedEvent` includes the
  transferred SAC token address so off-chain indexers can classify USDC as well
  as native XLM; deployments using the listener should use a contract build
  containing this event field.
- **`creator-registry`** owns creator profile state (username, lifetime
  totals) and only accepts `record_donation` calls from the donation contract
  address it was initialized with.

| Contract                                  | Address                                                                                                                                                                 | Source                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `donation` (v1)                           | [`CD6T563YCSYQHDMXC7VCFTKMWMXWHFHAU4NO7EAMFK57QLFI7SSXICYY`](https://stellar.expert/explorer/testnet/contract/CD6T563YCSYQHDMXC7VCFTKMWMXWHFHAU4NO7EAMFK57QLFI7SSXICYY) | [`contracts/donation/src/lib.rs`](contracts/donation/src/lib.rs)                 |
| `creator-registry` (v1)                   | [`CCJL2GIWNNWECKGSEY2EXEGKBMN2LYJ3HVNJNZEO2AUXC4LRR7THG2U6`](https://stellar.expert/explorer/testnet/contract/CCJL2GIWNNWECKGSEY2EXEGKBMN2LYJ3HVNJNZEO2AUXC4LRR7THG2U6) | [`contracts/creator-registry/src/lib.rs`](contracts/creator-registry/src/lib.rs) |
| `donation` (v2, adds recurring donations) | [`CAO2UABEB4A3EYFTWCMOSTFAUZ5FBSFRESQGWQHOLASZ3RHDCQHQG2LP`](https://stellar.expert/explorer/testnet/contract/CAO2UABEB4A3EYFTWCMOSTFAUZ5FBSFRESQGWQHOLASZ3RHDCQHQG2LP) | [`contracts/donation/src/lib.rs`](contracts/donation/src/lib.rs)                 |
| `creator-registry` (v2)                   | [`CB6PH7KYI3UHAUNYIJVCV7CT6BOBROLSR4LSZB3WSGFOYOW6JFAF5NDU`](https://stellar.expert/explorer/testnet/contract/CB6PH7KYI3UHAUNYIJVCV7CT6BOBROLSR4LSZB3WSGFOYOW6JFAF5NDU) | [`contracts/creator-registry/src/lib.rs`](contracts/creator-registry/src/lib.rs) |

For the build, testnet deployment, verification, and live-demo promotion
checklist, see [`docs/contract-deploy-workflow.md`](docs/contract-deploy-workflow.md).
For recovering contracts and environments after an SDF network wipe, see the
[`docs/testnet-reset-runbook.md`](docs/testnet-reset-runbook.md).

- **Network**: Stellar Testnet, RPC `https://soroban-testnet.stellar.org`
- **Example transactions (v1)**:
  - `register_creator` (bob registers as `bobcreates`): [`91d9cc8f1ed0905fe24a51e7213b582120f2e1fa74cf165b81cfb7f58077625f`](https://stellar.expert/explorer/testnet/tx/91d9cc8f1ed0905fe24a51e7213b582120f2e1fa74cf165b81cfb7f58077625f)
  - `donate` (charlie donates 5 XLM to bob; donation contract cross-calls the registry to update bob's stats): [`804cf80669333df32713d6297e806a7b09b0583cd2c98646315611656d1914b4`](https://stellar.expert/explorer/testnet/tx/804cf80669333df32713d6297e806a7b09b0583cd2c98646315611656d1914b4)
  - `donate` (10 XLM donation with memo "Manage it"): [`234e100afee6aa560261fe0968b8755739dbc3686370b5fda79294a133ea8611`](https://stellar.expert/explorer/testnet/tx/234e100afee6aa560261fe0968b8755739dbc3686370b5fda79294a133ea8611)
- **Example transactions (v2, recurring donations)** — charlie subscribes to bob at 0.5 XLM/15s, is charged twice, then cancels:
  - `subscribe`: [`768c35272723427c635a78e68930159b675b88f0f0ad8cf9f0e0b29be955c15f`](https://stellar.expert/explorer/testnet/tx/768c35272723427c635a78e68930159b675b88f0f0ad8cf9f0e0b29be955c15f)
  - `approve` (charlie grants the donation contract an allowance on the native SAC): [`e1635428678fbaa3a5c233a380a8fafc8ebc8f04210be6ff36bb1c78c8135a4b`](https://stellar.expert/explorer/testnet/tx/e1635428678fbaa3a5c233a380a8fafc8ebc8f04210be6ff36bb1c78c8135a4b)
  - `charge_subscription` (executor-signed, draws on the allowance): [`0b7f890c3e644b57a964d4069371000a286f8df27ae69f8621c4d0e156e212d5`](https://stellar.expert/explorer/testnet/tx/0b7f890c3e644b57a964d4069371000a286f8df27ae69f8621c4d0e156e212d5)
  - `cancel_subscription` (revokes the remaining allowance in the same tx): [`34d9c3d8d544cfdb390228a82372d64755c8f479fca4d959bb4e47b9ec0a4414`](https://stellar.expert/explorer/testnet/tx/34d9c3d8d544cfdb390228a82372d64755c8f479fca4d959bb4e47b9ec0a4414)

**The live demo (support-mee.vercel.app) still runs on v1.** A fresh local
checkout's `frontend/.env.example` and `backend/.env.example` now default to
the v2 addresses above (both v2 contracts are live on testnet and were
confirmed reachable via `stellar contract info interface` — same public
interface shape as v1, so this is a drop-in swap, not a breaking change for
any existing caller). Promoting the *live* demo to v2 is still a manual,
deliberate step: update `NEXT_PUBLIC_DONATION_CONTRACT_ID`/
`NEXT_PUBLIC_CREATOR_REGISTRY_CONTRACT_ID` on Vercel and set
`DONATION_CONTRACT_ID` (backend) plus `EXECUTOR_SECRET_KEY` on Railway (see
"What's New (v5)" above). That production repoint is intentionally left for
a maintainer to trigger, not done as part of an automated change — flipping
a live, user-facing
deployment's contract addresses is a deliberate release action.

The frontend calls the `donation` contract directly from
`frontend/lib/contract.js` (simulate → sign → submit → poll for
confirmation), with live transaction status shown on the donation page and
errors categorized as wallet, simulation, or network failures. The
`creator-registry` contract is never called directly by the frontend — it is
only reachable through the `donation` contract's cross-contract calls.

## Features

- **Wallet-Based Authentication**: Sign in by proving ownership of a Stellar wallet via a signed challenge message (SEP-0043/SEP-0053) — no passwords
- **Creator Profiles**: Public, shareable creator pages with unique usernames
- **Multi-Wallet Integration**: Connect Freighter, xBull, Albedo, Rabet, or Lobstr via Stellar Wallets Kit
- **On-Chain Contract Calls**: Donations are settled and recorded through a deployed Soroban contract
- **Multi-Asset Tipping**: Supporters can tip in XLM, USDC, or USDT — resolved client-side in [`frontend/lib/assets.js`](frontend/lib/assets.js); set `NEXT_PUBLIC_USDC_ISSUER`/`NEXT_PUBLIC_USDT_ISSUER` to enable each asset in the selector, otherwise the UI falls back to XLM-only. A creator opts each asset in/out from `/settings` (`acceptsXlm`/`acceptsUsdc`/`acceptsUsdt`)
- **Creator Goals**: A creator can track multiple simultaneous and/or recurring (weekly/monthly) donation goals, each denominated in a single asset. A donation applies in full to every active goal that matches its asset — not split between them. Amounts are tracked per-asset, never normalized to USD (no price oracle exists in this app). See [`backend/src/services/goalService.ts`](backend/src/services/goalService.ts), [`backend/src/services/goalResetScheduler.ts`](backend/src/services/goalResetScheduler.ts)
- **Recurring Donations**: Supporters grant the `donation` contract a standard SAC allowance (`approve`) and call `subscribe` to record a schedule (weekly, monthly, or custom); a backend-held "executor" keypair then calls `charge_subscription` per interval via `transfer_from`. The executor never custodies funds — `transfer_from`'s `to` is pinned to the subscription's stored creator inside the contract, so a leaked executor key can at most accelerate/replay already-approved charges, not redirect them. Supporters manage/cancel subscriptions at `/app/subscriptions` (cancelling revokes the remaining allowance in the same transaction). See [`contracts/donation/src/lib.rs`](contracts/donation/src/lib.rs), [`backend/src/services/subscriptionExecutor.ts`](backend/src/services/subscriptionExecutor.ts). Requires `EXECUTOR_SECRET_KEY` (see [`backend/.env.example`](backend/.env.example)); the v2 contracts must be pointed at (see contract table above) — the live demo still runs on v1.
- **Fiat Cash-Out (SEP-24)**: Creators can withdraw earnings through a Stellar anchor from `/settings` (SEP-10 sign-in → hosted KYC/bank form → on-chain transfer → live status), implemented in [`frontend/lib/anchor.js`](frontend/lib/anchor.js). Defaults to the SDF reference anchor (`testanchor.stellar.org`, asset `SRT`) on testnet; point `NEXT_PUBLIC_ANCHOR_*` at a real anchor to go live. This is a testnet-only demo by design — SEP-24 is not live on mainnet yet.
- **Donation Tracking**: Backend-stored donation history with stats
- **Creator Dashboard**: Real-time analytics and recent supporter feed, updated live over SSE
- **Profile Settings**: Update profile information, display name, bio, and connect/update wallet address
- **Zero Fees, Instant Settlement**: 100% of donations go directly to creators over the Stellar blockchain
- **Error Boundaries & Loading Skeletons**: Root error boundary with retry and skeleton screens
- **Test Suites**: Backend (Jest + Supertest), frontend (Vitest + React Testing Library), and Rust contract tests
- **CI Pipeline**: GitHub Actions runs all tests and builds on every push and pull request
- **Mobile Responsive Layout**: Optimized for all screen sizes

## Tech Stack

- **Frontend**: Next.js, React, TypeScript, Tailwind CSS
- **Backend**: Node.js, Express, Prisma
- **Database**: PostgreSQL
- **Smart Contract**: Soroban (Rust), deployed to Stellar Testnet
- **Wallet**: Stellar SDK + Stellar Wallets Kit (Freighter, xBull, Albedo, Rabet, Lobstr)
- **Auth**: JWT tokens; Stellar wallet sign-message challenge (SEP-0043/SEP-0053), Twitter/X OAuth 2.0 (Authorization Code + PKCE), and email magic links for sign-in — see [`docs/authentication.md`](docs/authentication.md)
- **Real-Time**: Server-Sent Events (backend polls Soroban RPC for contract events, streams them to clients)
- **Testing**: Jest + Supertest (backend), Vitest + React Testing Library (frontend), `cargo test` (contracts)
- **CI/CD**: GitHub Actions

## Project Structure

```
.
├── .github/
│   └── workflows/
│       └── ci.yml              # CI: contracts (cargo), backend (jest), frontend (vitest)
├── contracts/                   # Soroban smart contracts (Rust)
│   ├── donation/                # Settles donations, records on-chain, cross-calls the registry
│   ├── creator-registry/        # Owns creator profile state and lifetime totals
│   └── common/                  # Shared types between contracts
├── backend/                    # Express API and Prisma schema
│   ├── prisma/
│   │   └── schema.prisma       # Database models
│   ├── src/
│   │   ├── routes/
│   │   │   ├── auth.ts         # Authentication endpoints
│   │   │   ├── creators.ts     # Creator profile endpoints
│   │   │   ├── donations.ts    # Donation tracking endpoints
│   │   │   └── events.ts       # SSE stream of on-chain donation events
│   │   ├── services/
│   │   │   ├── sorobanEventListener.ts  # Polls Soroban RPC for donation events
│   │   │   └── eventBus.ts     # In-process pub/sub bridging listener → SSE route
│   │   ├── middleware/
│   │   │   ├── auth.ts         # JWT authentication middleware
│   │   │   ├── validate.ts     # Zod request validation
│   │   │   └── errorHandler.ts # Centralized error handling
│   │   ├── schemas/             # Zod request schemas
│   │   ├── errors/              # Typed application error classes
│   │   ├── __tests__/           # Jest + Supertest test suite
│   │   ├── app.ts              # Express app setup
│   │   ├── server.ts           # Server entry point
│   │   └── prisma.ts           # Prisma client
│   └── package.json
├── frontend/                   # Next.js application
│   ├── app/
│   │   ├── auth/               # Authentication pages
│   │   │   └── username/       # Username creation after first wallet sign-in
│   │   ├── dashboard/          # Creator dashboard (SSE-updated, with tests)
│   │   ├── settings/           # Profile and wallet settings
│   │   ├── [username]/         # Dynamic creator profile pages (SSE-updated)
│   │   ├── donate/             # Redirect page
│   │   ├── error.tsx           # Root error boundary
│   │   ├── layout.tsx          # Root layout with AuthProvider
│   │   ├── page.jsx            # Landing page
│   │   └── globals.css
│   ├── components/             # Reusable React components (incl. Skeleton, tested)
│   ├── context/
│   │   └── AuthContext.tsx     # Global auth state (tested)
│   ├── lib/
│   │   ├── wallet.js           # Multi-wallet connection (Stellar Wallets Kit)
│   │   └── contract.js         # Soroban donation contract calls
│   ├── vitest.config.ts        # Vitest + React Testing Library setup
│   └── package.json
├── docs/                       # Project documentation (index: docs/README.md)
├── PRD(v2).md                  # Product requirements
├── CONTRIBUTING.md             # Contribution guide
└── README.md
```

## User Flows

### Creator Flow

```
1. Connect Wallet & Sign Challenge Message (proves wallet ownership)
   ↓
2. Create Username
   ↓
3. Land in Dashboard
   ↓
4. Go to Settings → Connect Wallet (Freighter, xBull, Albedo, Rabet, or Lobstr)
   ↓
5. Profile is live at /[username]
   ↓
6. Share profile link with fans
   ↓
7. View donations in Dashboard
```

### Supporter Flow

```
1. Visit creator profile URL (e.g., supportme.app/sammie)
   ↓
2. See creator info and recent donations
   ↓
3. Connect a Stellar wallet (Freighter, xBull, Albedo, Rabet, or Lobstr)
   ↓
4. Choose donation amount + optional message
   ↓
5. Sign the on-chain `donate` contract call (live status shown)
   ↓
6. Donation appears on creator's dashboard
```

## Installation

### Prerequisites

- Node.js 20 (see [`.nvmrc`](.nvmrc); `nvm use` picks it up automatically) and
  npm 11+ for the frontend, npm 10+ for the backend (`npm install -g npm@11`
  if your Node install bundles an older npm — the frontend's lockfile needs
  npm 11's resolver).
- PostgreSQL
- A Stellar wallet browser extension (Freighter, xBull, Albedo, Rabet, or Lobstr)

### Backend Setup

The backend needs a running PostgreSQL database before it will start. If you
don't already have one, the fastest options are:

- **Local**: install Postgres (e.g. `brew install postgresql@16` on macOS),
  start it, then create a database: `createdb supportme`.
- **Hosted (no local install)**: create a free Postgres instance on
  [Neon](https://neon.tech), [Supabase](https://supabase.com), or
  [Railway](https://railway.app) and copy the connection string it gives you.

Then set up the backend:

```bash
cd backend
npm install

# Setup environment
cp .env.example .env
# Edit .env and set:
#   DATABASE_URL - your PostgreSQL connection string
#                  (e.g. postgresql://user:password@localhost:5432/supportme)
#   JWT_SECRET   - any random string, used to sign login tokens

# Generate the Prisma client
npm run prisma:generate

# Apply the committed migrations in backend/prisma/migrations to your local
# database (creates the tables and regenerates the Prisma client)
npx prisma migrate dev

# Start the development server
npm run dev
```

Schema changes are tracked as Prisma migrations in
[`backend/prisma/migrations`](backend/prisma/migrations):

- **Local development:** `npx prisma migrate dev` (or `npm run prisma:migrate`)
  applies pending migrations. After you edit `schema.prisma`, the same command
  creates a new migration. See
  [Creating a schema change](backend/README.md#creating-a-schema-change).
- **Staging and production:** `npx prisma migrate deploy` (or
  `npm run prisma:deploy`) applies the committed migrations. It never creates
  migrations or resets data.
- `npx prisma db push` syncs the schema without recording a migration. Use it
  only for a throwaway prototype database, never for a database you want to
  keep or migrate later.

If your local database was created earlier with `db push`, it has no migration
history. `migrate dev` reports drift and offers to reset the database. For a
local development database, accept the reset or point `DATABASE_URL` at a
fresh database.

Backend will run on `http://localhost:4000`. Verify it's up with:
`curl http://localhost:4000/health` (should return `{"status":"ok",...}`).

If you only want to work on the frontend UI without a real backend, you can
skip this section for now - pages that don't require sign-in (the landing
page, public creator profiles) will still work. Anything behind
`ProtectedRoute` (dashboard, settings, username creation) requires the wallet
sign-in flow, which requires the backend to be running.

### Frontend Setup

```bash
cd frontend
npm install

# Create your environment file from the example
cp .env.example .env.local
```

[`frontend/.env.example`](frontend/.env.example) lists every variable the
frontend reads. Nothing in it is required to start the dev server: without
`NEXT_PUBLIC_API_URL` the frontend calls `http://localhost:4000`. Donations and
subscriptions need `NEXT_PUBLIC_DONATION_CONTRACT_ID`, and USDC needs
`NEXT_PUBLIC_USDC_ISSUER`. See [Frontend (.env.local)](#frontend-envlocal)
below.

```bash
# Start the development server
npm run dev
```

The frontend runs on **`https://localhost:3000`**. `npm run dev` runs
`next dev --experimental-https`. The flag was added with the first wallet
signing flow so that local development uses an HTTPS origin like the deployed
site (Vercel), which is the origin wallet extensions and OAuth providers see in
production. Nothing in the code strictly requires HTTPS locally: browsers
treat `http://localhost` as a secure context (so the clipboard and Web Crypto APIs
work), the app sets no `Secure` cookies (the session is a JWT sent in the
`Authorization` header), and Twitter/X accepts `http://localhost` callbacks.

On the first run, Next.js creates a self-signed certificate for `localhost`
(using [mkcert](https://github.com/FiloSottile/mkcert)) and may ask for your
password to add its local certificate authority to the system trust store.
If you skip that step, or your browser does not use the system store, the
browser shows a certificate warning once. Accept it to continue.

If you can't or don't want to use the certificate, run `npm run dev:http` to
serve the app on plain `http://localhost:3000`, the same server Playwright
uses. The backend's development CORS allowlist accepts both origins. Set
`APP_URL` and `TWITTER_REDIRECT_URI` in `backend/.env` to the `http://` origin
so that magic links and the Twitter callback point at the server you are
running.

## Backend API Endpoints

### Authentication

Three sign-in methods are supported. All of them return the same session shape
(`{ user, token, hasProfile, username }`). Full setup instructions — including
the environment variables, how to register a Twitter app, and how to configure
the email provider — are in [`docs/authentication.md`](docs/authentication.md).

**Stellar wallet** (signature over a server-issued challenge):

- `POST /api/auth/challenge` - Request a sign-in challenge for a wallet address
  - Body: `{ walletAddress }`
  - Returns: `{ message }` - a nonce-bearing message to be signed by the wallet (valid for 5 minutes)

- `POST /api/auth/verify` - Verify the signed challenge and sign in
  - Body: `{ walletAddress, signedMessage }` (`signedMessage` is the base64 signature from the wallet's `signMessage` call)
  - Returns: `{ user: { id, walletAddress }, token, hasProfile, username }`

**Twitter / X** (OAuth 2.0 Authorization Code + PKCE; requires `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`, `TWITTER_REDIRECT_URI`):

- `GET /api/auth/twitter` - Start the flow; returns `{ redirectUrl }` to send the browser to (`503` if unconfigured)
- `GET /api/auth/twitter/callback?code=...&state=...` - Exchange the authorization code and sign in
  - Returns the standard session shape; `400` on missing `code`/`state`, `401` on an unknown/expired/reused `state`

**Magic link (email)** (single-use, 15-minute token; requires the email provider settings and `JWT_SECRET`):

- `POST /api/auth/magic-link` - Request a sign-in link (`RESEND_API_KEY` unset logs it instead of sending)
  - Body: `{ email }`
  - Returns: `{ message }` - the same generic message for new and existing addresses; `429` when rate-limited
- `POST /api/auth/magic-link/verify` - Verify a token and sign in
  - Body: `{ token }`
  - Returns the standard session shape; `401` on an invalid, expired, or already-used token

### Creators

- `GET /api/creators` - List all creators
- `GET /api/creators/:username` - Get creator by username
- `POST /api/creators/:username/create` - Create username after first wallet sign-in (requires auth)
  - Body: `{ walletAddress, displayName, bio }`
- `PUT /api/creators/:username` - Update creator profile
  - Body: `{ walletAddress, displayName, bio, avatarUrl }`

### Donations

- `GET /api/donations` - List donations (query: `creatorUsername`, `page`, and `limit`; default limit 20, maximum 100)
- `POST /api/donations` - Record a donation (requires an `Idempotency-Key` header; keys are retained for 24 hours)
  - Body: `{ creatorUsername, senderAddress, amount, message, transactionHash }` (the listener derives operation/event indices from RPC). `transactionHash` is required — a hash-less report is rejected with `400` rather than stored as a verifiable donation.
  - The record is upserted by the durable on-chain identity rather than inserted again on replay. Client-reported rows are always stored `verified: false` (only the listener / subscription executor sets `verified: true`), so they stay out of the verified-only feed until verified.

### Subscriptions (recurring donations)

- `GET /api/subscriptions` - List subscriptions (query: `creatorUsername`, `supporterAddress`)
- `POST /api/subscriptions` - Record a subscription the caller already started on-chain (requires auth; caller's wallet must match `supporterAddress`)
  - Body: `{ creatorUsername, supporterAddress, token, amount, intervalSecs, onChainId, subscribeTxHash }`
  - Idempotent on `onChainId` (globally unique, assigned by the donation contract)
- `POST /api/subscriptions/:id/cancel` - Mark a subscription cancelled after the caller cancelled it on-chain (requires auth, owner only)

### Admin

- `GET /api/admin/overview` - View platform/user earnings (requires a wallet in `ADMIN_WALLETS`)
- `GET /api/admin/audit-logs?page=1&limit=20` - View recent privileged actions and before/after snapshots (requires an allowlisted admin)

### Real-Time Events

- `GET /api/events` - Server-Sent Events stream of on-chain donations. The
  backend's `SorobanEventListener` polls the Soroban RPC for the `donation`
  contract's `DonatedEvent`s and republishes them here as they're seen
  (`event: donation`, `data: { donor, creator, amount, memo, timestamp, txHash, eventId, currency }`).
  Events are indexed idempotently by transaction hash, operation index, and
  event index, so a restart/lookback replay cannot double-count a donation.
  The frontend dashboard and creator profile pages subscribe with
  `EventSource` to update live without polling the REST API.

## Frontend Pages

- `/` - Landing page (includes "Connect Wallet" sign-in)
- `/auth/username` - Create username after first wallet sign-in (protected)
- `/dashboard` - Creator dashboard (protected)
- `/settings` - Profile and wallet settings (protected)
- `/[username]` - Public creator profile
- `/app/subscriptions` - Manage and cancel your recurring donations (protected)
- `/donate` - Redirects to home (legacy route)
- `/admin` - Allowlisted admin overview (earnings and user audit summary)
- `/admin/audit` - Recent privileged admin actions (allowlisted admins only)

## Environment Variables

### Backend (.env)

```env
DATABASE_URL=postgresql://user:password@localhost:5432/supportme
PORT=4000
JWT_SECRET=your-secret-key-here-change-in-production
NODE_ENV=development

# Optional: enables the Soroban event listener that powers /api/events (SSE).
# Without this set, the backend logs a warning and skips event polling.
# v2 (adds recurring donations/subscriptions) - matches the frontend's
# NEXT_PUBLIC_DONATION_CONTRACT_ID below.
DONATION_CONTRACT_ID=CAO2UABEB4A3EYFTWCMOSTFAUZ5FBSFRESQGWQHOLASZ3RHDCQHQG2LP
# Prefer a comma-separated failover pool. The singular setting remains supported.
# SOROBAN_RPC_URLS=https://soroban-testnet.stellar.org,https://backup-soroban.example/rpc
# SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
# SOROBAN_RPC_TIMEOUT_MS=10000
# SOROBAN_USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA
# SOROBAN_USDC_TOKEN_ID=...
# SOROBAN_EVENTS_POLL_INTERVAL_MS=5000
# SOROBAN_EVENTS_LOOKBACK_LEDGERS=100

# Required for /api/admin/*; comma-separated Stellar wallet allowlist.
# ADMIN_WALLETS=GADMIN...

# Optional: enables the SubscriptionExecutor that auto-charges due recurring
# donations. Without this set, the backend logs a warning and skips
# charging — subscriptions can still be created/cancelled, they just won't
# auto-charge. See "What's New (v5)" above for setup steps.
# EXECUTOR_SECRET_KEY=S...
# SUBSCRIPTION_EXECUTOR_POLL_INTERVAL_MS=60000

# Twitter/X OAuth 2.0 sign-in. All three are required to enable it; if any is
# missing, GET /api/auth/twitter and /api/auth/twitter/callback return 503.
# Register an app at https://developer.x.com (OAuth 2.0, "Web App" type) and
# add TWITTER_REDIRECT_URI to its allowed callback URLs. See
# docs/authentication.md for the full walkthrough.
# TWITTER_CLIENT_ID="..."
# TWITTER_CLIENT_SECRET="..."
# TWITTER_REDIRECT_URI="https://localhost:3000/auth/twitter/callback"

# Magic link (email) sign-in. Magic links are sent through Resend; without
# RESEND_API_KEY the message (and link) is logged instead of sent, so the flow
# still works in local dev. EMAIL_FROM must be a domain/address verified in
# Resend, and APP_URL is the public origin used to build the verification link.
# RESEND_API_KEY="re_..."
# EMAIL_FROM="SupportMe <notifications@supportme.app>"
# APP_URL="https://localhost:3000"
```

### Frontend (.env.local)

Copy [`frontend/.env.example`](frontend/.env.example) to `frontend/.env.local`.
The key settings are:

```env
# v2 (adds recurring donations/subscriptions) - see the contract table above.
NEXT_PUBLIC_DONATION_CONTRACT_ID=CAO2UABEB4A3EYFTWCMOSTFAUZ5FBSFRESQGWQHOLASZ3RHDCQHQG2LP
NEXT_PUBLIC_CREATOR_REGISTRY_CONTRACT_ID=CB6PH7KYI3UHAUNYIJVCV7CT6BOBROLSR4LSZB3WSGFOYOW6JFAF5NDU
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
# Client-side UX gate for /admin; backend ADMIN_WALLETS remains authoritative.
# NEXT_PUBLIC_ADMIN_WALLETS=GADMIN...

# SEP-24 cash-out anchor. Optional — if unset, the app defaults to the SDF
# reference anchor (testanchor.stellar.org / SRT). For local development
# against the self-hosted anchor, run `cd anchor && ./setup.sh` and set:
NEXT_PUBLIC_ANCHOR_HOME_DOMAIN=localhost:8080
NEXT_PUBLIC_ANCHOR_ASSET_CODE=USDC

# Public origin used to build absolute og:image / twitter:image URLs for link
# previews. Optional on Vercel (falls back to the production domain).
# NEXT_PUBLIC_SITE_URL=https://your-domain.example
```

**Deploying to Vercel:** do not ship `localhost:8080` — `NEXT_PUBLIC_` vars
are baked into the browser bundle at build time, so a visitor's browser would
try to reach `localhost` on _their own_ machine. For a hosted testnet demo
with no infrastructure to run, set these in the Vercel project's environment
variables and redeploy:

```env
NEXT_PUBLIC_ANCHOR_HOME_DOMAIN=testanchor.stellar.org
NEXT_PUBLIC_ANCHOR_ASSET_CODE=SRT
```

This uses the SDF public reference anchor (settles in the `SRT` test asset;
its backend errors intermittently server-side). To run the demo on _your own_
USDC anchor instead, the Docker stack in [`anchor/`](anchor/) must run on a
public host with HTTPS (Vercel can't host containers) and
`NEXT_PUBLIC_ANCHOR_HOME_DOMAIN` must point at that domain.

## Development Workflow

```bash
# Terminal 1: Start backend
cd backend
npm run dev

# Terminal 2: Start frontend
cd frontend
npm run dev
```

Visit `https://localhost:3000` in your browser.

### Testing the Flow

You need a wallet set to **Testnet** and an account funded with
[Friendbot](https://friendbot.stellar.org). If something fails, see
[Testnet troubleshooting](docs/testnet-troubleshooting.md).

1. **Connect Wallet**: On the landing page, click "Connect Wallet", pick a wallet, and approve the sign-message request
2. **Create Username**: First-time sign-ins are redirected to `/auth/username`, choose a unique username
3. **Dashboard**: Land in `/dashboard` - see stats and profile link
4. **Set Payout Wallet**: Go to `/settings`, click "Connect Wallet", pick a wallet, approve (can be the same or a different wallet from the one used to sign in)
5. **Share Link**: Copy your profile URL from dashboard
6. **Send Donation**: Visit your profile URL, connect a wallet as supporter, sign the `donate` contract call

## Database Models

### User

```
id, walletAddress (unique), createdAt, updatedAt
```

### Creator

```
id, userId (foreign key), username (unique), walletAddress,
displayName, bio, avatarUrl, socialLinks (JSON),
acceptsXlm (default: true), acceptsUsdc (default: true), acceptsUsdt (default: false),
donationGoal (deprecated — see Goal below), createdAt, updatedAt
```

### Goal

```
id, creatorId (foreign key), title, targetAmount (Float), currentAmount (Float, default: 0),
currency (default: "XLM"), status (ACTIVE | COMPLETED | EXPIRED),
recurring (default: false), recurrenceInterval (WEEKLY | MONTHLY),
currentPeriodEnd, createdAt, updatedAt
```

A creator can have several goals active at once, each denominated in its own
asset. `Creator.donationGoal` is deprecated in favor of this model — a
migration copies any existing single goal into a `Goal` row (see
[`backend/prisma/migrations`](backend/prisma/migrations)) rather than
dropping it.

### Donation

```
id, creatorId (foreign key), senderAddress, amount (Float),
currency (default: "XLM"), message, transactionHash, createdAt
```

### Subscription

```
id, creatorId (foreign key), supporterAddress, token, amount (Float),
intervalSecs, onChainId (unique), subscribeTxHash, nextChargeAt,
active (default: true), lastChargeTxHash, lastChargedAt, lastError,
createdAt, updatedAt
```

## Testing

Each part of the stack has its own test suite:

```bash
# Smart contracts (Rust unit + cross-contract integration tests)
cargo test --workspace

# Backend (Jest + Supertest, Prisma is mocked so no database is needed)
cd backend
npm test

# Frontend (Vitest + React Testing Library)
cd frontend
npm test
```

## CI/CD

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs independent jobs on every push and pull request to `main`, tied together by a single required `test-all` status check:

- **Contracts**: `cargo fmt --all -- --check`, `cargo test --workspace` for all three crates,
  `cargo clippy --workspace --all-targets -- -D warnings`, then a release build to
  `wasm32v1-none` to confirm both contracts still compile to WASM.
- **Backend**: `npm run lint` (ESLint, flat config), `npm run build` (Prisma client generation + `tsc`), then
  `npm test`.
- **Frontend**: `npx tsc --noEmit`, `npm run lint` (ESLint, flat config), then `npm test`, then `npm run build`.
- **Dependency Review**: On pull requests, GitHub's Dependency Review Action fails the check if the
  dependency changes in that PR introduce a new high-severity (or above) vulnerability; it does not
  re-flag vulnerabilities that already exist in `main`'s dependency tree.
- **Type Drift**: Verifies that changes to shared contract types (`contracts/common/src/lib.rs`) are accompanied by frontend TypeScript updates.
- **All tests passed**: A single job depending on all the above to provide a unified 'all green' status for branch protection.
  None of the jobs require real secrets or a live database — backend tests
  mock Prisma, and the Prisma client can be generated from `schema.prisma`
  without a reachable `DATABASE_URL`.

[`.github/dependabot.yml`](.github/dependabot.yml) opens weekly update pull requests for npm in
`frontend/` and `backend/`, the root Cargo workspace, and the GitHub Actions workflows themselves;
minor/patch updates within each ecosystem are grouped into one pull request instead of one per
dependency.

## Deployment

### Backend Deployment

```bash
# Build TypeScript
npm run build

# Deploy dist/ folder to your server (Heroku, Railway, Fly.io, etc.)
# Set environment variables on your hosting platform
npm start
```

### Frontend Deployment

```bash
# Build Next.js
npm run build

# Deploy to Vercel (recommended for Next.js)
# Or use other platforms like Netlify, AWS Amplify, etc.
```

## Security Notes

- JWT tokens expire in 7 days
- Sign-in requires a signed challenge message proving ownership of the wallet's private key (SEP-0053 verification), not just a submitted address
- Twitter/X sign-in uses OAuth 2.0 Authorization Code + PKCE; the PKCE verifier and the single-use `state` value stay server-side and expire after 10 minutes
- Magic-link tokens are stored only as SHA-256 hashes, are single-use, expire after 15 minutes, and are rate-limited to 5 requests per email per 15 minutes; requesting a link never reveals whether an address has an account
- Twitter OAuth and magic link degrade gracefully: unconfigured providers return `503` instead of breaking startup, so a deployment only needs the methods it enables
- All sensitive routes require valid JWT token
- CORS is enabled for development (configure for production)
- Stellar transactions are signed client-side via the connected wallet (Stellar Wallets Kit)

See [`docs/authentication.md`](docs/authentication.md) for auth setup details and the full set of auth-related environment variables.

## Contributing

See `CONTRIBUTING.md` for guidelines on making changes, opening issues, and submitting pull requests.

## Documentation

The full index, grouped by audience, is in [`docs/README.md`](docs/README.md).
Key entry points:

- [Testnet Troubleshooting](docs/testnet-troubleshooting.md) - Every wallet, donation and cash-out error, with testnet causes and fixes
- [Architecture Overview](docs/architecture.md) - System architecture and component interactions
- [Backend Configuration](backend/docs/CONFIGURATION.md) - Backend environment variables and defaults
- [Backend API Reference](docs/backend-api-reference.md) - Complete API documentation for all backend endpoints
- [Testing](TESTING.md) - What CI runs and how to run each suite locally

## Roadmap

- [x] Twitter OAuth authentication (#1, #10, #14)
- [x] Magic link (email-only) authentication (#2, #11, #15)
- [x] Custom themes for creator profiles (#3, #21, #227)
- [x] Leaderboards (top creators, top supporters) (#4, #12, #16)
- [x] QR code generation for profiles (#5, #13, #226)
- [x] Email notifications for donations (#6, #17, #97)
- [x] Additional asset support (USDT, etc.) (#7, #18)
- [ ] Embeddable donation widgets (#8) — design spec shipped ([`docs/design/donation-widget.md`](docs/design/donation-widget.md)); implementation still pending
- [x] Creator goals and progress tracking (#9, #225)

## License

MIT

## Support

For issues, questions, or suggestions, please open an issue on GitHub or contact the team..
