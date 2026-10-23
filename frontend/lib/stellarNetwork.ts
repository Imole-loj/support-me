import * as StellarSdk from '@stellar/stellar-sdk';

const network = (process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'testnet').toLowerCase();
export const STELLAR_NETWORK = network === 'public' ? 'public' : 'testnet';
export const NETWORK_PASSPHRASE = STELLAR_NETWORK === 'public'
  ? StellarSdk.Networks.PUBLIC
  : StellarSdk.Networks.TESTNET;
export const HORIZON_URL = STELLAR_NETWORK === 'public'
  ? 'https://horizon.stellar.org'
  : 'https://horizon-testnet.stellar.org';
export const SOROBAN_RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || (
  STELLAR_NETWORK === 'public'
    ? 'https://soroban.stellar.org'
    : 'https://soroban-testnet.stellar.org'
);
export const horizonServer = new StellarSdk.Horizon.Server(HORIZON_URL);

const explorerBase = `https://stellar.expert/explorer/${STELLAR_NETWORK}`;
export const explorerTxUrl = (hash: string): string => `${explorerBase}/tx/${hash}`;
export const explorerAccountUrl = (address: string): string => `${explorerBase}/account/${address}`;
