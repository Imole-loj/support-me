import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  signTransaction,
  getWalletNetwork,
  isWalletOnTestnet,
  WrongNetworkError,
} from '@/lib/wallet';

// lib/wallet statically imports the kit and every wallet module; stub them so
// this file exercises only the network-check logic and the
// window.__SUPPORTME_MOCK_WALLET__ hook, without loading real wallet SDKs.
// vitest.setup.ts globally mocks @/lib/wallet (to keep other suites off the
// real SDKs); override that mock here with the actual module, which is safe
// because the kit itself is stubbed below.
vi.mock('@/lib/wallet', async (importOriginal) =>
  importOriginal<typeof import('@/lib/wallet')>()
);
vi.mock('@creit.tech/stellar-wallets-kit', () => ({
  Networks: {
    TESTNET: 'Testnet SDF Network ; September 2022',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  },
  StellarWalletsKit: {
    init: vi.fn(),
    getNetwork: vi.fn(),
  },
}));
vi.mock('@creit.tech/stellar-wallets-kit/modules/freighter', () => ({ FreighterModule: class {} }));
vi.mock('@creit.tech/stellar-wallets-kit/modules/xbull', () => ({ xBullModule: class {} }));
vi.mock('@creit.tech/stellar-wallets-kit/modules/albedo', () => ({ AlbedoModule: class {} }));
vi.mock('@creit.tech/stellar-wallets-kit/modules/rabet', () => ({ RabetModule: class {} }));
vi.mock('@creit.tech/stellar-wallets-kit/modules/lobstr', () => ({ LobstrModule: class {} }));

const TESTNET_PASSPHRASE = 'Testnet SDF Network ; September 2022';
const PUBLIC_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

const setMockWallet = (wallet: Window['__SUPPORTME_MOCK_WALLET__']) => {
  window.__SUPPORTME_MOCK_WALLET__ = wallet;
};

describe('wallet network checks', () => {
  afterEach(() => {
    setMockWallet(undefined);
    vi.clearAllMocks();
  });

  it('reports Testnet when the wallet says Testnet', async () => {
    setMockWallet({
      getNetwork: async () => ({ network: 'TESTNET', networkPassphrase: TESTNET_PASSPHRASE }),
    });

    await expect(getWalletNetwork()).resolves.toEqual({
      network: 'TESTNET',
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    await expect(isWalletOnTestnet()).resolves.toBe(true);
  });

  it('reports a mismatch when the wallet is on Mainnet', async () => {
    setMockWallet({
      getNetwork: async () => ({ network: 'PUBLIC', networkPassphrase: PUBLIC_PASSPHRASE }),
    });

    await expect(isWalletOnTestnet()).resolves.toBe(false);
  });

  it('returns null (unknown) when the wallet exposes no network', async () => {
    setMockWallet({});

    await expect(getWalletNetwork()).resolves.toBeNull();
    await expect(isWalletOnTestnet()).resolves.toBeNull();
  });

  it('refuses to sign, without asking the wallet, when it is on Mainnet', async () => {
    const mockSign = vi.fn();
    setMockWallet({
      getNetwork: async () => ({ network: 'PUBLIC', networkPassphrase: PUBLIC_PASSPHRASE }),
      signTransaction: mockSign,
    });

    await expect(signTransaction('xdr', 'GADDR')).rejects.toThrow(WrongNetworkError);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('signs normally when the wallet is on Testnet', async () => {
    setMockWallet({
      getNetwork: async () => ({ network: 'TESTNET', networkPassphrase: TESTNET_PASSPHRASE }),
      signTransaction: async () => ({ signedTxXdr: 'signed' }),
    });

    await expect(signTransaction('xdr', 'GADDR')).resolves.toEqual({ signedTxXdr: 'signed' });
  });

  it('signs when the wallet does not expose its network (unknown is not a mismatch)', async () => {
    const mockSign = vi.fn().mockResolvedValue({ signedTxXdr: 'signed' });
    setMockWallet({ signTransaction: mockSign });

    await expect(signTransaction('xdr', 'GADDR')).resolves.toEqual({ signedTxXdr: 'signed' });
    expect(mockSign).toHaveBeenCalled();
  });
});
