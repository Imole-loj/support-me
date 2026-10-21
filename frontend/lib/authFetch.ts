import { notify } from './notify';

/**
 * Shared `fetch` wrapper for authenticated API calls (#246).
 *
 * Every signed-in request used to hand-roll its own `Authorization` header and
 * ignore what a 401 meant: when the JWT expired or was revoked, each call just
 * failed, pages kept rendering a signed-in shell full of stale data, and the
 * user had no way to know they had to sign in again. `authFetch` attaches the
 * token and, on a 401, signs the user out (via the supplied `onUnauthorized`,
 * normally `AuthContext`'s `logout`), surfaces one explanatory toast, and
 * throws a `SessionExpiredError` so callers can skip their own generic error
 * toast for what is really an auth problem.
 */

/** Stable sonner toast id, so parallel 401s (e.g. a `Promise.all`) replace
 * one toast instead of stacking one per failed request. */
export const SESSION_EXPIRED_TOAST_ID = 'session-expired';
export const SESSION_EXPIRED_MESSAGE = 'Your session expired, please sign in again';

export class SessionExpiredError extends Error {
  constructor() {
    super(`${SESSION_EXPIRED_MESSAGE}.`);
    this.name = 'SessionExpiredError';
  }
}

export function isSessionExpiredError(err: unknown): err is SessionExpiredError {
  return err instanceof SessionExpiredError;
}

export interface AuthFetchOptions {
  /** Bearer token to attach; when falsy the request is sent unauthenticated. */
  token?: string | null;
  /**
   * Called when the server rejects the token with a 401 — normally
   * `AuthContext`'s `logout`, which clears the session so protected pages
   * re-render their sign-in state.
   */
  onUnauthorized?: () => void;
  /**
   * Underlying fetch implementation; lets call sites keep their existing
   * transport (e.g. `fetchWithRetry`'s connection-failure handling) while
   * still getting the 401 treatment. Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: AuthFetchOptions = {}
): Promise<Response> {
  const { token, onUnauthorized, fetchImpl } = options;
  // Plain object (not Headers) so the merged headers keep the shape the call
  // sites — and their tests — already build by hand.
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string> | undefined) ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await (fetchImpl ?? fetch)(input, { ...init, headers });

  if (res.status === 401) {
    // The token is gone (expired or revoked): drop the local session so no
    // page keeps showing a signed-in shell, then tell the user why.
    onUnauthorized?.();
    notify.error(SESSION_EXPIRED_MESSAGE, undefined, { id: SESSION_EXPIRED_TOAST_ID });
    throw new SessionExpiredError();
  }

  return res;
}

/**
 * Best-effort decode of a JWT's `exp` claim (seconds since epoch). Returns
 * null for anything that isn't a decodable JWT — opaque or malformed tokens
 * are treated as non-expired so this never signs a working session out.
 */
export function decodeJwtExp(token: string): number | null {
  const payloadSegment = token.split('.')[1];
  if (!payloadSegment) return null;
  try {
    const base64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const payload: unknown = JSON.parse(atob(base64));
    const exp = (payload as { exp?: unknown } | null)?.exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

/**
 * True when the JWT's own `exp` claim has passed. Used on session restore to
 * drop expired tokens before any request is fired, so a reload of an expired
 * session lands straight on the sign-in state instead of a page of failing
 * calls.
 */
export function isTokenExpired(token: string, nowMs: number = Date.now()): boolean {
  const exp = decodeJwtExp(token);
  return exp !== null && exp * 1000 <= nowMs;
}
