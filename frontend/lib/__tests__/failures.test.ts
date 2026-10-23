import { describe, it, expect, vi } from 'vitest';
import { DonationError } from '@/lib/contract';
import { describeDonationFailure, describeChargeFailure } from '@/lib/failures';

// The contract module pulls in lib/wallet, which loads @stellar/freighter-api —
// its CJS named exports don't survive vitest's ESM interop, and nothing here
// exercises wallet signing anyway.
vi.mock('@/lib/wallet', () => ({
  connectWallet: vi.fn(),
  disconnectWallet: vi.fn(),
  signMessage: vi.fn(),
  signTransaction: vi.fn(),
}));

describe('describeDonationFailure', () => {
  it('maps a rejected signature to a specific message and wallet recovery', () => {
    const failure = describeDonationFailure(
      new DonationError('wallet', 'Signing was cancelled or failed.', undefined),
      'donate'
    );
    expect(failure.title).toBe('Signature declined');
    expect(failure.message).toMatch(/no funds were moved/i);
    expect(failure.action).toMatch(/wallet/i);
    expect(failure.retryable).toBe(true);
  });

  it('maps a WrongNetworkError cause to switch-network guidance, not "signature declined"', () => {
    const cause = Object.assign(
      new Error(
        'Wrong network: your wallet is set to a different network than the Stellar Testnet.'
      ),
      { name: 'WrongNetworkError' }
    );
    const failure = describeDonationFailure(
      new DonationError('wallet', 'Signing was cancelled or failed.', cause),
      'donate'
    );
    expect(failure.title).toBe('Wrong network');
    expect(failure.message).toMatch(/different network/i);
    expect(failure.action).toMatch(/testnet/i);
    expect(failure.retryable).toBe(true);
  });

  it('maps wallet-kit mismatch wording on the error itself to wrong-network guidance', () => {
    const failure = describeDonationFailure(
      new DonationError(
        'wallet',
        'Wrong network: the network does not match the passphrase the transaction was built with.',
        undefined
      ),
      'donate'
    );
    expect(failure.title).toBe('Wrong network');
    expect(failure.action).toMatch(/testnet/i);
  });

  it('maps insufficient balance to a fund-or-lower recovery', () => {
    const failure = describeDonationFailure(
      new DonationError(
        'simulation',
        'Insufficient balance or allowance to complete this action.',
        undefined
      ),
      'donate'
    );
    expect(failure.title).toBe('Not enough balance');
    expect(failure.action).toMatch(/lower the amount|add funds/i);
  });

  it('maps other simulation rejections to checking details', () => {
    const failure = describeDonationFailure(
      new DonationError('simulation', 'Enter a valid amount greater than 0.', undefined),
      'donate'
    );
    expect(failure.title).toBe('Transaction rejected');
    expect(failure.action).toMatch(/check the amount/i);
  });

  it('tells users to verify a timed-out transaction before retrying', () => {
    const failure = describeDonationFailure(
      new DonationError(
        'network',
        'Timed out waiting for confirmation. Check Stellar Explorer for the latest status.',
        undefined
      ),
      'donate'
    );
    expect(failure.title).toBe('Confirmation timed out');
    expect(failure.retryable).toBe(false);
    expect(failure.action).toMatch(/stellar explorer/i);
    expect(failure.action).toMatch(/do not send it twice/i);
  });

  it('routes on-chain failures to the explorer before a retry', () => {
    const failure = describeDonationFailure(
      new DonationError('network', 'Transaction failed on the network.', undefined),
      'donate'
    );
    expect(failure.title).toBe('Transaction failed');
    expect(failure.action).toMatch(/stellar explorer/i);
    expect(failure.retryable).toBe(true);
  });

  it('maps generic network errors to a connection recovery', () => {
    const failure = describeDonationFailure(
      new DonationError('network', 'Failed to submit the transaction to the network.', undefined),
      'subscribe'
    );
    expect(failure.title).toBe('Network error');
    expect(failure.action).toMatch(/check your connection/i);
    expect(failure.retryable).toBe(true);
  });

  it('falls back to a flow-specific title for unknown errors', () => {
    const failure = describeDonationFailure(new Error('boom'), 'subscribe');
    expect(failure.title).toBe("Couldn't start subscription");
    expect(failure.message).toBe('boom');
  });
});

describe('describeChargeFailure', () => {
  it('explains insufficient funds with automatic retry', () => {
    expect(describeChargeFailure('Insufficient balance for transfer')).toMatch(
      /didn't have enough funds.*retry automatically/i
    );
  });

  it('explains a revoked or expired allowance with the renewal recovery', () => {
    expect(describeChargeFailure('allowance expired or was revoked')).toMatch(
      /renew it from the subscriptions page/i
    );
  });

  it('explains confirmation timeouts with automatic retry', () => {
    expect(describeChargeFailure('Transaction abc did not confirm within 30s')).toMatch(
      /retry automatically/i
    );
  });

  it('keeps unrecognized errors with an automatic-retry note', () => {
    expect(describeChargeFailure('something exotic')).toMatch(
      /something exotic.*retry automatically/i
    );
  });
});
