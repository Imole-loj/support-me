// @vitest-environment node
// (Runs in Node, not jsdom: this is a pure network + crypto test with the
// wallet mocked, and jsdom's cross-realm Uint8Array trips up stellar-base.)
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as StellarSdk from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE as NETWORK } from '@/lib/stellarNetwork';

// LIVE smoke test for the SRT (SEP-24) cash-out / add-funds flow. It hits the
// REAL SDF reference anchor (testanchor.stellar.org) and exercises the shipping
// code in ../anchor.js end to end, up to (but not including) the hosted KYC
// popup and the on-chain payment:
//
//   loadAnchorConfig -> assertDeposit/WithdrawEnabled -> SEP-10 auth
//   -> deposit & withdraw interactive initiate
//
// The only substitution is the browser wallet: authenticate() calls
// signTransaction() from '@/lib/wallet', so we mock that one function to sign
// the SEP-10 challenge with a locally generated testnet keypair. Everything
// else is real network + real anchor.js logic.
//
// Skipped by default (network-dependent, non-deterministic). Enable with:
//   RUN_LIVE_ANCHOR=1 npx vitest run lib/__tests__/anchor.live.test.ts

const HOME_DOMAIN = process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN || 'testanchor.stellar.org';
const ASSET_CODE = process.env.NEXT_PUBLIC_ANCHOR_ASSET_CODE || 'SRT';

const keypair = StellarSdk.Keypair.random();

// Mock only the wallet: sign the SEP-10 challenge locally with our keypair,
// returning the { signedTxXdr } shape anchor.js expects.
vi.mock('@/lib/wallet', () => ({
  signTransaction: vi.fn(async (xdr: string) => {
    const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, NETWORK);
    tx.sign(keypair);
    return { signedTxXdr: tx.toEnvelope().toXDR('base64') };
  }),
}));

// Imported after the mock is registered.
import {
  loadAnchorConfig,
  authenticate,
  assertDepositEnabled,
  assertWithdrawEnabled,
  initiateDeposit,
  initiateWithdraw,
} from '@/lib/anchor';

const run = process.env.RUN_LIVE_ANCHOR ? describe : describe.skip;

run('SRT flow (live, testanchor.stellar.org)', () => {
  let config: Awaited<ReturnType<typeof loadAnchorConfig>>;
  let token: string;

  beforeAll(() => {
    console.log(`\n[live] anchor=${HOME_DOMAIN} asset=${ASSET_CODE} account=${keypair.publicKey()}`);
  });

  it('loadAnchorConfig resolves SEP-24 + SEP-10 endpoints and the SRT issuer', async () => {
    config = await loadAnchorConfig(HOME_DOMAIN, ASSET_CODE);
    expect(config.transferServer).toMatch(/^https:\/\//);
    expect(config.webAuthEndpoint).toMatch(/^https:\/\//);
    expect(config.signingKey).toMatch(/^G[A-Z2-7]{55}$/); // ed25519 public key
    expect(config.assetIssuer).toMatch(/^G[A-Z2-7]{55}$/);
    expect(config.assetCode).toBe(ASSET_CODE);
  }, 30000);

  it('/info advertises deposit enabled for SRT', async () => {
    await expect(assertDepositEnabled(config)).resolves.toBeDefined();
  }, 30000);

  it('/info advertises withdraw enabled for SRT', async () => {
    await expect(assertWithdrawEnabled(config)).resolves.toBeDefined();
  }, 30000);

  it('SEP-10 authenticate returns a JWT (challenge signed via wallet + accepted)', async () => {
    token = await authenticate(config, keypair.publicKey());
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // header.payload.signature
  }, 30000);

  it('deposit interactive initiate returns a hosted url + tx id', async () => {
    const { url, id } = await initiateDeposit(config, token, keypair.publicKey());
    expect(url).toMatch(/^https:\/\//);
    expect(id).toBeTruthy();
  }, 30000);

  it('withdraw interactive initiate returns a hosted url + tx id', async () => {
    const { url, id } = await initiateWithdraw(config, token, keypair.publicKey());
    expect(url).toMatch(/^https:\/\//);
    expect(id).toBeTruthy();
  }, 30000);
});
