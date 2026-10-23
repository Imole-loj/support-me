import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction as signWithWallet } from './wallet';
import { NETWORK_PASSPHRASE, horizonServer } from './stellarNetwork';

// SEP-24 interactive withdraw against a Stellar anchor. Defaults to the SDF
// reference anchor on testnet (testanchor.stellar.org), which issues the
// Stellar Reference Token (SRT) and fakes KYC — no signup, cost, or
// partnership required. Point NEXT_PUBLIC_ANCHOR_* at a real NGN anchor to
// go live; the code below is identical either way.
const HOME_DOMAIN = process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN || 'testanchor.stellar.org';
const ASSET_CODE = process.env.NEXT_PUBLIC_ANCHOR_ASSET_CODE || 'SRT';
const horizon = horizonServer;

/** Resolved SEP-24/SEP-10 endpoints and asset metadata for one anchor. */
export interface AnchorConfig {
  homeDomain: string;
  assetCode: string;
  assetIssuer: string;
  transferServer: string;
  webAuthEndpoint: string;
  signingKey: string;
}

/** The withdrawal payment instructions carried on a SEP-24 transaction once
 * the anchor reaches `pending_user_transfer_start`. */
export interface WithdrawPaymentInstructions {
  withdraw_anchor_account?: string;
  amount_in?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: 'hash' | 'id' | 'text';
}

/** The subset of a SEP-24 `/transaction` response the withdraw flow reads. */
export interface AnchorTransaction extends WithdrawPaymentInstructions {
  status: string;
  [key: string]: unknown;
}

/** Error the settings UI can surface directly. `step` says where the flow
 * stopped so we can show a useful message without leaking internals. */
export class AnchorError extends Error {
  step: string;
  cause?: unknown;

  constructor(step: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'AnchorError';
    this.step = step;
    this.cause = cause;
  }
}

/**
 * Read the anchor's stellar.toml and pull the endpoints + the issuer for the
 * asset we're withdrawing. Kept pure (no wallet, no popup) so it's unit-testable.
 */
export async function loadAnchorConfig(
  homeDomain: string = HOME_DOMAIN,
  assetCode: string = ASSET_CODE
): Promise<AnchorConfig> {
  // The TOML resolver is HTTPS-only by default. A local dev anchor is served
  // over plain http://localhost:8080, so allow cleartext ONLY for localhost —
  // never for a real anchor, where http would be an unacceptable downgrade.
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(homeDomain);
  let toml: Awaited<ReturnType<typeof StellarSdk.StellarToml.Resolver.resolve>>;
  try {
    toml = await StellarSdk.StellarToml.Resolver.resolve(
      homeDomain,
      isLocal ? { allowHttp: true } : undefined
    );
  } catch (err) {
    throw new AnchorError(
      'toml',
      `Could not read the anchor's stellar.toml for ${homeDomain}.`,
      err
    );
  }

  const transferServer = toml.TRANSFER_SERVER_SEP0024;
  const webAuthEndpoint = toml.WEB_AUTH_ENDPOINT;
  const signingKey = toml.SIGNING_KEY;
  const currency = (toml.CURRENCIES || []).find((c) => c.code === assetCode);

  if (!transferServer) {
    throw new AnchorError(
      'toml',
      `Anchor ${homeDomain} does not advertise a SEP-24 transfer server.`
    );
  }
  if (!webAuthEndpoint || !signingKey) {
    throw new AnchorError('toml', `Anchor ${homeDomain} does not advertise SEP-10 web auth.`);
  }
  if (!currency || !currency.issuer) {
    throw new AnchorError('toml', `Anchor ${homeDomain} does not list asset ${assetCode}.`);
  }

  return {
    homeDomain,
    assetCode,
    assetIssuer: currency.issuer,
    transferServer: transferServer.replace(/\/$/, ''),
    webAuthEndpoint: webAuthEndpoint.replace(/\/$/, ''),
    signingKey,
  };
}

