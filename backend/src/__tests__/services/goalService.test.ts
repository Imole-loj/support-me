jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    goal: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

import { Prisma } from "@prisma/client";
import prisma from "../../prisma";
import { applyDonationToGoals, computePeriodEnd, resetDueGoals } from "../../services/goalService";

const mockedPrisma = prisma as unknown as {
  goal: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
};

// applyDonationToGoals takes a Prisma.TransactionClient — a plain mocked
// object with the same shape works fine since the goal delegate is all it
// ever touches.
const fakeTransactionClient = () => mockedPrisma as unknown as Prisma.TransactionClient;

type FakeGoal = {
  id: number;
  creatorId?: number;
  currency?: string;
  currentAmount: number | Prisma.Decimal;
  targetAmount?: number | Prisma.Decimal;
  recurring?: boolean;
  status?: string;
  recurrenceInterval?: string | null;
  currentPeriodEnd?: Date | null;
};

// Yields to the event loop so two "concurrent" donation flows can interleave
// between a mock's guard-evaluation and its write — the exact window in which
// the old read-modify-write code lost updates (issue #262).
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type GoalWhere = {
  id?: number;
  status?: string;
  recurring?: boolean;
  currentAmount?: { lt?: number | Prisma.Decimal };
  currentPeriodEnd?: { lte?: Date };
  creatorId?: number;
  currency?: string;
};

type GoalData = {
  currentAmount?: number | Prisma.Decimal | { increment?: number | Prisma.Decimal };
  status?: string;
  currentPeriodEnd?: Date;
};

function rowMatches(row: FakeGoal, where: GoalWhere): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.recurring !== undefined && row.recurring !== where.recurring) return false;
  if (where.currentAmount?.lt !== undefined) {
    const cur = new Prisma.Decimal(row.currentAmount);
    const limit = new Prisma.Decimal(where.currentAmount.lt);
    if (!cur.lt(limit)) return false;
  }
  if (
    where.currentPeriodEnd?.lte !== undefined &&
    !(row.currentPeriodEnd != null && row.currentPeriodEnd <= where.currentPeriodEnd.lte)
  )
    return false;
  return true;
}

function applyData(row: FakeGoal, data: GoalData): void {
  if (data.currentAmount !== undefined) {
    if (typeof data.currentAmount === "object" && "increment" in data.currentAmount) {
      const inc = data.currentAmount.increment!;
      row.currentAmount = new Prisma.Decimal(row.currentAmount).add(new Prisma.Decimal(inc)).toNumber();
    } else {
      row.currentAmount = new Prisma.Decimal(data.currentAmount).toNumber();
    }
  }
  if (data.status !== undefined) row.status = data.status;
  if (data.currentPeriodEnd !== undefined) row.currentPeriodEnd = data.currentPeriodEnd;
}

/**
 * Wires the prisma mock to an in-memory goal table with database-like write
 * semantics: increments are applied relative to the CURRENT row value, and
 * updateMany re-checks its WHERE guard after yielding the "row lock" — just
 * as Postgres does under READ COMMITTED, where a concurrent transaction's
 * committed change makes a stale guard match zero rows.
 */
function createGoalStore(initialGoals: FakeGoal[]) {
  const rows = new Map(initialGoals.map((goal) => [goal.id, { ...goal }]));

  mockedPrisma.goal.findMany.mockImplementation(async ({ where = {} }: { where?: GoalWhere } = {}) => {
    await tick();
    return [...rows.values()].filter((row) => rowMatches(row, where)).map((row) => ({ ...row }));
  });
  mockedPrisma.goal.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => {
    await tick();
    const row = rows.get(where.id);
    return row ? { ...row } : null;
  });
  mockedPrisma.goal.update.mockImplementation(async ({ where, data }: { where: { id: number }; data: GoalData }) => {
    const row = rows.get(where.id);
    if (!row) throw new Error(`No goal with id ${where.id}`);
    await tick();
    applyData(row, data);
    return { ...row };
  });
  mockedPrisma.goal.updateMany.mockImplementation(
    async ({ where = {}, data }: { where?: GoalWhere; data?: GoalData } = {}) => {
      const candidates = [...rows.values()].filter((row) => rowMatches(row, where));
      await tick();
      let count = 0;
      for (const row of candidates) {
        if (!rowMatches(row, where)) continue;
        applyData(row, data ?? {});
        count += 1;
      }
      return { count };
    }
  );

  return rows;
}

