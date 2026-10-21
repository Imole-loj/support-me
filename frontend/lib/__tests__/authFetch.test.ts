import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  authFetch,
  isSessionExpiredError,
  isTokenExpired,
  decodeJwtExp,
  SessionExpiredError,
  SESSION_EXPIRED_TOAST_ID,
  SESSION_EXPIRED_MESSAGE,
} from '@/lib/authFetch';
import { notify } from '@/lib/notify';

vi.mock('@/lib/notify', () => ({
  notify: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

/** Builds a structurally-valid JWT with the given claims (no signature verification client-side). */
function makeJwt(claims: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

const futureExp = () => Math.floor(Date.now() / 1000) + 60 * 60;
const pastExp = () => Math.floor(Date.now() / 1000) - 60;

describe('authFetch (#246)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as Response));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('attaches the bearer token as an Authorization header', async () => {
    await authFetch('http://api.test/me', {}, { token: 'jwt-token' });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer jwt-token' });
  });

  it('sends no Authorization header without a token', async () => {
    await authFetch('http://api.test/me');

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.headers).not.toHaveProperty('Authorization');
  });

  it('passes through non-401 responses untouched', async () => {
    const onUnauthorized = vi.fn();
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as Response);

    const res = await authFetch('http://api.test/me', {}, { token: 't', onUnauthorized });

    expect(res.status).toBe(404);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('signs the user out, toasts, and throws SessionExpiredError on a 401', async () => {
    const onUnauthorized = vi.fn();
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 } as Response);

    let thrown: unknown;
    try {
      await authFetch('http://api.test/me', {}, { token: 'expired-jwt', onUnauthorized });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SessionExpiredError);
    expect(isSessionExpiredError(thrown)).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(notify.error).toHaveBeenCalledWith(
      SESSION_EXPIRED_MESSAGE,
      undefined,
      expect.objectContaining({ id: SESSION_EXPIRED_TOAST_ID })
    );
  });

  it('works without an onUnauthorized handler (still throws)', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 } as Response);

    await expect(authFetch('http://api.test/me', {}, { token: 't' })).rejects.toThrow(
      SessionExpiredError
    );
  });

  it('reuses one toast id so parallel 401s do not stack duplicate toasts', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 } as Response);
    const onUnauthorized = vi.fn();
    const run = () =>
      authFetch('http://api.test/a', {}, { token: 't', onUnauthorized }).catch(() => undefined);

    await Promise.all([run(), run(), run()]);

    expect(onUnauthorized).toHaveBeenCalledTimes(3);
    const ids = vi
      .mocked(notify.error)
      .mock.calls.map((call) => (call[2] as { id?: string } | undefined)?.id);
    expect(ids).toEqual([
      SESSION_EXPIRED_TOAST_ID,
      SESSION_EXPIRED_TOAST_ID,
      SESSION_EXPIRED_TOAST_ID,
    ]);
  });

  it('routes the request through a supplied fetchImpl (e.g. fetchWithRetry)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

    await authFetch('http://api.test/me', { method: 'POST' }, { token: 't', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api.test/me',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('signs out through fetchImpl responses too', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 } as Response));
    const onUnauthorized = vi.fn();

    await expect(
      authFetch('http://api.test/me', {}, { token: 't', onUnauthorized, fetchImpl })
    ).rejects.toThrow(SessionExpiredError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('isTokenExpired / decodeJwtExp', () => {
  it('detects an expired JWT', () => {
    expect(isTokenExpired(makeJwt({ exp: pastExp() }))).toBe(true);
  });

  it('accepts a JWT that is still valid', () => {
    expect(isTokenExpired(makeJwt({ exp: futureExp() }))).toBe(false);
  });

  it('treats an exp exactly now as expired', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(isTokenExpired(makeJwt({ exp: nowSec }))).toBe(true);
  });

  it('never signs out on opaque or malformed tokens', () => {
    expect(isTokenExpired('mock-jwt-token-abcdef123456')).toBe(false);
    expect(isTokenExpired('a.%%%.c')).toBe(false);
    expect(isTokenExpired('')).toBe(false);
  });

  it('ignores tokens without an exp claim', () => {
    expect(isTokenExpired(makeJwt({ sub: '1' }))).toBe(false);
    expect(decodeJwtExp(makeJwt({ sub: '1' }))).toBeNull();
  });

  it('decodes the exp claim from a base64url payload', () => {
    expect(decodeJwtExp(makeJwt({ exp: 1700000000 }))).toBe(1700000000);
  });
});
