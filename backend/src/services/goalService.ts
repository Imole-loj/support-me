import { Prisma, Goal, RecurrenceInterval } from "@prisma/client";
import prisma from "../prisma";
import { toAmount, MoneyValue } from "../lib/money";

export function formatGoalAmounts<T extends { targetAmount?: any; currentAmount?: any }>(goal: T): T {
  return {
    ...goal,
    ...(goal.targetAmount !== undefined ? { targetAmount: toAmount(goal.targetAmount) } : {}),
    ...(goal.currentAmount !== undefined ? { currentAmount: toAmount(goal.currentAmount) } : {}),
  };
}

/**
 * Shared goal logic used by the donation-recording routes
 * (routes/donations.ts, services/subscriptionExecutor.ts) and by the
 * recurring-reset scheduler (services/goalResetScheduler.ts).
 *
 * Multi-asset design decision (issue #18): goal amounts are tracked
 * per-asset, never normalized to USD. This is a testnet demo app with no
 * price oracle, and the existing single-goal model already assumed one
 * amount unit — adding real USD normalization here would require
 * integrating an external price feed, which is out of scope for this
 * change. A goal is denominated in exactly one `currency` (its `currency`
 * field); a donation only ever contributes to goals whose currency matches
 * the donation's own `currency`/asset code. Multi-asset totals (e.g. a
 * creator's overall "goals" view) are therefore a per-asset breakdown, not a
 * single blended number — see routes/creators.ts's goals list, which
 * returns each goal with its own currency rather than summing across them.
 */

/**
 * Donation-to-goal split rule (issue #20 acceptance criteria: "Donations
 * update the correct goal's progress"):
 *
 * A donation is applied IN FULL to every one of the creator's ACTIVE goals
 * denominated in the same currency as the donation — not divided/split
 * across them. Rationale: each goal is an independent target (e.g. "New
 * microphone — 500 XLM" and "Monthly support — 2000 XLM"); a supporter's tip
 * is genuine progress toward both at once, the same way it would be if the
 * creator tracked each goal by hand. Splitting the amount evenly across N
 * goals would mean adding a second goal silently halves the progress rate on
 * the first, which is surprising to the creator and actively punishes having
 * multiple goals. Applying the full amount to every matching active goal
 * keeps each goal's meaning ("progress toward this specific target")
 * independent of how many other goals happen to exist alongside it.
 *
 * Returns the goals this donation carried to their target, so the caller can
 * send goal-reached notifications once its transaction has committed.
 */
export async function applyDonationToGoals(
  client: Prisma.TransactionClient,
  creatorId: number,
  currency: string,
  amount: MoneyValue
): Promise<Goal[]> {
  const matchingGoals = await client.goal.findMany({
    where: { creatorId, currency, status: "ACTIVE" },
  });
  if (matchingGoals.length === 0) return [];

  const results = await Promise.all(
    matchingGoals.map((goal) => applyAmountToGoal(client, goal, amount))
  );
  return results.filter((goal): goal is Goal => goal !== null);
}

/**
 * Increments one goal's progress and flips it to COMPLETED once it reaches its target (non-recurring goals only — a recurring goal keeps accepting donations until its period resets, see goalResetScheduler.ts).
 * Returns the updated goal if this donation is the one that reached the target, otherwise null.
 *
 * Issue #262: this used to compute `goal.currentAmount + amount` in JS from
 * the value read by applyDonationToGoals's findMany and write the absolute
 * result back — two concurrent donations would both start from the same
 * stale `currentAmount` and the second write would silently erase the first
 * (lost update). The increment is now applied by the database relative to
 * the current row value, inside a guarded conditional update so that of any
 * number of concurrent donations, exactly one "claims" the below-target →
 * at-or-above-target crossing (Postgres re-evaluates the WHERE clause after
 * the row lock is released, so a loser of the race sees the winner's new
 * value and matches zero rows).
 */
async function applyAmountToGoal(
  client: Prisma.TransactionClient,
  goal: Goal,
  amount: MoneyValue
): Promise<Goal | null> {
  // Claim + increment in one atomic statement: only while the goal is still
  // ACTIVE and below its target. The amount is added by the database, never
  // computed from a possibly-stale read.
  const claimed = await client.goal.updateMany({
    where: {
      id: goal.id,
      status: "ACTIVE",
      currentAmount: { lt: goal.targetAmount },
    },
    data: { currentAmount: { increment: amount } },
  });

  if (claimed.count === 0) {
    // The goal was already at/above its target when this donation arrived
    // (a later donation in the same period, or a concurrent donation already
    // carried it over) — still apply the amount so no progress is lost,
    // just without reporting a "reached" event.
    await client.goal.update({
      where: { id: goal.id },
      data: { currentAmount: { increment: amount } },
    });
    return null;
  }

  const updated = await client.goal.findUnique({ where: { id: goal.id } });
  // The increment alone didn't carry the goal to its target (#372: exact decimal arithmetic).
  if (!updated) return null;
  const current = new Prisma.Decimal(updated.currentAmount);
  const target = new Prisma.Decimal(goal.targetAmount);
  if (current.lt(target)) return null;

  if (goal.recurring) {
    // A recurring goal stays ACTIVE past its target — "completed" isn't a
    // meaningful end state for something that resets on a schedule; it just
    // keeps accumulating until the next period. The claim guard above means
    // only the crossing donation reports it as reached.
    return updated;
  }

  // Flip to COMPLETED conditionally so this can happen at most once: only
  // the first donation to flip ACTIVE → COMPLETED counts as "reached".
  const flipped = await client.goal.updateMany({
    where: { id: goal.id, status: "ACTIVE" },
    data: { status: "COMPLETED" },
  });
  return flipped.count === 1 ? { ...updated, status: "COMPLETED" as const } : null;
}

const INTERVAL_MS: Record<RecurrenceInterval, number> = {
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
  MONTHLY: 30 * 24 * 60 * 60 * 1000,
};

/** The instant a new/reset period for this recurrence interval should end, measured from `from` (defaults to now). */
export function computePeriodEnd(interval: RecurrenceInterval, from: Date = new Date()): Date {
  return new Date(from.getTime() + INTERVAL_MS[interval]);
}

/** Only exported for tests — the scheduler in goalResetScheduler.ts is the real caller. */
export async function resetDueGoals(now: Date = new Date()): Promise<number> {
  const due = await prisma.goal.findMany({
    where: { recurring: true, currentPeriodEnd: { lte: now } },
  });

  let resetCount = 0;
  for (const goal of due) {
    // recurrenceInterval is guaranteed non-null whenever recurring is true
    // (enforced by the create/update schemas), but Prisma's generated type
    // still models it as nullable — fall back to MONTHLY defensively rather
    // than throwing and skipping the reset entirely.
    const interval = goal.recurrenceInterval ?? "MONTHLY";
    // Guard the reset with the same due-condition the findMany used (issue
    // #262): a second scheduler tick that raced this one re-checks the
    // condition after taking the row lock, finds currentPeriodEnd already
    // rolled forward, and matches zero rows — the period can't advance
    // twice. An in-flight donation increment racing here is relative, so it
    // either lands before the reset (zeroed, as intended) or after it
    // (counts toward the fresh period) instead of overwriting the reset
    // with a stale absolute value.
    const result = await prisma.goal.updateMany({
      where: { id: goal.id, recurring: true, currentPeriodEnd: { lte: now } },
      data: {
        currentAmount: 0,
        status: "ACTIVE",
        currentPeriodEnd: computePeriodEnd(interval, now),
      },
    });
    resetCount += result.count;
  }

  return resetCount;
}
