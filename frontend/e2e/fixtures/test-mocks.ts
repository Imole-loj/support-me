import { Page, Route } from '@playwright/test';
import { HORIZON_URL } from '../../lib/stellarNetwork';

export const MOCK_USER_ADDRESS = 'GDHJOKPWGK7WE6P63I5R6ILPFOF3HML3LKFV4SVXXL7DLDA5KD6J4XAS';
export const MOCK_CREATOR_ADDRESS = 'GC235RXOHGDYVO5P3UAGXATQ2W22XKH2LA64IZXQD6HDBKZWHZ3OAFVQ';

export interface MockCreator {
  id: number;
  userId?: number;
  username: string;
  displayName: string;
  walletAddress: string;
  bio: string;
  avatarUrl: string | null;
  socialLinks: Record<string, string>;
  acceptsXlm: boolean;
  acceptsUsdc: boolean;
  donationGoal: number | null;
  donations: Array<Record<string, unknown>>;
}

export const DEFAULT_MOCK_CREATOR: MockCreator = {
  id: 1,
  userId: 1,
  username: 'alice',
  displayName: 'Alice Creator',
  walletAddress: MOCK_CREATOR_ADDRESS,
  bio: 'Building open source decentralized tools on Stellar',
  avatarUrl: null,
  socialLinks: {
    twitter: 'https://twitter.com/alice',
    github: 'https://github.com/alice',
  },
  acceptsXlm: true,
  acceptsUsdc: true,
  donationGoal: 100,
  donations: [],
};

export const DEFAULT_MOCK_DONATIONS = [
  {
    id: 1,
    senderAddress: 'GBOB1234567890ABCDEF1234567890ABCDEF12345678',
    amount: 50,
    currency: 'XLM',
    message: 'Awesome work Alice! Keep it up!',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    transactionHash: 'tx_donation_past_hash_1',
  },
];

export interface MockGoal {
  id: number;
  creatorId: number;
  title: string;
  currency: string;
  targetAmount: number;
  currentAmount: number;
  status: string;
  recurring: boolean;
}

export const DEFAULT_MOCK_GOALS: MockGoal[] = [
  {
    id: 1,
    creatorId: 1,
    title: 'Community Fund',
    currency: 'XLM',
    targetAmount: 100,
    currentAmount: 50,
    status: 'ACTIVE',
    recurring: false,
  },
];

export interface SetupE2EOptions {
  userAddress?: string;
  creator?: MockCreator | null;
  goals?: MockGoal[];
  donations?: Array<Record<string, unknown>>;
  subscriptions?: Array<Record<string, unknown>>;
  hasProfile?: boolean;
  shouldFailDonation?: boolean;
  donationErrorMessage?: string;
  shouldFailSubscription?: boolean;
  subscriptionErrorMessage?: string;
  shouldFailCancel?: boolean;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
};

/**
 * Configure comprehensive mocks for browser-side wallet, contract calls,
 * and backend REST/Horizon APIs.
 */
