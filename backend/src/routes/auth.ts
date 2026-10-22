import { Router, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import prisma from '../prisma';
import { generateToken, authMiddleware, AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { validate } from '../middleware/validate';
import {
  challengeSchema,
  magicLinkRequestSchema,
  magicLinkVerifySchema,
  twitterCallbackSchema,
  verifySchema,
} from '../schemas/auth';
import { UnauthorizedError } from '../errors/AppError';
import { requestMagicLink, verifyMagicLink } from '../services/magicLink';
import { completeTwitterAuth, startTwitterAuth } from '../services/twitterAuth';
import { ChallengeStore } from '../services/challengeStore';
import { RateLimiter } from '../services/rateLimiter';
import { clientIp, rateLimit } from '../middleware/rateLimit';
import { getRateLimitConfig } from '../config';

const router = Router();

export const AUTH_COOKIE_NAME = 'token';

export function setAuthCookie(res: Response, token: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearAuthCookie(res: Response): void {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  });
}

const STELLAR_SIGNED_MESSAGE_PREFIX = 'Stellar Signed Message:\n';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const rateLimits = getRateLimitConfig();

// Bounded, self-sweeping store (see services/challengeStore.ts for the
// single-instance caveat).
export const challenges = new ChallengeStore();
challenges.startSweeping();

// Per-IP and per-wallet limits on the wallet sign-in endpoints. Generous for a
// real user retrying a signature, tight enough to stop a flood from growing the
// challenge store or hammering /verify.
//
// Each limiter self-sweeps idle keys (#271): an IP or wallet address an
// attacker never reuses would otherwise sit in the map forever, since a
// key's timestamps were only ever pruned when that same key was attempted
// again.
export const challengeIpLimiter = new RateLimiter(rateLimits.auth.ipMax, rateLimits.auth.windowMs);
challengeIpLimiter.startSweeping();
export const challengeWalletLimiter = new RateLimiter(
  rateLimits.auth.challengeAccountMax,
  rateLimits.auth.windowMs
);
challengeWalletLimiter.startSweeping();
export const verifyIpLimiter = new RateLimiter(rateLimits.auth.ipMax, rateLimits.auth.windowMs);
verifyIpLimiter.startSweeping();
export const verifyWalletLimiter = new RateLimiter(
  rateLimits.auth.verifyAccountMax,
  rateLimits.auth.windowMs
);
verifyWalletLimiter.startSweeping();
export const magicLinkIpLimiter = new RateLimiter(
  rateLimits.magicLink.ipMax,
  rateLimits.magicLink.windowMs
);
magicLinkIpLimiter.startSweeping();
export const magicLinkEmailLimiter = new RateLimiter(
  rateLimits.magicLink.accountMax,
  rateLimits.magicLink.windowMs
);
magicLinkEmailLimiter.startSweeping();

router.post(
  '/challenge',
  rateLimit(challengeIpLimiter, clientIp, 'sign-in challenge'),
  validate({ body: challengeSchema }),
  rateLimit(challengeWalletLimiter, (req) => req.body.walletAddress, 'sign-in challenge'),
  asyncHandler(async (req, res) => {
    const { walletAddress } = req.body;

    const nonce = randomBytes(16).toString('hex');
    const message = `Sign in to SupportMe\n\nAddress: ${walletAddress}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;

    challenges.set(walletAddress, { message, expiresAt: Date.now() + CHALLENGE_TTL_MS });

    return res.json({ message });
  })
);

router.post(
  '/verify',
  rateLimit(verifyIpLimiter, clientIp, 'sign-in verification'),
  validate({ body: verifySchema }),
  rateLimit(verifyWalletLimiter, (req) => req.body.walletAddress, 'sign-in verification'),
  asyncHandler(async (req, res) => {
    const { walletAddress, signedMessage } = req.body;

    const challenge = challenges.get(walletAddress);
    if (!challenge || challenge.expiresAt < Date.now()) {
      challenges.delete(walletAddress);
      throw new UnauthorizedError('Challenge expired or not found, please try again');
    }

    const payload = Buffer.concat([
      Buffer.from(STELLAR_SIGNED_MESSAGE_PREFIX, 'utf-8'),
      Buffer.from(challenge.message, 'utf-8'),
    ]);
    const hash = createHash('sha256').update(payload).digest();

    let signatureValid = false;
    try {
      signatureValid = Keypair.fromPublicKey(walletAddress).verify(
        hash,
        Buffer.from(signedMessage, 'base64')
      );
    } catch (error) {
      console.error('Signature verification error:', error);
      throw new UnauthorizedError('Signature verification failed');
    }

    if (!signatureValid) {
      throw new UnauthorizedError('Invalid signature');
    }

    challenges.delete(walletAddress);

    const user = await prisma.user.upsert({
      where: { walletAddress },
      update: {},
      create: { walletAddress },
    });

    // The wallet address uniquely identifies a user row even after a soft
    // delete (only `email` is cleared on delete, not `walletAddress`), so
    // the upsert above would otherwise keep matching the same deleted row
    // and minting it a fresh token forever (#270). Refuse rather than
    // silently reviving the account.
    if (user.deletedAt) {
      throw new UnauthorizedError('This account no longer exists');
    }

    const creator = await prisma.creator.findUnique({ where: { userId: user.id } });

    const token = generateToken(user.id, user.walletAddress);
    setAuthCookie(res, token);
    return res.json({
      user: { id: user.id, walletAddress: user.walletAddress },
      token,
      hasProfile: !!creator,
      username: creator?.username,
    });
  })
);

// Magic link (#15): email-only sign-in, the second auth method alongside
// the wallet-signature flow above.
router.post(
  '/magic-link',
  rateLimit(magicLinkIpLimiter, clientIp, 'magic link'),
  validate({ body: magicLinkRequestSchema }),
  rateLimit(
    magicLinkEmailLimiter,
    (req) => req.body.email.trim().toLowerCase(),
    'magic link'
  ),
  asyncHandler(async (req, res) => {
    const { email } = req.body;

    await requestMagicLink(email);

    // Same response for a new email and a returning one: this endpoint
    // must not be usable to enumerate which addresses already have an
    // account. Rate-limit middleware returns its own 429 before this handler;
    // that does not reveal anything about the target address's account status.
    return res.json({ message: 'If that email is valid, a sign-in link has been sent.' });
  })
);

router.post(
  '/magic-link/verify',
  validate({ body: magicLinkVerifySchema }),
  asyncHandler(async (req, res) => {
    const { token } = req.body;

    const session = await verifyMagicLink(token);
    setAuthCookie(res, session.token);

    return res.json(session);
  })
);

// Twitter/X OAuth (#14): the frontend flow in issue #10 calls these two
// endpoints — /twitter to get the URL to redirect the user to, then
// /twitter/callback once Twitter redirects back with a code.
router.get(
  '/twitter',
  asyncHandler(async (req, res) => {
    const redirectUrl = startTwitterAuth();
    return res.json({ redirectUrl });
  })
);

router.get(
  '/twitter/callback',
  validate({ query: twitterCallbackSchema }),
  asyncHandler(async (req, res) => {
    const { code, state } = req.query as unknown as { code: string; state: string };

    const session = await completeTwitterAuth(code, state);
    setAuthCookie(res, session.token);

    return res.json(session);
  })
);

router.post(
  '/logout',
  (req, res) => {
    clearAuthCookie(res);
    return res.json({ message: 'Logged out successfully' });
  }
);

router.get(
  '/me',
  authMiddleware,
  (req: AuthRequest, res) => {
    return res.json({ user: req.user });
  }
);

export default router;