/**
 * SEP-10: fetch a challenge transaction, have the wallet sign it, and exchange
 * the signed XDR for a short-lived anchor auth token (JWT).
 *
 * LIMITATION: this is SEP-10 only, so it authenticates classic (`G...`) and
 * muxed (`M...`) accounts. Contract accounts (`C...`, smart wallets) require
 * SEP-45 (challenge is a Soroban authorization entry verified via RPC against
 * the anchor's WEB_AUTH_CONTRACT_ID), which is not implemented here. Adding it
 * would mean: read WEB_AUTH_FOR_CONTRACTS_ENDPOINT + WEB_AUTH_CONTRACT_ID from
 * the TOML, branch on account type, and run the SEP-45 GET/POST auth entry
 * flow. Freighter on testnet uses a `G...` account, so SEP-10 is sufficient
 * for the current flow.
 */
export async function authenticate(config: AnchorConfig, account: string): Promise<string> {
  let challengeXdr: string;
  try {
    const res = await fetch(
      `${config.webAuthEndpoint}?account=${encodeURIComponent(account)}&home_domain=${encodeURIComponent(config.homeDomain)}`
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'challenge request failed');
    challengeXdr = json.transaction;
  } catch (err) {
    throw new AnchorError(
      'auth-challenge',
      'Could not get a sign-in challenge from the anchor.',
      err
    );
  }

  let signedXdr: string;
  try {
    const result = await signWithWallet(challengeXdr, account);
    signedXdr = result.signedTxXdr;
  } catch (err) {
    throw new AnchorError(
      'auth-sign',
      'Signing the anchor sign-in challenge was cancelled or failed.',
      err
    );
  }

  try {
    const res = await fetch(config.webAuthEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: signedXdr }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'token request failed');
    return json.token;
  } catch (err) {
    throw new AnchorError('auth-token', 'The anchor rejected the signed sign-in challenge.', err);
  }
}

interface AnchorInfoResponse {
  withdraw?: Record<string, { enabled?: boolean }>;
  deposit?: Record<string, { enabled?: boolean }>;
  [key: string]: unknown;
}

/** Confirm the anchor supports withdraw for our asset (and isn't disabled). */
export async function assertWithdrawEnabled(config: AnchorConfig): Promise<AnchorInfoResponse> {
  let info: AnchorInfoResponse;
  try {
    const res = await fetch(`${config.transferServer}/info`);
    info = await res.json();
    if (!res.ok) throw new Error((info as { error?: string }).error || 'info request failed');
  } catch (err) {
    throw new AnchorError('info', "Could not read the anchor's /info.", err);
  }
  const entry = info.withdraw?.[config.assetCode];
  if (!entry || entry.enabled === false) {
    throw new AnchorError('info', `Withdraw is not available for ${config.assetCode} at this anchor.`);
  }
  return info;
}

/** Confirm the anchor supports deposit for our asset (and isn't disabled). */
export async function assertDepositEnabled(config: AnchorConfig): Promise<AnchorInfoResponse> {
  let info: AnchorInfoResponse;
  try {
    const res = await fetch(`${config.transferServer}/info`);
    info = await res.json();
    if (!res.ok) throw new Error((info as { error?: string }).error || 'info request failed');
  } catch (err) {
    throw new AnchorError('info', "Could not read the anchor's /info.", err);
  }
  const entry = info.deposit?.[config.assetCode];
  if (!entry || entry.enabled === false) {
    throw new AnchorError('info', `Deposit is not available for ${config.assetCode} at this anchor.`);
  }
  return info;
}

/**
 * POST /transactions/withdraw/interactive → the anchor returns a hosted URL
 * (KYC + bank details) and a transaction id we poll on.
 */
