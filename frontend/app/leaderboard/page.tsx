'use client';

import { useEffect, useState, useId } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  TrophyIcon,
  CrownIcon,
  UserGroupIcon,
  Coins01Icon,
  Link01Icon,
  Alert02Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons';
import { Skeleton } from '@/components/Skeleton';
import { WalletMenu } from '@/components/WalletMenu';
import { ThemeToggle } from '@/components/ThemeToggle';
import { TestnetBadge } from '@/components/TestnetBadge';
import { useAuth } from '@/context/AuthContext';
import { API_URL } from '@/lib/api';
import { explorerAccountUrl } from '@/lib/stellarNetwork';

export type LeaderboardType = 'creators' | 'supporters';
export type CurrencyFilter = 'XLM' | 'USDC' | 'EURC';
export type TimeFilter = 'all' | 'month' | 'week';

export interface CreatorLeaderboardEntry {
  rank: number;
  total: number;
  donationCount: number;
  creator: {
    id: number;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

export interface SupporterLeaderboardEntry {
  rank: number;
  total: number;
  donationCount: number;
  senderAddress: string;
}

export interface LeaderboardResponse {
  items: (CreatorLeaderboardEntry | SupporterLeaderboardEntry)[];
  currency: string;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

function isCreatorEntry(
  entry: CreatorLeaderboardEntry | SupporterLeaderboardEntry
): entry is CreatorLeaderboardEntry {
  return 'creator' in entry && typeof entry.creator === 'object' && entry.creator !== null;
}

function sliceAddress(addr: string): string {
  if (!addr || addr.length <= 10) return addr || '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const CURRENCIES: CurrencyFilter[] = ['XLM', 'USDC', 'EURC'];
const TIMEFRAMES: { id: TimeFilter; label: string }[] = [
  { id: 'all', label: 'All-Time' },
  { id: 'month', label: 'This Month' },
  { id: 'week', label: 'This Week' },
];

export default function LeaderboardPage() {
  const { user } = useAuth();
  const [type, setType] = useState<LeaderboardType>('creators');
  const [currency, setCurrency] = useState<CurrencyFilter>('XLM');
  const [timeframe, setTimeframe] = useState<TimeFilter>('all');
  const [data, setData] = useState<(CreatorLeaderboardEntry | SupporterLeaderboardEntry)[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const creatorsTabId = useId();
  const supportersTabId = useId();

  const fetchLeaderboard = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_URL}/api/creators/leaderboard?type=${type}&currency=${currency}&page=1&limit=50`
      );
      if (!res.ok) {
        throw new Error('Failed to load leaderboard data.');
      }
      const json: LeaderboardResponse = await res.json();
      setData(json.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not fetch leaderboard');
      setData([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchLeaderboard();
  }, [type, currency]);

  const topThree = data.slice(0, 3);
  const restEntries = data.slice(3);

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav
        aria-label="Main Navigation"
        style={{ top: 'var(--offline-banner-h, 0px)' }}
        className="sticky w-full z-50 bg-background border-b-4 border-ink"
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center gap-4">
          <div className="flex items-center gap-2">
            <Link href="/" className="text-xl sm:text-2xl font-extrabold text-ink shrink-0 tracking-tight font-display">
              SupportMe
            </Link>
            <TestnetBadge />
          </div>
          <div className="hidden sm:flex items-center gap-6">
            <Link href="/discover" className="font-bold text-ink hover:text-primary transition">
              Discover
            </Link>
            <Link href="/leaderboard" className="font-bold text-primary underline underline-offset-4">
              Leaderboard
            </Link>
            {user && (
              <Link href="/dashboard" className="font-bold text-ink hover:text-primary transition">
                Dashboard
              </Link>
            )}
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <ThemeToggle />
            {user ? (
              <WalletMenu />
            ) : (
              <Link href="/" className="btn-brutal btn-brutal-primary text-sm sm:text-base">
                Connect Wallet
              </Link>
            )}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main id="main-content" className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14 space-y-8">
        {/* Hero Header */}
        <header className="text-center space-y-4 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 card-brutal bg-brand-yellow px-4 py-1.5 -rotate-1">
            <HugeiconsIcon icon={TrophyIcon} size={18} strokeWidth={2.5} className="text-ink" />
            <span className="text-xs sm:text-sm font-extrabold uppercase tracking-wide text-ink">
              Live Stellar Leaderboard
            </span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-ink tracking-tight font-display">
            Platform Leaderboard
          </h1>
          <p className="text-muted text-base sm:text-lg font-medium">
            Recognizing the most supported creators and generous community supporters across the Stellar network.
          </p>
        </header>

        {/* Controls: Type Tabs, Currency & Timeframe Filters */}
        <section aria-label="Leaderboard Filters" className="card-brutal bg-card p-4 sm:p-6 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            {/* Type Switcher Tabs */}
            <div
              role="tablist"
              aria-label="Leaderboard View Type"
              className="inline-flex bg-background border-2 border-ink rounded-xl p-1 gap-1"
            >
              <button
                id={creatorsTabId}
                role="tab"
                type="button"
                aria-selected={type === 'creators'}
                onClick={() => setType('creators')}
                className={`flex items-center gap-2 px-4 py-2 font-bold text-sm rounded-lg transition-all min-h-[44px] ${
                  type === 'creators'
                    ? 'bg-primary text-white shadow-brutal-sm'
                    : 'text-ink hover:bg-accent-bg'
                }`}
              >
                <HugeiconsIcon icon={CrownIcon} size={18} strokeWidth={2} />
                Top Creators
              </button>
              <button
                id={supportersTabId}
                role="tab"
                type="button"
                aria-selected={type === 'supporters'}
                onClick={() => setType('supporters')}
                className={`flex items-center gap-2 px-4 py-2 font-bold text-sm rounded-lg transition-all min-h-[44px] ${
                  type === 'supporters'
                    ? 'bg-primary text-white shadow-brutal-sm'
                    : 'text-ink hover:bg-accent-bg'
                }`}
              >
                <HugeiconsIcon icon={UserGroupIcon} size={18} strokeWidth={2} />
                Top Supporters
              </button>
            </div>

            {/* Currency Selector */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold uppercase tracking-wider text-muted mr-1">Currency:</span>
              {CURRENCIES.map((curr) => (
                <button
                  key={curr}
                  type="button"
                  onClick={() => setCurrency(curr)}
                  aria-pressed={currency === curr}
                  className={`btn-brutal px-3.5 py-1.5 text-xs font-extrabold min-h-[40px] ${
                    currency === curr ? 'btn-brutal-primary' : 'btn-brutal-white'
                  }`}
                >
                  {curr}
                </button>
              ))}
            </div>
          </div>

          {/* Timeframe Chips */}
          <div className="flex items-center gap-2 pt-2 border-t border-ink/10 flex-wrap">
            <span className="text-xs font-bold uppercase tracking-wider text-muted mr-1">Timeframe:</span>
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                type="button"
                onClick={() => setTimeframe(tf.id)}
                aria-pressed={timeframe === tf.id}
                className={`px-3 py-1 rounded-full text-xs font-bold border border-ink transition ${
                  timeframe === tf.id
                    ? 'bg-brand-lime text-ink'
                    : 'bg-background text-muted hover:text-ink'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </section>

        {/* Loading State */}
        {loading && (
          <div data-testid="leaderboard-skeleton" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Skeleton className="h-44 rounded-xl" />
              <Skeleton className="h-52 rounded-xl" />
              <Skeleton className="h-44 rounded-xl" />
            </div>
            <div className="card-brutal p-6 space-y-4">
              <Skeleton className="h-12 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
            </div>
          </div>
        )}

        {/* Error State */}
        {!loading && error && (
          <div
            role="alert"
            className="card-brutal bg-brand-pink p-6 text-center space-y-3"
          >
            <div className="inline-flex items-center justify-center w-12 h-12 bg-white rounded-full border-2 border-ink mx-auto text-ink">
              <HugeiconsIcon icon={Alert02Icon} size={24} strokeWidth={2} />
            </div>
            <h2 className="text-lg font-extrabold text-ink">Unable to Load Leaderboard</h2>
            <p className="text-sm font-medium text-ink/80 max-w-md mx-auto">{error}</p>
            <button
              type="button"
              onClick={fetchLeaderboard}
              className="btn-brutal btn-brutal-white text-sm inline-flex items-center gap-2 mt-2"
            >
              <HugeiconsIcon icon={RefreshIcon} size={16} strokeWidth={2} />
              Try Again
            </button>
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && data.length === 0 && (
          <div
            data-testid="leaderboard-empty"
            className="card-brutal bg-card p-12 text-center space-y-4"
          >
            <div className="w-16 h-16 rounded-full bg-brand-yellow border-2 border-ink flex items-center justify-center mx-auto text-ink">
              <HugeiconsIcon icon={Coins01Icon} size={30} strokeWidth={2} />
            </div>
            <h2 className="text-2xl font-extrabold text-ink font-display">No Leaderboard Entries Yet</h2>
            <p className="text-muted font-medium max-w-md mx-auto text-sm sm:text-base">
              No tips recorded for {currency} during this timeframe yet. Be the first to tip a creator and earn the #1 spot!
            </p>
            <div className="pt-2">
              <Link href="/discover" className="btn-brutal btn-brutal-primary text-sm inline-block">
                Discover Creators to Support
              </Link>
            </div>
          </div>
        )}

        {/* Loaded Content */}
        {!loading && !error && data.length > 0 && (
          <div className="space-y-8">
            {/* Top 3 Podium (when at least 3 entries exist) */}
            {topThree.length >= 3 && (
              <section aria-label="Top Ranked Podium" className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4">
                {/* 2nd Place */}
                <div className="order-2 md:order-1 card-brutal bg-brand-cyan/20 p-6 flex flex-col items-center text-center justify-between gap-4 border-2 border-ink">
                  <div className="inline-block px-3 py-1 bg-brand-cyan text-ink font-extrabold text-xs rounded-full border border-ink">
                    Rank #2
                  </div>
                  <PodiumAvatar entry={topThree[1]} />
                  <PodiumInfo entry={topThree[1]} currency={currency} type={type} />
                </div>

                {/* 1st Place (Center & Prominent) */}
                <div className="order-1 md:order-2 card-brutal bg-brand-yellow/30 p-8 flex flex-col items-center text-center justify-between gap-4 border-4 border-ink shadow-brutal-lg md:-translate-y-2">
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-brand-yellow text-ink font-extrabold text-sm rounded-full border-2 border-ink">
                    <HugeiconsIcon icon={CrownIcon} size={16} strokeWidth={2.5} />
                    Rank #1
                  </div>
                  <PodiumAvatar entry={topThree[0]} isFirst />
                  <PodiumInfo entry={topThree[0]} currency={currency} type={type} />
                </div>

                {/* 3rd Place */}
                <div className="order-3 card-brutal bg-brand-lime/20 p-6 flex flex-col items-center text-center justify-between gap-4 border-2 border-ink">
                  <div className="inline-block px-3 py-1 bg-brand-lime text-ink font-extrabold text-xs rounded-full border border-ink">
                    Rank #3
                  </div>
                  <PodiumAvatar entry={topThree[2]} />
                  <PodiumInfo entry={topThree[2]} currency={currency} type={type} />
                </div>
              </section>
            )}

            {/* Complete Rankings List / Table */}
            <section aria-label="Complete Rankings" className="card-brutal bg-card overflow-hidden">
              <div className="p-4 sm:p-6 border-b-2 border-ink bg-background flex justify-between items-center">
                <h2 className="text-xl font-extrabold text-ink font-display">
                  {type === 'creators' ? 'Top Earning Creators' : 'Top Supporters'}
                </h2>
                <span className="text-xs font-extrabold text-muted">
                  Showing top {data.length} entries ({currency})
                </span>
              </div>

              {/* Desktop Table View */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b-2 border-ink bg-accent-bg text-ink text-xs uppercase tracking-wider font-extrabold">
                      <th scope="col" className="py-3 px-4 w-16 text-center">Rank</th>
                      <th scope="col" className="py-3 px-4">Participant</th>
                      <th scope="col" className="py-3 px-4 text-center">Tips</th>
                      <th scope="col" className="py-3 px-4 text-right">Total Amount</th>
                      <th scope="col" className="py-3 px-4 text-right w-28">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y-2 divide-ink/10">
                    {data.map((entry) => (
                      <tr key={entry.rank} className="hover:bg-accent-bg/40 transition-colors">
                        <td className="py-4 px-4 text-center">
                          <span
                            className={`inline-block font-extrabold text-xs px-2.5 py-1 rounded-md border border-ink ${
                              entry.rank === 1
                                ? 'bg-brand-yellow text-ink'
                                : entry.rank === 2
                                ? 'bg-brand-cyan text-ink'
                                : entry.rank === 3
                                ? 'bg-brand-lime text-ink'
                                : 'bg-card text-muted'
                            }`}
                          >
                            #{entry.rank}
                          </span>
                        </td>
                        <td className="py-4 px-4">
                          <ParticipantRow entry={entry} />
                        </td>
                        <td className="py-4 px-4 text-center text-sm font-bold text-ink">
                          {entry.donationCount} {entry.donationCount === 1 ? 'tip' : 'tips'}
                        </td>
                        <td className="py-4 px-4 text-right">
                          <span className="text-base font-extrabold text-ink">
                            {entry.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                          </span>
                          <span className="ml-1 text-xs font-bold text-primary">{currency}</span>
                        </td>
                        <td className="py-4 px-4 text-right">
                          {isCreatorEntry(entry) ? (
                            <Link
                              href={`/${entry.creator.username}`}
                              className="btn-brutal btn-brutal-white text-xs px-3 py-1.5"
                            >
                              Profile
                            </Link>
                          ) : (
                            <a
                              href={explorerAccountUrl(entry.senderAddress)}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`View explorer details for ${sliceAddress(entry.senderAddress)}`}
                              className="btn-brutal btn-brutal-white text-xs px-3 py-1.5 inline-flex items-center gap-1"
                            >
                              <HugeiconsIcon icon={Link01Icon} size={14} />
                              Explorer
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile Cards View */}
              <div className="sm:hidden divide-y-2 divide-ink/10">
                {data.map((entry) => (
                  <div key={entry.rank} className="p-4 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-block font-extrabold text-xs px-2 py-1 rounded border border-ink ${
                          entry.rank === 1
                            ? 'bg-brand-yellow text-ink'
                            : entry.rank === 2
                            ? 'bg-brand-cyan text-ink'
                            : entry.rank === 3
                            ? 'bg-brand-lime text-ink'
                            : 'bg-card text-muted'
                        }`}
                      >
                        #{entry.rank}
                      </span>
                      <ParticipantRow entry={entry} isCompact />
                    </div>

                    <div className="text-right shrink-0">
                      <div className="text-sm font-extrabold text-ink">
                        {entry.total.toLocaleString(undefined, { minimumFractionDigits: 2 })} {currency}
                      </div>
                      <div className="text-xs text-muted font-bold">
                        {entry.donationCount} {entry.donationCount === 1 ? 'tip' : 'tips'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function ParticipantRow({
  entry,
  isCompact = false,
}: {
  entry: CreatorLeaderboardEntry | SupporterLeaderboardEntry;
  isCompact?: boolean;
}) {
  if (isCreatorEntry(entry)) {
    const { creator } = entry;
    const name = creator.displayName || creator.username;
    return (
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full border-2 border-ink overflow-hidden bg-accent-bg shrink-0 flex items-center justify-center font-extrabold text-sm text-ink">
          {creator.avatarUrl ? (
            <Image
              src={creator.avatarUrl}
              alt={name}
              width={40}
              height={40}
              className="w-full h-full object-cover"
              unoptimized
            />
          ) : (
            name.charAt(0).toUpperCase()
          )}
        </div>
        <div className="min-w-0">
          <Link
            href={`/${creator.username}`}
            className="font-extrabold text-ink hover:text-primary transition-colors text-sm truncate block"
          >
            {name}
          </Link>
          {!isCompact && (
            <span className="text-xs font-bold text-muted">@{creator.username}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-full border-2 border-ink bg-brand-lilac flex items-center justify-center shrink-0 font-extrabold text-xs text-ink font-mono">
        {entry.senderAddress.slice(0, 2)}
      </div>
      <div>
        <span className="font-mono text-sm font-bold text-ink">
          {sliceAddress(entry.senderAddress)}
        </span>
        {!isCompact && (
          <span className="block text-[11px] text-muted font-bold">Stellar Supporter</span>
        )}
      </div>
    </div>
  );
}

function PodiumAvatar({
  entry,
  isFirst = false,
}: {
  entry: CreatorLeaderboardEntry | SupporterLeaderboardEntry;
  isFirst?: boolean;
}) {
  const sizeClass = isFirst ? 'w-20 h-20' : 'w-16 h-16';

  if (isCreatorEntry(entry)) {
    const name = entry.creator.displayName || entry.creator.username;
    return (
      <div
        className={`${sizeClass} rounded-full border-4 border-ink overflow-hidden bg-accent-bg flex items-center justify-center font-extrabold text-xl text-ink`}
      >
        {entry.creator.avatarUrl ? (
          <Image
            src={entry.creator.avatarUrl}
            alt={name}
            width={isFirst ? 80 : 64}
            height={isFirst ? 80 : 64}
            className="w-full h-full object-cover"
            unoptimized
          />
        ) : (
          name.charAt(0).toUpperCase()
        )}
      </div>
    );
  }

  return (
    <div
      className={`${sizeClass} rounded-full border-4 border-ink bg-brand-lilac flex items-center justify-center font-extrabold font-mono text-ink text-base`}
    >
      {entry.senderAddress.slice(0, 2)}
    </div>
  );
}

function PodiumInfo({
  entry,
  currency,
  type,
}: {
  entry: CreatorLeaderboardEntry | SupporterLeaderboardEntry;
  currency: string;
  type: LeaderboardType;
}) {
  const title = isCreatorEntry(entry)
    ? entry.creator.displayName || entry.creator.username
    : sliceAddress(entry.senderAddress);

  const subtitle = isCreatorEntry(entry) ? `@${entry.creator.username}` : 'Supporter';

  return (
    <div className="space-y-1">
      {isCreatorEntry(entry) ? (
        <Link
          href={`/${entry.creator.username}`}
          className="font-extrabold text-ink hover:text-primary text-base sm:text-lg block tracking-tight truncate max-w-[200px]"
        >
          {title}
        </Link>
      ) : (
        <div className="font-extrabold font-mono text-ink text-base tracking-tight truncate max-w-[200px]">
          {title}
        </div>
      )}
      <div className="text-xs text-muted font-bold">{subtitle}</div>
      <div className="text-xl font-extrabold text-primary font-display pt-1">
        {entry.total.toLocaleString(undefined, { minimumFractionDigits: 2 })} {currency}
      </div>
      <div className="text-xs text-ink/70 font-bold">
        {entry.donationCount} {entry.donationCount === 1 ? 'tip' : 'tips'} {type === 'creators' ? 'received' : 'sent'}
      </div>
    </div>
  );
}
