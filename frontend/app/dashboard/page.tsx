'use client';

import { useState, useEffect, useRef, useLayoutEffect, useMemo } from 'react';
import Link from 'next/link';
import { notify } from '@/lib/notify';
import { donationsCsvFilename, donationsToCsv, downloadCsv } from '@/lib/csv';
import { HugeiconsIcon } from '@hugeicons/react';
import { PartyIcon } from '@hugeicons/core-free-icons';
import { useAuth } from '@/context/AuthContext';
import { useCreator } from '@/context/CreatorContext';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AppNav } from '@/components/AppNav';
import { DashboardSkeleton } from '@/components/DashboardSkeleton';
import { DonationHistorySkeleton } from '@/components/DonationHistorySkeleton';
import { TipChart } from '@/components/TipChart';
import { ShareCard } from '@/components/ShareCard';
import { ShareModal } from '@/components/ShareModal';
import { QrCodeCard } from '@/components/QrCodeCard';
import { DashboardStats, type CreatorStats } from '@/components/DashboardStats';
import { usePrices } from '@/lib/usePrices';
import { formatUsd } from '@/lib/prices';
import { API_URL } from '@/lib/api';
import { explorerTxUrl } from '@/lib/stellarNetwork';

interface Donation {
  id: number | string;
  senderAddress: string;
  amount: number;
  currency: string;
  message: string;
  transactionHash: string;
  eventId?: string;
  createdAt: string;
}

interface Withdrawal {
  id: number | string;
  amountIn: number;
  amountOut: number | null;
  fee: number | null;
  currency: string;
  anchorTxId: string;
  stellarTxId: string | null;
  status: string;
  createdAt: string;
}

// A single row in the merged Recent Activity feed — either an incoming tip or an
// outgoing cash-out — tagged so the UI can style and link each kind differently.
type ActivityItem =
  | { kind: 'donation'; createdAt: string; data: Donation }
  | { kind: 'withdrawal'; createdAt: string; data: Withdrawal };