export async function setupE2EMocks(page: Page, options: SetupE2EOptions = {}) {
  const userAddress = options.userAddress || MOCK_USER_ADDRESS;
  const creator = options.creator === undefined ? DEFAULT_MOCK_CREATOR : options.creator;
  const initialDonations = options.donations || DEFAULT_MOCK_DONATIONS;
  const initialSubscriptions = options.subscriptions || [];
  const initialGoals = options.goals || DEFAULT_MOCK_GOALS;

  // In-memory state for mutations during tests
  const recordedDonations = [...initialDonations];
  const activeSubscriptions = [...initialSubscriptions];
  const activeGoals = [...initialGoals];

  // 1. Inject mock wallet and contract handlers into window
  await page.addInitScript(
    ({
      userAddress,
      shouldFailDonation,
      donationErrorMessage,
      shouldFailSubscription,
      subscriptionErrorMessage,
      shouldFailCancel,
    }) => {
      // Mock window.__SUPPORTME_MOCK_WALLET__
      (window as unknown as { __SUPPORTME_MOCK_WALLET__: Record<string, unknown> }).__SUPPORTME_MOCK_WALLET__ = {
        connectWallet: async () => userAddress,
        disconnectWallet: async () => {
          sessionStorage.setItem('__E2E_LOGGED_OUT__', 'true');
        },
        signTransaction: async () => ({ signedTxXdr: 'mock_signed_tx_xdr' }),
        signMessage: async () => 'mock_signed_message_base64',
      };

      // Mock window.__SUPPORTME_MOCK_CONTRACT__
      (window as unknown as { __SUPPORTME_MOCK_CONTRACT__: Record<string, unknown> }).__SUPPORTME_MOCK_CONTRACT__ = {
        sendDonation: async ({ onStatus }: { onStatus?: (s: string) => void }) => {
          if (shouldFailDonation) {
            throw new Error(donationErrorMessage || 'Transaction rejected by user or network');
          }
          onStatus?.('building');
          onStatus?.('simulating');
          onStatus?.('awaiting-signature');
          onStatus?.('submitting');
          onStatus?.('pending');
          onStatus?.('success');
          return { hash: 'tx_donation_hash_1234567890abcdef' };
        },
        approveAllowance: async ({ onStatus }: { onStatus?: (s: string) => void }) => {
          if (shouldFailSubscription) {
            throw new Error(subscriptionErrorMessage || 'Allowance approval failed');
          }
          onStatus?.('building');
          onStatus?.('simulating');
          onStatus?.('submitting');
          return { hash: 'tx_allowance_hash_1234567890abcdef', periodsApproved: 12 };
        },
        subscribe: async ({ onStatus }: { onStatus?: (s: string) => void }) => {
          if (shouldFailSubscription) {
            throw new Error(subscriptionErrorMessage || 'Subscription contract call failed');
          }
          onStatus?.('building');
          onStatus?.('submitting');
          return { hash: 'tx_subscribe_hash_1234567890abcdef', subscriptionId: 99 };
        },
        cancelSubscription: async ({ onStatus }: { onStatus?: (s: string) => void }) => {
          if (shouldFailCancel) {
            throw new Error('Cancel transaction failed');
          }
          onStatus?.('building');
          onStatus?.('submitting');
          return { hash: 'tx_cancel_hash_1234567890abcdef' };
        },
      };
    },
    {
      userAddress,
      shouldFailDonation: options.shouldFailDonation ?? false,
      donationErrorMessage: options.donationErrorMessage,
      shouldFailSubscription: options.shouldFailSubscription ?? false,
      subscriptionErrorMessage: options.subscriptionErrorMessage,
      shouldFailCancel: options.shouldFailCancel ?? false,
    }
  );

  // 2. Intercept Horizon testnet requests for account balance
  await page.route(`${HORIZON_URL}/**`, async (route: Route) => {
    const url = route.request().url();
    if (url.includes('/accounts/')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify({
          id: userAddress,
          account_id: userAddress,
          sequence: '1000000',
          subentry_count: 0,
          inflation_destination: '',
          home_domain: '',
          last_modified_ledger: 1000,
          low_threshold: 0,
          med_threshold: 0,
          high_threshold: 0,
          flags: {
            auth_required: false,
            auth_revocable: false,
            auth_immutable: false,
            auth_clawback_enabled: false,
          },
          thresholds: {
            low_threshold: 0,
            med_threshold: 0,
            high_threshold: 0,
          },
          signers: [
            {
              weight: 1,
              key: userAddress,
              type: 'ed25519_public_key',
            },
          ],
          balances: [
            { asset_type: 'native', balance: '150.0000000' },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              balance: '50.0000000',
              asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_HEADERS, body: '{}' });
  });

  // 3. Intercept SSE event stream to prevent infinite connection
  await page.route('**/api/events', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: CORS_HEADERS,
      body: ': keepalive\n\n',
    });
  });

  // 4. Intercept backend auth APIs
  await page.route('**/api/auth/challenge', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: `Sign in to SupportMe\n\nAddress: ${userAddress}\nNonce: 12345`,
      }),
    });
  });

  await page.route('**/api/auth/verify', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    const hasProfile = options.hasProfile !== undefined ? options.hasProfile : true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS_HEADERS,
      body: JSON.stringify({
        user: { id: 1, walletAddress: userAddress },
        token: 'mock-jwt-token-abcdef123456',
        hasProfile,
        username: hasProfile && creator ? creator.username : undefined,
      }),
    });
  });

  // 5. Intercept creator endpoints
  await page.route('**/api/creators/me', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    if (creator) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify(creator),
      });
    } else {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Profile not found' }),
      });
    }
  });

  await page.route('**/api/creators/*', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    const url = route.request().url();
    const parts = url.split('/api/creators/')[1]?.split('?')[0]?.split('/');
    const username = parts?.[0];

    if (creator && username === creator.username) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify(creator),
      });
    } else {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Creator not found' }),
      });
    }
  });

  // 6. Intercept goals endpoints
  await page.route('**/api/goals/**', async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    const url = route.request().url();
    const parts = url.split('/api/goals/')[1]?.split('?')[0]?.split('/');
    const username = parts?.[0];

    if (creator && username === creator.username) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify(activeGoals),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify([]),
      });
    }
  });

  // 7. Intercept donations endpoints
  await page.route('**/api/donations*', async (route: Route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify({
          items: recordedDonations,
          pagination: {
            page: 1,
            limit: 20,
            totalItems: recordedDonations.length,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          },
        }),
      });
    } else if (method === 'POST') {
      const data = route.request().postDataJSON() || {};
      const newDonation = {
        id: recordedDonations.length + 1,
        senderAddress: data.senderAddress || userAddress,
        amount: data.amount || 5,
        currency: data.currency || 'XLM',
        message: data.message || '',
        createdAt: new Date().toISOString(),
        transactionHash: data.transactionHash || 'tx_mock_hash',
      };
      recordedDonations.unshift(newDonation);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify(newDonation),
      });
    } else {
      await route.continue();
    }
  });

  // 7. Intercept subscriptions endpoints
  await page.route('**/api/subscriptions*', async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    if (url.includes('/cancel') && method === 'POST') {
      const match = url.match(/\/api\/subscriptions\/(\d+)\/cancel/);
      const subId = match ? parseInt(match[1], 10) : null;
      const sub = activeSubscriptions.find((s) => s.id === subId);
      if (sub) {
        sub.active = false;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true }),
      });
      return;
    }

    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify(activeSubscriptions),
      });
    } else if (method === 'POST') {
      const data = route.request().postDataJSON() || {};
      const newSub = {
        id: activeSubscriptions.length + 1,
        creatorId: creator?.id || 1,
        creator: {
          username: data.creatorUsername || creator?.username || 'alice',
          displayName: creator?.displayName || 'Alice Creator',
          avatarUrl: creator?.avatarUrl || null,
        },
        supporterAddress: data.supporterAddress || userAddress,
        token: data.token || 'XLM',
        amount: data.amount || 5,
        intervalSecs: data.intervalSecs || 2592000,
        onChainId: data.onChainId || 99,
        nextChargeAt: new Date(Date.now() + (data.intervalSecs || 2592000) * 1000).toISOString(),
        active: true,
        lastChargeTxHash: data.subscribeTxHash || 'tx_subscribe_hash',
        lastChargedAt: null,
        lastError: null,
      };
      activeSubscriptions.push(newSub);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify(newSub),
      });
    } else {
      await route.continue();
    }
  });
}

/**
 * Pre-authenticates the page by setting authToken and authUser in localStorage
 * before navigation, unless marked logged out in this session.
 */
export async function setAuthenticatedSession(
  page: Page,
  user = { id: 1, walletAddress: MOCK_USER_ADDRESS },
  token = 'mock-jwt-token-abcdef123456'
) {
  await page.addInitScript(
    ({ user, token }) => {
      if (!sessionStorage.getItem('__E2E_LOGGED_OUT__')) {
        localStorage.setItem('authToken', token);
        localStorage.setItem('authUser', JSON.stringify(user));
      }
    },
    { user, token }
  );
}
