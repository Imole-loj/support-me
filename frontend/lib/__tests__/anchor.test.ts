// @vitest-environment node
// (Runs in Node, not jsdom: ensureTrustline builds and signs a real Stellar
// transaction, and jsdom's cross-realm Uint8Array trips up stellar-base. The
// other cases here — TOML resolution and fetch polling — are env-agnostic.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as StellarSdk from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE } from '@/lib/stellarNetwork';
import { loadAnchorConfig, pollWithdraw, ensureTrustline, sendWithdrawPayment, AnchorError } from '@/lib/anchor';
import { signTransaction } from '@/lib/wallet';

// The anchor module signs with the wallet; those paths aren't exercised here.
// We test the pure/network parts: TOML resolution + validation, and the
// status-polling loop, both with mocked I/O.
vi.mock('@/lib/wallet', () => ({
  signTransaction: vi.fn(),
}));

const GOOD_TOML = {
  TRANSFER_SERVER_SEP0024: 'https://anchor.example/sep24/',
  WEB_AUTH_ENDPOINT: 'https://anchor.example/auth',
  SIGNING_KEY: 'GSIGNINGKEY',
  CURRENCIES: [{ code: 'SRT', issuer: 'GISSUER' }],
};

describe('loadAnchorConfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves endpoints and the asset issuer from the anchor TOML', async () => {
    vi.spyOn(StellarSdk.StellarToml.Resolver, 'resolve').mockResolvedValue(GOOD_TOML as never);

    const config = await loadAnchorConfig('anchor.example', 'SRT');

    expect(config.transferServer).toBe('https://anchor.example/sep24'); // trailing slash trimmed
    expect(config.webAuthEndpoint).toBe('https://anchor.example/auth');
    expect(config.assetIssuer).toBe('GISSUER');
    expect(config.assetCode).toBe('SRT');
  });

  it('throws an AnchorError when the anchor does not list the asset', async () => {
    vi.spyOn(StellarSdk.StellarToml.Resolver, 'resolve').mockResolvedValue({
      ...GOOD_TOML,
      CURRENCIES: [{ code: 'USDC', issuer: 'GOTHER' }],
    } as never);

    await expect(loadAnchorConfig('anchor.example', 'SRT')).rejects.toThrowError(AnchorError);
  });

  it('throws an AnchorError when SEP-24 is not advertised', async () => {
    vi.spyOn(StellarSdk.StellarToml.Resolver, 'resolve').mockResolvedValue({
      WEB_AUTH_ENDPOINT: 'https://anchor.example/auth',
      SIGNING_KEY: 'GSIGNINGKEY',
      CURRENCIES: [{ code: 'SRT', issuer: 'GISSUER' }],
    } as never);

    await expect(loadAnchorConfig('anchor.example', 'SRT')).rejects.toThrowError(/transfer server/i);
  });

  it('allows cleartext http only for a localhost anchor', async () => {
    const spy = vi
      .spyOn(StellarSdk.StellarToml.Resolver, 'resolve')
      .mockResolvedValue({ ...GOOD_TOML, CURRENCIES: [{ code: 'USDC', issuer: 'GISSUER' }] } as never);

    await loadAnchorConfig('localhost:8080', 'USDC');

    expect(spy).toHaveBeenCalledWith('localhost:8080', { allowHttp: true });
  });

  it('does not allow cleartext http for a remote anchor', async () => {
    const spy = vi
      .spyOn(StellarSdk.StellarToml.Resolver, 'resolve')
      .mockResolvedValue(GOOD_TOML as never);

    await loadAnchorConfig('anchor.example', 'SRT');

    // Second arg must be undefined (HTTPS-only) for a non-localhost domain.
    expect(spy).toHaveBeenCalledWith('anchor.example', undefined);
  });
});

describe('pollWithdraw', () => {
  const config = {
    transferServer: 'https://anchor.example/sep24',
    assetCode: 'SRT',
  } as never;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function txResponse(status: string) {
    return { ok: true, json: async () => ({ transaction: { status } }) } as Response;
  }

  it('emits each new status and stops at a terminal status', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(txResponse('pending_user_transfer_start'))
      .mockResolvedValueOnce(txResponse('pending_anchor'))
      .mockResolvedValueOnce(txResponse('completed'));

    const seen: string[] = [];
    const result = await pollWithdraw(config, 'token', 'txid', {
      onStatus: (s: string) => { seen.push(s); },
      intervalMs: 0,
    });

    expect(seen).toEqual(['pending_user_transfer_start', 'pending_anchor', 'completed']);
    expect(result.status).toBe('completed');
  });

  it('does not re-emit an unchanged status', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(txResponse('pending_anchor'))
      .mockResolvedValueOnce(txResponse('pending_anchor'))
      .mockResolvedValueOnce(txResponse('completed'));

    const seen: string[] = [];
    await pollWithdraw(config, 'token', 'txid', {
      onStatus: (s: string) => { seen.push(s); },
      intervalMs: 0,
    });

    expect(seen).toEqual(['pending_anchor', 'completed']);
  });

  it('propagates a throw from onStatus (e.g. the withdraw payment failing)', async () => {
    vi.mocked(fetch).mockResolvedValue(txResponse('pending_user_transfer_start'));

    await expect(
      pollWithdraw(config, 'token', 'txid', {
        onStatus: async () => { throw new Error('payment failed'); },
        intervalMs: 0,
      })
    ).rejects.toThrow('payment failed');
  });
});

