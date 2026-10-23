// Categorizes Stellar wallet-connection failures into actionable cases so the
// UI can surface a specific message, a retry path and install instructions
// instead of a generic error. The wallet kit and individual wallet extensions
// reject with loosely-typed messages/objects, so categorization is based on
// conservative message heuristics with a friendly fallback.

import { troubleshootingUrl } from './docs';
import type { WalletConnectErrorData } from '@/components/WalletConnectError';

export const WALLET_CATEGORY = {
  NO_WALLET: 'NO_WALLET',
  USER_REJECTED: 'USER_REJECTED',
  WRONG_NETWORK: 'WRONG_NETWORK',
  UNKNOWN: 'UNKNOWN',
} as const;

export type WalletCategory = (typeof WALLET_CATEGORY)[keyof typeof WALLET_CATEGORY];

export interface WalletInstallLink {
  name: string;
  url: string;
  description: string;
}

// Install targets shown when no wallet is detected. URLs match each module's
// own product page from @creit.tech/stellar-wallets-kit.
export const WALLET_INSTALL_LINKS: WalletInstallLink[] = [
  {
    name: 'Freighter',
    url: 'https://freighter.app',
    description: 'Browser extension for Chrome, Firefox, Brave and Edge.',
  },
  {
    name: 'xBull Wallet',
    url: 'https://xbull.app',
    description: 'Browser extension and web wallet.',
  },
  {
    name: 'Albedo',
    url: 'https://albedo.link/',
    description: 'Web-based wallet — nothing to install.',
  },
  {
    name: 'Rabet',
    url: 'https://rabet.io/',
    description: 'Browser extension for Chrome and Firefox.',
  },
  {
    name: 'LOBSTR',
    url: 'https://lobstr.co',
    description: 'Mobile wallet for iOS and Android.',
  },
];

type CategoryMeta = Required<Pick<WalletConnectErrorData, 'type' | 'title' | 'message' | 'action' | 'retryLabel'>> &
  Pick<WalletConnectErrorData, 'showInstallLinks'>;

const CATEGORY_META: Record<WalletCategory, CategoryMeta> = {
  [WALLET_CATEGORY.NO_WALLET]: {
    type: WALLET_CATEGORY.NO_WALLET,
    title: 'No Stellar wallet detected',
    message:
      "We couldn't find a Stellar wallet in this browser. Install one of the supported wallets below, then try again.",
    action: 'Install a wallet from the list, then come back and connect.',
    retryLabel: 'Try again',
    showInstallLinks: true,
  },
  [WALLET_CATEGORY.USER_REJECTED]: {
    type: WALLET_CATEGORY.USER_REJECTED,
    title: 'Wallet connection cancelled',
    message:
      'The connection request was declined or the wallet window was closed before you approved it.',
    action: 'Click "Try again" and approve the request inside your wallet when prompted.',
    retryLabel: 'Try again',
  },
  [WALLET_CATEGORY.WRONG_NETWORK]: {
    type: WALLET_CATEGORY.WRONG_NETWORK,
    title: 'Wrong network',
    message: 'Your wallet is on a different network. SupportMe runs on the Stellar testnet.',
    action: 'Switch your wallet to the Stellar testnet, then try again.',
    retryLabel: 'Try again',
  },
  [WALLET_CATEGORY.UNKNOWN]: {
    type: WALLET_CATEGORY.UNKNOWN,
    title: 'Could not connect your wallet',
    message: 'Something unexpected went wrong while connecting your wallet.',
    action: 'You can try again. If it keeps failing, check that your wallet extension is up to date.',
    retryLabel: 'Try again',
  },
};

// Every title this module can show. Each must have a matching heading in
// docs/testnet-troubleshooting.md (enforced by troubleshootingDoc.test.ts),
// since results link to that section via `docsUrl`.
export const WALLET_ERROR_TITLES: string[] = Object.values(CATEGORY_META).map((meta) => meta.title);

// Ordered list of matchers. NO_WALLET wins over the others because messages
// like "Freighter is not connected" must not be read as a user rejection.
// WRONG_NETWORK_PATTERN is exported so lib/failures.ts can recognise the same
// mismatch wording on signing errors raised mid-donation.
export const WRONG_NETWORK_PATTERN =
  /(wrong network|network (does not match|doesn't match|is different|mismatch)|network.*(passphrase|testnet|mainnet|public).*(match|mismatch)|passphrase.*(match|mismatch|invalid))/i;

const PATTERNS: { type: WalletCategory; test: RegExp }[] = [
  {
    type: WALLET_CATEGORY.NO_WALLET,
    test:
      /(is not (installed|connected|available|found)|not (installed|found|connected)|no wallet|wallet (extension )?not|extension .*(missing|not found)|does not (exist|appear|seem)|unable to (find|connect)|could not (find|detect|connect))/i,
  },
  {
    type: WALLET_CATEGORY.USER_REJECTED,
    test:
      /(declined|rejected|denied|cancell?ed|cancel|dismissed|closed the modal|user closed|permission denied|did not (approve|sign)|request was (declined|rejected))/i,
  },
  {
    type: WALLET_CATEGORY.WRONG_NETWORK,
    test: WRONG_NETWORK_PATTERN,
  },
];

/** The loosely-typed shapes a wallet operation can reject with: a real Error, the kit's `{ code, message }` object, or a plain string. */
type RawWalletFailure = Error | { message?: string; error?: { message?: string } } | string | unknown;

/**
 * Maps any value raised by a wallet operation (Error, kit `{ code, message }`
 * object, or plain string) to a category with a user-facing title, message,
 * retry hint, optional install links and a `docsUrl` pointing at the matching
 * troubleshooting section. Raw messages are kept on the result
 * so the UI can surface them in the fallback (UNKNOWN) case only.
 */
export function categorizeWalletError(err: RawWalletFailure): WalletConnectErrorData {
  const raw = err as { message?: string; error?: { message?: string } } | null | undefined;
  const message = [raw?.message, raw?.error?.message, typeof err === 'string' ? err : null]
    .filter(Boolean)
    .join(' ')
    .trim();

  for (const pattern of PATTERNS) {
    if (pattern.test.test(message)) {
      const meta = CATEGORY_META[pattern.type];
      return { ...meta, docsUrl: troubleshootingUrl(meta.title), rawMessage: message || undefined };
    }
  }

  // Unrecognized failures keep their original message — it is the most
  // specific thing we have for cases the mapping doesn't cover (e.g. a
  // backend sign-in challenge rejection), and the generic string is only used
  // when there is nothing else to show.
  const fallback: WalletConnectErrorData = {
    ...CATEGORY_META[WALLET_CATEGORY.UNKNOWN],
    docsUrl: troubleshootingUrl(CATEGORY_META[WALLET_CATEGORY.UNKNOWN].title),
  };
  return message ? { ...fallback, message } : fallback;
}
