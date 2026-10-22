'use client';

import { useState, useEffect, useMemo, useCallback, use } from 'react';
import Image from 'next/image';
import * as StellarSdk from '@stellar/stellar-sdk';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import { notify } from '@/lib/notify';
import { HugeiconsIcon } from '@hugeicons/react';
import { PartyIcon, TwitterIcon, LinkIcon } from '@hugeicons/core-free-icons';
import { connectWallet, addTrustline } from '@/lib/wallet';
import {
  categorizeWalletError,
  WALLET_INSTALL_LINKS,
  WALLET_CATEGORY,
} from '@/lib/walletErrors';
import {
  sendDonation,
  MAX_MEMO_LENGTH,
  approveAllowance,
  subscribe,
  MAX_CHARGE_INTERVAL_DAYS,
  fundWithFriendbot,
} from '@/lib/contract';
import { availableAssetCodes, getAsset, type AssetCode } from '@/lib/assets';
import { MIN_DONATION_AMOUNT } from '@/lib/donation';
import { memoByteLength } from '@/lib/memo';
import { getPlatform, isHttpUrl } from '@/lib/socials';
import { explorerTxUrl, horizonServer } from '@/lib/stellarNetwork';
import { API_URL } from '@/lib/api';
import { fetchWithRetry } from '@/lib/network';
import { describeDonationFailure, type FlowFailure } from '@/lib/failures';
import { useAuth } from '@/context/AuthContext';
import { Skeleton } from '@/components/Skeleton';
import { TipJarLoader } from '@/components/TipJarLoader';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { getMessages, useDocumentLang, useLocalePreference, type Locale } from '@/lib/i18n';
import { THEME_LAYOUTS, themeStyle, type ProfileTheme } from '@/lib/theme';



interface Creator {
  id: number;
  username: string;
  displayName: string | null;
  walletAddress: string;
  bio: string | null;
  avatarUrl: string | null;
  socialLinks: Record<string, string> | null;
  acceptsXlm: boolean;
  acceptsUsdc: boolean;
  acceptsUsdt: boolean;
  donationGoal: number | null;
  // Creator-configured quick-select donate amounts (#120), set from
  // Settings. Absent/empty means the creator hasn't customized these.
  presetAmounts?: number[] | null;
  // Custom profile theme (#227); null/absent means the default design.
  theme?: ProfileTheme | null;
}

// Fallback quick-select amounts shown on the donate page when a creator
// hasn't configured their own presets from Settings.
const DEFAULT_DONATION_PRESETS = ['1', '5', '10', '20'];
// Re-exported for existing importers; defined in lib/donation.ts so Settings
// and the donate page enforce the same minimum (#244).
export { MIN_DONATION_AMOUNT };
export const LARGE_DONATION_THRESHOLD = 1000;

interface Goal {
  id: number;
  title: string | null;
  description: string | null;
  targetAmount: number;
  currentAmount: number;
  currency: string;
  status: 'ACTIVE' | 'COMPLETED' | 'EXPIRED';
  recurring: boolean;
}

export default function CreatorProfileClient({
  params,
  initialLocale,
}: {
  params: Promise<{ username: string }>;
  /** Locale from the `supportme_locale` cookie, read server-side by page.tsx. */
  initialLocale?: Locale;
}) {
  const { username } = use(params);
  const [locale, setLocale] = useLocalePreference(initialLocale);
  useDocumentLang(locale);

  return (
    <NextIntlClientProvider locale={locale} messages={getMessages(locale)}>
      {/* lang on the translated region too, so it is correct on first paint
          even before useDocumentLang's effect updates <html lang>. */}
      <div lang={locale}>
        <CreatorProfileView username={username} locale={locale} onLocaleChange={setLocale} />
      </div>
    </NextIntlClientProvider>
  );
}

interface CreatorProfileViewProps {
  username: string;
  locale: ReturnType<typeof useLocalePreference>[0];
  onLocaleChange: ReturnType<typeof useLocalePreference>[1];
}

/**
 * Error-toast body for a donation/subscription failure: the explanation and
 * recovery action from lib/failures, plus a link to the matching section of
 * docs/testnet-troubleshooting.md. The failure copy itself is English-only
 * (see lib/failures.ts), so the link label is too.
 */