describe('ensureTrustline', () => {
  const keypair = StellarSdk.Keypair.random();
  const account = keypair.publicKey();
  const config = { assetCode: 'SRT', assetIssuer: StellarSdk.Keypair.random().publicKey() } as never;

  afterEach(() => vi.restoreAllMocks());

  it('builds a changeTrust tx, signs it via the wallet, and submits to Horizon', async () => {
    // Minimal Horizon account for the TransactionBuilder to consume.
    const source = new StellarSdk.Account(account, '123');
    const loadAccount = vi
      .spyOn(StellarSdk.Horizon.Server.prototype, 'loadAccount')
      .mockResolvedValue(source as never);
    const submit = vi
      .spyOn(StellarSdk.Horizon.Server.prototype, 'submitTransaction')
      .mockResolvedValue({ hash: 'trust-hash' } as never);

    // Wallet mock signs the built XDR locally and returns the SDK's shape.
    vi.mocked(signTransaction).mockImplementation(async (xdr: string) => {
      const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
      tx.sign(keypair);
      return { signedTxXdr: tx.toEnvelope().toXDR('base64') };
    });

    const hash = await ensureTrustline(config, account);

    expect(hash).toBe('trust-hash');
    expect(loadAccount).toHaveBeenCalledWith(account);

    // The submitted transaction carries exactly one changeTrust op for SRT.
    const submitted = submit.mock.calls[0][0] as StellarSdk.Transaction;
    expect(submitted.operations).toHaveLength(1);
    expect(submitted.operations[0].type).toBe('changeTrust');
    expect((submitted.operations[0] as StellarSdk.Operation.ChangeTrust).line).toMatchObject({
      code: 'SRT',
    });
  });

  it('wraps a wallet rejection in an AnchorError at the trustline-sign step', async () => {
    vi.spyOn(StellarSdk.Horizon.Server.prototype, 'loadAccount')
      .mockResolvedValue(new StellarSdk.Account(account, '123') as never);
    vi.mocked(signTransaction).mockRejectedValue(new Error('user declined'));

    await expect(ensureTrustline(config, account)).rejects.toMatchObject({
      name: 'AnchorError',
      step: 'trustline-sign',
    });
  });
});

describe('sendWithdrawPayment', () => {
  const keypair = StellarSdk.Keypair.random();
  const account = keypair.publicKey();
  const config = { assetCode: 'USDC', assetIssuer: StellarSdk.Keypair.random().publicKey() } as never;
  const tx = {
    withdraw_anchor_account: StellarSdk.Keypair.random().publicKey(),
    amount_in: '10',
    withdraw_memo: '1234567890',
    withdraw_memo_type: 'id' as const,
  };

  afterEach(() => vi.restoreAllMocks());

  // Signs the built XDR locally so the submitted tx is well-formed.
  const mockWalletSign = () =>
    vi.mocked(signTransaction).mockImplementation(async (xdr: string) => {
      const built = StellarSdk.TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
      built.sign(keypair);
      return { signedTxXdr: built.toEnvelope().toXDR('base64') };
    });

  it('builds a payment to the anchor with the memo, signs, and submits', async () => {
    vi.spyOn(StellarSdk.Horizon.Server.prototype, 'loadAccount')
      .mockResolvedValue(new StellarSdk.Account(account, '123') as never);
    const submit = vi
      .spyOn(StellarSdk.Horizon.Server.prototype, 'submitTransaction')
      .mockResolvedValue({ hash: 'withdraw-hash' } as never);
    mockWalletSign();

    const hash = await sendWithdrawPayment(config, account, tx);

    expect(hash).toBe('withdraw-hash');
    const submitted = submit.mock.calls[0][0] as StellarSdk.Transaction;
    expect(submitted.operations[0].type).toBe('payment');
    expect((submitted.operations[0] as StellarSdk.Operation.Payment).destination).toBe(
      tx.withdraw_anchor_account,
    );
    expect(submitted.memo.value?.toString()).toBe(tx.withdraw_memo);
  });

  it('maps op_underfunded to a clear balance message', async () => {
    vi.spyOn(StellarSdk.Horizon.Server.prototype, 'loadAccount')
      .mockResolvedValue(new StellarSdk.Account(account, '123') as never);
    vi.spyOn(StellarSdk.Horizon.Server.prototype, 'submitTransaction').mockRejectedValue({
      response: { data: { extras: { result_codes: { operations: ['op_underfunded'] } } } },
    });
    mockWalletSign();

    await expect(sendWithdrawPayment(config, account, tx)).rejects.toMatchObject({
      name: 'AnchorError',
      step: 'payment-submit',
      message: expect.stringMatching(/balance is too low/i),
    });
  });

  it('falls back to the generic submit error for other Horizon failures', async () => {
    vi.spyOn(StellarSdk.Horizon.Server.prototype, 'loadAccount')
      .mockResolvedValue(new StellarSdk.Account(account, '123') as never);
    vi.spyOn(StellarSdk.Horizon.Server.prototype, 'submitTransaction').mockRejectedValue({
      response: { data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } },
    });
    mockWalletSign();

    await expect(sendWithdrawPayment(config, account, tx)).rejects.toMatchObject({
      name: 'AnchorError',
      step: 'payment-submit',
      message: expect.stringMatching(/Failed to submit/i),
    });
  });
});