export async function initiateWithdraw(
  config: AnchorConfig,
  authToken: string,
  account: string
): Promise<{ url: string; id: string }> {
  try {
    const res = await fetch(`${config.transferServer}/transactions/withdraw/interactive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ asset_code: config.assetCode, account }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'interactive request failed');
    return { url: json.url, id: json.id };
  } catch (err) {
    throw new AnchorError('interactive', 'Could not start the withdrawal with the anchor.', err);
  }
}

/**
 * POST /transactions/deposit/interactive → the anchor returns a hosted URL
 * (KYC + amount) and a transaction id we poll on. For a deposit the anchor
 * credits the asset to `account` on its side once its off-chain leg clears —
 * the user never signs an on-chain payment (unlike withdraw), which is why the
 * deposit flow is simpler.
 */
export async function initiateDeposit(
  config: AnchorConfig,
  authToken: string,
  account: string
): Promise<{ url: string; id: string }> {
  try {
    const res = await fetch(`${config.transferServer}/transactions/deposit/interactive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ asset_code: config.assetCode, account }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'interactive request failed');
    return { url: json.url, id: json.id };
  } catch (err) {
    throw new AnchorError('interactive', 'Could not start the deposit with the anchor.', err);
  }
}

export interface InteractiveHandle {
  close: () => void;
  /** Resolves if the popup posts back or is closed; never rejects — purely an accelerator. */
  onDone: Promise<void>;
}

/**
 * Open the anchor's interactive flow. MUST be called synchronously from the
 * user's click, or the browser blocks the popup. Returns a handle the caller
 * can use to close the window early and to detect the popup `postMessage`
 * callback — but the caller must NOT depend on that callback: browsers may
 * open the URL as a full tab (severing `window.opener`) rather than a popup,
 * in which case no message is ever delivered back. The authoritative signal
 * for completion is polling the anchor's transaction status, not this handle.
 */
export function openInteractive(url: string): InteractiveHandle {
  const target = window.open(
    `${url}&callback=postMessage`,
    'supportme_transfer',
    'popup,width=450,height=750'
  );
  if (!target) {
    throw new AnchorError(
      'popup',
      'The anchor window was blocked. Allow popups for this site and try again.'
    );
  }

  let cleanup = (): void => {};
  const onDone = new Promise<void>((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      if (!event.data?.transaction) return;
      resolve();
    };
    // Also resolve if the user closes the window, so the poll can react
    // sooner — but the poll's own timeout is the real backstop.
    const closedPoll = setInterval(() => {
      if (target.closed) resolve();
    }, 800);

    cleanup = () => {
      clearInterval(closedPoll);
      window.removeEventListener('message', onMessage);
    };
    window.addEventListener('message', onMessage);
  }).finally(() => cleanup());

  return {
    close: () => {
      try {
        target.close();
      } catch {
        /* cross-origin/full-tab: nothing to close */
      }
      cleanup();
    },
    onDone,
  };
}

/**
 * For a withdrawal the user must send the asset to the anchor's account with
 * the anchor-provided memo. Build that payment, sign it with the wallet, and
 * submit to Horizon.
 */
export async function sendWithdrawPayment(
  config: AnchorConfig,
  account: string,
  tx: WithdrawPaymentInstructions
): Promise<string> {
  const { withdraw_anchor_account, amount_in, withdraw_memo, withdraw_memo_type } = tx;
  if (!withdraw_anchor_account || !amount_in) {
    throw new AnchorError(
      'payment',
      'The anchor did not return payment instructions for this withdrawal.'
    );
  }

  let source: StellarSdk.Account;
  try {
    source = await horizon.loadAccount(account);
  } catch (err) {
    throw new AnchorError('payment', 'Could not load your account to build the withdrawal payment.', err);
  }

  const asset = new StellarSdk.Asset(config.assetCode, config.assetIssuer);
  const builder = new StellarSdk.TransactionBuilder(source, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: withdraw_anchor_account,
        asset,
        amount: String(amount_in),
      })
    )
    .setTimeout(180);

  // Anchors usually require a memo so they can match the incoming payment to
  // the withdrawal. SEP-24 sends it base64-encoded for hash memos.
  if (withdraw_memo) {
    if (withdraw_memo_type === 'hash') {
      builder.addMemo(StellarSdk.Memo.hash(Buffer.from(withdraw_memo, 'base64').toString('hex')));
    } else if (withdraw_memo_type === 'id') {
      builder.addMemo(StellarSdk.Memo.id(withdraw_memo));
    } else {
      builder.addMemo(StellarSdk.Memo.text(withdraw_memo));
    }
  }

  const built = builder.build();

  let signedXdr: string;
  try {
    const result = await signWithWallet(built.toXDR(), account);
    signedXdr = result.signedTxXdr;
  } catch (err) {
    throw new AnchorError('payment-sign', 'Signing the withdrawal payment was cancelled or failed.', err);
  }

  try {
    const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    const res = await horizon.submitTransaction(signedTx);
    return res.hash;
  } catch (err) {
    // Horizon returns the failure reason in extras.result_codes; surface the
    // common ones as plain language instead of a generic "submit failed" that
    // forces the user into DevTools. op_underfunded is the usual one: the
    // anchor asked for more than the account holds.
    const ops: string[] =
      (err as { response?: { data?: { extras?: { result_codes?: { operations?: string[] } } } } })
        ?.response?.data?.extras?.result_codes?.operations || [];
    if (ops.includes('op_underfunded')) {
      throw new AnchorError(
        'payment-submit',
        `Your ${config.assetCode} balance is too low to send ${amount_in} ${config.assetCode} for this withdrawal.`,
        err
      );
    }
    if (ops.includes('op_no_trust') || ops.includes('op_no_issuer')) {
      throw new AnchorError(
        'payment-submit',
        `Your account can't send ${config.assetCode} to the anchor — the ${config.assetCode} trustline is missing.`,
        err
      );
    }
    throw new AnchorError('payment-submit', 'Failed to submit the withdrawal payment to the network.', err);
  }
}