export default function DashboardPage() {
  const { user, token } = useAuth();
  const { creator, loading } = useCreator();
  const [donations, setDonations] = useState<Donation[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [donationPage, setDonationPage] = useState(1);
  const [hasMoreDonations, setHasMoreDonations] = useState(false);
  const [totalDonations, setTotalDonations] = useState<number | null>(null);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [loadingMoreDonations, setLoadingMoreDonations] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [infiniteScroll, setInfiniteScroll] = useState(true);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<CreatorStats | null>(null);
  // Bumped on every live donation so the metrics are re-fetched from the API.
  const [statsVersion, setStatsVersion] = useState(0);
  const [showShareCard, setShowShareCard] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const seenDonationEventIds = useRef(new Set<string>());
  const prices = usePrices();

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const prevScrollYRef = useRef<number | null>(null);

  // Preserve scroll position when older donations are appended
  useLayoutEffect(() => {
    if (prevScrollYRef.current !== null && typeof window !== 'undefined') {
      const savedY = prevScrollYRef.current;
      prevScrollYRef.current = null;
      window.scrollTo({ top: savedY, behavior: 'instant' });
    }
  }, [donations]);

  useEffect(() => {
    if (!user || !token || !creator) return;

    const fetchData = async () => {
      try {
        const [resDonations, resWithdrawals] = await Promise.all([
          fetch(`${API_URL}/api/donations?creatorUsername=${encodeURIComponent(creator.username)}&page=1&limit=20`, {
            headers: { 'Authorization': `Bearer ${token}` },
          }),
          fetch(`${API_URL}/api/withdrawals?creatorUsername=${creator.username}`, {
            headers: { 'Authorization': `Bearer ${token}` },
          }),
        ]);

        if (resDonations.ok) {
          const donationsData = await resDonations.json();
          const items = Array.isArray(donationsData) ? donationsData : donationsData.items || [];
          setDonations(items);
          setDonationPage(1);
          if (donationsData.pagination) {
            setTotalDonations(donationsData.pagination.total);
            setTotalPages(donationsData.pagination.totalPages);
            setHasMoreDonations(donationsData.pagination.page < donationsData.pagination.totalPages);
          } else {
            setTotalDonations(Array.isArray(donationsData) ? donationsData.length : items.length);
            setTotalPages(1);
            setHasMoreDonations(false);
          }
        }

        if (resWithdrawals.ok) {
          const withdrawalsData = await resWithdrawals.json();
          setWithdrawals(Array.isArray(withdrawalsData) ? withdrawalsData : []);
        }
      } catch (err) {
        setError((err as Error).message);
      }
    };

    fetchData();
  }, [user, token, creator]);

  const [exporting, setExporting] = useState(false);

  // Exports the creator's full donation history (not just the pages loaded on
  // screen) by walking every page of the API, then downloads it as a CSV.
  const exportDonationsCsv = async () => {
    if (!creator || !token || exporting) return;
    setExporting(true);
    try {
      const all: Donation[] = [];
      const pageSize = 100;
      const maxPages = 200;
      for (let page = 1; page <= maxPages; page++) {
        const response = await fetch(
          `${API_URL}/api/donations?creatorUsername=${encodeURIComponent(creator.username)}&page=${page}&limit=${pageSize}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!response.ok) throw new Error('The server returned an error. Please try again.');
        const data = await response.json();
        all.push(...((Array.isArray(data) ? data : data.items) || []));
        if (Array.isArray(data) || !data.pagination || page >= data.pagination.totalPages) break;
      }
      downloadCsv(donationsCsvFilename(creator.username), donationsToCsv(all));
      notify.success(`Exported ${all.length} donation${all.length === 1 ? '' : 's'}`);
    } catch (err) {
      notify.error('Could not export donations', err);
    } finally {
      setExporting(false);
    }
  };

  const loadMoreDonations = async () => {
    if (!creator || !token || loadingMoreDonations || !hasMoreDonations) return;
    setLoadingMoreDonations(true);
    setLoadMoreError(null);
    if (typeof window !== 'undefined') {
      prevScrollYRef.current = window.scrollY;
    }
    try {
      const nextPage = donationPage + 1;
      const response = await fetch(
        `${API_URL}/api/donations?creatorUsername=${encodeURIComponent(creator.username)}&page=${nextPage}&limit=20`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (!response.ok) throw new Error('The server returned an error. Please try again.');
      const data = await response.json();
      const newItems: Donation[] = data.items || [];

      setDonations((current) => {
        const existingIds = new Set(current.map((d) => String(d.id)));
        const existingHashes = new Set(current.map((d) => d.transactionHash).filter(Boolean));
        const deduplicated = newItems.filter(
          (item) => !existingIds.has(String(item.id)) && (!item.transactionHash || !existingHashes.has(item.transactionHash))
        );
        return [...current, ...deduplicated];
      });

      setDonationPage(nextPage);
      if (data.pagination) {
        setTotalDonations(data.pagination.total);
        setTotalPages(data.pagination.totalPages);
        setHasMoreDonations(nextPage < data.pagination.totalPages);
      } else {
        setHasMoreDonations(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not load older donations';
      setLoadMoreError(msg);
      notify.error('Could not load more donations', err);
    } finally {
      setLoadingMoreDonations(false);
    }
  };

  // Automatically fetch next page when user scrolls near the bottom of the list
  useEffect(() => {
    if (!infiniteScroll || !hasMoreDonations || loadingMoreDonations || loading || loadMoreError) {
      return;
    }

    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          loadMoreDonations();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [infiniteScroll, hasMoreDonations, loadingMoreDonations, loading, loadMoreError, donationPage, creator, token]);

  // Subscribe to the backend's SSE stream so newly confirmed on-chain
  // donations show up here live, without needing to refresh the page.
  // Dashboard metrics (#224) are aggregated server-side over every verified
  // donation, so they stay correct beyond the first page of history.
  useEffect(() => {
    if (!token || !creator) return;
    let cancelled = false;
    fetch(`${API_URL}/api/creators/me/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.currencies)) setStats(data);
      })
      .catch(() => {
        // Metrics are best-effort; the rest of the dashboard still works.
      });
    return () => {
      cancelled = true;
    };
  }, [token, creator, statsVersion]);

  useEffect(() => {
    if (!creator?.walletAddress) return;

    const source = new EventSource(`${API_URL}/api/events`);

    const handleDonation = (event: MessageEvent) => {
      let payload: {
        donor: string;
        creator: string;
        amount: string;
        memo: string;
        timestamp: number;
        txHash: string;
        eventId?: string;
        currency?: string;
      };
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.creator !== creator.walletAddress) return;

      const eventKey = payload.eventId || payload.txHash;
      if (seenDonationEventIds.current.has(eventKey)) return;
      seenDonationEventIds.current.add(eventKey);

      setDonations((prev) => {
        if (!payload.eventId && prev.some((d) => d.transactionHash === payload.txHash)) return prev;
        if (payload.eventId && prev.some((d) => d.eventId === payload.eventId)) return prev;
        const newDonation: Donation = {
          id: payload.eventId || payload.txHash,
          senderAddress: payload.donor,
          amount: Number(payload.amount) / 1e7,
          currency: payload.currency || 'XLM',
          message: payload.memo,
          transactionHash: payload.txHash,
          eventId: payload.eventId,
          createdAt: new Date(payload.timestamp * 1000).toISOString(),
        };
        return [newDonation, ...prev];
      });
      setTotalDonations((prev) => (prev !== null ? prev + 1 : null));
      setStatsVersion((v) => v + 1);

      notify.success('New donation received!', {
        icon: <HugeiconsIcon icon={PartyIcon} size={18} strokeWidth={1.5} />,
      });
    };

    source.addEventListener('donation', handleDonation);

    return () => {
      source.removeEventListener('donation', handleDonation);
      source.close();
    };
  }, [creator?.walletAddress]);

  // Lifetime received totals per asset (#245). The headline volume cards must
  // reflect the creator's full verified history, so once the server-side
  // aggregate (#224) has loaded we use it rather than summing the paginated
  // list — which only covers the loaded page and would grow as the creator
  // scrolls. Before it loads we fall back to the loaded rows so the section
  // isn't blank.
  const receivedTotals = useMemo(() => {
    const totals = new Map<string, number>();
    if (stats) {
      for (const c of stats.currencies) totals.set(c.currency, c.total);
    } else {
      for (const d of donations) totals.set(d.currency, (totals.get(d.currency) ?? 0) + d.amount);
    }
    return totals;
  }, [stats, donations]);

  // One card per accepted or received currency, so USDT (or any future asset)
  // shows up instead of being silently dropped by a hardcoded XLM/USDC pair.
  const volumeCurrencies = useMemo(() => {
    const accepted = [
      creator?.acceptsXlm ? 'XLM' : null,
      creator?.acceptsUsdc ? 'USDC' : null,
      creator?.acceptsUsdt ? 'USDT' : null,
    ].filter((c): c is string => Boolean(c));
    const all = new Set<string>([...accepted, ...receivedTotals.keys()]);
    return Array.from(all).sort((a, b) => a.localeCompare(b));
  }, [creator, receivedTotals]);

  if (loading) {
    return (
      <ProtectedRoute>
        <DashboardSkeleton />
      </ProtectedRoute>
    );
  }

  if (!creator) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen bg-background flex items-center justify-center px-4">
          <div className="card-brutal bg-card p-10 text-center max-w-md">
            <h1 className="text-2xl font-extrabold text-ink mb-4">Complete Your Profile</h1>
            <p className="text-muted font-medium mb-6">You need to create a username first</p>
            <Link href="/auth/username" className="btn-brutal btn-brutal-primary">
              Create Username
            </Link>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  // Total cashed out, by asset withdrawn. Kept separate from the received-volume
  // cards above so those stay a clean lifetime-received figure.
  const withdrawnByCurrency = withdrawals.reduce<Record<string, number>>((acc, w) => {
    acc[w.currency] = (acc[w.currency] || 0) + w.amountIn;
    return acc;
  }, {});
  const withdrawnTotal = withdrawals.reduce((sum, w) => sum + w.amountIn, 0);

  // Merge tips and cash-outs into one time-ordered feed.
  const activity: ActivityItem[] = [
    ...donations.map((d) => ({ kind: 'donation' as const, createdAt: d.createdAt, data: d })),
    ...withdrawals.map((w) => ({ kind: 'withdrawal' as const, createdAt: w.createdAt, data: w })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-background">
        <AppNav />
        <main id="main-content" className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex items-center justify-between mb-8 gap-4">
            <h1 className="text-4xl font-extrabold text-ink tracking-tight">Dashboard</h1>
            <button
              type="button"
              onClick={() => setShowShareModal(true)}
              className="btn-brutal btn-brutal-primary shrink-0"
            >
              Share
            </button>
          </div>

          {error && (
            <div className="card-brutal bg-brand-pink p-4 mb-6 text-ink font-bold">
              {error}
            </div>
          )}

          {donations.length === 0 ? (
            /* No tips yet — a zeroed stats grid and an empty chart would read as
               broken, so show an encouraging empty state with a share CTA instead. */
            <div className="card-brutal bg-card p-10 text-center mb-8">
              <h2 className="text-2xl font-extrabold text-ink mb-2">Waiting for your first supporter</h2>
              <p className="text-muted font-medium mb-6 max-w-md mx-auto">
                Your tip volume and activity will show up here as soon as someone sends you a
                tip. Share your page so people know where to support you.
              </p>
              <button
                type="button"
                onClick={() => setShowShareModal(true)}
                className="btn-brutal btn-brutal-primary"
              >
                Share your page
              </button>
            </div>
          ) : (
            <>
              {stats && <DashboardStats stats={stats} prices={prices} />}

              {/* Volume by asset, plus lifetime cashed out */}
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                {volumeCurrencies.map((currency) => {
                  const total = receivedTotals.get(currency) ?? 0;
                  return (
                    <div
                      key={currency}
                      className={`card-brutal p-6 ${
                        currency === 'XLM' ? 'bg-brand-cyan' : currency === 'USDC' ? 'bg-brand-lime' : 'bg-card'
                      }`}
                    >
                      <p className="text-ink text-sm font-bold uppercase tracking-wide">
                        {currency} Volume
                      </p>
                      <p className="text-2xl sm:text-3xl font-extrabold text-ink mt-2 tabular-nums">
                        {Math.round(total).toLocaleString()} <span className="text-xl">{currency}</span>
                      </p>
                      {formatUsd(total, currency, prices) && (
                        <p className="text-sm font-bold text-ink/70 mt-1">{formatUsd(total, currency, prices)}</p>
                      )}
                    </div>
                  );
                })}
                <div className="card-brutal bg-card p-6">
                  <p className="text-ink text-sm font-bold uppercase tracking-wide">Withdrawn</p>
                  {withdrawnTotal === 0 ? (
                    <p className="text-4xl font-extrabold text-ink/40 mt-2 tabular-nums">—</p>
                  ) : (
                    <div className="mt-2 space-y-1">
                      {Object.entries(withdrawnByCurrency).map(([currency, amount]) => (
                        <p key={currency} className="text-2xl sm:text-3xl font-extrabold text-ink tabular-nums">
                          {Math.round(amount)} <span className="text-xl">{currency}</span>
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Earnings over time chart */}
              <div className="mb-8">
                <TipChart donations={donations} />
              </div>
            </>
          )}

          <div className="mb-8">
            <QrCodeCard creator={creator} />
          </div>

          {/* Recent Activity — tips received and cash-outs, newest first */}
          <div className="card-brutal p-4 sm:p-6 overflow-x-auto">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-extrabold text-ink">Recent Activity</h2>
                {totalDonations !== null && (
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-brand-light-purple/40 border border-ink/20 text-ink">
                    {donations.length} of {totalDonations} tips
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={exportDonationsCsv}
                disabled={exporting || donations.length === 0}
                className="btn-brutal btn-brutal-white px-3 py-1.5 text-xs"
              >
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
            </div>
            {activity.length === 0 ? (
              <p className="text-muted font-medium text-center py-6">
                No activity yet. Share your page above to start receiving tips.
              </p>
            ) : (
              <ul className="divide-y divide-ink/10">
                {activity.map((item) => {
                  if (item.kind === 'donation') {
                    const donation = item.data;
                    const hasHash = Boolean(donation.transactionHash);
                    const usd = formatUsd(donation.amount, donation.currency, prices);
                    const row = (
                      <div className="flex items-center gap-3 py-2.5">
                        <span className="text-sm font-extrabold text-primary whitespace-nowrap tabular-nums">
                          +{donation.amount} {donation.currency}
                        </span>
                        {usd && (
                          <span className="text-xs text-muted whitespace-nowrap tabular-nums">{usd}</span>
                        )}
                        <span className="text-xs text-muted font-mono whitespace-nowrap">
                          {donation.senderAddress.slice(0, 6)}…{donation.senderAddress.slice(-4)}
                        </span>
                        {donation.message && (
                          <span className="text-sm text-ink font-medium truncate flex-1 min-w-0">
                            {donation.message}
                          </span>
                        )}
                        <span className="text-xs text-muted whitespace-nowrap ml-auto pl-2">
                          {new Date(donation.createdAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      </div>
                    );

                    return (
                      <li key={`donation-${donation.id}`}>
                        {hasHash ? (
                          <a
                            href={explorerTxUrl(donation.transactionHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="View transaction on Stellar Expert"
                            className="block -mx-2 px-2 rounded hover:bg-accent-bg focus:bg-accent-bg focus:outline-none transition-colors"
                          >
                            {row}
                          </a>
                        ) : (
                          <div className="-mx-2 px-2">{row}</div>
                        )}
                      </li>
                    );
                  }

                  const withdrawal = item.data;
                  const hasHash = Boolean(withdrawal.stellarTxId);
                  const usd = formatUsd(withdrawal.amountIn, withdrawal.currency, prices);
                  const row = (
                    <div className="flex items-center gap-3 py-2.5">
                      <span className="text-sm font-extrabold text-brand-pink whitespace-nowrap tabular-nums">
                        −{withdrawal.amountIn} {withdrawal.currency}
                      </span>
                      {usd && (
                        <span className="text-xs text-muted whitespace-nowrap tabular-nums">{usd}</span>
                      )}
                      <span className="text-xs font-bold text-ink uppercase tracking-wide whitespace-nowrap">
                        Withdraw
                      </span>
                      {withdrawal.anchorTxId && (
                        <span
                          className="text-[11px] font-mono text-muted/80 truncate max-w-[120px] hidden sm:inline"
                          title={`Ref: ${withdrawal.anchorTxId}`}
                        >
                          {withdrawal.anchorTxId}
                        </span>
                      )}
                      <span className="text-xs text-muted whitespace-nowrap ml-auto pl-2">
                        {new Date(withdrawal.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </div>
                  );

                  return (
                    <li key={`withdrawal-${withdrawal.id}`}>
                      {hasHash ? (
                        <a
                          href={explorerTxUrl(withdrawal.stellarTxId as string)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View transaction on Stellar Expert"
                          className="block -mx-2 px-2 rounded hover:bg-accent-bg focus:bg-accent-bg focus:outline-none transition-colors"
                        >
                          {row}
                        </a>
                      ) : (
                        <div className="-mx-2 px-2">{row}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {loadMoreError && (
              <div className="mt-4 p-3 bg-red-50 border-2 border-red-500 rounded-lg flex items-center justify-between gap-2 text-sm text-red-700">
                <span>{loadMoreError}</span>
                <button
                  type="button"
                  onClick={loadMoreDonations}
                  className="px-3 py-1 bg-red-600 text-white font-bold rounded text-xs hover:bg-red-700 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {loadingMoreDonations && (
              <div className="mt-4 space-y-3">
                <DonationHistorySkeleton rows={2} />
                <div
                  data-testid="donations-loading-indicator"
                  className="p-3 bg-brand-light-purple/20 border-2 border-dashed border-ink/20 rounded-lg flex items-center justify-center gap-2 text-sm font-bold text-ink"
                >
                  <div aria-hidden="true" className="w-4 h-4 border-2 border-brand-purple border-t-transparent rounded-full motion-safe:animate-spin" />
                  <span>Loading older donations…</span>
                </div>
              </div>
            )}

            {hasMoreDonations && !loadingMoreDonations && (
              <div className="mt-4 flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={loadMoreDonations}
                  className="btn-brutal btn-brutal-white w-full sm:w-auto"
                >
                  Load older donations
                </button>
                {infiniteScroll && (
                  <div ref={sentinelRef} className="h-1 w-full" aria-hidden="true" />
                )}
              </div>
            )}

            {!hasMoreDonations && totalDonations !== null && donations.length > 20 && (
              <p className="text-center text-xs text-muted font-bold mt-4 pt-4 border-t border-ink/10">
                All {totalDonations} donations loaded
              </p>
            )}
          </div>
        </main>
      </div>

      {showShareModal && (
        <ShareModal
          creator={creator}
          onClose={() => setShowShareModal(false)}
          onOpenShareCard={() => setShowShareCard(true)}
        />
      )}

      {showShareCard && (
        <ShareCard creator={creator} donations={donations} onClose={() => setShowShareCard(false)} />
      )}
    </ProtectedRoute>
  );
}
