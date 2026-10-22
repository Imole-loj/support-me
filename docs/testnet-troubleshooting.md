# Testnet troubleshooting

SupportMe runs on the **Stellar testnet**. This page lists every error title
the app shows for wallet connections, donations, subscriptions and the SEP-24
cash-out flow. For each one it gives the likely testnet causes and the steps
to fix them.

The error copy comes from these files:

- [`frontend/lib/walletErrors.js`](../frontend/lib/walletErrors.js): wallet
  connection errors (the card rendered by
  [`components/WalletConnectError.tsx`](../frontend/components/WalletConnectError.tsx)).
- [`frontend/lib/failures.ts`](../frontend/lib/failures.ts): donation and
  subscription failures (the error toast on a creator's profile page).
- [`frontend/lib/anchor.js`](../frontend/lib/anchor.js): SEP-24 anchor
  (cash-out) errors. These are `AnchorError`s identified by a `step` rather
  than a title.

The wallet error card and the donation error toast link to the matching
heading on this page ("Learn more"). Keep each heading identical to the title
in the source file. A unit test
([`frontend/lib/__tests__/troubleshootingDoc.test.ts`](../frontend/lib/__tests__/troubleshootingDoc.test.ts))
fails if a title has no matching heading here.

## Contents

- [Before you start: testnet checklist](#before-you-start-testnet-checklist)
- [Testnet reset](#testnet-reset)
- [Wallet connection errors](#wallet-connection-errors)
- [Donation and subscription errors](#donation-and-subscription-errors)
- [Reading a raw "Transaction rejected" message](#reading-a-raw-transaction-rejected-message)
- [Cash-out (SEP-24 anchor) errors](#cash-out-sep-24-anchor-errors)
- [FAQ](#faq)

## Before you start: testnet checklist

Most testnet failures come from a short list of causes. Check these first:

1. **The wallet is on Testnet.** The app builds and signs every transaction
   with the testnet passphrase (`Networks.TESTNET` in
   [`frontend/lib/wallet.js`](../frontend/lib/wallet.js) and
   [`frontend/lib/contract.js`](../frontend/lib/contract.js)). A wallet set
   to Mainnet ("Public") or Futurenet cannot sign these transactions. In
   Freighter, open **Settings → Network** and select **Testnet**.
2. **The account is funded.** A new Stellar account does not exist on the
   network until it receives XLM. Fund it with Friendbot:
   `https://friendbot.stellar.org/?addr=<YOUR_G_ADDRESS>`, or use the "Fund
   with Friendbot" button in Freighter (testnet only).
3. **The account trusts the asset.** To hold or send USDC (or USDT), the
   account needs a trustline to the issuer that the frontend is configured
   with (`NEXT_PUBLIC_USDC_ISSUER`). On testnet this is usually the SDF test
   USDC issuer
   `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA`. Add the
   trustline in your wallet ("Add asset" / "Manage assets"). XLM needs no
   trustline.
4. **The contract IDs are current.** The SDF resets the testnet from time to
   time, and a reset deletes every deployed contract. If
   `NEXT_PUBLIC_DONATION_CONTRACT_ID` (frontend) and the backend's contract
   IDs point at contracts from before a reset, every call fails during
   simulation. Redeploy, or use the IDs in the README contract table. See
   [contract-deploy-workflow.md](contract-deploy-workflow.md) and the
   [testnet reset runbook](#testnet-reset-runbook).
5. **Soroban RPC is up.** The frontend uses `NEXT_PUBLIC_SOROBAN_RPC_URL`
   (default `https://soroban-testnet.stellar.org`). Check
   [status.stellar.org](https://status.stellar.org). The backend's
   `GET /health` endpoint reports `dependencies.sorobanRpc.status: "down"`
   when no RPC endpoint responds.
6. **The contract is not paused.** An admin can pause the donation contract
   (see [admin-multisig-timelock.md](admin-multisig-timelock.md)). While it is
   paused, `donate`, `subscribe`, `charge_subscription` and `register_creator`
   all fail with `contract is currently paused`.

## Testnet reset

The Stellar Development Foundation resets the public testnet from time to time.
A reset wipes every deployed contract, restarts the ledger sequence and empties
accounts the reset did not preserve. After a reset the previously configured
`NEXT_PUBLIC_DONATION_CONTRACT_ID` no longer exists, so every simulated call
fails and the backend's subscription executor can no longer charge anything.

The backend detects a reset automatically (#278): it stores the last ledger
sequence it observed and treats a lower "latest ledger" — or a missing donation
contract — as a reset. When that happens:

- The executor and event listener pause, so no charges are attempted and no
  failure emails are sent for subscriptions that simply ceased to exist.
- `GET /health` reports `status: "unhealthy"` and
  `network: "reset_detected"` (the reason is under `dependencies.network.reason`).
- A fatal message is sent to Sentry.

### Recovering from a reset

1. **Redeploy the contracts** to the testnet. Follow
   [contract-deploy-workflow.md](contract-deploy-workflow.md) and note the new
   donation and creator-registry contract IDs.
2. **Update the contract IDs** in the frontend and backend environments
   (`NEXT_PUBLIC_DONATION_CONTRACT_ID`,
   `NEXT_PUBLIC_CREATOR_REGISTRY_CONTRACT_ID`), then **restart the backend** so
   the new values are loaded. Boot validation (#281) fails fast if the IDs and
   the configured network still disagree, or if the executor key is invalid.
3. **Run the resync.** Sign in as an allowlisted admin and call:

   ```bash
   curl -X POST https://<backend>/api/admin/network-resync \
     -H "Authorization: Bearer <admin-token>"
   ```

   This clears the event cursor, marks the old (now non-existent) active
   subscriptions inactive with an explanatory `lastError`, clears the reset
   state and ledger checkpoint, and restarts the executor and listener against
   the new deployment. The response reports how many subscriptions were
   deactivated.
4. **Confirm recovery.** `GET /health` returns `status: "ok"` and
   `network: "ok"`, and `GET /health/executor` shows a fresh run.
5. **Re-seed demo data if needed** (`npx prisma db seed`) and ask supporters to
   subscribe again from the creator's page.

The ledger checkpoint lives in the `NetworkCheckpoint` table (`key =
"soroban:lastSeenLedger"`). Clearing it by hand
(`DELETE FROM "NetworkCheckpoint";`) has the same effect as the checkpoint step
of the resync, for environments where the admin endpoint cannot be reached.

## Wallet connection errors

These come from `categorizeWalletError()` in
[`frontend/lib/walletErrors.js`](../frontend/lib/walletErrors.js). The
function matches the wallet's error message against patterns, so the category
is a best guess based on what the wallet extension reports.

### No Stellar wallet detected

### Account not funded

The Stellar account does not exist on the network yet. Fund it with Friendbot
using the button in the app or `https://friendbot.stellar.org/?addr=<YOUR_G_ADDRESS>`.
After funding, reload the page and try again.

The wallet kit could not find a wallet extension, or the extension reported
that it is not installed or not connected.

Likely causes:

- No Stellar wallet extension is installed in this browser profile.
- The extension is installed but disabled, or is blocked in a private window.
- Freighter is locked or has no account yet. Some versions report this as
  "not connected".

How to fix it:

1. Install one of the wallets listed on the card (Freighter, xBull, Albedo,
   Rabet or LOBSTR). Albedo is a web wallet and needs no extension.
2. Unlock the extension and create or import an account.
3. Allow the extension in private windows, or use a normal window.
4. Reload the page and click **Try again**.

### Wallet connection cancelled

The connection request was declined, or the wallet window was closed before
you approved it.

How to fix it:

1. Click **Try again**.
2. Approve the request in the wallet popup. If no popup appears, click the
   extension icon. Some wallets queue the request there.

### Wrong network

The wallet reported a network or passphrase mismatch. SupportMe runs only on
the Stellar testnet.

How to fix it:

1. Switch the wallet to **Testnet**. In Freighter, use **Settings → Network**.
   Mainnet ("Public") and Futurenet are not supported.
2. Click **Try again**.

Note: many wallets report a network mismatch only when they sign, not when
they connect. In that case the error appears as
[Signature declined](#signature-declined).

### Could not connect your wallet

The error did not match any known pattern. The card shows the wallet's own
message when there is one.

How to fix it:

1. Click **Try again**.
2. Update the wallet extension to its latest version.
3. If the message mentions a sign-in challenge, the backend rejected the
   wallet sign-in. Check that the backend is running and reachable at
   `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`), and that its CORS
   settings allow the frontend origin (see
   [backend/docs/CONFIGURATION.md](../backend/docs/CONFIGURATION.md)).
4. Try a different wallet to see if the problem is specific to one extension.

## Donation and subscription errors

These come from `describeDonationFailure()` in
[`frontend/lib/failures.ts`](../frontend/lib/failures.ts). It maps the typed
`DonationError` thrown by
[`frontend/lib/contract.js`](../frontend/lib/contract.js) (`wallet`,
`simulation` or `network`) to a title. The design matrix behind this copy is in
[design/donation-subscription-failure-states.md](design/donation-subscription-failure-states.md).

### Signature declined

The wallet did not return a signed transaction. No funds moved.

Likely causes:

- You rejected or closed the signing popup.
- The wallet is on Mainnet or Futurenet and refused to sign a testnet
  transaction.
- The wallet is locked, or the account in the wallet is not the one that
  connected to the page.

How to fix it:

1. Switch the wallet to **Testnet** and unlock it.
2. Make sure the active account in the wallet is the one shown on the page.
3. Try again and approve the request.

### Not enough balance

The transaction failed simulation, and the error message contained
`insufficient`, `underfunded` or `allowance`. The check uses
`INSUFFICIENT_PATTERN = /insufficient|underfunded|allowance/i`, so **allowance
errors also appear under this title**, even though the fix is different.

Likely causes:

- The balance does not cover the amount plus the network fee. Every account
  must also keep the XLM minimum balance (base reserve plus 0.5 XLM for each
  trustline). That reserve cannot be spent.
- For a subscription, the allowance granted to the donation contract is used
  up or has expired. The allowance has a limited lifetime (see
  [Why did my subscription stop charging?](#why-did-my-subscription-stop-charging)).
- The account has not been funded by Friendbot. In this case the account does
  not exist yet, so the error normally appears as
  [Network error](#network-error) instead.

How to fix it:

1. Lower the amount, or add funds. On testnet, use Friendbot for XLM. For test
   USDC, use the faucet of the issuer you configured, or a testnet DEX swap.
2. For a subscription allowance, cancel the subscription on
   `/app/subscriptions` and subscribe again from the creator's page. This
   signs a new `approve` for the allowance.

### Missing trustline

Credit assets such as USDC require a trustline before the account can hold or
send them. Add the asset in your wallet using the issuer configured for this
deployment, then retry the donation.

### Transaction rejected

Simulation failed for a reason other than balance or allowance. The toast
shows the raw message from Soroban RPC or from `contract.js`.

Likely causes:

- The donation contract is paused (`contract is currently paused`).
- The amount is outside the contract's minimum or maximum (`Error(Contract,
  #10)` or `#11`).
- The asset is not on the contract's allowlist (`Token is not in the
  allowlist`).
- The memo is longer than 140 bytes.
- The contract ID is stale after a testnet reset, or is not set:
  `Donation contract is not configured (missing NEXT_PUBLIC_DONATION_CONTRACT_ID).`
- The account has no USDC trustline, so the token contract fails the transfer.

How to fix it: read the message using
[Reading a raw "Transaction rejected" message](#reading-a-raw-transaction-rejected-message),
then fix the cause (for example, change the amount, add the trustline, or
update the contract ID).

### Confirmation timed out

The transaction was submitted, but it was not confirmed within about 30
seconds (`CONFIRMATION_WINDOW_MS` in `contract.js`). **It may still succeed.**

Likely causes:

- The testnet or Soroban RPC is slow or congested.
- The RPC provider is having an outage.

How to fix it:

1. Do **not** send again yet. You could pay twice.
2. Look up your account on stellar.expert (see
   [How do I see my transaction on stellar.expert?](#how-do-i-see-my-transaction-on-stellarexpert)).
   If the transaction is there and successful, you are done.
3. If it is not there after a few minutes, try again.

### Transaction failed

The network accepted the transaction, but it failed when it was applied
(`Transaction failed on the network.` or
`The network rejected the transaction.`).

Likely causes:

- The state changed between simulation and submission. For example, the
  balance dropped or the contract was paused.
- The transaction expired before it reached a ledger. Transactions are built
  with a 60-second timeout.

How to fix it:

1. Open the transaction on stellar.expert and read the result code.
2. Adjust the amount or details, then try again.

### Network error

The app could not reach the Stellar network, or could not submit the
transaction.

Likely causes:

- **The account is not funded.** If Friendbot never funded the account, it
  does not exist. Loading it fails with
  `Could not load your account from the Stellar network.`, and that appears
  under this title.
- Soroban RPC is down, or `NEXT_PUBLIC_SOROBAN_RPC_URL` is wrong.
- Your internet connection is offline. The offline banner shows this.

How to fix it:

1. Fund the account with Friendbot:
   `https://friendbot.stellar.org/?addr=<YOUR_G_ADDRESS>`.
2. Check [status.stellar.org](https://status.stellar.org) and your
   connection.
3. Try again.

### Donation failed

This is the fallback title for a one-off donation when the error is not a
typed `DonationError`. The toast shows the original error message.

How to fix it: try again in a moment. If the message mentions an amount, check
that you entered a valid number greater than zero. Otherwise, check the
[testnet checklist](#before-you-start-testnet-checklist).

### Couldn't start subscription

This is the fallback title for starting a recurring donation when the error is
not a typed `DonationError`. Starting a subscription takes two signatures: one
for `approve` (the allowance) and one for `subscribe`.

How to fix it:

1. Check the [testnet checklist](#before-you-start-testnet-checklist). The
   account must be funded, and for USDC it needs a trustline.
2. Make sure the interval is not longer than the maximum the page allows
   (`MAX_CHARGE_INTERVAL_DAYS`, about 180 days). This limit comes from
   Soroban's maximum ledger-entry TTL.
3. Try again and approve both signatures.

### Couldn't cancel subscription

This fallback title is defined in `failures.ts` for the cancel flow. The
Subscriptions page (`/app/subscriptions`) currently shows its own toast,
**"Could not cancel subscription"**, with the raw error. The causes are the
same for both.

How to fix it:

1. Check that the wallet is on Testnet and is the account that created the
   subscription.
2. Check that the account still has enough XLM to pay the fee.
3. Try again. If the toast says the cancellation went through, the
   subscription can still show as active until the backend's event listener
   catches up. Refresh after a minute.

## Reading a raw "Transaction rejected" message

When simulation fails, Soroban RPC returns a host error. The frontend shows it
as-is under [Transaction rejected](#transaction-rejected). The parts that
matter are:

- **`Error(Contract, #N)`**: a contract returned or panicked with error code
  `N`. Look the code up in the tables below. The diagnostic events in the
  message include the contract address (`C...`) that raised it. Use the
  address to tell the donation contract apart from a token contract.
- **`Error(WasmVm, InvalidAction)`** together with a text message (for
  example `contract is currently paused`): an `assert!` or `panic!` in the
  contract failed. The text explains why.
- **`Error(Storage, MissingValue)`** or a "contract not found" style message:
  the contract ID does not exist on this network. This usually means a stale
  ID after a testnet reset.
- **`Error(Auth, ...)`**: the transaction is missing a required signature.
  This usually means the wallet signed with a different account.

### Donation contract error codes

These are defined in
[`contracts/donation/src/lib.rs`](../contracts/donation/src/lib.rs):

| Code | Enum | Raised by | Meaning |
| --- | --- | --- | --- |
| `#1` | `ChargeError::InsufficientAllowance` | `charge_subscription` | The supporter's allowance for the donation contract is lower than one charge. It is used up, expired or revoked. |
| `#2` | `ChargeError::InsufficientBalance` | `charge_subscription` | The supporter's token balance is lower than one charge. |
| `#10` | `DonationError::AmountTooLow` | `donate` | The amount is below the admin-configured minimum donation. |
| `#11` | `DonationError::AmountTooHigh` | `donate` | The amount is above the admin-configured maximum donation. |

Only the backend subscription executor calls `charge_subscription`. Codes `#1`
and `#2` therefore appear in a subscription's `lastError` and on the
Subscriptions page, not in the donate flow.

The contract also rejects calls with these `assert!`/`panic!` messages (shown
as text, not codes): `contract is currently paused`,
`Donation amount must be positive`, `Donation memo exceeds maximum length`,
`Token is not in the allowlist`, `Subscription amount must be positive`,
`Interval must be positive`, `subscription is not active`,
`subscription not yet due` and `caller is not the authorized executor`.

### Token (Stellar Asset Contract) errors

The transfer itself is done by the asset's Stellar Asset Contract (SAC), and a
SAC can also fail with `Error(Contract, #N)`. Common SAC codes are `#9`
(allowance too low), `#10` (balance too low) and `#13` (trustline missing).
**SAC `#10` uses the same number as `DonationError::AmountTooLow`.** Check
which contract address raised the error before you act on it.

## Cash-out (SEP-24 anchor) errors

[`frontend/lib/anchor.js`](../frontend/lib/anchor.js) implements SEP-10
authentication and the SEP-24 interactive deposit and withdraw flows. By
default it uses the SDF reference anchor (`testanchor.stellar.org`, asset
`SRT`). Set `NEXT_PUBLIC_ANCHOR_HOME_DOMAIN` and
`NEXT_PUBLIC_ANCHOR_ASSET_CODE` to use the local anchor in
[`anchor/`](../anchor/README.md) instead. Errors are thrown as `AnchorError`
with a `step` field and a user-facing message. The headings below group them
by step.

Note: the `/app/withdraw` page is currently a simulated Naira payout form and
does not call `anchor.js` yet. These errors appear when you run the anchor
flow directly, for example through the live anchor test
(`RUN_LIVE_ANCHOR=1 npx vitest run lib/__tests__/anchor.live.test.ts`) or in a
UI that calls `runWithdraw()` / `runDeposit()`.

### Anchor configuration errors

Step `toml`. Messages:

- `Could not read the anchor's stellar.toml for <domain>.`
- `Anchor <domain> does not advertise a SEP-24 transfer server.`
- `Anchor <domain> does not advertise SEP-10 web auth.`
- `Anchor <domain> does not list asset <code>.`

Likely causes: the domain in `NEXT_PUBLIC_ANCHOR_HOME_DOMAIN` is wrong or
unreachable, or the local anchor is not running (`cd anchor && ./setup.sh`).
Another cause is a mismatch between `NEXT_PUBLIC_ANCHOR_ASSET_CODE` and the
anchor's assets. For example, `testanchor.stellar.org` lists `SRT`, not
`USDC`. Plain `http://` is allowed only for `localhost` and `127.0.0.1`.

How to fix it: open `https://<domain>/.well-known/stellar.toml` in a browser,
or `http://localhost:8080/.well-known/stellar.toml` for the local anchor.
Check that it lists `TRANSFER_SERVER_SEP0024`, `WEB_AUTH_ENDPOINT`,
`SIGNING_KEY` and your asset code.

### Anchor sign-in errors

Steps `auth-challenge`, `auth-sign` and `auth-token`. Messages:

- `Could not get a sign-in challenge from the anchor.`
- `Signing the anchor sign-in challenge was cancelled or failed.`
- `The anchor rejected the signed sign-in challenge.`

Likely causes: the anchor is unreachable, or you rejected the signature. The
wallet may be on the wrong network, which makes the anchor reject the
signature. Another cause is a contract account (`C...`): SEP-10 supports only
`G...` and `M...` accounts.

How to fix it: switch the wallet to Testnet, use a classic `G...` account, and
approve the challenge signature.

### Anchor transfer not available

Step `info`. Messages:

- `Could not read the anchor's /info.`
- `Withdraw is not available for <code> at this anchor.`
- `Deposit is not available for <code> at this anchor.`

How to fix it: check `<TRANSFER_SERVER_SEP0024>/info`. The asset must be
listed under `withdraw` or `deposit` with `enabled: true`.

### Could not start the transfer

Step `interactive`. Messages:

- `Could not start the withdrawal with the anchor.`
- `Could not start the deposit with the anchor.`

Likely cause: the anchor's server returned an error. The SDF reference anchor
fails now and then on its server side. How to fix it: wait and try again, or
switch to the local anchor.

### The anchor window was blocked

Step `popup`. Message:
`The anchor window was blocked. Allow popups for this site and try again.`

The anchor's KYC and bank-details form opens in a popup. The browser blocks it
if it is not opened directly from your click. How to fix it: allow popups for
the site and try again. See
[Why does cash-out open a popup?](#why-does-cash-out-open-a-popup).

### Withdrawal payment errors

Steps `payment`, `payment-sign` and `payment-submit`. Messages:

- `The anchor did not return payment instructions for this withdrawal.`
- `Could not load your account to build the withdrawal payment.`
- `Signing the withdrawal payment was cancelled or failed.`
- `Your <code> balance is too low to send <amount> <code> for this withdrawal.`
  (Horizon `op_underfunded`)
- ``Your account can't send <code> to the anchor — the <code> trustline is missing.``
  (Horizon `op_no_trust` / `op_no_issuer`)
- `Failed to submit the withdrawal payment to the network.`

How to fix it: fund the account with Friendbot. Add a trustline to the
anchor's asset issuer, and make sure you hold enough of the asset. On the
reference anchor, run a deposit first to mint test `SRT`. Then try again.

### Trustline errors

Steps `trustline`, `trustline-sign` and `trustline-submit`. These happen
during a deposit, when the anchor waits at `pending_trust`. Messages:

- `Could not load your account to add the asset trustline.`
- `Signing the <code> trustline was cancelled or failed.`
- `Failed to add the <code> trustline on the network.`

How to fix it: the account must be funded, because each trustline raises the
XLM minimum balance by 0.5 XLM. Approve the `changeTrust` signature in the
wallet.

### Lost contact with the anchor

Steps `poll` and `poll-timeout`. Messages:

- `Lost contact with the anchor while tracking the withdrawal.`
- `Timed out waiting for the anchor to finish the withdrawal.`

The flow polls the anchor's `GET /transaction` every 3 seconds for up to 5
minutes. The same messages appear for deposits. How to fix it: finish the
anchor's popup form within 5 minutes. If the poll timed out, check the status
in the anchor's own UI before you start a new transfer.

## FAQ

### Why is my USD total lower than my balance?

The USD figure on `/app` is an estimate built from these inputs:

- **Balances are rounded to whole units** before conversion
  (`Math.round(parseFloat(balance))` in
  [`frontend/app/app/page.tsx`](../frontend/app/app/page.tsx)). For example,
  0.4 USDC counts as 0 and 12.6 XLM counts as 13.
- **Only priced assets count.** Prices come from the frontend's
  `/api/prices` route
  ([`frontend/app/api/prices/route.ts`](../frontend/app/api/prices/route.ts)).
  USDC and USDT are fixed at $1, and XLM comes from CoinGecko. If CoinGecko
  fails or rate-limits the request, XLM has no price and is left out of the
  total.
- **Prices are cached for 60 seconds**, on the server and in the client, so
  the figure can trail the market.
- **The XLM balance includes the minimum reserve**, which you cannot spend or
  cash out.

Note: on testnet, test assets have no real value. The USD figure only shows
what the same balance would be worth at mainnet prices.

### Why did my subscription stop charging?

The backend subscription executor
([`backend/src/services/subscriptionExecutor.ts`](../backend/src/services/subscriptionExecutor.ts))
runs every `SUBSCRIPTION_EXECUTOR_POLL_INTERVAL_MS` (default 60 s). It charges
each active subscription whose `nextChargeAt` has passed. Charges stop when:

1. **The executor is not running.** It needs `EXECUTOR_SECRET_KEY` and the
   donation contract ID. The executor key must also be set on the contract as
   the authorized executor (`set_executor`). `GET /health` (and `GET /health/executor`)
   report executor health.
2. **The allowance ran out or expired** (`ChargeError::InsufficientAllowance`,
   `#1`). Subscribing approves at most 12 charges, and never past Soroban's
   maximum ledger-entry TTL (about 180 days). After that, charges fail until a
   new allowance is approved. The Subscriptions page says "renew it from the
   Subscriptions page", but that page has no renew button yet. To renew,
   cancel the subscription and subscribe again from the creator's page.
3. **The balance is too low** (`ChargeError::InsufficientBalance`, `#2`). The
   executor retries on each run until the balance is topped up.
4. **The failure streak hit the limit.** After 24 consecutive failures (or 3
   for permanent, on-chain failures), the executor sets the subscription to
   inactive. It then shows as "Cancelled" on `/app/subscriptions`. Subscribe
   again to restart it.
5. **The contract is paused** (`contract is currently paused`).
6. **Testnet was reset.** The subscription no longer exists on-chain, and the
   contract ID must be updated.

The Subscriptions page shows the last error in plain language (from
`describeChargeFailure()` in
[`frontend/lib/failures.ts`](../frontend/lib/failures.ts)). The supporter also
gets one email per failure streak.

### How do I see my transaction on stellar.expert?

After a donation succeeds, the success toast links to
`https://stellar.expert/explorer/testnet/tx/<hash>`. The receipt page
(`/receipt/<hash>`) and the dashboard's activity list link to the same
explorer. To find a transaction yourself:

1. Open `https://stellar.expert/explorer/testnet/account/<YOUR_G_ADDRESS>`.
   Make sure the URL says **testnet**: a testnet transaction does not appear
   under `public`.
2. Open the latest transaction and check its result. For Soroban calls, the
   events tab shows `donated` / `subscribed` events or the contract error.

If a [Confirmation timed out](#confirmation-timed-out) error appeared, check
the account page before you retry.

### Why does cash-out open a popup?

SEP-24 is an *interactive* protocol. The anchor, not SupportMe, collects KYC
details, bank details and the amount on its own hosted page. `openInteractive()`
in [`frontend/lib/anchor.js`](../frontend/lib/anchor.js) opens that page with
`window.open(..., 'popup,width=450,height=750')`. The call must happen
directly from your click, or the browser blocks it
([The anchor window was blocked](#the-anchor-window-was-blocked)). The app does
not rely on the popup reporting back: some browsers open it as a full tab. The
anchor's transaction status, polled every 3 seconds, decides when the flow is
done. When the anchor asks for the on-chain transfer
(`pending_user_transfer_start`), the app asks your wallet to sign the payment.
It closes the popup when the flow ends.

As noted above, the current `/app/withdraw` page is a simulated payout form
and does not open the anchor popup yet.