function FailureDescription({ failure }: { failure: FlowFailure }) {
  return (
    <>
      {failure.message} {failure.action}{' '}
      <a href={failure.docsUrl} target="_blank" rel="noopener noreferrer" className="underline">
        Learn more<span className="sr-only"> about this error (opens in a new tab)</span>
      </a>
    </>
  );
}

function CreatorProfileView({ username, locale, onLocaleChange }: CreatorProfileViewProps) {
  const t = useTranslations('donate');
  const tProfile = useTranslations('creatorProfile');
  const { token, loginWithWallet } = useAuth();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  // 'paused' = the SSE stream dropped and the browser is retrying.
  const [liveStatus, setLiveStatus] = useState<'connecting' | 'live' | 'paused'>('connecting');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // A non-404 failure (5xx, 429, dropped connection): the profile may well
  // exist, so show a retryable error rather than "creator not found".
  const [loadFailed, setLoadFailed] = useState(false);

  const [userAddress, setUserAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [isUnfunded, setIsUnfunded] = useState(false);
  const [funding, setFunding] = useState(false);
  const [missingTrustline, setMissingTrustline] = useState(false);

  const [donationAmount, setDonationAmount] = useState('5');
  const [donationMessage, setDonationMessage] = useState('');
  const [assetCode, setAssetCode] = useState<AssetCode>('XLM');
  const [sending, setSending] = useState(false);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [largeDonationConfirmed, setLargeDonationConfirmed] = useState(false);

  const [recurring, setRecurring] = useState(false);
  const [intervalChoice, setIntervalChoice] = useState<'7' | '30' | 'custom'>('30');
  const [customDays, setCustomDays] = useState('14');
  const [subscribeStep, setSubscribeStep] = useState<string | null>(null);

  const intervalDays = intervalChoice === 'custom' ? customDays : intervalChoice;

  // Use the creator's own presets when they've set any (#120), otherwise
  // fall back to sensible defaults.
  const presets =
    creator?.presetAmounts && creator.presetAmounts.length > 0
      ? creator.presetAmounts.map((amount) => String(amount))
      : DEFAULT_DONATION_PRESETS;

  const statusLabels: Record<string, string> = useMemo(
    () => ({
      building: t('status.building'),
      simulating: t('status.simulating'),
      'awaiting-signature': t('status.awaitingSignature'),
      submitting: t('status.submitting'),
      pending: t('status.pending'),
    }),
    [t]
  );

  // Only offer assets the creator actually accepts, intersected with what this
  // deployment supports (USDC/USDT only appear when their issuer is configured).
  const assetCodes = useMemo(() => {
    if (!creator) return [];
    return availableAssetCodes().filter((code) => {
      if (code === 'XLM') return creator.acceptsXlm;
      if (code === 'USDC') return creator.acceptsUsdc;
      if (code === 'USDT') return creator.acceptsUsdt;
      return true;
    });
  }, [creator]);

  // Goal progress lives entirely server-side (Goal.currentAmount, updated by
  // the backend as donations come in — see goalService.ts) rather than being
  // derived here by summing donations, since a single donation can now count
  // toward several simultaneously-active goals. Only ACTIVE goals are shown;
  // a COMPLETED (non-recurring, target reached) or EXPIRED goal drops off the
  // profile's goal bar list.
  // useCallback (keyed only on username, not on every render) so the SSE
  // effect below can safely list it as a dependency without resubscribing on
  // every render.
  const fetchGoals = useCallback(async () => {
    try {
      const res = await fetch(
        `${API_URL}/api/goals/${encodeURIComponent(username)}?status=ACTIVE`
      );
      if (!res.ok) return;
      const data = await res.json();
      setGoals(Array.isArray(data) ? data : data.items || []);
    } catch {
      // Non-fatal: the profile still renders without goal bars.
    }
  }, [username]);

  const fetchCreator = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    setLoadFailed(false);
    try {
      const res = await fetchWithRetry(
        `${API_URL}/api/creators/${encodeURIComponent(username)}`
      );
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const data: Creator = await res.json();
      setCreator(data);
      await fetchGoals();
    } catch {
      // fetchWithRetry already surfaced the connection failure (toast +
      // offline banner); show the retryable error state too.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [username, fetchGoals]);

  useEffect(() => {
    fetchCreator();
  }, [fetchCreator]);

  // Default the selected asset to the first one the creator accepts, once the
  // profile loads.
  useEffect(() => {
    if (assetCodes.length > 0 && !assetCodes.includes(assetCode)) {
      setAssetCode(assetCodes[0]);
    }
  }, [assetCodes, assetCode]);

  // Subscribe to the backend's SSE stream so a live donation bumps the goal
  // progress without a refresh. The stream is closed while the tab is hidden
  // (so many open profile tabs don't each hold a connection), and whenever it
  // is re-established after an error or a hidden period the goals are refetched
  // to backfill anything that arrived while it was down.
  useEffect(() => {
    if (!creator?.walletAddress) return;

    let source: EventSource | null = null;
    let needsBackfill = false;

    const handleDonation = (event: MessageEvent) => {
      let payload: { creator: string };
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.creator !== creator.walletAddress) return;

      // The SSE event only carries the on-chain payment, not which goal(s) it
      // was applied to server-side — refetch rather than guess at the split.
      void fetchGoals();
    };

    const open = () => {
      if (source) return;
      setLiveStatus('connecting');
      const next = new EventSource(`${API_URL}/api/events`);
      next.onopen = () => {
        setLiveStatus('live');
        if (needsBackfill) {
          needsBackfill = false;
          void fetchGoals();
        }
      };
      next.onerror = () => {
        needsBackfill = true;
        setLiveStatus('paused');
      };
      next.addEventListener('donation', handleDonation);
      source = next;
    };

    const close = () => {
      if (!source) return;
      source.removeEventListener('donation', handleDonation);
      source.close();
      source = null;
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        close();
      } else {
        needsBackfill = true;
        open();
      }
    };

    if (!document.hidden) open();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      close();
    };
  }, [creator?.walletAddress, fetchGoals]);

  // Read the connected wallet's balance for whichever asset is selected. Falls
  // back to null when the wallet holds no trustline/balance for it.
  const loadAssetBalance = useCallback(async (address: string, code: string) => {
    try {
      const account = await horizonServer.loadAccount(address);
      setIsUnfunded(false);
      const asset = getAsset(code);
      let match;
      if (code === 'XLM') {
        match = account.balances.find(
          (b: { asset_type?: string }) => b.asset_type === 'native'
        );
        setMissingTrustline(false);
      } else {
        match = account.balances.find((b: { asset_type?: string; asset_code?: string }) => {
          if (b.asset_type === 'native') return false;
          if (asset && asset.code === code && typeof asset.balanceMatcher === 'function') {
            return asset.balanceMatcher(b as StellarSdk.Horizon.HorizonApi.BalanceLine);
          }
          return b.asset_code === code;
        });
        // For non-XLM assets, missing match means no trustline
        setMissingTrustline(!match);
      }
      return parseFloat((match as { balance?: string })?.balance || '0').toFixed(4);
    } catch (err) {
      // Detect 404 / not found errors which indicate an unfunded account
      const message = (err as Error)?.message || '';
      if (/not found|404|account does not exist/i.test(message)) {
        setIsUnfunded(true);
      }
      return null;
    }
  }, []);

  // Keep displayed balance in sync with connected wallet and selected asset.
  useEffect(() => {
    if (!userAddress) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    loadAssetBalance(userAddress, assetCode).then((bal) => {
      if (!cancelled) {
        setBalance(bal);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [userAddress, assetCode, loadAssetBalance]);

  const handleConnectWallet = async () => {
    setConnecting(true);
    try {
      const address = await connectWallet();
      setUserAddress(address);
      // address is null when the user closed the wallet picker without
      // connecting (see lib/wallet.ts) -- nothing to load or celebrate yet.
      if (!address) return;
      setBalance(await loadAssetBalance(address, assetCode));
      notify.success(t('walletConnected'));
    } catch (err) {
      const walletError = categorizeWalletError(err);
      if (walletError.type === WALLET_CATEGORY.NO_WALLET) {
        notify.error(walletError.title, walletError.message);
        notify.info(t('installWalletTitle'), {
          description: (
            <ul className="list-disc pl-4">
              {WALLET_INSTALL_LINKS.map((wallet) => (
                <li key={wallet.name}>
                  <a
                    href={wallet.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {wallet.name}
                  </a>{' '}
                  — {wallet.description}
                </li>
              ))}
            </ul>
          ),
        });
      } else {
        notify.error(walletError.title, walletError.message);
      }
    } finally {
      setConnecting(false);
    }
  };

  const handleFundWithFriendbot = async () => {
    if (!userAddress) return;
    setFunding(true);
    try {
      await fundWithFriendbot(userAddress);
      notify.success('Wallet funded successfully!');
      setBalance(await loadAssetBalance(userAddress, assetCode));
    } catch (err) {
      notify.error('Failed to fund wallet', (err as Error).message);
    } finally {
      setFunding(false);
    }
  };

  const handleAddTrustline = async () => {
    if (!userAddress || assetCode === 'XLM') return;
    setFunding(true);
    try {
      await addTrustline(assetCode, userAddress);
      notify.success(`Trustline for ${assetCode} added successfully!`);
      setBalance(await loadAssetBalance(userAddress, assetCode));
    } catch (err) {
      notify.error('Failed to add trustline', (err as Error).message);
    } finally {
      setFunding(false);
    }
  };

  const handleSendDonation = async () => {
    if (!userAddress || !creator?.walletAddress) {
      notify.error(t('cannotSendDonationTitle'), t('cannotSendDonationMessage'));
      return;
    }

    setSending(true);
    setTxStatus('building');
    try {
      const { hash } = await sendDonation({
        donorAddress: userAddress,
        creatorAddress: creator.walletAddress,
        amount: donationAmount,
        assetCode,
        memo: donationMessage,
        onStatus: setTxStatus,
      });

      // Record the donation, tagging it with the asset that was sent so the
      // dashboard can split XLM vs USDC volume.
      const recordRes = await fetch(`${API_URL}/api/donations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': hash },
        body: JSON.stringify({
          creatorUsername: creator.username,
          senderAddress: userAddress,
          amount: parseFloat(donationAmount),
          currency: assetCode,
          message: donationMessage,
          transactionHash: hash,
        }),
      });

      setBalance(await loadAssetBalance(userAddress, assetCode));
      // A hash-bearing report is only provisional: the backend's Soroban event
      // listener verifies the event and applies it to matching active goals
      // asynchronously, so goal totals may lag this response by a poll.
      if (recordRes.ok) await fetchGoals();

      const txLink = (
        <a
          href={explorerTxUrl(hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          {hash.slice(0, 16)}…
        </a>
      );

      notify.success(t('donationSentTitle'), {
        icon: <HugeiconsIcon icon={PartyIcon} size={18} strokeWidth={1.5} />,
        description: txLink,
      });

      // The on-chain transfer already happened; a failure here only means our
      // own records (dashboard totals, goal progress) missed it, not that the
      // donation itself failed — so it gets a separate, non-error notify.
      if (!recordRes.ok) {
        notify.warning(t('donationRecordFailedTitle'), {
          description: <>{t('donationRecordFailedDescription')} {txLink}</>,
        });
      }

      setDonationAmount('5');
      setDonationMessage('');
    } catch (err) {
      const failure = describeDonationFailure(err, 'donate');
      notify.error(failure.title, undefined, {
        description: <FailureDescription failure={failure} />,
      });
    } finally {
      setSending(false);
      setTxStatus(null);
    }
  };

  const handleStartSubscription = async () => {
    if (!creator?.walletAddress) return;

    const intervalSecs = Math.round(parseFloat(intervalDays) * 86400);
    if (!intervalSecs || intervalSecs <= 0) {
      notify.error(t('invalidInterval'));
      return;
    }
    if (intervalSecs > MAX_CHARGE_INTERVAL_DAYS * 86400) {
      notify.error(
        t('intervalTooLongTitle'),
        t('intervalTooLongMessage', { max: MAX_CHARGE_INTERVAL_DAYS }),
      );
      return;
    }

    setSending(true);
    try {
      let address = userAddress;
      if (!address) {
        address = await connectWallet();
        setUserAddress(address);
      }
      if (!address) {
        setSending(false);
        return;
      }

      // Recording a subscription (so the supporter can later see/cancel it)
      // requires a site sign-in, on top of connecting the wallet for signing
      // transactions — the on-chain subscribe() call itself only needs the
      // wallet connection.
      let authToken = token;
      if (!authToken) {
        setSubscribeStep(t('signingIn'));
        const result = await loginWithWallet();
        authToken = result.token;
      }

      setSubscribeStep(t('approvingAllowance'));
      await approveAllowance({
        supporterAddress: address,
        amount: donationAmount,
        assetCode,
        intervalSecs,
        onStatus: setTxStatus,
      });

      setSubscribeStep(t('startingSubscription'));
      const { hash, subscriptionId } = await subscribe({
        supporterAddress: address,
        creatorAddress: creator.walletAddress,
        amount: donationAmount,
        assetCode,
        intervalSecs,
        onStatus: setTxStatus,
      });

      const recordRes = await fetch(`${API_URL}/api/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          creatorUsername: creator.username,
          supporterAddress: address,
          token: assetCode,
          amount: parseFloat(donationAmount),
          intervalSecs,
          onChainId: subscriptionId,
          subscribeTxHash: hash,
        }),
      });

      notify.success(t('recurringStartedTitle'), {
        description: t('recurringStartedDescription', {
          amount: donationAmount,
          asset: assetCode,
          interval: intervalDays,
        }),
      });

      // The on-chain subscribe() already succeeded; if this recording call
      // fails, the subscription won't show up under Subscriptions and won't
      // be auto-charged, so the supporter needs to know to follow up.
      if (!recordRes.ok) {
        notify.warning(t('subscriptionSaveFailedTitle'), {
          description: t('subscriptionSaveFailedDescription', {
            hash: hash.slice(0, 16) + '…',
          }),
        });
      }

      setRecurring(false);
      setDonationAmount('5');
      setDonationMessage('');
    } catch (err) {
      const failure = describeDonationFailure(err, 'subscribe');
      notify.error(failure.title, undefined, {
        description: <FailureDescription failure={failure} />,
      });
    } finally {
      setSending(false);
      setTxStatus(null);
      setSubscribeStep(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background py-10 px-4" aria-busy="true">
        <div className="max-w-md mx-auto">
          <div className="card-brutal p-8 text-center">
            <Skeleton className="h-24 w-24 rounded-full mx-auto mb-4" />
            <Skeleton className="h-8 w-48 mx-auto mb-2" />
            <Skeleton className="h-5 w-32 mx-auto mb-6" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="card-brutal p-10 text-center max-w-md" role="alert">
          <h1 className="text-2xl font-extrabold text-ink mb-2">
            {tProfile('loadFailed.title')}
          </h1>
          <p className="text-muted font-medium mb-6">
            {tProfile.rich('loadFailed.description', {
              username,
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </p>
          <button
            type="button"
            onClick={() => fetchCreator()}
            className="btn-brutal btn-brutal-primary"
          >
            {tProfile('loadFailed.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (notFound || !creator) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="card-brutal p-10 text-center max-w-md">
          <h1 className="text-2xl font-extrabold text-ink mb-2">{tProfile('notFound.title')}</h1>
          <p className="text-muted font-medium">
            {tProfile.rich('notFound.description', {
              username,
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </p>
        </div>
      </div>
    );
  }

  const socialLinks = creator.socialLinks || {};
  const socialEntries = Object.entries(socialLinks).filter(([, url]) => isHttpUrl(url));

  const displayName = creator.displayName || creator.username;
  const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://support-mee.vercel.app';
  const profileUrl = `${SITE_URL}/${creator.username}`;

  const handleShareOnTwitter = () => {
    const text = encodeURIComponent(
      tProfile('share.tweetText', { name: displayName, username: creator.username })
    );
    const url = encodeURIComponent(profileUrl);
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, '_blank');
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(profileUrl);
      notify.success(tProfile('share.linkCopied'));
    } catch {
      notify.error(tProfile('share.copyFailed'));
    }
  };

  const layout = THEME_LAYOUTS[creator.theme?.layout ?? 'default'];

  return (
    <div
      className={`min-h-screen bg-background px-4 ${layout.page}`}
      style={creator.theme ? themeStyle(creator.theme) : undefined}
    >
      <main id="main-content" className={`max-w-md mx-auto ${layout.column}`}>
        {/* Creator header */}
        <div className="card-brutal p-8 text-center">
          <div className="w-24 h-24 mx-auto mb-4 rounded-full border-4 border-ink overflow-hidden bg-accent-bg flex items-center justify-center">
            {creator.avatarUrl ? (
              <Image
                src={creator.avatarUrl}
                alt={displayName}
                width={96}
                height={96}
                className="w-full h-full object-cover"
                unoptimized
              />
            ) : (
              <span className="text-3xl font-extrabold text-muted">
                {displayName.charAt(0).toUpperCase()}
              </span>
            )}
          </div>

          <h1 className="text-3xl font-extrabold text-ink mb-1 tracking-tight">{displayName}</h1>
          <p className="text-muted font-bold mb-4">@{creator.username}</p>
          {creator.bio && <p className="text-ink/70 font-medium mb-4">{creator.bio}</p>}

          {socialEntries.length > 0 && (
            <div className="flex items-center justify-center gap-3">
              {socialEntries.map(([key, url]) => {
                const platform = getPlatform(key);
                if (!platform) return null;
                return (
                  <a
                    key={key}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={platform.label}
                    title={platform.label}
                    className="text-ink hover:text-primary transition-colors"
                  >
                    <HugeiconsIcon icon={platform.icon} size={24} strokeWidth={2} />
                  </a>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-center gap-2 mt-4">
            <button
              onClick={handleShareOnTwitter}
              className="btn-brutal btn-brutal-white px-3 py-2 text-sm flex items-center gap-2"
              aria-label={tProfile('share.shareAriaLabel')}
            >
              <HugeiconsIcon icon={TwitterIcon} size={18} strokeWidth={2} />
              {tProfile('share.shareButton')}
            </button>
            <button
              onClick={handleCopyLink}
              className="btn-brutal btn-brutal-white px-3 py-2 text-sm flex items-center gap-2"
              aria-label={tProfile('share.copyLinkAriaLabel')}
            >
              <HugeiconsIcon icon={LinkIcon} size={18} strokeWidth={2} />
              {tProfile('share.copyLinkButton')}
            </button>
          </div>

          <div className="flex items-center justify-center mt-4">
            <LanguageSwitcher locale={locale} onChange={onLocaleChange} />
          </div>

          {liveStatus === 'paused' && (
            <p role="status" className="mt-4 text-xs font-bold text-ink">
              {tProfile('livePaused')}
            </p>
          )}

          {goals.length > 0 && (
            <div className="mt-6 pt-6 border-t-2 border-ink text-left space-y-4">
              {goals.map((g) => {
                // Progress is whatever the backend has already computed for
                // this goal (Goal.currentAmount) — never re-derived here by
                // summing donations, since a donation can count toward
                // several active goals at once (see goalService.ts).
                const pct = Math.min(100, (g.currentAmount / g.targetAmount) * 100);
                return (
                  <div key={g.id}>
                    <div className="flex justify-between text-sm font-bold text-ink mb-2 gap-2">
                      <span className="truncate">
                        {g.title || tProfile('goals.fallbackTitle')}
                        {g.recurring && (
                          <span className="ml-1.5 text-[10px] font-extrabold uppercase tracking-wide text-ink/60 align-middle">
                            {tProfile('goals.recurringBadge')}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0">
                        {g.currentAmount.toFixed(0)} / {g.targetAmount.toFixed(0)} {g.currency} ({pct.toFixed(0)}%)
                      </span>
                    </div>
                    {g.description && (
                      <p className="text-sm text-muted font-medium mb-2">{g.description}</p>
                    )}
                    <div
                      className="h-3 border-2 border-ink rounded-full overflow-hidden bg-accent-bg"
                      role="progressbar"
                      aria-valuenow={Math.round(pct)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={g.title || tProfile('goals.ariaLabel', { currency: g.currency })}
                    >
                      <div className="h-full bg-brand-lime" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Donation card */}
        <div className="card-brutal p-6">
          <div className="flex items-center justify-between gap-2 mb-4">
            <h2 className="text-lg font-extrabold text-ink">{t('heading', { name: displayName })}</h2>
            <span
              className="text-[10px] font-extrabold uppercase tracking-wide text-ink/60 border-2 border-ink/30 rounded px-1.5 py-0.5"
              title={t('testnetTooltip')}
            >
              {t('testnetBadge')}
            </span>
          </div>

          {sending ? (
            <div className="py-2">
              <TipJarLoader fullScreen={false} />
              {(subscribeStep || (txStatus && statusLabels[txStatus])) && (
                <p className="text-sm text-ink text-center motion-safe:animate-pulse font-bold mt-2">
                  {subscribeStep ?? statusLabels[txStatus as string]}
                </p>
              )}
            </div>
          ) : !userAddress ? (
            <button
              onClick={handleConnectWallet}
              disabled={connecting}
              className="btn-brutal btn-brutal-primary w-full min-h-[48px]"
            >
              {connecting ? t('connecting') : t('connectWallet')}
            </button>
          ) : (
            <div className="space-y-4">
              <div className="card-brutal bg-brand-lime p-3 text-sm">
                <p className="text-ink font-medium">
                  {t('walletLabel', { address: userAddress.slice(0, 8) })}
                </p>
                <p className="text-ink font-extrabold mt-1">
                  {isUnfunded ? 'Not funded on Testnet' : (balance ?? '0.0000')} {assetCode}
                </p>
                {isUnfunded && (
                  <button
                    onClick={handleFundWithFriendbot}
                    disabled={funding}
                    className="btn-brutal btn-brutal-primary w-full mt-2 text-xs py-1.5"
                  >
                    {funding ? 'Funding...' : 'Fund with Friendbot'}
                  </button>
                )}
                {missingTrustline && !isUnfunded && assetCode !== 'XLM' && (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-ink/70 font-medium">
                      You need a {assetCode} trustline to hold or send this asset.
                    </p>
                    <button
                      onClick={handleAddTrustline}
                      disabled={funding}
                      className="btn-brutal btn-brutal-primary w-full text-xs py-1.5"
                    >
                      {funding ? 'Adding...' : `Add ${assetCode} trustline`}
                    </button>
                    <p className="text-xs text-muted">
                      Get test {assetCode} from{' '}
                      <a
                        href="https://faucet.circle.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        Circle&apos;s faucet
                      </a>
                      . Test tokens have no real value.
                    </p>
                  </div>
                )}
              </div>

              {assetCodes.length > 1 && (
                <fieldset>
                  <legend className="block text-sm font-bold text-ink mb-2">{t('assetLegend')}</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {assetCodes.map((code) => (
                      <button
                        key={code}
                        onClick={async () => {
                          if (code === assetCode) return;
                          setAssetCode(code);
                          if (userAddress) {
                            setBalance(null);
                            const nextBal = await loadAssetBalance(userAddress, code);
                            setBalance(nextBal);
                          }
                        }}
                        aria-pressed={assetCode === code}
                        className={`btn-brutal text-sm px-0 py-2 min-h-[44px] ${
                          assetCode === code ? 'btn-brutal-primary' : 'btn-brutal-white'
                        }`}
                      >
                        {code}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {(() => {
                const parsedAmt = parseFloat(donationAmount);
                const isAmountValid = Number.isFinite(parsedAmt) && parsedAmt >= MIN_DONATION_AMOUNT;
                const isLargeDonation = Number.isFinite(parsedAmt) && parsedAmt >= LARGE_DONATION_THRESHOLD;
                const memoBytes = memoByteLength(donationMessage);
                const memoTooLong = memoBytes > MAX_MEMO_LENGTH;
                const canSubmit = isAmountValid && (!isLargeDonation || largeDonationConfirmed) && !memoTooLong;

                return (
                  <>
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label htmlFor="donation-amount" className="block text-sm font-bold text-ink">
                          {t('amountLabel', { asset: assetCode })}
                        </label>
                        <span className="text-xs text-muted font-bold" data-testid="min-donation-label">
                          {t('minDonation', { min: MIN_DONATION_AMOUNT, asset: assetCode })}
                        </span>
                      </div>
                      <input
                        id="donation-amount"
                        type="number"
                        min={MIN_DONATION_AMOUNT}
                        step="0.1"
                        value={donationAmount}
                        onChange={(e) => {
                          setDonationAmount(e.target.value);
                          setLargeDonationConfirmed(false);
                        }}
                        className={`input-brutal ${!isAmountValid ? 'border-red-500' : ''}`}
                      />
                      {!isAmountValid && (
                        <p className="text-xs text-red-600 font-bold mt-1" role="alert">
                          {donationAmount.trim() === ''
                            ? t('amountRequired')
                            : t('amountInvalid')}
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-4 gap-2">
                      {presets.map((preset) => (
                        <button
                          key={preset}
                          onClick={() => setDonationAmount(preset)}
                          aria-pressed={donationAmount === preset}
                          className={`btn-brutal text-sm px-0 py-2 min-h-[44px] ${
                            donationAmount === preset ? 'btn-brutal-primary' : 'btn-brutal-white'
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>

                    {isLargeDonation && (
                      <div
                        className="card-brutal bg-amber-50 dark:bg-amber-950/30 border-2 border-amber-500 p-3 text-xs space-y-2"
                        role="region"
                        aria-label="Large donation warning"
                        data-testid="large-donation-warning"
                      >
                        <p className="text-amber-900 dark:text-amber-200 font-bold flex items-center gap-1.5">
                          <span>⚠️</span>
                          {t('largeDonationWarning', { amount: donationAmount, asset: assetCode })}
                        </p>
                        <label className="flex items-center gap-2 cursor-pointer font-bold text-ink select-none">
                          <input
                            type="checkbox"
                            checked={largeDonationConfirmed}
                            onChange={(e) => setLargeDonationConfirmed(e.target.checked)}
                            className="h-4 w-4 accent-amber-600 rounded border-ink"
                            data-testid="large-donation-checkbox"
                          />
                          <span>{t('confirmLargeDonation', { amount: donationAmount, asset: assetCode })}</span>
                        </label>
                      </div>
                    )}

                    <div>
                      <label htmlFor="donation-message" className="block text-sm font-bold text-ink mb-2">
                        {t('messageLabel')}
                      </label>
                      <textarea
                        id="donation-message"
                        value={donationMessage}
                        onChange={(e) => setDonationMessage(e.target.value)}
                        placeholder={t('messagePlaceholder')}
                        className="input-brutal text-sm"
                        rows={3}
                      />
                      <p className="text-xs text-muted mt-1 font-medium">
                        {memoBytes}/{MAX_MEMO_LENGTH} bytes
                      </p>
                      {memoTooLong && (
                        <p role="alert" className="text-xs text-red-600 mt-1">
                          Message must be {MAX_MEMO_LENGTH} bytes or fewer.
                        </p>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <label className="flex items-center gap-2 text-sm font-bold text-ink">
                        <input
                          type="checkbox"
                          checked={recurring}
                          onChange={(e) => setRecurring(e.target.checked)}
                          className="h-4 w-4 accent-primary"
                        />
                        {t('makeRecurring')}
                      </label>

                      {recurring && (
                        <div className="flex items-center gap-1.5">
                          <select
                            value={intervalChoice}
                            onChange={(e) => setIntervalChoice(e.target.value as typeof intervalChoice)}
                            className="input-brutal text-sm py-1.5 w-auto min-h-[44px]"
                          >
                            <option value="7">{t('intervalWeekly')}</option>
                            <option value="30">{t('intervalMonthly')}</option>
                            <option value="custom">{t('intervalCustom')}</option>
                          </select>
                          {intervalChoice === 'custom' && (
                            <input
                              type="number"
                              min="1"
                              max={MAX_CHARGE_INTERVAL_DAYS}
                              step="1"
                              value={customDays}
                              onChange={(e) => setCustomDays(e.target.value)}
                              aria-label={t('daysBetweenChargesLabel')}
                              title={t('daysBetweenChargesTitle', { max: MAX_CHARGE_INTERVAL_DAYS })}
                              className="input-brutal text-sm py-1.5 w-14 min-h-[44px]"
                            />
                          )}
                        </div>
                      )}
                    </div>

                    {recurring && (
                      <p className="text-xs text-muted font-medium -mt-2">
                        {t('recurringHint', {
                          period:
                            intervalChoice === '7'
                              ? t('periodWeek')
                              : intervalChoice === '30'
                                ? t('periodMonth')
                                : t('periodOther'),
                        })}
                      </p>
                    )}

                    <button
                      onClick={recurring ? handleStartSubscription : handleSendDonation}
                      disabled={sending || !creator.walletAddress || !canSubmit}
                      className="btn-brutal btn-brutal-lime w-full disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {recurring ? t('startRecurringDonation') : t('sendDonation')}
                    </button>
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
