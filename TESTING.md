# Testing

This guide covers the test suites and checks run by the repository's GitHub
Actions workflow in [.github/workflows/ci.yml](.github/workflows/ci.yml).
CI runs on pushes to `main` and pull requests targeting `main`; the workflow
does not filter by changed paths, so all jobs run for each pull request.

## Prerequisites

- Node.js 20 (see [`.nvmrc`](.nvmrc), the version CI uses via
  `node-version-file`). npm 11+ for the frontend (`npm install -g npm@11` —
  its lockfile needs npm 11's resolver, which is why CI force-installs it
  before `npm ci`) and npm 10+ for the backend (no upgrade needed; Node 20's
  bundled npm already satisfies this).
- Rust stable and `rustup` for the contract workspace. CI installs the
  `wasm32v1-none` target for the contract build.
- Chromium for running the frontend browser tests locally.

Install JavaScript dependencies with `npm ci` from the relevant package
directory. The frontend and backend each have their own `package-lock.json`.

## Frontend

From `frontend/`:

```sh
npm ci
npx tsc --noEmit
npm run lint
npm test
npm run build
```

`npm test` runs Vitest tests in jsdom. `npm run lint` runs ESLint using the
flat config in [`frontend/eslint.config.mjs`](frontend/eslint.config.mjs); CI
runs it as its own step, after the type check and before the test/build
steps. To run the Playwright end-to-end suite, install Chromium once and then
run:

```sh
npx playwright install chromium
npm run test:e2e
```

Playwright starts its own Next.js development server with
`npx next dev -p 3000` (see the `webServer` block in
[`frontend/playwright.config.ts`](frontend/playwright.config.ts)). This server
uses plain **HTTP** at `http://localhost:3000`, unlike `npm run dev`, which
serves `https://localhost:3000` with `--experimental-https`. Playwright can
reuse an existing local server on that port when not running in CI, but that
server must answer on `http://localhost:3000`. Stop a running `npm run dev`
(HTTPS) first, or start the app with `npm run dev:http`.
`PLAYWRIGHT_BASE_URL` changes the URL the tests open. The web server is still
started and checked at `http://localhost:3000`. CI installs Chromium with its system
dependencies using `npx playwright install --with-deps chromium` before running
the same `npm run test:e2e` command.

For errors you see when testing manually against the Stellar testnet (wallet
network, Friendbot funding, trustlines, contract errors), see
[`docs/testnet-troubleshooting.md`](docs/testnet-troubleshooting.md).

## Backend

From `backend/`:

```sh
npm ci
npm run lint
npm test
npm run build
```

`npm test` runs Jest tests, including HTTP route tests using Supertest. `npm
run lint` runs ESLint using the flat config in
[`backend/eslint.config.mjs`](backend/eslint.config.mjs), including the
type-aware `@typescript-eslint/no-floating-promises` rule (an un-awaited,
uncaught promise in an Express route handler or the subscription executor's
background loop is a real bug: a dropped request or a silently-missed
charge). CI runs it as its own step, right after installing dependencies. The
build runs `prisma generate` followed by the TypeScript compiler. CI supplies
`DATABASE_URL=postgresql://postgres:postgres@localhost:5432/supportme?schema=public`
for this build step.

## Contracts

Run contract unit tests from the repository root:

```sh
cargo test --workspace
```

To also verify the release WASM build performed by CI, install the target if it
is not already available and run:

```sh
rustup target add wasm32v1-none
cargo build --workspace --target wasm32v1-none --release
```

Check formatting and lint with Clippy, both of which CI runs as their own
steps (`rustfmt` and `clippy` components are installed alongside the
toolchain):

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

`cargo fmt --all` (without `--check`) applies the formatting a failing check
expects. A Clippy warning fails the build (`-D warnings`); fix it, or if it's
a deliberate false positive, suppress it with a scoped `#[allow(clippy::...)]`
directly above the specific line along with a one-line reason comment, not a
blanket module- or crate-level allow.

The Cargo workspace includes the donation and creator-registry contracts, as
well as shared contract code.