describe("applyDonationToGoals", () => {
  it("does nothing when the creator has no active goals in that currency", async () => {
    mockedPrisma.goal.findMany.mockResolvedValue([]);

    await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    expect(mockedPrisma.goal.update).not.toHaveBeenCalled();
    expect(mockedPrisma.goal.updateMany).not.toHaveBeenCalled();
  });

  it("applies the full donation amount to a single matching active goal", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 20, targetAmount: 100, recurring: false, status: "ACTIVE" },
    ]);

    await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    expect(mockedPrisma.goal.findMany).toHaveBeenCalledWith({
      where: { creatorId: 1, currency: "XLM", status: "ACTIVE" },
    });
    // The increment is applied by the database relative to the current row
    // value — never an absolute amount computed in JS from a possibly-stale
    // read, which is what lost concurrent donations (issue #262).
    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: "ACTIVE", currentAmount: { lt: 100 } },
      data: { currentAmount: { increment: 10 } },
    });
    expect(rows.get(1)!.currentAmount).toBe(30);
  });

  it("applies the FULL amount to every matching active goal, not a split", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 0, targetAmount: 1000, recurring: false, status: "ACTIVE" },
      { id: 2, creatorId: 1, currency: "XLM", currentAmount: 0, targetAmount: 1000, recurring: false, status: "ACTIVE" },
      { id: 3, creatorId: 1, currency: "XLM", currentAmount: 0, targetAmount: 1000, recurring: false, status: "ACTIVE" },
    ]);

    await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 50);

    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledTimes(3);
    for (const id of [1, 2, 3]) {
      expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
        where: { id, status: "ACTIVE", currentAmount: { lt: 1000 } },
        data: { currentAmount: { increment: 50 } },
      });
      expect(rows.get(id)!.currentAmount).toBe(50);
    }
  });

  it("marks a non-recurring goal COMPLETED once it reaches its target", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: false, status: "ACTIVE" },
    ]);

    const reached = await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: "ACTIVE", currentAmount: { lt: 100 } },
      data: { currentAmount: { increment: 10 } },
    });
    // The COMPLETED transition is conditional on the goal still being
    // ACTIVE, so a concurrent crossing can't flip it twice.
    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: "ACTIVE" },
      data: { status: "COMPLETED" },
    });
    expect(rows.get(1)!.currentAmount).toBe(105);
    expect(rows.get(1)!.status).toBe("COMPLETED");
    expect(reached).toEqual([expect.objectContaining({ id: 1, currentAmount: 105, status: "COMPLETED" })]);
  });

  it("does NOT mark a recurring goal COMPLETED when it reaches its target — it keeps accumulating until reset", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: true, status: "ACTIVE" },
    ]);

    const reached = await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    expect(mockedPrisma.goal.updateMany).not.toHaveBeenCalledWith({
      where: { id: 1, status: "ACTIVE" },
      data: { status: "COMPLETED" },
    });
    expect(rows.get(1)!.currentAmount).toBe(105);
    expect(rows.get(1)!.status).toBe("ACTIVE");
    expect(reached).toEqual([expect.objectContaining({ id: 1, currentAmount: 105, status: "ACTIVE" })]);
  });

  it("returns only the goals this donation carried to their target", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: false, status: "ACTIVE" },
      { id: 2, creatorId: 1, currency: "XLM", currentAmount: 0, targetAmount: 100, recurring: false, status: "ACTIVE" },
    ]);

    const reached = await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatchObject({ id: 1, currentAmount: 105, status: "COMPLETED" });
    expect(rows.get(2)!.currentAmount).toBe(10);
    expect(rows.get(2)!.status).toBe("ACTIVE");
  });

  it("reports a recurring goal as reached only on the donation that crosses its target", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: true, status: "ACTIVE" },
      { id: 2, creatorId: 1, currency: "XLM", currentAmount: 120, targetAmount: 100, recurring: true, status: "ACTIVE" },
    ]);

    const reached = await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10);

    // Goal 1 crossed the target; goal 2 was already past it, so the
    // below-target claim matches nothing and it just keeps accumulating
    // without being reported as reached.
    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatchObject({ id: 1, currentAmount: 105 });
    expect(rows.get(2)!.currentAmount).toBe(130);
  });

  it("only touches goals denominated in the donated currency", async () => {
    // findMany is already filtered by currency in the query itself, but this
    // asserts the call shape so a regression (e.g. dropping the `currency`
    // filter) is caught even though the mock would otherwise happily return
    // whatever it's told to.
    mockedPrisma.goal.findMany.mockResolvedValue([]);

    await applyDonationToGoals(fakeTransactionClient(), 1, "USDC", 10);

    expect(mockedPrisma.goal.findMany).toHaveBeenCalledWith({
      where: { creatorId: 1, currency: "USDC", status: "ACTIVE" },
    });
  });

  // Issue #18: `currency` is a free-form asset code, not an enum of known
  // assets — a new asset (USDT) needs zero changes here to work, since
  // amounts are tracked per-asset and matched by exact currency string (see
  // the multi-asset design-decision comment at the top of this file).
  it("applies a USDT donation the same way as any other asset — no special-casing needed", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "USDT", currentAmount: 40, targetAmount: 200, recurring: false, status: "ACTIVE" },
    ]);

    await applyDonationToGoals(fakeTransactionClient(), 1, "USDT", 15);

    expect(mockedPrisma.goal.findMany).toHaveBeenCalledWith({
      where: { creatorId: 1, currency: "USDT", status: "ACTIVE" },
    });
    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: "ACTIVE", currentAmount: { lt: 200 } },
      data: { currentAmount: { increment: 15 } },
    });
    expect(rows.get(1)!.currentAmount).toBe(55);
  });
});

