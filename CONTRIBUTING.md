# Contributing to SupportMe

Thank you for your interest in contributing to SupportMe. This project is built to support creator tipping and donations across a Next.js frontend, an Express + Prisma backend, and Soroban smart contracts on Stellar.

## How to Contribute

1. Fork the repository.
2. Create a descriptive branch name, e.g. `feature/creator-dashboard` or `fix/api-validation`.
3. Make small, focused changes.
4. Add or update documentation when you add features — and tick the README Roadmap checklist when a roadmap item ships.
5. Run the affected test suites (see [`TESTING.md`](TESTING.md)); CI runs the frontend, backend, and contract suites on every pull request.
6. Commit with clear messages.
7. Open a pull request with a summary and motivation.

## Repository Structure

- `frontend/` — Next.js client for public pages, the creator dashboard, and donation flows.
- `backend/` — Express API with Prisma and PostgreSQL support.
- `contracts/` — Soroban smart contracts (`donation`, `creator-registry`) in a Cargo workspace. Deployed testnet addresses are listed in the README; contract tests run in CI on every pull request.
- `anchor/` — Local SEP-24 test anchor for the fiat cash-out flow; see [`anchor/README.md`](anchor/README.md).
- `docs/` — Architecture, API, authentication, security, troubleshooting, and runbook documentation. Start at the index in [`docs/README.md`](docs/README.md).
- [`docs/testnet-quickstart.md`](docs/testnet-quickstart.md) — Step-by-step testnet wallet setup (Freighter, Friendbot, USDC trustline, first tip).
- `docs/design/` — Handoff-ready UI/UX specs (donation widget, profile themes, empty states, …). New UI areas start here before implementation.
- `TESTING.md` — What CI runs and how to run each suite locally.

## Development Setup

### Backend

See [`backend/docs/CONFIGURATION.md`](backend/docs/CONFIGURATION.md) for the
backend environment variables grouped by service, including defaults and
local, staging, and production guidance.

```bash
cd backend
npm install
cp .env.example .env
# update DATABASE_URL in .env
npx prisma migrate dev   # apply migrations (also generates the Prisma client)
npm run dev
```

To change the database schema, follow
[Creating a schema change](backend/README.md#creating-a-schema-change). Commit
the generated migration with your change. Do not use `prisma db push` on a
database you intend to keep.

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local   # every variable is documented in the example
npm run dev                  # serves https://localhost:3000
```

`npm run dev` uses `next dev --experimental-https`. The first run creates a
self-signed certificate for `localhost` and may ask for your password to trust
it. Otherwise your browser shows a one-time certificate warning. Use
`npm run dev:http` if you need plain `http://localhost:3000`. In that case,
update `APP_URL` and `TWITTER_REDIRECT_URI` in `backend/.env` to match. See the
README's Frontend Setup section for details.

If a wallet, donation or cash-out step fails on testnet, see
[`docs/testnet-troubleshooting.md`](docs/testnet-troubleshooting.md). The full
documentation index is in [`docs/README.md`](docs/README.md).

### Auth providers (optional)

Wallet sign-in only needs `JWT_SECRET`. To exercise the Twitter/X OAuth and
magic-link flows locally, add the relevant variables to `backend/.env` and
restart the server:

- **Twitter/X OAuth**: `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`, and
  `TWITTER_REDIRECT_URI`. Register an app at
  [developer.x.com](https://developer.x.com) and set its callback URL to
  `https://localhost:3000/auth/twitter/callback`, the origin `npm run dev`
  serves. If you use `npm run dev:http`, register
  `http://localhost:3000/auth/twitter/callback` instead (Twitter allows HTTP
  for localhost).
- **Magic link**: `RESEND_API_KEY` (plus optional `EMAIL_FROM` and `APP_URL`).
  If `RESEND_API_KEY` is unset, the magic link is printed to the backend log
  instead of being emailed — the quickest way to test the flow locally.

Both methods are optional: the app runs without them, and the endpoints return
`503` when a provider is unconfigured. See
[`docs/authentication.md`](docs/authentication.md) for the full setup steps,
required environment variables, and curl walkthroughs.

## What We Want

- Clean, well-documented APIs
- Stable database schema and migrations
- Accessible frontend flows
- A small, well-tested contract surface — new on-chain logic should be justified
- Tests and validation for new features

## Best Practices

- Keep user flows simple and reliable.
- Prefer explicit API responses and error handling.
- Keep architecture documentation updated.
- Keep the README Roadmap checklist accurate as features ship.
- Design new UI areas (widgets, themes, …) in `docs/design/` before implementing them.
- Avoid adding contract complexity unless it is required by the feature.

## Dependency Updates

[Dependabot](.github/dependabot.yml) opens automated pull requests on a weekly
schedule for four ecosystems: npm in `frontend/`, npm in `backend/`, the root
Cargo workspace (`contracts/`), and the GitHub Actions used in
`.github/workflows/`. Expect roughly one pull request per ecosystem per week
under normal circumstances, since minor and patch updates within each
ecosystem are grouped into a single pull request rather than opened one at a
time; a major version bump still opens its own pull request. Review and merge
these the same way as any other pull request, including running the affected
test suite locally if CI doesn't give you enough confidence on its own.

## Reporting Issues

If you find a bug or want to propose a feature, open an issue with:

- Summary of the problem or feature
- Steps to reproduce / expected behavior
- Any relevant screenshots or logs
