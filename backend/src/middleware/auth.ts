import { Request, RequestHandler } from 'express';
import * as jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../errors/AppError';
import { getJwtSecret, getAllowedOrigins } from '../config';
import prisma from '../prisma';
import { TtlCache } from '../services/ttlCache';
import { asyncHandler } from './asyncHandler';

export interface AuthRequest extends Request {
  user?: {
    id: number;
    // Null for a magic-link (#15) or OAuth (#14) account that hasn't
    // connected a wallet. Existing wallet-authenticated call sites that
    // compare this against a Stellar address (e.g. authorizing a
    // subscription action) still behave correctly when it's null: a
    // non-wallet user can never equal a real wallet address, so they're
    // correctly denied rather than needing every call site updated.
    walletAddress: string | null;
  };
}

// Whether a user id is soft-deleted, cached briefly (#270) so a signature
// check that otherwise costs nothing but CPU doesn't turn into a database
// round-trip on every single authenticated request. A 30s TTL bounds how
// long a token issued just before deletion can keep working to at most
// one cache window, while keeping the common case (an active, never-deleted
// account) cheap.
const deletedAtCache = new TtlCache<Date | null>(30_000);

async function isUserDeleted(userId: number): Promise<boolean> {
  const cached = await deletedAtCache.getOrSet(String(userId), async () => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { deletedAt: true },
    });
    // A user id from a validly-signed token that no longer exists at all
    // (e.g. a hard-deleted test fixture) is treated the same as deleted:
    // there is nothing valid to authenticate as. Checked explicitly
    // against `undefined` (user not found), not with `??`: a real,
    // never-deleted user's `deletedAt` is `null`, and `null ?? x` also
    // falls through to `x`, which would misclassify every active user as
    // deleted.
    return user === null ? new Date(0) : user.deletedAt;
  });
  return cached !== null;
}

export function parseCookie(header: string | undefined, key: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

// Typed as a plain `RequestHandler` (not `(req: AuthRequest, ...) => void`) so
// it can be passed straight to `router.use`/`router.get` etc. without an
// `as any` cast at every call site: a handler accepting the narrower
// `AuthRequest` isn't assignable where Express expects one accepting
// `Request`, even though this function only ever runs within this app's own
// Express instance. The cast narrows in exactly one place instead of 16.
export const authMiddleware: RequestHandler = asyncHandler(async (req, res, next) => {
  const authReq = req as AuthRequest;
  const authHeader = authReq.headers.authorization?.split(' ')[1];
  const cookieToken = parseCookie(req.headers.cookie, 'token');
  const token = authHeader || cookieToken;

  if (!token) {
    return next(new UnauthorizedError('No token provided'));
  }

  // CSRF protection for cookie-based state-changing requests (#366)
  if (!authHeader && cookieToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
    const allowed = getAllowedOrigins().map((o) => o.replace(/\/$/, ''));
    if (origin && !allowed.includes(origin.replace(/\/$/, ''))) {
      return next(new UnauthorizedError('Cross-site request forgery blocked'));
    }
  }

  let decoded: { id: number; walletAddress: string | null };
  try {
    decoded = jwt.verify(token, getJwtSecret()) as {
      id: number;
      walletAddress: string | null;
    };
  } catch {
    return next(new UnauthorizedError('Invalid token'));
  }

  // A token's signature alone proves it was issued by this server, not
  // that the account it names is still usable: without this check, a
  // token issued before a soft delete stayed valid for its full 7-day
  // lifetime (#270). Wrapped in asyncHandler so a DB error here (Express 4
  // does not forward a rejected async-middleware promise to next() on its
  // own) reaches the error handler instead of hanging the request.
  if (await isUserDeleted(decoded.id)) {
    return next(new UnauthorizedError('This account no longer exists'));
  }

  authReq.user = decoded;
  next();
});

export const generateToken = (userId: number, walletAddress: string | null): string => {
  return jwt.sign(
    { id: userId, walletAddress },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
};
