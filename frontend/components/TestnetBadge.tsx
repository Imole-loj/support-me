'use client';

import { STELLAR_NETWORK } from '@/lib/stellarNetwork';

interface TestnetBadgeProps {
  className?: string;
}

/**
 * Shows a "Testnet" badge when the app is configured for Testnet.
 * This helps users distinguish between testnet and mainnet environments.
 */
export function TestnetBadge({ className = '' }: TestnetBadgeProps) {
  if (STELLAR_NETWORK !== 'testnet') {
    return null;
  }

  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-md bg-brand-lime border border-ink/30 font-bold text-ink ${className}`}
      title="This app runs on Stellar Testnet — no real funds are used."
    >
      Testnet
    </span>
  );
}
