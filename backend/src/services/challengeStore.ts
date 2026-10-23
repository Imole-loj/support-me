export interface StoredChallenge {
  id: string;
  walletAddress: string;
  message: string;
  expiresAt: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * In-process store for wallet sign-in challenges, with a bounded size and a
 * periodic sweep so abandoned challenges (a wallet that requests `/challenge`
 * and never calls `/verify`) are evicted instead of accumulating forever.
 *
 * Single-instance assumption: this lives in process memory, so a challenge
 * issued by one instance cannot be verified by another. Running more than one
 * API instance behind a load balancer needs a shared store (Redis or the
 * database) with a TTL; until then keep sign-in traffic on one instance or use
 * sticky sessions for `/api/auth`. This mirrors the RateLimiter and TtlCache
 * notes elsewhere in the backend.
 */
export class ChallengeStore {
  private readonly entries = new Map<string, StoredChallenge>();
  private readonly walletToChallengeId = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS
  ) {}

  set(walletAddress: string, challenge: StoredChallenge): void {
    const previousId = this.walletToChallengeId.get(walletAddress);
    if (previousId) {
      this.entries.delete(previousId);
    }

    const nextChallenge: StoredChallenge = {
      ...challenge,
      walletAddress,
      id: challenge.id || `${walletAddress}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    };

    this.entries.set(nextChallenge.id, nextChallenge);
    this.walletToChallengeId.set(walletAddress, nextChallenge.id);

    if (this.entries.size > this.maxEntries) {
      this.sweep();
      // Still over the cap (a flood of unexpired challenges): drop the oldest.
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value as string;
        const oldestChallenge = this.entries.get(oldest);
        this.entries.delete(oldest);
        if (oldestChallenge) {
          this.walletToChallengeId.delete(oldestChallenge.walletAddress);
        }
      }
    }
  }

  get(walletAddress: string): StoredChallenge | undefined {
    const challengeId = this.walletToChallengeId.get(walletAddress);
    if (!challengeId) return undefined;
    return this.entries.get(challengeId);
  }

  getById(challengeId: string): StoredChallenge | undefined {
    return this.entries.get(challengeId);
  }

  delete(walletAddress: string): void {
    const challengeId = this.walletToChallengeId.get(walletAddress);
    if (!challengeId) return;
    this.entries.delete(challengeId);
    this.walletToChallengeId.delete(walletAddress);
  }

  deleteById(challengeId: string): void {
    const challenge = this.entries.get(challengeId);
    if (!challenge) return;
    this.entries.delete(challengeId);
    this.walletToChallengeId.delete(challenge.walletAddress);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Removes every expired challenge. Returns how many were evicted. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, challenge] of this.entries) {
      if (challenge.expiresAt <= now) {
        this.entries.delete(key);
        this.walletToChallengeId.delete(challenge.walletAddress);
        removed++;
      }
    }
    return removed;
  }

  /** Starts the periodic sweep. The timer is unref'd so it never keeps the process alive. */
  startSweeping(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref();
  }

  stopSweeping(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  clear(): void {
    this.entries.clear();
    this.walletToChallengeId.clear();
  }
}