describe("concurrent donations (issue #262)", () => {
  it("never loses an increment when two donations land at once", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 1000, recurring: false, status: "ACTIVE" },
    ]);

    await Promise.all([
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
    ]);

    // 95 + 10 + 10. With the old absolute-value writes both donations
    // started from the same stale 95 and the second clobbered the first,
    // leaving 105 instead of 115.
    expect(rows.get(1)!.currentAmount).toBe(115);
  });

  it("reports a non-recurring goal reached exactly once when concurrent donations cross the target together", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: false, status: "ACTIVE" },
    ]);

    const [first, second] = await Promise.all([
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
    ]);

    expect(rows.get(1)!.currentAmount).toBe(115);
    expect(rows.get(1)!.status).toBe("COMPLETED");
    expect(first.length + second.length).toBe(1);
  });

  it("reports a recurring goal's crossing exactly once under concurrency", async () => {
    const rows = createGoalStore([
      { id: 1, creatorId: 1, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: true, status: "ACTIVE" },
    ]);

    const [first, second] = await Promise.all([
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
      applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 10),
    ]);

    expect(rows.get(1)!.currentAmount).toBe(115);
    expect(rows.get(1)!.status).toBe("ACTIVE");
    expect(first.length + second.length).toBe(1);
  });
});

describe("computePeriodEnd", () => {
  it("computes a MONTHLY period end 30 days out", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const end = computePeriodEnd("MONTHLY", from);
    expect(end.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });

  it("computes a WEEKLY period end 7 days out", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const end = computePeriodEnd("WEEKLY", from);
    expect(end.toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });
});

