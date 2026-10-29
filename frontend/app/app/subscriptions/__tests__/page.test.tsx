import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SubscriptionsPage from '@/app/app/subscriptions/page';
import { cancelSubscription } from '@/lib/contract';
import { fetchWithRetry } from '@/lib/network';
import { notify } from '@/lib/notify';

const mockAuthState = vi.hoisted(() => ({
  user: { id: 1, walletAddress: 'GSUPPORTER' as string | null } as { id: number; walletAddress: string | null } | null,
  token: 'tok' as string | null,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));
vi.mock('@/components/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/AppNav', () => ({ AppNav: () => null }));
vi.mock('@/lib/notify', () => ({
  notify: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/contract', () => ({ cancelSubscription: vi.fn() }));
vi.mock('@/lib/network', () => ({
  fetchWithRetry: vi.fn(),
  isNetworkError: () => false,
}));

const subscription = {
  id: 3,
  onChainId: 42,
  amount: '5',
  token: 'XLM',
  intervalSecs: 7 * 86400,
  nextChargeAt: '2026-11-01T00:00:00.000Z',
  active: true,
  lastError: null,
  creator: { username: 'alice', displayName: 'Alice' },
};

describe('SubscriptionsPage', () => {
  beforeEach(() => {
    mockAuthState.user = { id: 1, walletAddress: 'GSUPPORTER' };
    mockAuthState.token = 'tok';
    vi.mocked(cancelSubscription).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(notify.error).mockReset();
    vi.mocked(fetchWithRetry).mockReset().mockImplementation(async (url) =>
      String(url).includes('/cancel')
        ? new Response('{}', { status: 200 })
        : new Response(JSON.stringify([subscription]), { status: 200 })
    );
  });

  describe('authenticated subscriptions fetch (#234)', () => {
    it('sends the Authorization header with bearer token and renders the subscription list', async () => {
      render(<SubscriptionsPage />);

      await waitFor(() => {
        expect(fetchWithRetry).toHaveBeenCalledWith(
          expect.stringContaining('/api/subscriptions?supporterAddress=GSUPPORTER'),
          expect.objectContaining({
            headers: { Authorization: 'Bearer tok' },
          })
        );
      });

      expect(await screen.findByText('Alice')).toBeInTheDocument();
      expect(screen.getByText(/5 XLM/)).toBeInTheDocument();
    });

    it('shows a specific session expired error when receiving 401', async () => {
      vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
      render(<SubscriptionsPage />);

      await waitFor(() => {
        expect(notify.error).toHaveBeenCalledWith(
          expect.stringMatching(/session expired, sign in again/i)
        );
      });
    });
  });

  describe('wallet-less user handling (#235)', () => {
    it('renders empty state with link to settings, without permanent skeleton or fetch call', async () => {
      mockAuthState.user = { id: 2, walletAddress: null };

      render(<SubscriptionsPage />);

      expect(
        await screen.findByText(/connect a wallet to start or manage recurring donations/i)
      ).toBeInTheDocument();

      const settingsLink = screen.getByRole('link', { name: /settings/i });
      expect(settingsLink).toHaveAttribute('href', '/settings');

      expect(screen.queryByTestId('subscriptions-skeleton')).not.toBeInTheDocument();
      expect(fetchWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('cancel confirmation (#236)', () => {
    it('asks before cancelling and does nothing when the supporter keeps it', async () => {
      const user = userEvent.setup();
      render(<SubscriptionsPage />);

      const cancelButton = await screen.findByRole('button', { name: /cancel donation to alice/i });
      expect(cancelButton).toHaveAttribute('aria-label', 'Cancel donation to Alice');

      await user.click(cancelButton);
      const dialog = screen.getByRole('alertdialog', { name: 'Cancel your donation to Alice?' });
      expect(dialog).toHaveAccessibleDescription(/stop sending 5 XLM weekly/i);

      await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(cancelSubscription).not.toHaveBeenCalled();
    });

    it('cancels on-chain once confirmed', async () => {
      const user = userEvent.setup();
      render(<SubscriptionsPage />);

      const cancelButton = await screen.findByRole('button', { name: /cancel donation to alice/i });
      await user.click(cancelButton);
      await user.click(screen.getByRole('button', { name: 'Cancel donation' }));

      await waitFor(() =>
        expect(cancelSubscription).toHaveBeenCalledWith({ supporterAddress: 'GSUPPORTER', subscriptionId: 42 })
      );
      expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    });
  });
});
