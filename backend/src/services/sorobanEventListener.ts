import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import prisma from "../prisma";
import { networkReset } from "./networkReset";
import { eventListenerHealth } from "./eventListenerHealth";
import * as Sentry from "@sentry/node";
import {
  DONATION_EVENT,
  SUBSCRIPTION_CREATED_EVENT,
  SUBSCRIPTION_CANCELLED_EVENT,
  GOAL_UPDATED_EVENT,
  DONATION_RECORDED_EVENT,
  DonationEvent,
  SubscriptionCreatedEvent,
  SubscriptionCancelledEvent,
  GoalUpdatedEvent,
  DonationRecordedEvent,
  eventBus,
} from "./eventBus";
import { applyDonationToGoals } from "./goalService";
import { notifyDonationConfirmation, notifyDonationReceived, notifyGoalsReached } from "./donationNotifications";
import { resolveTokenCurrency } from "../lib/stellarAssets";

// On-chain amounts are integer stroops (1 unit = 1e7 stroops); Donation.amount
// is stored as a decimal in whole asset units, so divide before persisting.
const STROOPS_PER_UNIT = 1e7;

const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const DONATION_CONTRACT_ID = process.env.NEXT_PUBLIC_DONATION_CONTRACT_ID;
const CREATOR_REGISTRY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_CREATOR_REGISTRY_CONTRACT_ID;
const POLL_INTERVAL_MS =
  Number(process.env.SOROBAN_EVENTS_POLL_INTERVAL_MS) || 5000;
// How far back to look for events the first time the listener starts, so a
// freshly-restarted backend still surfaces recent events instead of only
// ones that happen after this exact moment.
const LOOKBACK_LEDGERS = Number(process.env.SOROBAN_EVENTS_LOOKBACK_LEDGERS) || 100;
// Soroban RPC getEvents returns at most this many events per call; paging
// within one tick until fewer than this many come back is what lets a
// backlog (e.g. after a restart, or a retention-window recovery) drain in
// one poll instead of trickling in one page every POLL_INTERVAL_MS (#268).
const EVENTS_PAGE_LIMIT = 50;
// Upper bound on pages drained in a single poll tick, so a pathological
// backlog cannot monopolize the event loop forever; the next tick resumes
// from wherever this one left off.
const MAX_PAGES_PER_TICK = 20;

/** DB row key (NetworkCheckpoint, the same table #278's reset detector uses) for the persisted cursor. */
export const EVENT_CURSOR_KEY = "soroban:eventListener:cursor";

/** Error messages Soroban RPC nodes use for a start position outside their retention window. */
function isOutOfRetentionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /before\s+(the\s+)?oldest|outside.*retention|retention\s+window|start\s+is\s+too\s+old/i.test(
    message
  );
}

export interface RawEvent {
  type: string;
  ledger: number;
  id: string;
  txHash: string;
  topic: string[];
  value: string;
}

export function decodeScVal(base64Xdr: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(base64Xdr, "base64"));
}

async function rpcCall<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (body.error) {
    throw new Error(`Soroban RPC ${method} failed: ${body.error.message}`);
  }
  return body.result as T;
}

/**
 * Polls the Soroban RPC's `getEvents` for events emitted by the SupportMe
 * smart contracts (`donated`, `subscribed`, `sub_cancelled`, `goal_upd`, `don_rec`).
 *
 * Emits events to `eventBus` for real-time SSE streaming, and executes
 * event-driven reconciliation (e.g. deactivating cancelled subscriptions,
 * updating creator goals) without requiring constant polling of contract RPCs.
 */
