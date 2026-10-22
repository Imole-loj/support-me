'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { notify } from '@/lib/notify';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ViewIcon,
  ViewOffSlashIcon,
  Share08Icon,
  Copy01Icon,
} from '@hugeicons/core-free-icons';
import { useAuth } from '@/context/AuthContext';
import { useCreator } from '@/context/CreatorContext';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AppNav } from '@/components/AppNav';
import { Skeleton } from '@/components/Skeleton';
import { usePrices } from '@/lib/usePrices';
import { formatUsd } from '@/lib/prices';
import { availableAssetCodes, getAsset } from '@/lib/assets';
import { ShareModal } from '@/components/ShareModal';
import { fundWithFriendbot } from '@/lib/contract';
import { horizonServer } from '@/lib/stellarNetwork';


export const BALANCE_HIDDEN_STORAGE_KEY = 'balance_hidden';

// The balance we hold per asset code, as a Horizon-precision string. `null`
// means "not loaded / no trustline" and renders as a dash.
type Balances = Record<string, string | null>;

export default function AppHubPage() {
  const { user } = useAuth();
  const { creator, loading } = useCreator();
  const prices = usePrices();

  const [balances, setBalances] = useState<Balances>({});
  const [balancesLoading, setBalancesLoading] = useState(true);
  const [hidden, setHidden] = useState(true);
  const [showUsd, setShowUsd] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [isUnfunded, setIsUnfunded] = useState(false);
  const [funding, setFunding] = useState(false);

  // Load balance masking preference from localStorage (defaults to hidden = true)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(BALANCE_HIDDEN_STORAGE_KEY);
      if (saved !== null) {
        setHidden(saved === 'true');
      }
    } catch {
      // Ignore localStorage errors (e.g. private browsing, disabled cookies)
    }
  }, []);

  const toggleHidden = () => {
    setHidden((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(BALANCE_HIDDEN_STORAGE_KEY, String(next));
      } catch {
        // Ignore localStorage errors
      }
      return next;
    });
  };


  // Stable across renders so the balance-loading effect below doesn't re-run in
  // a loop (availableAssetCodes returns a fresh array each call).
  const assetCodes = useMemo(() => availableAssetCodes(), []);
  const walletAddress = user?.walletAddress || '';

  // Read on-chain balances for every supported asset in one account load, so
  // the aggregate figure reflects what's actually in the wallet.
  const loadBalances = useCallback(async () => {
    if (!walletAddress) {
      setBalancesLoading(false);
      return;
    }
    setBalancesLoading(true);
    try {
      const account = await horizonServer.loadAccount(walletAddress);
      setIsUnfunded(false);
      const next: Balances = {};
      for (const code of assetCodes) {
        const match = account.balances.find(getAsset(code).balanceMatcher);
        next[code] = match ? String(Math.round(parseFloat((match as { balance?: string }).balance || '0'))) : null;
      }
      setBalances(next);
    } catch (err) {
      // Detect 404 / not found errors which indicate an unfunded account
      const message = (err as Error)?.message || '';
      if (/not found|404|account does not exist/i.test(message)) {
        setIsUnfunded(true);
      }
      // No account yet (unfunded) or network hiccup: leave balances empty so
      // the UI shows dashes rather than a misleading zero.
      setBalances({});
    } finally {
      setBalancesLoading(false);
    }
  }, [walletAddress, assetCodes]);

  useEffect(() => {
    loadBalances();
  }, [loadBalances]);

  const profileUrl =
    creator && typeof window !== 'undefined'
      ? `${window.location.origin}/${creator.username}`
      : '';

  // Total portfolio value in USD across every asset we have a price for. Null
  // when we can't price anything, so we can fall back to the per-asset list.
  const totalUsd = (() => {
    if (!prices) return null;
    let sum = 0;
    let priced = false;
    for (const code of assetCodes) {
      const bal = balances[code];
      const price = prices[code];
      if (bal != null && price != null) {
        sum += parseFloat(bal) * price;
        priced = true;
      }
    }
    return priced ? sum : null;
  })();

  const copyProfile = async () => {
    if (!profileUrl) return;
    try {
      await navigator.clipboard.writeText(profileUrl);
      setCopied(true);
      notify.success('Profile link copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify.error('Could not copy link');
    }
  };

  // Open the share choice modal (Copy link, QR code, both, or native share)
  const shareProfile = () => {
    setShowShareModal(true);
  };

  const handleFundWithFriendbot = async () => {
    if (!walletAddress) return;
    setFunding(true);
    try {
      await fundWithFriendbot(walletAddress);
      notify.success('Wallet funded successfully!');
      await loadBalances();
    } catch (err) {
      notify.error('Failed to fund wallet', (err as Error).message);
    } finally {
      setFunding(false);
    }
  };

  const greetingName = creator?.displayName || creator?.username || 'there';

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-background">
        <AppNav />
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          {loading ? (
            <Skeleton className="h-9 w-56 mb-8" />
          ) : (
            <h1 className="text-3xl sm:text-4xl font-extrabold text-ink mb-8 tracking-tight">
              Hey, {greetingName} 👋
            </h1>
          )}

          {/* Balance card */}
          <div className="card-brutal bg-brand-cyan p-6 sm:p-8 mb-8">
            <div className="flex items-center justify-between mb-4">
              <p className="text-ink text-sm font-bold uppercase tracking-wide">Balance</p>
              <div className="flex items-center gap-2">
                {totalUsd != null && (
                  <button
                    onClick={() => setShowUsd((v) => !v)}
                    className="btn-brutal btn-brutal-white text-xs px-3 py-1.5"
                    aria-pressed={showUsd}
                  >
                    {showUsd ? 'USD' : 'Crypto'}
                  </button>
                )}
                <button
                  onClick={toggleHidden}
                  aria-label={hidden ? 'Show balance' : 'Hide balance'}
                  className="btn-brutal btn-brutal-white text-xs px-3 py-1.5 gap-1.5"
                >
                  <HugeiconsIcon
                    icon={hidden ? ViewIcon : ViewOffSlashIcon}
                    size={16}
                    strokeWidth={2}
                  />
                  {hidden ? 'Show' : 'Hide'}
                </button>
              </div>
            </div>

            {hidden ? (
              <p className="text-4xl sm:text-5xl font-extrabold text-ink tabular-nums">••••••</p>
            ) : balancesLoading ? (
              <Skeleton className="h-12 w-48" />
            ) : showUsd && totalUsd != null ? (
              <p className="text-4xl sm:text-5xl font-extrabold text-ink tabular-nums">
                ${totalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            ) : (
              <div className="space-y-1">
                {assetCodes.map((code) => {
                  const bal = balances[code];
                  const usd = bal != null ? formatUsd(parseFloat(bal), code, prices) : null;
                  return (
                    <div key={code} className="flex items-baseline gap-3">
                      <span className="text-2xl sm:text-3xl font-extrabold text-ink tabular-nums">
                        {isUnfunded ? 'Not funded' : (bal != null ? Number(bal).toLocaleString() : '—')}
                      </span>
                      <span className="text-base font-bold text-ink/70">{code}</span>
                      {usd && <span className="text-sm font-bold text-ink/60">{usd}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {isUnfunded && !hidden && (
              <button
                onClick={handleFundWithFriendbot}
                disabled={funding}
                className="btn-brutal btn-brutal-primary w-full mt-3 text-xs py-1.5"
              >
                {funding ? 'Funding...' : 'Fund with Friendbot'}
              </button>
            )}
          </div>

          {/* Profile link + share */}
          {loading ? (
            <div className="card-brutal p-6 mb-8">
              <Skeleton className="h-4 w-24 mb-2" />
              <Skeleton className="h-5 w-64" />
            </div>
          ) : creator ? (
            <div className="card-brutal p-6 mb-8">
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-ink mb-1">Your profile</p>
                  <Link
                    href={`/${creator.username}`}
                    className="font-mono text-sm text-primary hover:underline break-all"
                  >
                    {profileUrl || `/${creator.username}`}
                  </Link>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={copyProfile}
                    className="btn-brutal btn-brutal-white gap-1.5 text-xs px-3 py-1.5 sm:text-sm sm:px-6 sm:py-3"
                    aria-label="Copy profile link"
                  >
                    <HugeiconsIcon icon={Copy01Icon} size={18} strokeWidth={2} />
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    onClick={shareProfile}
                    className="btn-brutal btn-brutal-primary gap-1.5 text-xs px-3 py-1.5 sm:text-sm sm:px-6 sm:py-3"
                    aria-label="Share profile"
                  >
                    <HugeiconsIcon icon={Share08Icon} size={18} strokeWidth={2} />
                    Share
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Cash out */}
          <div className="card-brutal p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-extrabold text-ink">Cash out</h2>
              <span className="text-xs px-2 py-0.5 rounded-md bg-brand-lime border border-ink/30 font-bold text-ink">
                Demo
              </span>
            </div>
            <p className="text-sm text-muted mb-4 font-medium">
              Simulate converting your USDC to Naira and sending it straight to your bank account.
            </p>
            <Link
              href="/app/withdraw"
              className="btn-brutal btn-brutal-primary w-full"
            >
              Withdraw (Demo)
            </Link>
          </div>
        </div>
      </div>

      {showShareModal && creator && (
        <ShareModal creator={creator} onClose={() => setShowShareModal(false)} />
      )}
    </ProtectedRoute>
  );
}
