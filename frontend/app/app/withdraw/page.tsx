'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import * as StellarSdk from '@stellar/stellar-sdk';
import { useAuth } from '@/context/AuthContext';
import { useCreator } from '@/context/CreatorContext';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AppNav } from '@/components/AppNav';
import { Skeleton } from '@/components/Skeleton';
import { notify } from '@/lib/notify';
import { useNgnRate } from '@/lib/useNgnRate';
import { API_URL } from '@/lib/api';
import { fundWithFriendbot } from '@/lib/contract';
import { horizonServer } from '@/lib/stellarNetwork';


const NIGERIAN_BANKS = [
  'Access Bank', 'GTBank', 'Kuda', 'Opay', 'UBA', 'Zenith Bank',
  'First Bank', 'Stanbic IBTC', 'Wema Bank',
];

type Stage = 'form' | 'processing' | 'done';

export default function WithdrawPage() {
  const { user, token } = useAuth();
  const { creator, loading: creatorLoading } = useCreator();
  const walletAddress = user?.walletAddress || '';
  const ngnRate = useNgnRate();

  const [xlmBalance, setXlmBalance] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(true);
  const [isUnfunded, setIsUnfunded] = useState(false);
  const [funding, setFunding] = useState(false);

  const [amount, setAmount] = useState('');
  const [bank, setBank] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [stage, setStage] = useState<Stage>('form');
  const [error, setError] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  useEffect(() => {
    if (!walletAddress) { setBalancesLoading(false); return; }
    horizonServer.loadAccount(walletAddress)
      .then((account) => {
        setIsUnfunded(false);
        const native = account.balances.find(
          (b): b is StellarSdk.Horizon.HorizonApi.BalanceLineNative => b.asset_type === 'native'
        );
        setXlmBalance(native ? Math.round(parseFloat(native.balance)).toString() : '0');

        const usdcIssuer = process.env.NEXT_PUBLIC_USDC_ISSUER;
        const usdc = account.balances.find(
          (b): b is StellarSdk.Horizon.HorizonApi.BalanceLineAsset =>
            'asset_code' in b && b.asset_code === 'USDC' && (!usdcIssuer || b.asset_issuer === usdcIssuer)
        );
        setUsdcBalance(usdc ? Math.round(parseFloat(usdc.balance)).toString() : null);
      })
      .catch((err) => {
        const message = (err as Error)?.message || '';
        if (/not found|404|account does not exist/i.test(message)) {
          setIsUnfunded(true);
        }
        notify.error(
          'Could not load your balances',
          'Make sure your wallet is funded on testnet, then refresh the page.',
        );
      })
      .finally(() => setBalancesLoading(false));
  }, [walletAddress]);

  const NGN_PER_USDC = ngnRate?.rate || 1380;
  const naira = amount ? Number(amount) * NGN_PER_USDC : 0;
  const availableUsdc = usdcBalance != null ? parseFloat(usdcBalance) : 0;

  const handleFundWithFriendbot = async () => {
    if (!walletAddress) return;
    setFunding(true);
    try {
      await fundWithFriendbot(walletAddress);
      notify.success('Wallet funded successfully!');
      // Reload balances
      const account = await horizonServer.loadAccount(walletAddress);
      setIsUnfunded(false);
      const native = account.balances.find(
        (b): b is StellarSdk.Horizon.HorizonApi.BalanceLineNative => b.asset_type === 'native'
      );
      setXlmBalance(native ? Math.round(parseFloat(native.balance)).toString() : '0');

      const usdcIssuer = process.env.NEXT_PUBLIC_USDC_ISSUER;
      const usdc = account.balances.find(
        (b): b is StellarSdk.Horizon.HorizonApi.BalanceLineAsset =>
          'asset_code' in b && b.asset_code === 'USDC' && (!usdcIssuer || b.asset_issuer === usdcIssuer)
      );
      setUsdcBalance(usdc ? Math.round(parseFloat(usdc.balance)).toString() : null);
    } catch (err) {
      notify.error('Failed to fund wallet', (err as Error).message);
    } finally {
      setFunding(false);
    }
  };

  const verifyAccount = async (acctNo: string, selectedBank: string) => {
    if (!/^\d{10}$/.test(acctNo) || !selectedBank) return;
    setVerifying(true);
    setVerifyError(null);
    setAccountName(null);
    try {
      const res = await fetch(`/api/verify-account?accountNo=${acctNo}&bank=${encodeURIComponent(selectedBank)}`);
      if (res.ok) {
        const data = await res.json();
        setAccountName(data.accountName);
      } else {
        const data = await res.json().catch(() => ({}));
        setVerifyError(data.error || 'Could not verify account');
      }
    } catch {
      setVerifyError('Could not reach verification service');
    } finally {
      setVerifying(false);
    }
  };

  const handleAccountChange = (value: string) => {
    const digitsOnly = value.replace(/\D/g, '').slice(0, 10);
    setAccountNo(digitsOnly);
    setAccountName(null);
    setVerifyError(null);
    if (digitsOnly.length === 10 && bank) {
      verifyAccount(digitsOnly, bank);
    }
  };

  const handleBankChange = (value: string) => {
    setBank(value);
    setAccountName(null);
    setVerifyError(null);
    if (accountNo.length === 10 && value) {
      verifyAccount(accountNo, value);
    }
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) { setError('Enter an amount greater than zero.'); return; }
    if (usdcBalance !== null && n > availableUsdc) { setError('Amount exceeds your available USDC balance.'); return; }
    if (!/^\d{10}$/.test(accountNo)) { setError('Enter a valid 10-digit account number.'); return; }
    if (!bank) { setError('Select your bank.'); return; }
    if (!accountName && !verifying) { setError('Please verify your account number first.'); return; }

    // Ensure we have a creator profile and an auth token before calling the API
    if (!creator) {
      setError('You need a creator profile to withdraw. Create one in settings.');
      return;
    }
    if (!token) {
      setError('Not authenticated. Please sign in again.');
      return;
    }

    setStage('processing');

    const anchorTxId = `PL-${Date.now().toString(36).toUpperCase()}`;

    try {
      const res = await fetch(`${API_URL}/api/withdrawals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          creatorUsername: creator.username,
          amountIn: n,
          amountOut: naira || undefined,
          fee: 0,
          currency: 'USDC',
          anchorTxId,
          status: 'completed',
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server responded ${res.status}`);
      }

      const withdrawal = await res.json();
      setRef(withdrawal.anchorTxId || anchorTxId);
      setStage('done');
      notify.success('Withdrawal recorded (demo)');
    } catch (err) {
      setError((err as Error).message || 'Could not record withdrawal');
      setStage('form');
    }
  }

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-background">
        <AppNav />
        <div className="max-w-lg mx-auto px-4 sm:px-6 py-10 space-y-6">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight">Withdraw to Naira</h1>
              <span className="text-xs px-2 py-0.5 rounded-md bg-brand-lime border border-ink/30 font-bold text-ink">
                Demo
              </span>
            </div>
            <p className="mt-1 text-sm text-muted font-medium">
              Convert your USDC to NGN and send it to your bank account.
            </p>
          </div>

          {/* Demo disclaimer: placed prominently above the fold before the form */}
          <div className="card-brutal bg-brand-lime/40 border-2 border-ink p-4 text-sm font-medium text-ink">
            <div className="flex items-center gap-2 mb-1">
              <span className="px-2 py-0.5 rounded bg-brand-lime border border-ink text-xs font-black uppercase tracking-wider">
                Demo mode
              </span>
              <span className="font-extrabold text-ink">Simulated off-ramp</span>
            </div>
            <p>
              This simulates a licensed bank off-ramp on testnet. No real bank transfer occurs and no on-chain funds move.
              The resulting withdrawal record is persisted to your account history so it appears in your Activity and exports.
            </p>
          </div>

          {!creator && !creatorLoading && (
            <div className="card-brutal bg-amber-500/20 border-2 border-ink p-4 text-sm font-medium text-ink">
              <p className="font-bold">Creator profile required</p>
              <p className="mt-1 text-xs text-muted">
                You must have a creator profile before recording withdrawals so they can be associated with your account.
              </p>
              <Link href="/settings" className="btn-brutal btn-brutal-white mt-3 inline-block text-xs py-1.5 px-3">
                Go to Settings
              </Link>
            </div>
          )}

          <div className="card-brutal bg-brand-cyan p-4 sm:p-5">
            <p className="text-xs font-bold text-ink/70 uppercase tracking-wide mb-2">Your balances</p>
            {balancesLoading ? (
              <Skeleton className="h-10 w-48" />
            ) : (
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span className="text-xl font-extrabold text-ink tabular-nums">
                  {isUnfunded ? 'Not funded' : (xlmBalance != null ? Number(xlmBalance).toLocaleString() : '—')} <span className="text-base font-bold text-ink/70">XLM</span>
                </span>
                <span className="text-xl font-extrabold text-ink tabular-nums">
                  {isUnfunded ? 'Not funded' : (usdcBalance != null ? Number(usdcBalance).toLocaleString() : '—')} <span className="text-base font-bold text-ink/70">USDC</span>
                </span>
              </div>
            )}
            {isUnfunded && !balancesLoading && (
              <button
                onClick={handleFundWithFriendbot}
                disabled={funding}
                className="btn-brutal btn-brutal-primary w-full mt-3 text-xs py-1.5"
              >
                {funding ? 'Funding...' : 'Fund with Friendbot'}
              </button>
            )}
          </div>

          {stage === 'done' ? (
            <div className="card-brutal p-6 sm:p-8 text-center space-y-4">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15 text-3xl">✓</div>
              <div>
                <p className="text-xl font-extrabold text-ink">Withdrawal recorded (Demo)</p>
                <p className="mt-1 text-sm text-muted font-medium">
                  ₦{naira.toLocaleString()} simulated transfer to your {bank} account ending {accountNo.slice(-4)}.
                </p>
                <p className="mt-1 text-xs text-muted">
                  This transaction has been persisted to your withdrawal history.
                </p>
              </div>
              <div className="rounded-xl bg-background border-2 border-ink/10 p-3 text-sm">
                <span className="text-muted font-medium">Reference</span>{' '}
                <span className="font-mono font-bold">{ref}</span>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <Link
                  href="/dashboard"
                  className="btn-brutal btn-brutal-primary flex-1 text-center"
                >
                  View in Dashboard
                </Link>
                <button
                  className="btn-brutal btn-brutal-white flex-1"
                  onClick={() => { setStage('form'); setAmount(''); setAccountNo(''); setBank(''); setAccountName(null); setRef(''); }}
                >
                  Make another withdrawal
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="card-brutal p-6 space-y-4">
              <div>
                <label className="block text-sm font-bold text-ink mb-1.5" htmlFor="amt">
                  Amount (USDC)
                </label>
                <input
                  id="amt"
                  className="input-brutal"
                  inputMode="decimal"
                  placeholder="100.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={stage === 'processing'}
                />
                {naira > 0 && (
                  <div className="mt-1.5 text-sm text-muted font-medium">
                    <p>
                      You&apos;ll receive ≈{' '}
                      <span className="font-bold text-ink">₦{naira.toLocaleString()}</span>{' '}
                      <span className="text-muted">(₦{NGN_PER_USDC.toLocaleString()}/USDC)</span>
                    </p>
                    {ngnRate?.ageMinutes != null && (
                      <p className="text-xs mt-0.5">
                        Rate as of {ngnRate.ageMinutes === 0 ? 'just now' : `${ngnRate.ageMinutes}m ago`}
                        {ngnRate.isStale && (
                          <span className="text-amber-600 font-bold ml-1">· rate may be stale</span>
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-bold text-ink mb-1.5" htmlFor="bank">
                  Bank
                </label>
                <select
                  id="bank"
                  className="input-brutal"
                  value={bank}
                  onChange={(e) => handleBankChange(e.target.value)}
                  disabled={stage === 'processing'}
                >
                  <option value="">Select bank…</option>
                  {NIGERIAN_BANKS.map((b) => <option key={b}>{b}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-sm font-bold text-ink mb-1.5" htmlFor="acct">
                  Account number
                </label>
                <input
                  id="acct"
                  className="input-brutal"
                  inputMode="numeric"
                  placeholder="0123456789"
                  value={accountNo}
                  onChange={(e) => handleAccountChange(e.target.value)}
                  maxLength={10}
                  disabled={stage === 'processing'}
                />
                {verifying && (
                  <p className="mt-1.5 text-xs text-muted font-medium">Verifying account…</p>
                )}
                {accountName && (
                  <p className="mt-1.5 text-sm font-bold text-emerald-700">
                    Account holder: {accountName}
                  </p>
                )}
                {verifyError && (
                  <p className="mt-1.5 text-sm font-bold text-red-600">{verifyError}</p>
                )}
              </div>

              {error && (
                <div className="card-brutal bg-brand-pink p-3 text-sm font-bold text-ink">{error}</div>
              )}

              <p className="text-xs text-muted text-center font-medium">
                Simulated withdrawal — records a demo cash-out to your activity history.
              </p>

              <button
                type="submit"
                disabled={stage === 'processing' || (!creator && !creatorLoading)}
                className="btn-brutal btn-brutal-primary w-full"
              >
                {stage === 'processing' ? 'Processing…' : 'Simulate withdrawal'}
              </button>
            </form>
          )}
        </div>
      </div>
    </ProtectedRoute>
  );
}
