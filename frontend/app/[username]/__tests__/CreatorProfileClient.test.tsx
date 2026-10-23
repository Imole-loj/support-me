import { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreatorProfileClient from '@/app/[username]/CreatorProfileClient';
import { useAuth } from '@/context/AuthContext';
import { connectWallet, isWalletOnTestnet } from '@/lib/wallet';

// CreatorProfileClient unwraps the `params` prop with React's use(), which
// suspends on an unresolved promise — App Router provides a Suspense
// boundary in production, so tests need to provide one too. The initial
// render has to be wrapped in `act` (and awaited) for React to actually
// flush past the suspended commit once the (already-resolved) promise
// settles — otherwise React Testing Library never sees the real content.
async function renderProfile(username: string, initialLocale?: 'en' | 'es') {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Suspense fallback={null}>
        <CreatorProfileClient params={Promise.resolve({ username })} initialLocale={initialLocale} />
      </Suspense>
    );
  });
  return result;
}

vi.mock('@/context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

// The installed @hugeicons/core-free-icons (4.3.5) has no `TwitterLogoIcon`
// export, so the component would render `icon={undefined}` and every test in
// this file threw "currentIcon is not iterable". Stub just that export here.
vi.mock('@hugeicons/core-free-icons', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@hugeicons/core-free-icons');
  return { ...actual, TwitterLogoIcon: actual.TwitterLogoIcon ?? actual.LinkIcon };
});

vi.mock('@/lib/wallet', () => ({
  connectWallet: vi.fn(),
  disconnectWallet: vi.fn(),
  isWalletOnTestnet: vi.fn(),
}));

vi.mock('@/lib/notify', () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

// The `@hugeicons/core-free-icons` version currently pinned in package-lock.json
// doesn't export `TwitterLogoIcon` (it's `undefined`), which crashes
// `HugeiconsIcon` on every render that reaches the Share button — pre-existing
// and unrelated to this change (reproduces identically against the unmodified
// component on upstream/main). Stub the icon renderer so these tests can
// exercise the component's actual logic instead of that unrelated bug.
vi.mock('@hugeicons/react', () => ({
  HugeiconsIcon: () => null,
}));

const { mockLoadAccount } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn().mockResolvedValue({ balances: [] }),
}));

// lib/assets.js's ASSETS registry is gated on NEXT_PUBLIC_USDC_ISSUER /
// NEXT_PUBLIC_USDT_ISSUER at module-load time (see lib/__tests__/assets.test.ts
// for that logic in isolation). Here we only care about how
// CreatorProfileClient consumes availableAssetCodes()/getAsset() against
// creator.acceptsXlm/Usdc/Usdt, so stub a deployment where all three are
// configured and let the component's own gating do the filtering.
vi.mock('@/lib/assets', () => ({
  availableAssetCodes: () => ['XLM', 'USDC', 'USDT'],
  getAsset: (code: string) => ({
    code,
    label: code,
    balanceMatcher:
      code === 'XLM'
        ? (b: { asset_type?: string }) => b.asset_type === 'native'
        : (b: { asset_code?: string }) => b.asset_code === code,
  }),
}));

// Avoids a real Horizon network call from loadAssetBalance() whenever a
// wallet "connects" in these tests.
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: class {
        loadAccount(...args: unknown[]) {
          return mockLoadAccount(...args);
        }
      },
    },
  };
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners: Record<string, Array<(event: MessageEvent) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (event: MessageEvent) => void) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(cb);
  }

  removeEventListener() {}

  close() {
    this.closed = true;
  }
}

