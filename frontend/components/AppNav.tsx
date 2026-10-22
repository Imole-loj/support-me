'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  GridViewIcon,
  DashboardSquare01Icon,
  Search01Icon,
  Settings01Icon,
  RepeatIcon,
  Activity01Icon,
  Menu01Icon,
  Cancel01Icon,
} from '@hugeicons/core-free-icons';
import { WalletMenu } from '@/components/WalletMenu';
import { ThemeToggle } from '@/components/ThemeToggle';
import { TestnetBadge } from '@/components/TestnetBadge';

/**
 * The three destinations that stay in the desktop top nav. Everything else
 * lives in the wallet menu (#151) so the nav stops competing with page
 * content for horizontal space on smaller laptop screens.
 */
const PRIMARY_LINKS = [
  { href: '/app', label: 'App', icon: GridViewIcon },
  { href: '/dashboard', label: 'Dashboard', icon: DashboardSquare01Icon },
  { href: '/discover', label: 'Discover', icon: Search01Icon },
];

/** Secondary destinations, reached through the wallet menu. */
const SECONDARY_LINKS = [
  { href: '/app/subscriptions', label: 'Subscriptions', icon: RepeatIcon },
  { href: '/activity', label: 'Activity', icon: Activity01Icon },
  { href: '/settings', label: 'Settings', icon: Settings01Icon },
];

/**
 * Mobile keeps its full list: the drawer is a full-screen-feeling surface with
 * room to spare, and the bottom tab bar already covers the frequent routes, so
 * hiding anything there would only make it harder to reach.
 */
const ALL_LINKS = [...PRIMARY_LINKS, ...SECONDARY_LINKS];

/** Shared navigation for the authenticated app shell (/app, /dashboard,
 * /settings, /activity). Highlights the active route and exposes mobile navigation
 * toggle and wallet chip + sign-out via <WalletMenu>.
 */
export function AppNav() {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const primaryMobileLinks = ALL_LINKS.filter((link) =>
    ['/app', '/dashboard', '/discover', '/activity'].includes(link.href)
  );

  return (
    <>
      <nav
        aria-label="Main Navigation"
        style={{ top: 'var(--offline-banner-h, 0px)' }}
        className="sticky w-full z-50 bg-background border-b-4 border-ink"
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle mobile menu"
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-menu-drawer"
              className="sm:hidden btn-brutal btn-brutal-white p-2 min-h-[44px] min-w-[44px] flex items-center justify-center focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
            >
              <HugeiconsIcon icon={mobileMenuOpen ? Cancel01Icon : Menu01Icon} size={22} strokeWidth={2} />
            </button>
            <div className="flex items-center gap-2">
              <Link
                href="/app"
                className="text-xl sm:text-2xl font-extrabold font-display text-ink shrink-0 tracking-tight rounded-lg focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              >
                SupportMe
              </Link>
              <TestnetBadge />
            </div>
          </div>

          <div data-testid="primary-nav" className="hidden sm:flex items-center gap-6">
            {PRIMARY_LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2 font-bold transition min-h-[44px] px-2.5 py-1.5 rounded-lg focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
                    active ? 'text-primary underline underline-offset-4' : 'text-ink hover:text-primary'
                  }`}
                >
                  <HugeiconsIcon icon={link.icon} size={18} strokeWidth={2} />
                  {link.label}
                </Link>
              );
            })}
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <ThemeToggle />
            <WalletMenu />
          </div>
        </div>

        {/* Mobile Drawer / Dropdown Menu */}
        {mobileMenuOpen && (
          <div id="mobile-menu-drawer" data-testid="mobile-menu" className="sm:hidden border-t-4 border-ink bg-background px-4 py-4 space-y-2 pb-20">
            {ALL_LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileMenuOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-3 px-4 py-3 rounded border-2 border-ink font-bold text-base min-h-[44px] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
                    active ? 'bg-primary text-white' : 'bg-white text-ink hover:bg-accent-bg'
                  }`}
                >
                  <HugeiconsIcon icon={link.icon} size={20} strokeWidth={2} />
                  {link.label}
                </Link>
              );
            })}
          </div>
        )}
      </nav>

      {/* Mobile Bottom Tab Bar below sm breakpoint */}
      <nav
        aria-label="Mobile Bottom Navigation"
        className="sm:hidden fixed bottom-0 left-0 right-0 z-50 bg-background border-t-4 border-ink px-2 py-2 flex justify-around items-center shadow-lg"
      >
        {primaryMobileLinks.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center gap-1 font-bold text-xs transition-colors px-2 py-1 rounded-lg focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
                active ? 'text-primary bg-accent-bg border border-ink' : 'text-ink hover:text-primary'
              }`}
            >
              <HugeiconsIcon icon={link.icon} size={20} strokeWidth={2} />
              <span>{link.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