export class SorobanEventListener {
  // `undefined` means "not yet loaded from the DB this process" — distinct
  // from `null`, "loaded, and there genuinely is none yet" (#268). Without
  // that distinction the first poll after a restart cannot tell those two
  // cases apart and would always fall back to the lookback window, which is
  // exactly the bug this issue reports.
  private cursor: string | null | undefined = undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  start(): void {
    if (!DONATION_CONTRACT_ID) {
      console.warn(
        "SorobanEventListener: NEXT_PUBLIC_DONATION_CONTRACT_ID is not set, skipping event polling.",
      );
      return;
    }
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    void this.poll();
    console.log(
      `SorobanEventListener: polling ${RPC_URL} for contracts [${DONATION_CONTRACT_ID}${
        CREATOR_REGISTRY_CONTRACT_ID ? `, ${CREATOR_REGISTRY_CONTRACT_ID}` : ""
      }] every ${POLL_INTERVAL_MS}ms`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Drops the stored event cursor so the next poll re-derives its start ledger
   * from the current chain head. Used by the post-reset resync (#278): the old
   * cursor points into a ledger sequence that no longer exists.
   */
  async resetCursor(): Promise<void> {
    this.cursor = null;
    await this.clearStoredCursor();
    eventListenerHealth.setCursor(null);
    // A fresh chain after resync invalidates any prior out-of-retention gap
    // report too — it referred to the old (now-gone) chain's history.
    eventListenerHealth.clearGap();
  }

  /** Reads the persisted cursor (NetworkCheckpoint), or null if none is stored. */
  private async loadStoredCursor(): Promise<string | null> {
    const row = await prisma.networkCheckpoint.findUnique({
      where: { key: EVENT_CURSOR_KEY },
    });
    return row?.value ?? null;
  }

  private async saveCursor(cursor: string): Promise<void> {
    await prisma.networkCheckpoint.upsert({
      where: { key: EVENT_CURSOR_KEY },
      update: { value: cursor },
      create: { key: EVENT_CURSOR_KEY, value: cursor },
    });
    eventListenerHealth.setCursor(cursor);
  }

  private async clearStoredCursor(): Promise<void> {
    await prisma.networkCheckpoint.deleteMany({ where: { key: EVENT_CURSOR_KEY } });
  }

  /**
   * Processes a single raw contract event, parses its payload, emits on `eventBus`,
   * and triggers backend database reconciliation where applicable.
   * Public for deterministic testing without external RPC.
   */
  async processEvent(evt: RawEvent): Promise<boolean> {
    if (evt.type !== "contract") return false;

    const topics = evt.topic.map(decodeScVal);
    const eventType = topics[0] as string;

    switch (eventType) {
      case "donated": {
        const value = decodeScVal(evt.value) as {
          amount: bigint;
          memo?: string;
          timestamp: bigint;
          token?: string;
          donation_id?: bigint | number;
          fee_amount?: bigint;
          subscription_id?: bigint | number | null;
        };

        const donationId =
          value.donation_id != null ? Number(value.donation_id) : undefined;
        const feeAmount =
          value.fee_amount != null ? value.fee_amount.toString() : undefined;
        const subId =
          value.subscription_id != null
            ? Number(value.subscription_id)
            : undefined;
        const donor = topics[1] as string;
        const creator = topics[2] as string;
        const currency = resolveTokenCurrency(value.token ? String(value.token) : undefined);

        const payload: DonationEvent = {
          donor,
          creator,
          token: value.token ? String(value.token) : undefined,
          amount: value.amount.toString(),
          memo: value.memo || "",
          timestamp: Number(value.timestamp),
          ledger: evt.ledger,
          txHash: evt.txHash,
          donationId,
          feeAmount,
          subscriptionId: subId,
        };

        if (subId != null) {
          try {
            await prisma.subscription.updateMany({
              where: { onChainId: subId },
              data: {
                lastChargeTxHash: evt.txHash,
                lastChargedAt: new Date(Number(value.timestamp) * 1000),
                lastError: null,
                failureCount: 0,
              },
            });
          } catch (err) {
            console.error(
              `Failed to reconcile subscription ${subId} on donation event:`,
              err,
            );
          }
        }

        eventBus.emit(DONATION_EVENT, payload);

        await this.reconcileDonation(evt, donor, creator, {
          amount: value.amount,
          memo: value.memo || "",
          currency,
        });
        return true;
      }

      case "subscribed": {
        const value = decodeScVal(evt.value) as {
          subscription_id: bigint | number;
          token?: string;
          amount: bigint;
          interval_secs: bigint | number;
          next_charge_at?: bigint | number;
        };

        const payload: SubscriptionCreatedEvent = {
          supporter: topics[1] as string,
          creator: topics[2] as string,
          subscriptionId: Number(value.subscription_id),
          token: value.token ? String(value.token) : "XLM",
          amount: value.amount.toString(),
          intervalSecs: Number(value.interval_secs),
          nextChargeAt: value.next_charge_at ? Number(value.next_charge_at) : 0,
          ledger: evt.ledger,
          txHash: evt.txHash,
        };

        eventBus.emit(SUBSCRIPTION_CREATED_EVENT, payload);
        return true;
      }

      case "sub_cancelled": {
        const value = decodeScVal(evt.value) as {
          subscription_id: bigint | number;
        };

        const subId = Number(value.subscription_id);
        const payload: SubscriptionCancelledEvent = {
          supporter: topics[1] as string,
          creator: topics[2] ? (topics[2] as string) : undefined,
          subscriptionId: subId,
          ledger: evt.ledger,
          txHash: evt.txHash,
        };

        eventBus.emit(SUBSCRIPTION_CANCELLED_EVENT, payload);

        // State Reconciliation Flow:
        // Backend relies on events to mark subscription cancelled in DB
        // without requiring scheduled RPC polling for status checks.
        try {
          await prisma.subscription.updateMany({
            where: { onChainId: subId },
            data: { active: false },
          });
        } catch (err) {
          console.error(
            `SorobanEventListener: error reconciling cancelled subscription #${subId}:`,
            (err as Error).message,
          );
        }
        return true;
      }

      case "goal_upd": {
        const value = decodeScVal(evt.value) as {
          goal_amount: bigint | string | number;
          updated_at: bigint | number;
        };

        const creatorAddress = topics[1] as string;
        const goalAmountBigInt = BigInt(value.goal_amount);
        const goalAmountStr = goalAmountBigInt.toString();

        const payload: GoalUpdatedEvent = {
          creator: creatorAddress,
          goalAmount: goalAmountStr,
          updatedAt: Number(value.updated_at),
          ledger: evt.ledger,
          txHash: evt.txHash,
        };

        eventBus.emit(GOAL_UPDATED_EVENT, payload);

        // State Reconciliation Flow:
        // Update creator donation goal in database when updated on-chain
        try {
          await prisma.creator.updateMany({
            where: { walletAddress: creatorAddress },
            data: {
              donationGoal:
                goalAmountBigInt <= BigInt(2147483647)
                  ? Number(goalAmountBigInt)
                  : 2147483647,
            },
          });
        } catch (err) {
          console.error(
            `SorobanEventListener: error reconciling creator goal for ${creatorAddress}:`,
            (err as Error).message,
          );
        }
        return true;
      }

      case "don_rec": {
        const value = decodeScVal(evt.value) as {
          amount: bigint;
          total_donations: bigint;
          donation_count: number;
        };

        const payload: DonationRecordedEvent = {
          creator: topics[1] as string,
          amount: value.amount.toString(),
          totalDonations: value.total_donations.toString(),
          donationCount: Number(value.donation_count),
          ledger: evt.ledger,
          txHash: evt.txHash,
        };

        eventBus.emit(DONATION_RECORDED_EVENT, payload);
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Persists a `donated` event's Donation row and, exactly once, applies it to
   * the creator's goals and sends the donation/goal notifications (#259).
   *
   * The row's on-chain identity is `rpcEventId` (the RPC event id) with
   * `transactionHash`/`operationIndex`/`eventIndex` as the secondary identity a
   * client report already uses. A client report stores the row with
   * `verified: false`; this reconciliation flips it to `verified: true` and
   * fills in the authoritative amount/currency/sender/creator from the event.
   *
   * Idempotency: goals and notifications fire only for the call that actually
   * transitions the row into `verified: true` — determined atomically by a
   * conditional `updateMany({ where: { verified: false } })`, so a replay after
   * a restart lookback (or a concurrent client report) never double-counts.
   */
  private async reconcileDonation(
    evt: RawEvent,
    donorAddress: string,
    creatorAddress: string,
    onChain: { amount: bigint; memo: string; currency: string }
  ): Promise<void> {
    // walletAddress is not unique on Creator (only User's is), so resolve with
    // findFirst across any creator sharing the wallet address.
    const creator = await prisma.creator.findFirst({
      where: { walletAddress: creatorAddress },
      select: { id: true },
    });
    if (!creator) {
      console.warn(
        `SorobanEventListener: donated event ${evt.id} references unknown creator wallet ${creatorAddress}; skipping`
      );
      return;
    }

    const amount = Number(onChain.amount) / STROOPS_PER_UNIT;
    const identity = { transactionHash: evt.txHash, operationIndex: 0, eventIndex: 0 };

    try {
      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.donation.findFirst({
          where: {
            OR: [{ rpcEventId: evt.id }, identity],
          },
          select: { id: true, verified: true },
        });

        if (existing?.verified) {
          // Already reconciled (a replayed lookback, or the listener won a race
          // with itself) — nothing to apply.
          return null;
        }

        let donation;
        if (existing) {
          // A pending client report: verify it and backfill the authoritative
          // event data. The conditional guard keeps a concurrent reconciliation
          // from applying twice.
          const updated = await tx.donation.updateMany({
            where: { id: existing.id, verified: false },
            data: {
              verified: true,
              rpcEventId: evt.id,
              amount,
              currency: onChain.currency,
              senderAddress: donorAddress,
              creatorId: creator.id,
            },
          });
          if (updated.count === 0) return null;
          donation = await tx.donation.findUniqueOrThrow({ where: { id: existing.id } });
        } else {
          donation = await tx.donation.create({
            data: {
              creatorId: creator.id,
              senderAddress: donorAddress,
              amount,
              currency: onChain.currency,
              message: onChain.memo || null,
              transactionHash: evt.txHash,
              onChainEventId: `${evt.txHash}:0:0`,
              rpcEventId: evt.id,
              operationIndex: 0,
              eventIndex: 0,
              verified: true,
            },
          });
        }

        const reachedGoals = await applyDonationToGoals(tx, creator.id, onChain.currency, amount);
        return { donation, reachedGoals };
      });

      if (!result) return;

      // Notifications run after the transaction commits, and never let a mail
      // failure surface as an event-processing error.
      setImmediate(async () => {
        const [creatorResult, supporterResult] = await Promise.allSettled([
          notifyDonationReceived(result.donation),
          notifyDonationConfirmation(result.donation),
        ]);
        if (creatorResult.status === "rejected") {
          console.error(
            `SorobanEventListener: donation-received email failed for donation ${result.donation.id}:`,
            (creatorResult.reason as Error).message
          );
        }
        if (supporterResult.status === "rejected") {
          console.error(
            `SorobanEventListener: donation-confirmation email failed for donation ${result.donation.id}:`,
            (supporterResult.reason as Error).message
          );
        }
        try {
          await notifyGoalsReached(result.reachedGoals);
        } catch (error) {
          console.error(
            `SorobanEventListener: goals-reached notification failed for donation ${result.donation.id}:`,
            (error as Error).message
          );
        }
      });
    } catch (err) {
      // A unique-constraint loss means a concurrent writer already owns the
      // on-chain identity; that row's own reconciliation is authoritative.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
      console.error(
        `SorobanEventListener: error reconciling donated event ${evt.id}:`,
        (err as Error).message
      );
    }
  }

  private buildEventsParams(): Record<string, unknown> {
    const contractIds = [DONATION_CONTRACT_ID!];
    if (CREATOR_REGISTRY_CONTRACT_ID) {
      contractIds.push(CREATOR_REGISTRY_CONTRACT_ID);
    }
    return {
      filters: [{ type: "contract", contractIds }],
      pagination: { limit: EVENTS_PAGE_LIMIT },
    };
  }

  /**
   * Fetches one page starting from the current ledger lookback (used only
   * when there is no cursor at all — first-ever start, or right after a
   * resync). Separate from the cursor-based call below because this one
   * always derives a fresh `startLedger` and never supplies a cursor.
   */
  private async pollFromLookback(): Promise<{ events: RawEvent[] }> {
    const { sequence: latestLedger } = await rpcCall<{ sequence: number }>(
      "getLatestLedger",
      {}
    );
    const params = this.buildEventsParams();
    params.startLedger = Math.max(latestLedger - LOOKBACK_LEDGERS, 1);
    return rpcCall<{ events: RawEvent[] }>("getEvents", params);
  }

  /**
   * Restarts from the oldest ledger the RPC node still retains, after the
   * stored cursor was rejected as outside its retention window (#268). The
   * gap between the old cursor and this ledger is permanently lost — those
   * events can never be fetched from this (or any public) RPC node again —
   * so this records it on eventListenerHealth rather than pretending
   * nothing happened.
   */
  private async recoverFromOutOfRetention(): Promise<{ events: RawEvent[] }> {
    const { oldestLedger } = await rpcCall<{ oldestLedger: number }>("getHealth", {});
    console.warn(
      `SorobanEventListener: stored cursor is outside the RPC's retention window; ` +
        `restarting from the oldest retained ledger ${oldestLedger}. Events between the ` +
        `old cursor and this ledger were missed and cannot be recovered.`
    );
    eventListenerHealth.recordGap(oldestLedger);
    Sentry.captureMessage(
      `SorobanEventListener: cursor outside retention window, recovered from ledger ${oldestLedger}`,
      "warning"
    );

    const params = this.buildEventsParams();
    params.startLedger = oldestLedger;
    return rpcCall<{ events: RawEvent[] }>("getEvents", params);
  }

  private async fetchNextPage(): Promise<{ events: RawEvent[] }> {
    if (this.cursor) {
      const params = this.buildEventsParams();
      (params.pagination as Record<string, unknown>).cursor = this.cursor;
      try {
        return await rpcCall<{ events: RawEvent[] }>("getEvents", params);
      } catch (error) {
        if (!isOutOfRetentionError(error)) throw error;
        return this.recoverFromOutOfRetention();
      }
    }
    return this.pollFromLookback();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    // #278: once a reset is detected the listener is stopped, but a poll in
    // flight must not replay events from the dead network. Checking here too
    // keeps the guarantee local to the polling loop.
    if (networkReset.getState().status === "reset_detected") return;
    this.polling = true;
    try {
      // Run detection on the poll cadence as well: the executor only ticks
      // once a minute, so this is what makes a reset visible "within one poll
      // interval". check() is cheap and short-circuits once detected.
      if (await networkReset.check()) return;

      // Resume from the DB-persisted cursor (#268): `undefined` means this
      // process has not loaded it yet (fresh start or restart); `null` means
      // it was loaded and there genuinely is none, so the lookback below is
      // the correct fallback rather than a sign something went missing.
      if (this.cursor === undefined) {
        this.cursor = await this.loadStoredCursor();
        eventListenerHealth.setCursor(this.cursor);
      }

      // Drain within this tick while the RPC keeps returning a full page, so
      // a backlog (after a restart, or a retention-window recovery) catches
      // up in one poll instead of trickling in one page every interval.
      for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
        const result = await this.fetchNextPage();

        for (const evt of result.events) {
          await this.processEvent(evt);
        }

        if (result.events.length > 0) {
          this.cursor = result.events[result.events.length - 1].id;
          await this.saveCursor(this.cursor);
        }

        if (result.events.length < EVENTS_PAGE_LIMIT) break;
      }
    } catch (error) {
      console.error(
        "SorobanEventListener: poll failed:",
        (error as Error).message,
      );
    } finally {
      this.polling = false;
    }
  }
}

export const sorobanEventListener = new SorobanEventListener();
