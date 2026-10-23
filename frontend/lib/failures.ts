import { DonationError } from './contract';
import { troubleshootingUrl } from './docs';
import { WRONG_NETWORK_PATTERN } from './walletErrors';

/**
 * Shared copy for donation/subscription failure states, implementing the
 * message + recovery matrix in docs/design/donation-subscription-failure-states.md.
 * Every failure maps to a distinct title, explanation and recovery action so
 * flows surface something specific and actionable instead of a generic error.
 */

export type DonationFlow = 'donate' | 'subscribe' | 'cancel';

export interface FlowFailure {
  title: string;
  message: string;
  action: string;
  retryable: boolean;
  /** Link to this failure's section in docs/testnet-troubleshooting.md. */
  docsUrl: string;
}

/**
 * Every title the donation/subscription failure copy can show. Each must have
 * a matching heading in docs/testnet-troubleshooting.md (enforced by
 * troubleshootingDoc.test.ts), since failures link there via `docsUrl`.
 */
export const FAILURE_TITLES = {
  signatureDeclined: 'Signature declined',
  wrongNetwork: 'Wrong network',
  notEnoughBalance: 'Not enough balance',
  transactionRejected: 'Transaction rejected',
  confirmationTimedOut: 'Confirmation timed out',
  transactionFailed: 'Transaction failed',
  networkError: 'Network error',
  accountNotFunded: 'Account not funded',
  testnetReset: 'Testnet reset',
  missingTrustline: 'Missing trustline',
  donate: 'Donation failed',
  subscribe: "Couldn't start subscription",
  cancel: "Couldn't cancel subscription",
} as const;

const INSUFFICIENT_PATTERN = /insufficient|underfunded|allowance/i;
const TIMEOUT_PATTERN = /timed out|did not confirm|confirmation/i;
const TRUSTLINE_PATTERN = /no trustline|trustline missing|line not found|asset not trusted/i;

const FLOW_TITLES: Record<DonationFlow, string> = {
  donate: FAILURE_TITLES.donate,
  subscribe: FAILURE_TITLES.subscribe,
  cancel: FAILURE_TITLES.cancel,
};

export function describeDonationFailure(err: unknown, flow: 'donate' | 'subscribe'): FlowFailure {
  const failure = describeFailureCopy(err, flow);
  return { ...failure, docsUrl: troubleshootingUrl(failure.title) };
}

function describeFailureCopy(err: unknown, flow: 'donate' | 'subscribe'): Omit<FlowFailure, 'docsUrl'> {
  if (err instanceof DonationError) {
    if (err.type === 'wallet') {
      // A network mismatch can surface as our own WrongNetworkError (thrown
      // by lib/wallet before signing) or as a wallet-extension message that
      // only matches the wrong-network heuristics — either way the user must
      // switch networks, not "approve the request" like a plain decline.
      const cause = err.cause;
      const causeMessage =
        cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
      if (
        (cause instanceof Error && cause.name === 'WrongNetworkError') ||
        WRONG_NETWORK_PATTERN.test(causeMessage) ||
        WRONG_NETWORK_PATTERN.test(err.message || '')
      ) {
        return {
          title: FAILURE_TITLES.wrongNetwork,
          message:
            'Your wallet is set to a different network than the Stellar Testnet, so the transaction was not sent. No funds were moved.',
          action: 'Switch your wallet to the Stellar Testnet, then try again.',
          retryable: true,
        };
      }
      return {
        title: FAILURE_TITLES.signatureDeclined,
        message:
          'The transaction was cancelled or could not be approved in your wallet. No funds were moved.',
        action: 'Open your wallet and approve the request to try again.',
        retryable: true,
      };
    }

    if (err.type === 'simulation') {
      if (INSUFFICIENT_PATTERN.test(err.message || '')) {
        return {
          title: FAILURE_TITLES.notEnoughBalance,
          message:
            "Your wallet doesn't have enough to cover this amount plus the network fee.",
          action: 'Lower the amount or add funds to your wallet, then try again.',
          retryable: true,
        };
      }
      if (TRUSTLINE_PATTERN.test(err.message || '')) {
        return {
          title: FAILURE_TITLES.missingTrustline,
          message: `Your wallet doesn't have a trustline for this asset. You need to add a trustline before you can hold or send it.`,
          action: 'Add the trustline from the donate card, then try again.',
          retryable: true,
        };
      }
      return {
        title: FAILURE_TITLES.transactionRejected,
        message: err.message || 'The network rejected this transaction during simulation.',
        action: 'Check the amount and details, then try again.',
        retryable: true,
      };
    }

    if (err.type === 'network') {
      if (TIMEOUT_PATTERN.test(err.message || '')) {
        return {
          title: FAILURE_TITLES.confirmationTimedOut,
          message:
            'The network has not confirmed this transaction yet — it may still succeed.',
          action:
            'Check the transaction on Stellar Explorer before retrying, so you do not send it twice.',
          retryable: false,
        };
      }
      if (/failed on the network|rejected the transaction/i.test(err.message || '')) {
        return {
          title: FAILURE_TITLES.transactionFailed,
          message: err.message || 'The transaction failed on the network.',
          action:
            'Check the transaction on Stellar Explorer for the failure reason, then adjust and try again.',
          retryable: true,
        };
      }
      return {
        title: FAILURE_TITLES.networkError,
        message: err.message || "The Stellar network could not be reached.",
        action: 'Check your connection (the offline banner shows your status), then try again.',
        retryable: true,
      };
    }

    if (err.type === 'unfunded') {
      return {
        title: FAILURE_TITLES.accountNotFunded,
        message: 'Your wallet does not exist on the network yet. It needs to be funded first.',
        action: 'Use the Fund with Friendbot button to add testnet funds to your wallet.',
        retryable: true,
      };
    }

    if (err.type === 'reset') {
      return {
        title: FAILURE_TITLES.testnetReset,
        message: 'The Stellar Testnet was reset. The deployed contracts have been removed.',
        action: 'Check back later — the demo is being redeployed.',
        retryable: false,
      };
    }
  }

  return {
    title: FLOW_TITLES[flow],
    message: err instanceof Error && err.message ? err.message : 'Something unexpected went wrong.',
    action: 'Try again in a moment. If it keeps failing, come back later.',
    retryable: true,
  };
}

/**
 * Maps a subscription executor charge error (`Subscription.lastError`) to
 * supporter-facing copy for the Subscriptions page. Raw contract/RPC errors
 * are technical; these rephrase the common causes with what happens next.
 */
export function describeChargeFailure(lastError: string): string {
  // Checked before the insufficient-funds branch: "insufficient allowance" is
  // a renewal problem, not a top-up problem.
  if (/revoked|expired|allowance/i.test(lastError)) {
    return 'the payment allowance expired or was revoked — renew it from the Subscriptions page to resume charges.';
  }
  if (INSUFFICIENT_PATTERN.test(lastError)) {
    return "the supporter's wallet didn't have enough funds — it will retry automatically each cycle.";
  }
  if (TIMEOUT_PATTERN.test(lastError)) {
    return 'the network was slow to confirm — it will retry automatically next cycle.';
  }
  if (/network|rpc|fetch|connect/i.test(lastError)) {
    return 'the network was unreachable — it will retry automatically next cycle.';
  }
  return `${lastError} — it will retry automatically next cycle.`;
}
