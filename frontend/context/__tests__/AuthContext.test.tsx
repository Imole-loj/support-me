import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { connectWallet, disconnectWallet, signMessage } from '@/lib/wallet';

vi.mock('@/lib/wallet', () => ({
  connectWallet: vi.fn(),
  disconnectWallet: vi.fn(),
  signMessage: vi.fn(),
}));

const mockConnectWallet = vi.mocked(connectWallet);
const mockDisconnectWallet = vi.mocked(disconnectWallet);
const mockSignMessage = vi.mocked(signMessage);

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

/** Builds a structurally-valid JWT with the given claims (#246). */
function makeJwt(claims: Record<string, unknown>) {
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

describe('AuthContext', () => {
  beforeEach(() => {
    localStorage.clear();
    mockConnectWallet.mockReset();
    mockDisconnectWallet.mockReset().mockResolvedValue(undefined);
    mockSignMessage.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores a session from localStorage on mount', async () => {
    localStorage.setItem('authToken', 'saved-token');
    localStorage.setItem('authUser', JSON.stringify({ id: 1, walletAddress: 'GABC' }));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.token).toBe('saved-token');
    expect(result.current.user).toEqual({ id: 1, walletAddress: 'GABC' });
  });

  it('restores a session whose stored JWT is still valid', async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 60 * 60 });
    localStorage.setItem('authToken', token);
    localStorage.setItem('authUser', JSON.stringify({ id: 1, walletAddress: 'GABC' }));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.token).toBe(token);
    expect(result.current.user).toEqual({ id: 1, walletAddress: 'GABC' });
  });

  it('drops an expired stored token instead of restoring the session (#246)', async () => {
    const expiredToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    localStorage.setItem('authToken', expiredToken);
    localStorage.setItem('authUser', JSON.stringify({ id: 1, walletAddress: 'GABC' }));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
    expect(localStorage.getItem('authToken')).toBeNull();
    expect(localStorage.getItem('authUser')).toBeNull();
  });

  it('logs in with a wallet and persists the session', async () => {
    mockConnectWallet.mockResolvedValue('GABC');
    mockSignMessage.mockResolvedValue('signed-message');
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'sign this' }))
      .mockResolvedValueOnce(
        jsonResponse({
          user: { id: 1, walletAddress: 'GABC' },
          token: 'jwt-token',
          hasProfile: true,
        })
      );

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let loginResult;
    await act(async () => {
      loginResult = await result.current.loginWithWallet();
    });

    expect(loginResult).toEqual({
      user: { id: 1, walletAddress: 'GABC' },
      token: 'jwt-token',
      hasProfile: true,
    });
    expect(result.current.token).toBe('jwt-token');
    expect(result.current.user).toEqual({ id: 1, walletAddress: 'GABC' });
    expect(localStorage.getItem('authToken')).toBe('jwt-token');
  });

  it('throws when the sign-in challenge fails', async () => {
    mockConnectWallet.mockResolvedValue('GABC');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad address' }, false));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.loginWithWallet()).rejects.toThrow('bad address');
  });

  it('clears the session and disconnects the wallet on logout', async () => {
    localStorage.setItem('authToken', 'saved-token');
    localStorage.setItem('authUser', JSON.stringify({ id: 1, walletAddress: 'GABC' }));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.logout();
    });

    expect(result.current.user).toBeNull();
    expect(result.current.token).toBeNull();
    expect(localStorage.getItem('authToken')).toBeNull();
    expect(mockDisconnectWallet).toHaveBeenCalledTimes(1);
  });

  describe('Twitter OAuth (#10)', () => {
    it('returns the redirect URL from the backend', async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(jsonResponse({ redirectUrl: 'https://twitter.com/i/oauth2/authorize?...' }));

      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const url = await result.current.getTwitterRedirectUrl();

      expect(url).toBe('https://twitter.com/i/oauth2/authorize?...');
    });

    it('throws when starting Twitter sign-in fails (e.g. unconfigured provider)', async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Twitter sign-in is not configured' }, false));

      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(result.current.getTwitterRedirectUrl()).rejects.toThrow('Twitter sign-in is not configured');
    });

    it('completes sign-in and persists the session', async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          user: { id: 2, walletAddress: null },
          token: 'twitter-jwt',
          hasProfile: false,
        })
      );

      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let loginResult;
      await act(async () => {
        loginResult = await result.current.completeTwitterLogin('the-code', 'the-state');
      });

      expect(loginResult).toEqual({
        user: { id: 2, walletAddress: null },
        token: 'twitter-jwt',
        hasProfile: false,
      });
      expect(result.current.token).toBe('twitter-jwt');
      expect(localStorage.getItem('authToken')).toBe('twitter-jwt');
    });

    it('throws when the state is invalid or expired', async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Invalid or expired OAuth state, please try again' }, false)
      );

      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(result.current.completeTwitterLogin('code', 'stale-state')).rejects.toThrow(
        'Invalid or expired OAuth state, please try again'
      );
    });
  });

  describe('magic link sign-in (#11)', () => {
    it('requests a magic link without throwing on success', async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ message: 'If that email is valid, a sign-in link has been sent.' })
      );

      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(result.current.requestMagicLink('you@example.com')).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/magic-link'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ email: 'you@example.com' }),
        })
      );
    });

    it('throws when the request is rate-limited', async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Too many requests, please try again later' }, false)
      );

      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(result.current.requestMagicLink('you@example.com')).rejects.toThrow(
        'Too many requests, please try again later'
      );
    });

    it('verifies a valid token and persists the session', async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          user: { id: 3, email: 'you@example.com', walletAddress: null },
          token: 'magic-link-jwt',
          hasProfile: true,
          username: 'you',
        })
      );

      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let loginResult;
      await act(async () => {
        loginResult = await result.current.verifyMagicLink('the-token');
      });

      expect(loginResult).toEqual({
        user: { id: 3, email: 'you@example.com', walletAddress: null },
        token: 'magic-link-jwt',
        hasProfile: true,
        username: 'you',
      });
      expect(result.current.token).toBe('magic-link-jwt');
      expect(localStorage.getItem('authToken')).toBe('magic-link-jwt');
    });

    it('throws when the token has already been used', async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'This magic link has already been used' }, false));

      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(result.current.verifyMagicLink('used-token')).rejects.toThrow(
        'This magic link has already been used'
      );
    });
  });
});
