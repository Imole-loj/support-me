import { randomBytes } from "crypto";
import prisma from "../prisma";
import { generateToken } from "../middleware/auth";
import { BadRequestError, ServiceUnavailableError, UnauthorizedError } from "../errors/AppError";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchTwitterProfile,
  generatePkcePair,
  getTwitterOAuthConfig,
  type TwitterProfile,
} from "./twitterOAuth";

const STATE_TTL_MS = 10 * 60 * 1000;
const PROVIDER = "twitter";

interface PendingState {
  codeVerifier: string;
  expiresAt: number;
}

// Keyed by the opaque `state` param round-tripped through the redirect, the
// same in-memory-Map-with-TTL pattern as the wallet challenge flow in
// routes/auth.ts. Holds the PKCE verifier server-side so it's never
// exposed to the browser or the OAuth provider.
const pendingStates = new Map<string, PendingState>();

function pruneExpiredStates(): void {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (entry.expiresAt < now) pendingStates.delete(state);
  }
}

/** Starts the flow: returns the URL the frontend should redirect the user to. */
export function startTwitterAuth(): string {
  const config = getTwitterOAuthConfig();
  if (!config) {
    throw new ServiceUnavailableError("Twitter sign-in is not configured");
  }

  pruneExpiredStates();

  const state = randomBytes(16).toString("hex");
  const { verifier, challenge } = generatePkcePair();
  pendingStates.set(state, { codeVerifier: verifier, expiresAt: Date.now() + STATE_TTL_MS });

  return buildAuthorizeUrl(config, state, challenge);
}

export interface TwitterAuthSession {
  user: { id: number; walletAddress: string | null };
  token: string;
  hasProfile: boolean;
  username?: string;
}

/**
 * Completes the flow: exchanges the code, fetches the Twitter profile,
 * and create-or-attaches a SupportMe account. Matched by
 * (provider, providerAccountId), not by any email the profile might
 * expose, since Twitter's OAuth 2.0 API doesn't return a verified email
 * without an additional, separately-gated scope this app doesn't request.
 */
export async function completeTwitterAuth(code: string, state: string): Promise<TwitterAuthSession> {
  const config = getTwitterOAuthConfig();
  if (!config) {
    throw new ServiceUnavailableError("Twitter sign-in is not configured");
  }
  if (!code || !state) {
    throw new BadRequestError("code and state are required");
  }

  pruneExpiredStates();
  const pending = pendingStates.get(state);
  if (!pending) {
    throw new UnauthorizedError("Invalid or expired OAuth state, please try again");
  }
  pendingStates.delete(state); // single-use, like the wallet challenge

  const { accessToken } = await exchangeCodeForToken(config, code, pending.codeVerifier);
  const profile = await fetchTwitterProfile(accessToken);

  const user = await linkTwitterIdentity(profile);
  const creator = await prisma.creator.findUnique({ where: { userId: user.id } });
  const token = generateToken(user.id, user.walletAddress);

  return {
    user: { id: user.id, walletAddress: user.walletAddress },
    token,
    hasProfile: !!creator,
    username: creator?.username,
  };
}

async function linkTwitterIdentity(profile: TwitterProfile) {
  const existing = await prisma.oAuthIdentity.findUnique({
    where: { provider_providerAccountId: { provider: PROVIDER, providerAccountId: profile.id } },
    include: { user: true },
  });

  if (existing) {
    // Account deletion never removes the OAuthIdentity row linking this
    // Twitter profile to its user, so without this check a deleted
    // account's Twitter sign-in would keep returning the same deleted
    // user and minting it a fresh token indefinitely (#270). Refuse
    // rather than silently reviving the account.
    if (existing.user.deletedAt) {
      throw new UnauthorizedError("This account no longer exists");
    }
    await prisma.oAuthIdentity.update({
      where: { id: existing.id },
      data: { updatedAt: new Date() },
    });
    return existing.user;
  }

  // New Twitter identity: create a fresh account and link it in one
  // transaction, so a failure partway through never leaves an orphaned
  // OAuthIdentity row with no user, or vice versa.
  // Third-party tokens are not persisted to database (#367).
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: {} });
    await tx.oAuthIdentity.create({
      data: {
        provider: PROVIDER,
        providerAccountId: profile.id,
        userId: user.id,
      },
    });
    return user;
  });
}
