import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { useAuthFetch } from '@/lib/useAuthFetch';
import { notify } from '@/lib/notify';
import { disconnectWallet } from '@/lib/wallet';
import { SESSION_EXPIRED_MESSAGE } from '@/lib/authFetch';

vi.mock('@/lib/notify', () => ({
  notify: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function setupSession() {
  localStorage.setItem('authToken', 'stored-jwt');
  localStorage.setItem('authUser', JSON.stringify({ id: 1, walletAddress: 'GABC' }));
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

describe('useAuthFetch (#246)', () => {
  beforeEach(() => {
    // logout() kicks off a wallet disconnect; the global wallet mock returns
    // undefined, which would throw on `.catch` and mask the 401 flow.
    vi.mocked(disconnectWallet).mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('signs the user out with an explanatory toast when a request 401s', async () => {
    setupSession();
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 } as Response);

    const { result } = renderHook(() => ({ auth: useAuth(), authFetch: useAuthFetch() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.auth.loading).toBe(false));
    expect(result.current.auth.token).toBe('stored-jwt');

    await act(async () => {
      await result.current.authFetch('http://api.test/api/creators/me').catch(() => undefined);
    });

    // Clean signed-out state: context cleared and localStorage wiped.
    await waitFor(() => expect(result.current.auth.token).toBeNull());
    expect(result.current.auth.user).toBeNull();
    expect(localStorage.getItem('authToken')).toBeNull();
    expect(localStorage.getItem('authUser')).toBeNull();

    // ...with a toast explaining why.
    expect(notify.error).toHaveBeenCalledWith(
      SESSION_EXPIRED_MESSAGE,
      undefined,
      expect.objectContaining({ id: 'session-expired' })
    );
  });

  it('leaves the session intact for authenticated 200s', async () => {
    setupSession();
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const { result } = renderHook(() => ({ auth: useAuth(), authFetch: useAuthFetch() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.auth.loading).toBe(false));

    await act(async () => {
      await result.current.authFetch('http://api.test/api/creators/me');
    });

    expect(result.current.auth.token).toBe('stored-jwt');
    expect(localStorage.getItem('authToken')).toBe('stored-jwt');
    expect(notify.error).not.toHaveBeenCalled();

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer stored-jwt' });
  });

  it('drops an expired stored token on load before any request is fired', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 60;
    const encode = (obj: unknown) =>
      btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem('authToken', `${encode({ alg: 'HS256' })}.${encode({ exp: pastExp })}.sig`);
    localStorage.setItem('authUser', JSON.stringify({ id: 1, walletAddress: 'GABC' }));

    const { result } = renderHook(() => ({ auth: useAuth(), authFetch: useAuthFetch() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.auth.loading).toBe(false));

    expect(result.current.auth.token).toBeNull();
    expect(result.current.auth.user).toBeNull();
    expect(localStorage.getItem('authToken')).toBeNull();
    expect(localStorage.getItem('authUser')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
