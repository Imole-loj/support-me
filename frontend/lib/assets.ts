import * as StellarSdk from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE } from './stellarNetwork';

// USDC/USDT are only available when their issuer is configured via env. On
// testnet these are typically the SDF-issued test USDC
// (GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA) and a similarly
// issued test USDT.
const USDC_ISSUER = process.env.NEXT_PUBLIC_USDC_ISSUER;
const USDT_ISSUER = process.env.NEXT_PUBLIC_USDT_ISSUER;

export type AssetCode = 'XLM' | 'USDC' | 'USDT';

/** A Horizon account balance line, for any asset type (native, credit, or liquidity pool). */
export type BalanceLine = StellarSdk.Horizon.HorizonApi.BalanceLine;

export interface AssetEntry {
  code: AssetCode;
  label: string;
  /** Present for credit assets (USDC/USDT); absent for XLM, which has no issuer. */
  issuer?: string;
  asset: () => StellarSdk.Asset;
  balanceMatcher: (balance: BalanceLine) => boolean;
}

/**
 * Supported donation assets. Each entry knows how to resolve its own Stellar
 * Asset Contract (SAC) id — the address the `donate` contract's generic
 * `token` parameter expects. XLM is always available; USDC/USDT only appear
 * when their issuer is configured, so the UI can hide them cleanly on
 * deployments that haven't set them up yet.
 */
export const ASSETS: Partial<Record<AssetCode, AssetEntry>> = {
  XLM: {
    code: 'XLM',
    label: 'XLM',
    asset: () => StellarSdk.Asset.native(),
    // Native asset type on Horizon balances is 'native', not 'credit_*'.
    balanceMatcher: (b) => b.asset_type === 'native',
  },
  ...(USDC_ISSUER
    ? {
        USDC: {
          code: 'USDC' as const,
          label: 'USDC',
          issuer: USDC_ISSUER,
          asset: () => new StellarSdk.Asset('USDC', USDC_ISSUER),
          balanceMatcher: (b: BalanceLine) =>
            'asset_code' in b && b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER,
        },
      }
    : {}),
  ...(USDT_ISSUER
    ? {
        USDT: {
          code: 'USDT' as const,
          label: 'USDT',
          issuer: USDT_ISSUER,
          asset: () => new StellarSdk.Asset('USDT', USDT_ISSUER),
          balanceMatcher: (b: BalanceLine) =>
            'asset_code' in b && b.asset_code === 'USDT' && b.asset_issuer === USDT_ISSUER,
        },
      }
    : {}),
};

/** Asset codes available to the donation UI, XLM first. */
export function availableAssetCodes(): AssetCode[] {
  return Object.keys(ASSETS) as AssetCode[];
}

/** Look up an asset entry by code, defaulting to XLM. */
export function getAsset(code: string): AssetEntry {
  return ASSETS[code as AssetCode] ?? (ASSETS.XLM as AssetEntry);
}

/**
 * Resolve the SAC contract id for an asset code. Throws a clear, user-facing
 * error if an asset was requested that isn't configured (e.g. USDC without an
 * issuer env), mirroring the guard style already used in `lib/contract.ts`.
 */
export function sacContractId(code: string): string {
  const entry = ASSETS[code as AssetCode];
  if (!entry) {
    throw new Error(`${code} is not configured for donations on this deployment.`);
  }
  return entry.asset().contractId(NETWORK_PASSPHRASE);
}
