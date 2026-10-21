import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { CreatorProvider, useCreator } from '@/context/CreatorContext';
import { disconnectWallet } from '@/lib/wallet';
import { notify } from '@/lib/notify';
import { SESSION_EXPIRED_MESSAGE } from '@/lib/authFetch';

vi.mock('@/lib/notify', () => ({
  notify: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const creator = {
  id: 1,
  userId: 42,
  username: 'alice',
  displayName: 'Alice',
  walletAddress: 'GALICE',
  avatarUrl: null,
  donationGoal: null,
  acceptsXlm: true,
  socialLinks: null,
  acceptsUsdc: true,
  acceptsUsdt: false,
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>
    <CreatorProvider>{children}</CreatorProvider>
  </AuthProvider>
);

describe('CreatorContext (#246)', () => {
  beforeEach(() => {
    localStorage.setItem('authToken', 'stored-jwt');
    localStorage.setItem('authUser', JSON.stringify({ id: 42, walletAddress: 'GALICE' }));
    vi.mocked(disconnectWallet).mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('loads the creator profile for an active session', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => creator } as Response);

    const { result } = renderHook(() => ({ auth: useAuth(), creator: useCreator() }), { wrapper });
    // loading starts false-able at each render boundary, so wait for the
    // profile itself rather than the loading flag.
    await waitFor(() => expect(result.current.creator.creator?.username).toBe('alice'));

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer stored-jwt' });
  });

  it('signs out instead of keeping a stale creator when the profile call 401s', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);

    const { result } = renderHook(() => ({ auth: useAuth(), creator: useCreator() }), { wrapper });
    // The session-expired toast only fires after the 401 flow has run its
    // course, so it is the deterministic sync point for the signed-out state.
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        SESSION_EXPIRED_MESSAGE,
        undefined,
        expect.objectContaining({ id: 'session-expired' })
      )
    );

    expect(result.current.creator.creator).toBeNull();
    expect(result.current.creator.loading).toBe(false);
    expect(result.current.auth.token).toBeNull();
    expect(result.current.auth.user).toBeNull();
    expect(localStorage.getItem('authToken')).toBeNull();
  });

  it('clears the creator when the user signs out', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => creator } as Response);

    const { result } = renderHook(() => ({ auth: useAuth(), creator: useCreator() }), { wrapper });
    await waitFor(() => expect(result.current.creator.creator?.username).toBe('alice'));

    act(() => {
      result.current.auth.logout();
    });

    await waitFor(() => expect(result.current.creator.creator).toBeNull());
    expect(result.current.creator.loading).toBe(false);
  });
});