describe("resetDueGoals", () => {
  it("resets currentAmount to 0, reactivates, and rolls currentPeriodEnd forward for every due recurring goal", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    const rows = createGoalStore([
      {
        id: 1,
        creatorId: 1,
        currency: "XLM",
        currentAmount: 500,
        targetAmount: 1000,
        recurring: true,
        recurrenceInterval: "MONTHLY",
        status: "COMPLETED",
        currentPeriodEnd: new Date("2026-01-31T00:00:00.000Z"),
      },
    ]);

    const count = await resetDueGoals(now);

    expect(mockedPrisma.goal.findMany).toHaveBeenCalledWith({
      where: { recurring: true, currentPeriodEnd: { lte: now } },
    });
    // The reset is re-guarded on the same due-condition the findMany used,
    // so a racing scheduler tick that already rolled the period forward
    // matches zero rows and can't reset the goal a second time (issue #262).
    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledWith({
      where: { id: 1, recurring: true, currentPeriodEnd: { lte: now } },
      data: {
        currentAmount: 0,
        status: "ACTIVE",
        currentPeriodEnd: computePeriodEnd("MONTHLY", now),
      },
    });
    expect(count).toBe(1);
    expect(rows.get(1)!.currentAmount).toBe(0);
    expect(rows.get(1)!.status).toBe("ACTIVE");
  });

  it("does not touch goals whose period has not yet ended", async () => {
    mockedPrisma.goal.findMany.mockResolvedValue([]);

    const count = await resetDueGoals(new Date("2026-02-01T00:00:00.000Z"));

    expect(mockedPrisma.goal.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.goal.update).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it("resets multiple due goals independently, using each one's own interval", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    const rows = createGoalStore([
      {
        id: 1,
        creatorId: 1,
        currency: "XLM",
        currentAmount: 10,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "MONTHLY",
        status: "ACTIVE",
        currentPeriodEnd: now,
      },
      {
        id: 2,
        creatorId: 1,
        currency: "XLM",
        currentAmount: 20,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "WEEKLY",
        status: "ACTIVE",
        currentPeriodEnd: now,
      },
    ]);

    const count = await resetDueGoals(now);

    expect(count).toBe(2);
    expect(rows.get(1)!.currentPeriodEnd).toEqual(computePeriodEnd("MONTHLY", now));
    expect(rows.get(2)!.currentPeriodEnd).toEqual(computePeriodEnd("WEEKLY", now));
    expect(rows.get(1)!.currentAmount).toBe(0);
    expect(rows.get(2)!.currentAmount).toBe(0);
  });

  it("does not re-reset a goal whose period a racing tick already rolled forward", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    const alreadyResetPeriodEnd = computePeriodEnd("MONTHLY", now);
    const rows = createGoalStore([
      {
        id: 1,
        creatorId: 1,
        currency: "XLM",
        currentAmount: 42,
        targetAmount: 100,
        recurring: true,
        recurrenceInterval: "MONTHLY",
        status: "ACTIVE",
        currentPeriodEnd: alreadyResetPeriodEnd,
      },
    ]);
    // Simulate the findMany snapshot having been taken before the racing
    // tick's reset committed — the goal looks due in the stale list, but
    // the guarded updateMany re-checks the row and finds it is not due.
    mockedPrisma.goal.findMany.mockResolvedValue([
      {
        id: 1,
        recurring: true,
        recurrenceInterval: "MONTHLY",
        currentAmount: 500,
        status: "COMPLETED",
        currentPeriodEnd: new Date("2026-01-31T00:00:00.000Z"),
      },
    ]);

    const count = await resetDueGoals(now);

    expect(count).toBe(0);
    expect(mockedPrisma.goal.updateMany).toHaveBeenCalledTimes(1);
    expect(rows.get(1)!.currentAmount).toBe(42);
    expect(rows.get(1)!.currentPeriodEnd).toEqual(alreadyResetPeriodEnd);
  });

  it("accumulates small donations using decimal arithmetic: 0.1 ten times reaches a goal of 1 and marks it complete (#372)", async () => {
    const rows = createGoalStore([
      {
        id: 1,
        creatorId: 1,
        currency: "XLM",
        currentAmount: new Prisma.Decimal(0),
        targetAmount: new Prisma.Decimal(1),
        recurring: false,
        status: "ACTIVE",
      },
    ]);

    let finalCompletedGoal: any = null;
    for (let i = 0; i < 10; i++) {
      const reached = await applyDonationToGoals(fakeTransactionClient(), 1, "XLM", 0.1);
      if (reached.length > 0) {
        finalCompletedGoal = reached[0];
      }
    }

    expect(rows.get(1)!.currentAmount).toBe(1);
    expect(rows.get(1)!.status).toBe("COMPLETED");
    expect(finalCompletedGoal).not.toBeNull();
    expect(finalCompletedGoal.status).toBe("COMPLETED");
  });
});