/**
 * A Stellar account can't hold a non-native asset until it trusts the issuer.
 * On deposit the anchor waits at `pending_trust` until this line exists, so we
 * build a changeTrust op, sign it with the wallet, and submit to Horizon.
 * Idempotent-ish: if the trustline already exists this is a harmless no-op
 * change, but callers only invoke it when the anchor asks (pending_trust).
 */
export async function ensureTrustline(config: AnchorConfig, account: string): Promise<string> {
  let source: StellarSdk.Account;
  try {
    source = await horizon.loadAccount(account);
  } catch (err) {
    throw new AnchorError('trustline', 'Could not load your account to add the asset trustline.', err);
  }

  const asset = new StellarSdk.Asset(config.assetCode, config.assetIssuer);
  const built = new StellarSdk.TransactionBuilder(source, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset }))
    .setTimeout(180)
    .build();

  let signedXdr: string;
  try {
    const result = await signWithWallet(built.toXDR(), account);
    signedXdr = result.signedTxXdr;
  } catch (err) {
    throw new AnchorError(
      'trustline-sign',
      `Signing the ${config.assetCode} trustline was cancelled or failed.`,
      err
    );
  }

  try {
    const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    const res = await horizon.submitTransaction(signedTx);
    return res.hash;
  } catch (err) {
    throw new AnchorError(
      'trustline-submit',
      `Failed to add the ${config.assetCode} trustline on the network.`,
      err
    );
  }
}

// SEP-24 terminal transaction statuses. Once the anchor reports one of these,
// the flow is over and polling stops. (`no_market` is a SEP-6 status, not
// SEP-24, so it's intentionally not here.)
const TERMINAL_STATUSES = ['completed', 'refunded', 'error', 'expired'];