// Some Node versions ship a native `localStorage` global that jsdom's own
// implementation doesn't fully take over in this test environment (its
// getItem/setItem/clear come back `undefined`), so the language-switcher
// tests below stub in a minimal in-memory Storage instead of relying on
// `window.localStorage` directly. lib/i18n.ts itself already guards every
// real-world localStorage call in a try/catch for the same reason.
class FakeLocalStorage {
  private store = new Map<string, string>();

  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

const mockUseAuth = vi.mocked(useAuth);
const mockConnectWallet = vi.mocked(connectWallet);
const mockIsWalletOnTestnet = vi.mocked(isWalletOnTestnet);

const baseCreator = {
  id: 1,
  username: 'alice',
  displayName: 'Alice',
  walletAddress: 'GALICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  bio: null,
  avatarUrl: null,
  socialLinks: null,
  acceptsXlm: true,
  acceptsUsdc: true,
  acceptsUsdt: false,
  donationGoal: null,
};

const goal = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  title: 'New microphone',
  targetAmount: 500,
  currentAmount: 120,
  currency: 'XLM',
  status: 'ACTIVE',
  recurring: false,
  ...overrides,
});

function mockFetchSequence(handlers: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      for (const [pattern, body] of Object.entries(handlers)) {
        if (url.includes(pattern)) {
          return {
            ok: true,
            json: async () => body,
          } as Response;
        }
      }
      return { ok: false, json: async () => ({}) } as Response;
    })
  );
}

