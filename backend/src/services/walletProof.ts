import { createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { UnauthorizedError } from '../errors/AppError';
import type { ChallengeStore } from './challengeStore';

// Same prefix the wallet sign-in flow (routes/auth.ts) uses, so a signature
// produced by `signMessage` for a /api/auth/challenge message is accepted here.
const STELLAR_SIGNED_MESSAGE_PREFIX = 'Stellar Signed Message:\n';

/**
 * Proves the caller controls `walletAddress` by checking `signedMessage`
 * (base64) against the challenge previously issued for that address by
 * POST /api/auth/challenge. The challenge is single-use: it is consumed on
 * success and on an expired lookup, so a captured signature cannot be replayed.
 *
 * Throws UnauthorizedError when there is no live challenge or the signature
 * does not verify.
 */
export function verifyWalletOwnership(
  store: ChallengeStore,
  walletAddress: string,
  signedMessage: string,
  challengeId?: string
): void {
  const challenge = challengeId ? store.getById(challengeId) ?? store.get(walletAddress) : store.get(walletAddress);
  if (!challenge || challenge.expiresAt < Date.now()) {
    if (challengeId) {
      store.deleteById(challengeId);
    }
    store.delete(walletAddress);
    throw new UnauthorizedError(
      'Wallet challenge expired or not found, request a new one from /api/auth/challenge'
    );
  }

  const payload = Buffer.concat([
    Buffer.from(STELLAR_SIGNED_MESSAGE_PREFIX, 'utf-8'),
    Buffer.from(challenge.message, 'utf-8'),
  ]);
  const hash = createHash('sha256').update(payload).digest();

  let valid = false;
  try {
    valid = Keypair.fromPublicKey(walletAddress).verify(hash, Buffer.from(signedMessage, 'base64'));
  } catch {
    throw new UnauthorizedError('Wallet signature verification failed');
  }

  if (!valid) {
    throw new UnauthorizedError('Invalid wallet signature');
  }

  if (challengeId) {
    store.deleteById(challengeId);
  } else {
    store.delete(walletAddress);
  }
}
