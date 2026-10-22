'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Activity01Icon,
  RepeatIcon,
  Settings01Icon,
} from '@hugeicons/core-free-icons';
import { useAuth } from '@/context/AuthContext';

/**
 * Secondary destinations, kept out of the desktop top nav so it stays short
 * (#151). They live here alongside the wallet address and sign-out, which is
 * the one control that is always visible in the header.
 */
const SECONDARY_LINKS = [
  { href: '/app/subscriptions', label: 'Subscriptions', icon: RepeatIcon },
  { href: '/activity', label: 'Activity', icon: Activity01Icon },
  { href: '/settings', label: 'Settings', icon: Settings01Icon },
];

function sliceAddress(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/**
 * The account identifier shown in the header chip. A user signed in with a
 * wallet has walletAddress; a Twitter-only user has neither (Twitter's API
 * doesn't return a verified email for the scopes this app requests - see
 * docs/authentication.md "Twitter / X OAuth 2.0"); a magic-link user has
 * email. Falls back to a generic label rather than rendering an empty chip.
 */
function accountLabel(user: { walletAddress: string | null; email?: string | null }): string {
  if (user.walletAddress) return sliceAddress(user.walletAddress);
  if (user.email) return user.email;
  return 'Account';
}

/**
 * Wallet chip shown in place of a bare "Sign Out" button: displays the
 * connected wallet's sliced address with a down arrow; clicking opens a small
 * menu with the secondary destinations and the Sign Out action. Closes on
 * outside-click or Escape.
 */
export function WalletMenu() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Wallet menu (${accountLabel(user)})`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-brutal btn-brutal-white text-sm sm:text-base font-mono gap-1.5 min-h-[44px] flex items-center justify-center focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[var(--focus-ring)]"
      >
        {accountLabel(user)}
        <span className={`text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-48 card-brutal bg-card p-2 z-50 flex flex-col gap-1"
        >
          {/* Secondary destinations, no longer in the top nav (#151) */}
          <div className="border-b border-ink/20 pb-1 mb-1 flex flex-col gap-1">
            {SECONDARY_LINKS.map((link) => {
              // The top nav no longer highlights these routes, so the menu
              // is the only place the active state can be shown.
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  role="menuitem"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                  className={`w-full text-left px-3 py-2 rounded-lg font-bold transition-colors min-h-[44px] flex items-center gap-2 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] focus-visible:bg-accent-bg ${
                    active ? 'bg-accent-bg text-primary' : 'text-ink hover:bg-accent-bg'
                  }`}
                >
                  <HugeiconsIcon icon={link.icon} size={18} strokeWidth={2} />
                  {link.label}
                </Link>
              );
            })}
          </div>

          <button
            role="menuitem"
            onClick={() => {
              logout();
              window.location.href = '/';
            }}
            className="w-full text-left px-3 py-2 rounded-lg font-bold text-ink hover:bg-brand-pink transition-colors min-h-[44px] flex items-center focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] focus-visible:bg-brand-pink"
          >
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
