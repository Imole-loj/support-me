import { afterEach, describe, expect, it, vi } from 'vitest';

const originalNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK;
const originalRpc = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;

afterEach(() => {
  vi.resetModules();
  if (originalNetwork === undefined) delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  else process.env.NEXT_PUBLIC_STELLAR_NETWORK = originalNetwork;
  if (originalRpc === undefined) delete process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;
  else process.env.NEXT_PUBLIC_SOROBAN_RPC_URL = originalRpc;
});

describe('stellar network config', () => {
  it('defaults Horizon, RPC, passphrase, and explorer links to Testnet', async () => {
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    delete process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;
    vi.resetModules();
    const config = await import('@/lib/stellarNetwork');
    expect(config.STELLAR_NETWORK).toBe('testnet');
    expect(config.HORIZON_URL).toBe('https://horizon-testnet.stellar.org');
    expect(config.SOROBAN_RPC_URL).toBe('https://soroban-testnet.stellar.org');
    expect(config.explorerTxUrl('abc')).toBe('https://stellar.expert/explorer/testnet/tx/abc');
    expect(config.explorerAccountUrl('GABC')).toBe('https://stellar.expert/explorer/testnet/account/GABC');
    expect(config.horizonServer).toBeDefined();
  });

  it('uses the selected public network and permits an RPC override', async () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'public';
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL = 'https://rpc.example';
    vi.resetModules();
    const config = await import('@/lib/stellarNetwork');
    expect(config.STELLAR_NETWORK).toBe('public');
    expect(config.HORIZON_URL).toBe('https://horizon.stellar.org');
    expect(config.SOROBAN_RPC_URL).toBe('https://rpc.example');
    expect(config.explorerTxUrl('abc')).toBe('https://stellar.expert/explorer/public/tx/abc');
  });
});