describe('CreatorProfileClient', () => {
  beforeEach(() => {
    mockLoadAccount.mockResolvedValue({ balances: [] });
    // Unknown network by default: the wallet doesn't report one, so nothing
    // is blocked (tests override this to simulate a Mainnet wallet).
    mockIsWalletOnTestnet.mockResolvedValue(null);
    mockUseAuth.mockReturnValue({
      user: null,
      token: null,
      loading: false,
      loginWithWallet: vi.fn(),
      getTwitterRedirectUrl: vi.fn(),
      completeTwitterLogin: vi.fn(),
      requestMagicLink: vi.fn(),
      verifyMagicLink: vi.fn(),
      logout: vi.fn(),
    });
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('explains why tips are unavailable before asking the supporter to connect', async () => {
    mockFetchSequence({
      '/api/creators/alice': { ...baseCreator, walletAddress: null },
      '/api/goals/alice': { items: [] },
    });
    await renderProfile('alice');
    await waitFor(() => expect(screen.getByText(/not accepting tips yet/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Connect Wallet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send Donation' })).not.toBeInTheDocument();
  });

  it('renders a progress bar for every active goal, using server-computed totals', async () => {
    mockFetchSequence({
      '/api/creators/alice': baseCreator,
      '/api/goals/alice': {
        items: [
          goal({ id: 1, title: 'New microphone', targetAmount: 500, currentAmount: 120, currency: 'XLM' }),
          goal({ id: 2, title: 'Monthly support', targetAmount: 2000, currentAmount: 0, currency: 'XLM', recurring: true }),
        ],
      },
    });

    await renderProfile('alice');

    await waitFor(() => expect(screen.getByText('New microphone')).toBeInTheDocument());
    expect(screen.getByText('120 / 500 XLM (24%)')).toBeInTheDocument();

    expect(screen.getByText('Monthly support')).toBeInTheDocument();
    expect(screen.getByText('0 / 2000 XLM (0%)')).toBeInTheDocument();
    expect(screen.getByText('Recurring')).toBeInTheDocument();

    // Two independent progressbars, not one summed/blended total.
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });

  it('shows the goal description and progress percentage', async () => {
    mockFetchSequence({
      '/api/creators/alice': baseCreator,
      '/api/goals/alice': {
        items: [goal({ title: 'Buy a new laptop', description: 'For editing videos', targetAmount: 500, currentAmount: 360 })],
      },
    });

    await renderProfile('alice');

    await waitFor(() => expect(screen.getByText('Buy a new laptop')).toBeInTheDocument());
    expect(screen.getByText('For editing videos')).toBeInTheDocument();
    expect(screen.getByText('360 / 500 XLM (72%)')).toBeInTheDocument();
  });

  it('renders no goal section when the creator has no active goals', async () => {
    mockFetchSequence({
      '/api/creators/alice': baseCreator,
      '/api/goals/alice': { items: [] },
    });

    await renderProfile('alice');

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('applies the creator custom theme as CSS variables and layout classes', async () => {
    mockFetchSequence({
      '/api/creators/alice': {
        ...baseCreator,
        theme: { backgroundColor: '#101820', accentColor: '#b42318', font: 'serif', layout: 'compact' },
      },
      '/api/goals/alice': { items: [] },
    });

    await renderProfile('alice');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument());
    const page = screen.getByRole('heading', { name: 'Alice' }).closest<HTMLElement>('.min-h-screen')!;
    expect(page.style.getPropertyValue('--background')).toBe('#101820');
    expect(page.style.getPropertyValue('--primary')).toBe('#b42318');
    // A dark background pins the dark palette so text stays readable.
    expect(page.style.getPropertyValue('--ink')).toBe('#f4f2ec');
    expect(page.style.fontFamily).toMatch(/serif$/);
    expect(page).toHaveClass('py-4');
  });

  it('keeps the default design untouched when the creator has no theme', async () => {
    mockFetchSequence({
      '/api/creators/alice': baseCreator,
      '/api/goals/alice': { items: [] },
    });

    await renderProfile('alice');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument());
    const page = screen.getByRole('heading', { name: 'Alice' }).closest<HTMLElement>('.min-h-screen')!;
    expect(page).not.toHaveAttribute('style');
    expect(page).toHaveClass('py-10');
  });

  it('offers USDT in the asset selector once the wallet is connected, when the creator accepts it', async () => {
    mockFetchSequence({
      '/api/creators/alice': { ...baseCreator, acceptsUsdt: true },
      '/api/goals/alice': { items: [] },
    });
    mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

    await renderProfile('alice');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'USDT' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'XLM' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'USDC' })).toBeInTheDocument();
  });

  it('does not offer USDT when the creator has not opted in, even if configured on this deployment', async () => {
    mockFetchSequence({
      '/api/creators/alice': { ...baseCreator, acceptsUsdt: false },
      '/api/goals/alice': { items: [] },
    });
    mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

    await renderProfile('alice');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'XLM' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'USDT' })).not.toBeInTheDocument();
  });

  // Issue #155: Donate page shows XLM balance value under USDC label after switching asset
  it('updates displayed balance to actual balance of newly selected asset when switching asset toggle (#155)', async () => {
    mockFetchSequence({
      '/api/creators/alice': baseCreator,
      '/api/goals/alice': { items: [] },
    });
    mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '100.5000' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '25.0000' },
      ],
    });

    await renderProfile('alice');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    // Initially displays the connected wallet's XLM balance
    await waitFor(() => expect(screen.getByText('100.5000 XLM')).toBeInTheDocument());

    // Switch to USDC
    await userEvent.click(screen.getByRole('button', { name: 'USDC' }));

    // Displayed balance updates to the actual USDC balance, not the previous XLM balance relabeled
    await waitFor(() => expect(screen.getByText('25.0000 USDC')).toBeInTheDocument());
    expect(screen.queryByText('100.5000 USDC')).not.toBeInTheDocument();

    // Switch back to XLM
    await userEvent.click(screen.getByRole('button', { name: 'XLM' }));

    // Displayed balance updates back to XLM balance
    await waitFor(() => expect(screen.getByText('100.5000 XLM')).toBeInTheDocument());
    expect(screen.queryByText('25.0000 XLM')).not.toBeInTheDocument();
  });

  it('displays zero balance when switching to an asset without a balance or trustline instead of showing XLM balance (#155)', async () => {
    mockFetchSequence({
      '/api/creators/alice': baseCreator,
      '/api/goals/alice': { items: [] },
    });
    mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '9970.9243' },
      ],
    });

    await renderProfile('alice');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    await waitFor(() => expect(screen.getByText('9970.9243 XLM')).toBeInTheDocument());

    // Switch to USDC when wallet has no USDC balance
    await userEvent.click(screen.getByRole('button', { name: 'USDC' }));

    // Displays 0.0000 USDC instead of the XLM balance value
    await waitFor(() => expect(screen.getByText('0.0000 USDC')).toBeInTheDocument());
    expect(screen.queryByText('9970.9243 USDC')).not.toBeInTheDocument();
  });

  // Issue #120: quick-select preset amount buttons on the donate page.
  it('falls back to default preset amounts when the creator has not configured any', async () => {
    mockFetchSequence({
      '/api/creators/alice': { ...baseCreator, presetAmounts: [] },
      '/api/goals/alice': { items: [] },
    });
    mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

    await renderProfile('alice');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    for (const preset of ['1', '5', '10', '20']) {
      expect(screen.getByRole('button', { name: preset })).toBeInTheDocument();
    }
  });

  it("shows the creator's custom preset amounts instead of the defaults", async () => {
    mockFetchSequence({
      '/api/creators/alice': { ...baseCreator, presetAmounts: [2, 15, 50] },
      '/api/goals/alice': { items: [] },
    });
    mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

    await renderProfile('alice');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    for (const preset of ['2', '15', '50']) {
      expect(screen.getByRole('button', { name: preset })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: '20' })).not.toBeInTheDocument();
  });

  it('clicking a preset amount populates the donation amount input', async () => {
    mockFetchSequence({
      '/api/creators/alice': { ...baseCreator, presetAmounts: [2, 15, 50] },
      '/api/goals/alice': { items: [] },
    });
    mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

    await renderProfile('alice');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    await userEvent.click(screen.getByRole('button', { name: '15' }));

    expect(screen.getByLabelText(/amount/i)).toHaveValue(15);
  });

  describe('donation amount guardrails (#45)', () => {
    it('surfaces the configured minimum donation amount to the user', async () => {
      mockFetchSequence({
        '/api/creators/alice': baseCreator,
        '/api/goals/alice': { items: [] },
      });
      mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

      await renderProfile('alice');
      await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

      expect(screen.getByTestId('min-donation-label')).toHaveTextContent(/minimum donation: 0.1 XLM/i);
    });

    it('rejects donation submission and shows validation error when below minimum', async () => {
      mockFetchSequence({
        '/api/creators/alice': baseCreator,
        '/api/goals/alice': { items: [] },
      });
      mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

      await renderProfile('alice');
      await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

      const amountInput = screen.getByLabelText(/amount/i);
      await userEvent.clear(amountInput);
      await userEvent.type(amountInput, '0.05');

      expect(screen.getByRole('alert')).toHaveTextContent(/minimum 0.1/i);
      expect(screen.getByRole('button', { name: /send donation/i })).toBeDisabled();
    });

    it('prompts with explicit confirmation when donation exceeds large donation threshold', async () => {
      mockFetchSequence({
        '/api/creators/alice': baseCreator,
        '/api/goals/alice': { items: [] },
      });
      mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

      await renderProfile('alice');
      await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

      const amountInput = screen.getByLabelText(/amount/i);
      await userEvent.clear(amountInput);
      await userEvent.type(amountInput, '2500');

      // Large donation warning is surfaced
      expect(screen.getByTestId('large-donation-warning')).toBeInTheDocument();
      const sendBtn = screen.getByRole('button', { name: /send donation/i });
      expect(sendBtn).toBeDisabled();

      // Check explicit confirmation
      const confirmCheckbox = screen.getByTestId('large-donation-checkbox');
      await userEvent.click(confirmCheckbox);

      expect(sendBtn).not.toBeDisabled();
    });
  });

  describe('language switcher', () => {
    let fakeLocalStorage: FakeLocalStorage;

    beforeEach(() => {
      fakeLocalStorage = new FakeLocalStorage();
      vi.stubGlobal('localStorage', fakeLocalStorage);
    });

    it('renders donate/profile strings in English by default', async () => {
      mockFetchSequence({
        '/api/creators/alice': baseCreator,
        '/api/goals/alice': { items: [] },
      });

      await renderProfile('alice');

      await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
      expect(screen.getByText(/support alice/i)).toBeInTheDocument();
    });

    it('switches the donate/profile strings to Spanish when a different language is picked', async () => {
      mockFetchSequence({
        '/api/creators/alice': baseCreator,
        '/api/goals/alice': { items: [] },
      });

      await renderProfile('alice');
      await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

      const select = screen.getByRole('combobox', { name: /language/i });
      await userEvent.selectOptions(select, 'es');

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /conectar billetera/i })).toBeInTheDocument()
      );
      expect(screen.getByText(/apoya a alice/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /connect wallet/i })).not.toBeInTheDocument();

      // The choice is persisted so it survives a remount (e.g. navigating away and back).
      expect(fakeLocalStorage.getItem('supportme-locale')).toBe('es');
    });

    it('restores a previously-picked language on the next render', async () => {
      fakeLocalStorage.setItem('supportme-locale', 'es');
      mockFetchSequence({
        '/api/creators/alice': baseCreator,
        '/api/goals/alice': { items: [] },
      });

      await renderProfile('alice');

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /conectar billetera/i })).toBeInTheDocument()
      );
    });

    describe('lang attribute', () => {
      afterEach(() => {
        document.documentElement.lang = 'en';
      });

      it('follows the selected locale on <html> and the translated region', async () => {
        mockFetchSequence({
          '/api/creators/alice': baseCreator,
          '/api/goals/alice': { items: [] },
        });

        const { container } = await renderProfile('alice');
        await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
        expect(document.documentElement.lang).toBe('en');
        expect(container.querySelector('[lang]')).toHaveAttribute('lang', 'en');

        await userEvent.selectOptions(screen.getByRole('combobox', { name: /language/i }), 'es');

        await waitFor(() => expect(document.documentElement.lang).toBe('es'));
        expect(container.querySelector('[lang]')).toHaveAttribute('lang', 'es');

        await userEvent.selectOptions(screen.getByRole('combobox', { name: /idioma/i }), 'en');
        await waitFor(() => expect(document.documentElement.lang).toBe('en'));
      });

      it('restores the default lang when leaving the page', async () => {
        fakeLocalStorage.setItem('supportme-locale', 'es');
        mockFetchSequence({
          '/api/creators/alice': baseCreator,
          '/api/goals/alice': { items: [] },
        });

        const { unmount } = await renderProfile('alice');
        await waitFor(() => expect(document.documentElement.lang).toBe('es'));

        unmount();
        expect(document.documentElement.lang).toBe('en');
      });

      it('renders the server-provided cookie locale on the first render', async () => {
        fakeLocalStorage.setItem('supportme-locale', 'es');
        mockFetchSequence({
          '/api/creators/alice': baseCreator,
          '/api/goals/alice': { items: [] },
        });

        const { container } = await renderProfile('alice', 'es');

        expect(container.querySelector('[lang]')).toHaveAttribute('lang', 'es');
        await waitFor(() =>
          expect(screen.getByRole('button', { name: /conectar billetera/i })).toBeInTheDocument()
        );
      });

      it('tells readers which surfaces are translated', async () => {
        mockFetchSequence({
          '/api/creators/alice': baseCreator,
          '/api/goals/alice': { items: [] },
        });

        await renderProfile('alice');
        await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

        expect(screen.getByRole('combobox', { name: /language/i })).toHaveAccessibleDescription(
          /this profile and the donation form only/i
        );
      });
    });
  });

  describe('profile load errors', () => {
    function mockFetchResponses(
      responder: (url: string, init?: RequestInit) => Promise<Response> | Response
    ) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => responder(url, init))
      );
    }

    const response = (status: number, body: unknown = {}) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

    it('shows the not-found screen only for a 404', async () => {
      mockFetchResponses((url) =>
        url.includes('/api/creators/') ? response(404) : response(200, { items: [] })
      );

      await renderProfile('alice');

      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /creator not found/i })).toBeInTheDocument()
      );
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    });

    it('shows a retryable error instead of not-found for a 500', async () => {
      let creatorCalls = 0;
      mockFetchResponses((url) => {
        if (url.includes('/api/creators/alice')) {
          creatorCalls += 1;
          return creatorCalls === 1
            ? response(500)
            : response(200, baseCreator);
        }
        return response(200, { items: [] });
      });

      await renderProfile('alice');

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i)
      );
      expect(screen.queryByRole('heading', { name: /creator not found/i })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /try again/i }));

      await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
      expect(creatorCalls).toBe(2);
    });

    it('shows a retryable error, not not-found, when the request fails on the network', async () => {
      let creatorCalls = 0;
      mockFetchResponses((url) => {
        if (url.includes('/api/creators/alice')) {
          creatorCalls += 1;
          if (creatorCalls === 1) throw new TypeError('Failed to fetch');
        }
        if (url.includes('/api/goals/alice')) return response(200, { items: [goal()] });
        return response(200, baseCreator);
      });

      await renderProfile('alice');

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i)
      );
      expect(screen.queryByRole('heading', { name: /creator not found/i })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /try again/i }));

      await waitFor(() => expect(screen.getByText('New microphone')).toBeInTheDocument());
      expect(creatorCalls).toBe(2);
    });

    it('encodes the username in the creator request URL', async () => {
      mockFetchResponses((url) => {
        if (url.includes('/api/creators/')) return response(200, baseCreator);
        return response(200, { items: [] });
      });

      await renderProfile('weird/name');

      await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
      const creatorCall = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).includes('/api/creators/'));
      expect(String(creatorCall?.[0])).toContain('/api/creators/weird%2Fname');
    });
  });

  describe('live updates (SSE) lifecycle', () => {
    const goalsCalls = () =>
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/goals/alice')).length;

    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    afterEach(() => {
      setHidden(false);
    });

    beforeEach(() => {
      mockFetchSequence({
        '/api/creators/alice': baseCreator,
        '/api/goals/alice': { items: [goal()] },
      });
    });

    it('shows a paused indicator when the stream errors and backfills goals once it reconnects', async () => {
      await renderProfile('alice');
      await waitFor(() => expect(screen.getByText('New microphone')).toBeInTheDocument());
      const source = FakeEventSource.instances[0];
      act(() => source.onopen?.());
      expect(screen.queryByText(/live updates paused/i)).not.toBeInTheDocument();
      const before = goalsCalls();

      act(() => source.onerror?.());
      expect(screen.getByRole('status')).toHaveTextContent(/live updates paused/i);
      // Nothing is refetched while the connection is still down.
      expect(goalsCalls()).toBe(before);

      act(() => source.onopen?.());
      expect(screen.queryByText(/live updates paused/i)).not.toBeInTheDocument();
      await waitFor(() => expect(goalsCalls()).toBe(before + 1));
    });

    it('does not refetch on the first successful connection', async () => {
      await renderProfile('alice');
      await waitFor(() => expect(screen.getByText('New microphone')).toBeInTheDocument());
      const before = goalsCalls();

      act(() => FakeEventSource.instances[0].onopen?.());

      expect(goalsCalls()).toBe(before);
    });

    it('closes the stream while the tab is hidden and reopens it with a backfill when visible again', async () => {
      await renderProfile('alice');
      await waitFor(() => expect(screen.getByText('New microphone')).toBeInTheDocument());
      const first = FakeEventSource.instances[0];
      const before = goalsCalls();

      act(() => setHidden(true));
      expect(first.closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(1);

      act(() => setHidden(false));
      expect(FakeEventSource.instances).toHaveLength(2);

      act(() => FakeEventSource.instances[1].onopen?.());
      await waitFor(() => expect(goalsCalls()).toBe(before + 1));

    });
  });
});