export interface PollWithdrawOptions {
  onStatus?: (status: string, tx: AnchorTransaction) => void | Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * Poll GET /transaction?id= until the withdrawal reaches a terminal status.
 * Calls onStatus with each new status so the UI can show progress
 * (incomplete → pending_user_transfer_start → pending_anchor → completed).
 */
export async function pollWithdraw(
  config: AnchorConfig,
  authToken: string,
  id: string,
  { onStatus, intervalMs = 3000, timeoutMs = 300000 }: PollWithdrawOptions = {}
): Promise<AnchorTransaction> {
  const start = Date.now();
  let last: string | null = null;

  while (Date.now() - start < timeoutMs) {
    let tx: AnchorTransaction;
    try {
      const res = await fetch(`${config.transferServer}/transaction?id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'transaction poll failed');
      tx = json.transaction;
    } catch (err) {
      throw new AnchorError('poll', 'Lost contact with the anchor while tracking the withdrawal.', err);
    }

    if (tx.status !== last) {
      last = tx.status;
      // Awaited so a throw inside the callback (e.g. the withdraw payment
      // failing) propagates out of the poll instead of becoming an unhandled
      // rejection.
      await onStatus?.(tx.status, tx);
    }

    if (TERMINAL_STATUSES.includes(tx.status)) return tx;

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new AnchorError('poll-timeout', 'Timed out waiting for the anchor to finish the withdrawal.');
}

export interface RunFlowOptions {
  onStatus?: (status: string, detail?: unknown) => void;
}

/**
 * Full SEP-24 withdraw, start to finish. `onStatus(phase, detail)` fires at
 * each step so the settings panel can narrate progress. Opens the anchor's
 * hosted flow and polls its transaction status (authoritative), signing the
 * on-chain payment to the anchor when it asks for the transfer. Returns the
 * terminal anchor transaction, or null if it timed out / was abandoned.
 */
export async function runWithdraw(
  account: string,
  { onStatus }: RunFlowOptions = {}
): Promise<AnchorTransaction> {
  onStatus?.('config');
  const config = await loadAnchorConfig();

  onStatus?.('auth');
  const authToken = await authenticate(config, account);

  onStatus?.('info');
  await assertWithdrawEnabled(config);

  onStatus?.('interactive');
  const { url, id } = await initiateWithdraw(config, authToken, account);

  // Open the anchor's hosted flow. We do NOT block on its callback: browsers
  // may open it as a popup, a new tab, or a full redirect-back, and a
  // postMessage from a new tab often can't reach us. Instead we start polling
  // the anchor's transaction status immediately — that's authoritative. The
  // popup callback, if it fires, just lets us close the window early.
  const win = openInteractive(url);

  // The anchor drives the rest. Poll, and when it's waiting on the user's
  // on-chain transfer, sign and submit the payment to the anchor.
  onStatus?.('pending');
  let paid = false;
  try {
    return await pollWithdraw(config, authToken, id, {
      onStatus: async (status, polledTx) => {
        onStatus?.(status, polledTx);
        if (status === 'pending_user_transfer_start' && !paid) {
          paid = true;
          onStatus?.('sending-payment', polledTx);
          await sendWithdrawPayment(config, account, polledTx);
        }
      },
    });
  } finally {
    win.close();
  }
}

/**
 * Full SEP-24 deposit, start to finish. Mirrors runWithdraw but has no
 * on-chain payment step: the anchor credits the asset to the account itself
 * once its off-chain leg clears. On the testnet sandbox this is how you mint
 * test SRT into a wallet (fake KYC in the popup). Returns the terminal anchor
 * transaction, or null if the user closed the popup before completing.
 */
export async function runDeposit(
  account: string,
  { onStatus }: RunFlowOptions = {}
): Promise<AnchorTransaction> {
  onStatus?.('config');
  const config = await loadAnchorConfig();

  onStatus?.('auth');
  const authToken = await authenticate(config, account);

  onStatus?.('info');
  await assertDepositEnabled(config);

  onStatus?.('interactive');
  const { url, id } = await initiateDeposit(config, authToken, account);

  // Open the anchor's hosted flow without blocking on its callback (works for
  // popup, new tab, or full redirect-back — see runWithdraw).
  const handle = openInteractive(url);

  // Deposit needs no on-chain payment, but the account must trust the asset
  // before the anchor can credit it. If the anchor parks at `pending_trust`,
  // establish the trustline (one wallet signature) and let polling continue.
  onStatus?.('pending');
  let trusted = false;
  try {
    const result = await pollWithdraw(config, authToken, id, {
      onStatus: async (status, polledTx) => {
        onStatus?.(status, polledTx);
        if (status === 'pending_trust' && !trusted) {
          trusted = true;
          onStatus?.('adding-trustline', polledTx);
          await ensureTrustline(config, account);
        }
      },
    });
    return result;
  } finally {
    handle.close();
  }
}

export const anchorConfig = { homeDomain: HOME_DOMAIN, assetCode: ASSET_CODE };
