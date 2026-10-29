'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { notify } from '@/lib/notify';
import { useAuth } from '@/context/AuthContext';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AppNav } from '@/components/AppNav';
import { Skeleton } from '@/components/Skeleton';
import { cancelSubscription } from '@/lib/contract';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { API_URL } from '@/lib/api';
import { fetchWithRetry, isNetworkError } from '@/lib/network';
import { useAuthFetch } from '@/lib/useAuthFetch';
import { isSessionExpiredError } from '@/lib/authFetch';
import { describeChargeFailure } from '@/lib/failures';
import { explorerTxUrl } from '@/lib/stellarNetwork';

interface Subscription {
  id: number;
  creatorId: number;
  creator: { username: string; displayName: string | null; avatarUrl: string | null };
  supporterAddress: string;
  token: string;
  amount: number;
  intervalSecs: number;
  onChainId: number;
  nextChargeAt: string;
  active: boolean;
  lastChargeTxHash: string | null;
  lastChargedAt: string | null;
  lastError: string | null;
}

function formatInterval(intervalSecs: number): string {
  const days = Math.round(intervalSecs / 86400);
  if (days === 7) return 'weekly';
  if (days === 30) return 'monthly';
  return `every ${days} day${days === 1 ? '' : 's'}`;
}

function SubscriptionsList() {
  const { user } = useAuth();
  const authFetch = useAuthFetch();
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [subscriptionToCancel, setSubscriptionToCancel] = useState<Subscription | null>(null);
  const [subscriptionToRemove, setSubscriptionToRemove] = useState<Subscription | null>(null);

  useEffect(() => {
    if (!user?.walletAddress) {
      setLoading(false);
      return;
    }
    if (!token) return;

    fetchWithRetry(`${API_URL}/api/subscriptions?supporterAddress=${encodeURIComponent(user.walletAddress)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.status === 401) {
          const authErr = new Error('Session expired, sign in again');
          (authErr as any).isAuthError = true;
          throw authErr;
        }
        if (!res.ok) throw new Error('The server returned an error. Please try again.');
        return res.json();
      })
      .then(setSubscriptions)
      .catch((err) => {
        if (isNetworkError(err)) return;
        if (err?.isAuthError) {
          notify.error('Session expired, sign in again');
          return;
        }
        notify.error('Could not load your subscriptions', err);
      })
      .finally(() => setLoading(false));
  }, [user?.walletAddress, token]);

  const handleCancel = async (subscription: Subscription) => {
    if (!user?.walletAddress) return;
    setCancellingId(subscription.id);
    try {
      await cancelSubscription({
        supporterAddress: user.walletAddress,
        subscriptionId: subscription.onChainId,
      });

      // The on-chain cancel (which also revokes the allowance) is what stops
      // charges; this call only updates our records, so a failure here is a
      // warning rather than an error. An expired token (#246) is different:
      // authFetch has already signed the user out and toasted, so it
      // propagates to the catch below instead of masquerading as a warning.
      const recordRes = await authFetch(
        `${API_URL}/api/subscriptions/${subscription.id}/cancel`,
        { method: 'POST' },
        { fetchImpl: fetchWithRetry }
      ).catch((err) => {
        if (isSessionExpiredError(err)) throw err;
        return null;
      });

      setSubscriptions((prev) =>
        prev.map((s) => (s.id === subscription.id ? { ...s, active: false } : s))
      );
      if (recordRes?.ok) {
        notify.success('Subscription cancelled');
      } else {
        notify.warning("Subscription cancelled, but we couldn't update our records", {
          description: 'No further charges will be made. It may still show as active after a refresh.',
        });
      }
    } catch (err) {
      // An expired token already signed the user out with its own toast (#246).
      if (isSessionExpiredError(err)) return;
      const message = (err as Error)?.message || '';
      // Detect testnet reset errors (contract/subscription not found)
      if (/not found|no such contract|entry not found|missing contract/i.test(message)) {
        setSubscriptionToRemove(subscription);
        notify.warning('Subscription no longer exists on-chain', {
          description: 'This subscription was lost during a Testnet reset. You can remove it from your records.',
        });
      } else {
        notify.error('Could not cancel subscription', err);
      }
    } finally {
      setCancellingId(null);
    }
  };

  const handleRemoveStaleRecord = async (subscription: Subscription) => {
    try {
      const recordRes = await authFetch(
        `${API_URL}/api/subscriptions/${subscription.id}/cancel`,
        { method: 'POST' },
        { fetchImpl: fetchWithRetry }
      );
      if (recordRes?.ok) {
        setSubscriptions((prev) => prev.filter((s) => s.id !== subscription.id));
        notify.success('Stale subscription removed');
      } else {
        notify.error('Could not remove subscription');
      }
    } catch (err) {
      // An expired token already signed the user out with its own toast (#246).
      if (isSessionExpiredError(err)) return;
      notify.error('Could not remove subscription', err);
    } finally {
      setSubscriptionToRemove(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <div className="max-w-lg mx-auto px-4 sm:px-6 py-10 space-y-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight">
            Subscriptions
          </h1>
          <p className="mt-1 text-sm text-muted font-medium">
            Recurring donations you&apos;ve started from creator profiles.
          </p>
        </div>

        {loading ? (
          <div className="space-y-3" data-testid="subscriptions-skeleton">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !user?.walletAddress ? (
          <div className="card-brutal p-8 text-center space-y-3">
            <p className="text-muted font-medium">
              Connect a wallet to start or manage recurring donations
            </p>
            <div>
              <Link
                href="/settings"
                className="btn-brutal btn-brutal-white inline-block text-sm py-2 px-4"
              >
                Go to Settings
              </Link>
            </div>
          </div>
        ) : subscriptions.length === 0 ? (
          <div className="card-brutal p-8 text-center">
            <p className="text-muted font-medium">
              You don&apos;t have any recurring donations yet. Start one from a creator&apos;s
              profile page.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {subscriptions.map((subscription) => (
              <div key={subscription.id} className="card-brutal p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/${subscription.creator.username}`}
                    className="font-extrabold text-ink hover:text-primary truncate block"
                  >
                    {subscription.creator.displayName || subscription.creator.username}
                  </Link>
                  <p className="text-sm text-muted font-medium truncate">
                    {subscription.amount} {subscription.token}{' '}
                    <span>· {formatInterval(subscription.intervalSecs)}</span>
                  </p>
                  <p className="text-xs text-muted font-medium mt-0.5">
                    {subscription.active
                      ? `Next charge ${new Date(subscription.nextChargeAt).toLocaleDateString()}`
                      : 'Cancelled'}
                  </p>
                  {subscription.lastError && (
                    <p className="text-xs text-red-600 font-bold mt-0.5">
                      Last charge failed — {describeChargeFailure(subscription.lastError)}
                    </p>
                  )}
                  {subscription.lastChargeTxHash && (
                    <a href={explorerTxUrl(subscription.lastChargeTxHash)} target="_blank" rel="noopener noreferrer" className="text-xs underline text-primary">
                      View last charge
                    </a>
                  )}
                </div>

                {subscription.active && (
                  <button
                    onClick={() => setSubscriptionToCancel(subscription)}
                    disabled={cancellingId === subscription.id}
                    aria-label={`Cancel donation to ${subscription.creator.displayName || subscription.creator.username}`}
                    className="text-sm font-bold text-ink/60 hover:text-ink underline underline-offset-2 shrink-0"
                  >
                    {cancellingId === subscription.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={subscriptionToCancel !== null}
        title={`Cancel your donation to ${
          subscriptionToCancel?.creator.displayName || subscriptionToCancel?.creator.username
        }?`}
        description={
          subscriptionToCancel &&
          `You'll stop sending ${subscriptionToCancel.amount} ${subscriptionToCancel.token} ${formatInterval(
            subscriptionToCancel.intervalSecs
          )}. Your wallet will ask you to sign the cancellation.`
        }
        confirmLabel="Cancel donation"
        cancelLabel="Keep it"
        onConfirm={() => {
          const subscription = subscriptionToCancel;
          setSubscriptionToCancel(null);
          if (subscription) handleCancel(subscription);
        }}
        onCancel={() => setSubscriptionToCancel(null)}
      />

      <ConfirmDialog
        open={subscriptionToRemove !== null}
        title="Remove stale subscription?"
        description={
          subscriptionToRemove &&
          `This subscription to ${subscriptionToRemove.creator.displayName || subscriptionToRemove.creator.username} no longer exists on-chain (likely due to a Testnet reset). Remove it from your records?`
        }
        confirmLabel="Remove"
        cancelLabel="Keep"
        onConfirm={() => {
          const subscription = subscriptionToRemove;
          setSubscriptionToRemove(null);
          if (subscription) handleRemoveStaleRecord(subscription);
        }}
        onCancel={() => setSubscriptionToRemove(null)}
      />
    </div>
  );
}

export default function SubscriptionsPage() {
  return (
    <ProtectedRoute>
      <SubscriptionsList />
    </ProtectedRoute>
  );
}
