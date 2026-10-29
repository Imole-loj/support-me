# SupportMe Backend

This backend is a lightweight API layer for the SupportMe application.
It is built with TypeScript, Express, and Prisma, and is designed to support creator profiles, donations, and backend-driven dashboards.

## Features

- REST API for creators and donations
- PostgreSQL-compatible Prisma schema
- Local development server with hot reload
- Clear extension points for contributors

## Getting Started

1. Install dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Create a `.env` from the example:
   ```bash
   cp .env.example .env
   ```

3. Set your database URL in `.env`.

4. Apply the database migrations (this also generates the Prisma client):
   ```bash
   npx prisma migrate dev
   ```

5. Run the backend in development mode:
   ```bash
   npm run dev
   ```

6. Visit the health check:
   ```bash
   http://localhost:4000/health
   ```

## Postgres integration tests

With the backend dependencies and generated Prisma client already available,
and a running local/test PostgreSQL database, run from `backend/`:

```bash
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/supportme' npm run test:integration
```

The database role needs `CREATEDB` and permission to drop the database it
creates. Point the command at a local/test Postgres instance, never production.
The runner creates a randomly named temporary database and a fresh schema for
each invocation, runs `prisma migrate deploy` against it, runs the separate
Jest integration project serially, and drops the temporary database (including
its schema) in a `finally` block even when a test fails. Each test truncates
only tables in that schema; the supplied database is used only as the
administrative connection. A separate database avoids cross-schema catalog
guards in historical migrations interfering with setup. If the process is
forcibly killed, its `integration_<uuid>` database may need manual removal.

This suite uses real Prisma transactions and Postgres constraints, covering
donation HTTP retries, concurrent idempotency keys, key expiration, listener
event replay and goal progress, and all three on-chain identity constraints.
Only outbound donation notifications are mocked. The regular `npm test`
suite remains independent of Postgres. CI runs both suites using its Postgres
service, after deploying migrations.

## Seeding demo data

For local and testnet demos, populate the database with creators, goals,
donations, one recurring subscription and one withdrawal:

```bash
npx prisma db seed        # runs prisma/seed.ts via ts-node
npx prisma db seed -- --fund   # also fund the demo wallets via Friendbot (testnet)
```

The seed is idempotent — every row is upserted on a stable natural key, so
running it twice produces no duplicates. It refuses to run against a
`NODE_ENV=production` database unless `SEED_FORCE=true` is set. The demo wallet
addresses are public keys only; no secret keys are stored.

## API Endpoints

- `GET /health`
- `GET /api/creators`
- `POST /api/creators`
- `GET /api/creators/:username`
- `PUT /api/creators/:username`
- `GET /api/donations?creatorUsername={username}&page=1&limit=20`
- `POST /api/donations` (requires an `Idempotency-Key` header)
- `GET /api/admin/overview` (requires an allowlisted admin wallet)
- `GET /api/admin/audit-logs?page=1&limit=20` (requires an allowlisted admin wallet)

Donation history responses contain `items` and `pagination`. `limit` defaults to
20 and is capped at 100. Use `page` to request older pages. Recording the same
on-chain donation again with the same `Idempotency-Key` returns the original
donation without inserting another row. Keys are retained for 24 hours.

Creator payout wallets are nullable. A profile created through Twitter or a
magic link can exist before its owner connects a wallet; it remains accessible
by username and explains that tips are unavailable. Discover/search and creator
leaderboards exclude these profiles until a payout wallet is connected. The
creation endpoint accepts legacy empty-string wallets but stores them as null;
the payout-wallet migration converts existing empty strings and prevents new
ones. Connected wallets still require ownership proof and remain unique.

`GET /health` reports `status: "ok"` when the process and Soroban RPC are
available, and `status: "degraded"` with `dependencies.sorobanRpc.status:
"down"` when all RPC endpoints fail. Configure a failover pool with
`SOROBAN_RPC_URLS` (comma-separated, in priority order); the legacy
`SOROBAN_RPC_URL` setting is still accepted. `SOROBAN_RPC_TIMEOUT_MS` controls
the per-endpoint timeout (the health probe allows 1.5 seconds per endpoint and
up to 3 seconds total for failover). Each
successful request logs the endpoint that served it, and failed endpoints are
logged before the next attempt.

The response also carries `network: "ok" | "reset_detected"`. On boot — and on
every event-listener poll — the backend compares the chain's latest ledger with
a stored checkpoint and checks that the donation contract still exists. A
testnet reset makes the latest ledger move backwards or the contract vanish, at
which point `status` becomes `"unhealthy"`, `network` becomes
`"reset_detected"`, and the executor and event listener pause so they stop
charging against the dead chain. Recovery steps are in
[the testnet reset runbook](../docs/testnet-troubleshooting.md#testnet-reset-runbook).

## Notes for Contributors

- The backend is intentionally simple so contributors can add authentication, payment workflows, and dashboard queries.
- There is no contract dependency for this API layer.
- Soroban donation events are indexed with a durable `(transaction hash, operation index, event index)` identity. A listener restart may replay the configured lookback window, but the unique on-chain identity makes the database write an idempotent upsert rather than a second donation. New contract events include the SAC token address; redeploy the donation contract with this event shape before relying on USDC classification, and configure `SOROBAN_USDC_ISSUER` (or `SOROBAN_USDC_TOKEN_ID`) so the listener can classify USDC instead of guessing.
- Donation rows reported by a browser with a transaction hash remain provisional (`verified: false`) and are excluded from aggregate queries until the listener verifies the on-chain event; the listener then replaces the provisional metadata with authoritative event data.
- Admin overview access and future state-changing admin routes are recorded in `AdminAuditLog`; `/api/admin/audit-logs` exposes the recent entries to allowlisted admins.
- If you add or change a database model, follow [Creating a schema change](#creating-a-schema-change) below.

## Creating a schema change

The schema is versioned with Prisma Migrate. Every change to
`prisma/schema.prisma` ships with a migration folder in
[`prisma/migrations/`](prisma/migrations).

1. Edit `prisma/schema.prisma`.
2. Create and apply a migration against your local database. Give it a short
   descriptive name:
   ```bash
   npx prisma migrate dev --name add_creator_banner
   # or: npm run prisma:migrate -- --name add_creator_banner
   ```
   This writes `prisma/migrations/<timestamp>_add_creator_banner/migration.sql`,
   applies it, and regenerates the Prisma client.
3. Review the generated SQL. If the change needs a data backfill, or could fail
   on existing rows (for example a new `NOT NULL` column or a new unique
   constraint), edit `migration.sql` before you commit. For a unique
   constraint, reconcile duplicate rows first.
4. Commit the schema change and the new migration folder together, along with
   any code and tests that use them.
5. Staging and production apply committed migrations with:
   ```bash
   npx prisma migrate deploy   # or: npm run prisma:deploy
   ```
   `migrate deploy` only applies pending migrations. It never creates
   migrations, prompts, or resets data, so it is safe to run in CI and deploys.
   Never run `migrate dev` against a shared database.

`npx prisma db push` syncs the schema to a database without recording a
migration. Use it only for a throwaway prototype database. A database that was
set up with `db push` has no migration history, so `migrate deploy` cannot
manage it later.

The `backend` CI job replays `prisma/migrations/` into a shadow Postgres
service and diffs the result against `schema.prisma`, failing when the two
disagree:

```bash
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code
```

Exit code 0 with `No difference detected.` is the passing case; exit code 2
means a schema change is missing its migration. Run it locally before pushing
if you touched `schema.prisma` (the shadow URL must point at an empty
database, which the CLI does not create for you).