## Testnet Integration Tests

SupportMe includes an end-to-end integration test suite that exercises the full
on-chain lifecycle against a live Soroban RPC on Stellar Testnet:

- Funds fresh donor, creator, and executor accounts via Friendbot.
- Deploys and initializes fresh instances of `creator-registry` and `donation` contracts.
- Exercises creator registration, one-time XLM donation, SAC allowance approval, recurring subscription creation, charging subscription by authorized executor, and subscription cancellation.
- Ingests on-chain events via `server.getEvents` and feeds them through `SorobanEventListener.processEvent` to validate event decoding.

### Running Locally

Prerequisites:

- Contracts compiled to WASM: `cargo build --workspace --target wasm32v1-none --release`
- Stellar CLI installed: `stellar --version`
- Backend dependencies installed: `cd backend && npm ci`

Run the integration suite from the `backend/` directory:

```sh
cd backend
npm run test:testnet
```

Optionally specify pre-deployed contracts or a custom RPC endpoint:

```sh
DONATION_CONTRACT_ID=<id> CREATOR_REGISTRY_CONTRACT_ID=<id> npm run test:testnet
```

### Scheduled CI

A dedicated GitHub Actions workflow ([.github/workflows/testnet-integration.yml](.github/workflows/testnet-integration.yml))
runs nightly and on manual `workflow_dispatch`. It includes automatic retries to account for transient testnet network flakiness.

## What CI Runs

For every pull request targeting `main`, the workflow runs:

- **Contracts:** `cargo fmt --all -- --check`, `cargo test --workspace`,
  `cargo clippy --workspace --all-targets -- -D warnings`, and a release
  build for `wasm32v1-none`.
- **Backend:** `npm ci`, `npm run lint`, `npm run build`, and `npm test` in
  `backend/`.
- **Frontend:** `npm ci`, `npx tsc --noEmit`, `npm run lint`, `npm test`, and
  `npm run build` in `frontend/`.
- **Frontend E2E:** install Chromium and run `npm run test:e2e` in
  `frontend/`.
- **Dependency Review:** on pull requests only, flags any dependency change
  that introduces a new high-severity (or above) vulnerability, via GitHub's
  [Dependency Review
  Action](https://github.com/actions/dependency-review-action). This is
  diff-based: it does not fail on vulnerabilities that already exist on
  `main` in either `frontend/` or `backend/`'s current dependency tree (see
  `npm audit` below).
- **Type drift:** if `contracts/common/src/lib.rs` changes, require a changed
  frontend TypeScript file in the same pull request.

Dependabot (see [`.github/dependabot.yml`](.github/dependabot.yml)) opens
weekly update pull requests for `frontend/`, `backend/`, the contracts Cargo
workspace, and the GitHub Actions workflows themselves; minor/patch updates
within each ecosystem are grouped into a single pull request rather than one
per dependency. `npm audit --audit-level=high` currently reports pre-existing
high/critical findings in both `frontend/` and `backend/`'s dependency trees
(transitive dependencies, not anything this repository's own code depends on
directly); that is why CI uses the diff-based Dependency Review Action above
instead of a flat `npm audit` step, which would fail on every pull request
today regardless of its content. Resolving those pre-existing findings is
tracked separately from linting/CI setup.

## Coverage Expectations

There is currently no configured coverage report or minimum percentage enforced
by CI. The Playwright project covers Chromium only, and its fixtures mock the
wallet and backend boundaries; it does not validate live wallet-provider,
backend deployment, or testnet behavior.

Add or update tests for the behavior a pull request changes. Cover successful
and rejected inputs or operations where relevant, and include important edge
states such as validation failures, authorization failures, empty data, and
network errors. Prefer focused Vitest/Testing Library tests for frontend
interactions, Jest/Supertest tests for backend routes and services, and Rust
unit tests for contract behavior. Use Playwright when a change affects a
complete browser workflow; it complements rather than replaces focused tests.
Do not skip or weaken a test to make a change pass. No fixed coverage
percentage is expected; tests should exercise the new behavior and its
meaningful failure cases.
