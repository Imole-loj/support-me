import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AppHubPage from '@/app/app/page';
import { useAuth } from '@/context/AuthContext';
import { useCreator } from '@/context/CreatorContext';

vi.mock('@/context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/components/AppNav', () => ({
  AppNav: () => <nav data-testid="app-nav" />,
}));

vi.mock('@/context/CreatorContext', () => ({
  useCreator: vi.fn(),
}));

const mockLoadAccount = vi.hoisted(() => vi.fn());

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: class MockServer {
        loadAccount = mockLoadAccount;
      },
    },
  };
});

vi.mock('@/lib/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assets')>();
  return {
    ...actual,
    availableAssetCodes: () => ['XLM', 'USDC'],
    getAsset: (code: string) => ({
      code,
      label: code,
      balanceMatcher: (b: any) =>
        code === 'XLM' ? b.asset_type === 'native' : b.asset_code === code,
    }),
  };
});

const mockUseAuth = vi.mocked(useAuth);
const mockUseCreator = vi.mocked(useCreator);

describe('AppHubPage', () => {
  const creator = {
    id: 1,
    userId: 42,
    username: 'alice',
    displayName: 'Alice',
    walletAddress: 'GALICE',
    avatarUrl: null,
    donationGoal: null,
    acceptsXlm: true,
    acceptsUsdc: true,
    acceptsUsdt: false,
    socialLinks: null,
    presetAmounts: [],
  };

  beforeEach(() => {
    mockLoadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '100' }],
    });

    mockUseAuth.mockReturnValue({
      user: { id: 42, walletAddress: 'GALICE' },
      token: 'mock-jwt-token',
      loading: false,
      loginWithWallet: vi.fn(),
      getTwitterRedirectUrl: vi.fn(),
      completeTwitterLogin: vi.fn(),
      requestMagicLink: vi.fn(),
      verifyMagicLink: vi.fn(),
      logout: vi.fn(),
    });

    mockUseCreator.mockReturnValue({
      creator,
      loading: false,
      invalidate: vi.fn(),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/api/creators/me')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => creator,
          });
        }
        if (url.includes('/api/prices')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ prices: { XLM: 0.12 } }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders profile link and opens ShareModal when Share button is tapped', async () => {
    render(<AppHubPage />);

    await waitFor(() => {
      expect(screen.getByText('Hey, Alice 👋')).toBeInTheDocument();
      expect(screen.getByText(/\/alice$/)).toBeInTheDocument();
    });

    // Share modal is not open yet
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Click the Share button
    const shareBtn = screen.getByRole('button', { name: 'Share profile' });
    fireEvent.click(shareBtn);

    // Share modal opens with choices
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Share Profile')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /both/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /copy link/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /qr code/i })).toBeInTheDocument();
    });

    // Close the modal
    const closeBtn = screen.getByRole('button', { name: 'Close' });
    fireEvent.click(closeBtn);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('Balance privacy masking & localStorage persistence (#152)', () => {
    it('masks balance by default as •••••• on first visit and shows Show balance button', async () => {
      render(<AppHubPage />);

      await waitFor(() => {
        expect(screen.getByText('••••••')).toBeInTheDocument();
      });
      expect(screen.queryByText('100')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show balance' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show balance' })).toHaveTextContent('Show');
    });

    it('reveals balance upon clicking Show button and saves false to localStorage', async () => {
      render(<AppHubPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Show balance' })).toBeInTheDocument();
      });

      const toggleBtn = screen.getByRole('button', { name: 'Show balance' });
      fireEvent.click(toggleBtn);

      await waitFor(() => {
        expect(screen.queryByText('••••••')).not.toBeInTheDocument();
        expect(screen.getByText('100')).toBeInTheDocument();
        expect(screen.getByText('XLM')).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: 'Hide balance' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Hide balance' })).toHaveTextContent('Hide');
      expect(localStorage.getItem('balance_hidden')).toBe('false');
    });

    it('masks balance again upon clicking Hide button and saves true to localStorage', async () => {
      render(<AppHubPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Show balance' })).toBeInTheDocument();
      });

      const showBtn = screen.getByRole('button', { name: 'Show balance' });
      fireEvent.click(showBtn);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Hide balance' })).toBeInTheDocument();
      });

      const hideBtn = screen.getByRole('button', { name: 'Hide balance' });
      fireEvent.click(hideBtn);

      await waitFor(() => {
        expect(screen.getByText('••••••')).toBeInTheDocument();
      });
      expect(screen.queryByText('100')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show balance' })).toBeInTheDocument();
      expect(localStorage.getItem('balance_hidden')).toBe('true');
    });

    it('restores unmasked balance on visit if user previously chose to show balance', async () => {
      localStorage.setItem('balance_hidden', 'false');

      render(<AppHubPage />);

      await waitFor(() => {
        expect(screen.queryByText('••••••')).not.toBeInTheDocument();
        expect(screen.getByText('100')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Hide balance' })).toBeInTheDocument();
      });
    });

    it('keeps balance masked on visit if user previously set preference to hidden', async () => {
      localStorage.setItem('balance_hidden', 'true');

      render(<AppHubPage />);

      await waitFor(() => {
        expect(screen.getByText('••••••')).toBeInTheDocument();
      });
      expect(screen.queryByText('100')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show balance' })).toBeInTheDocument();
    });

    it('handles localStorage errors gracefully without crashing', async () => {
      const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('Storage access denied');
      });
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Quota exceeded');
      });

      render(<AppHubPage />);

      await waitFor(() => {
        expect(screen.getByText('••••••')).toBeInTheDocument();
      });

      const toggleBtn = screen.getByRole('button', { name: 'Show balance' });
      fireEvent.click(toggleBtn);

      await waitFor(() => {
        expect(screen.queryByText('••••••')).not.toBeInTheDocument();
        expect(screen.getByText('100')).toBeInTheDocument();
      });

      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
    });
  });

  describe('Partial USD total handling and caveat for unpriced assets (#168)', () => {
    it('displays complete USD total with no caveat when all held assets are priced', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '100' }],
      });

      render(<AppHubPage />);

      // Reveal balances
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Show balance' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Show balance' }));

      // Switch to USD view
      const usdToggle = await screen.findByRole('button', { name: 'Crypto' });
      fireEvent.click(usdToggle);

      await waitFor(() => {
        expect(screen.getByText('$12.00')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('unpriced-caveat')).not.toBeInTheDocument();
      expect(screen.queryByText(/asset not priced/i)).not.toBeInTheDocument();
    });

    it('indicates partial total and renders visible caveat when a held asset is missing price', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [
          { asset_type: 'native', balance: '100' },
          { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '50' },
        ],
      });

      render(<AppHubPage />);

      // Reveal balances
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Show balance' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Show balance' }));

      // In crypto view, unpriced asset is marked
      await waitFor(() => {
        expect(screen.getByText('Price unavailable')).toBeInTheDocument();
      });

      // Switch to USD view
      const usdToggle = await screen.findByRole('button', { name: 'Crypto' });
      fireEvent.click(usdToggle);

      // Total shows ≈ prefix and caveat badge
      await waitFor(() => {
        expect(screen.getByText(/≈\s*\$12\.00/)).toBeInTheDocument();
      });
      const caveat = screen.getByTestId('unpriced-caveat');
      expect(caveat).toBeInTheDocument();
      expect(caveat).toHaveTextContent('+ 1 asset not priced');
      expect(screen.getByText(/excludes USDC due to missing price data/i)).toBeInTheDocument();
    });
  });
});
