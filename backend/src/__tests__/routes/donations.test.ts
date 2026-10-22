jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    creator: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    donation: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    donationIdempotencyKey: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
      create: jest.fn(),
    },
    goal: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../services/email/mailer", () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import app from "../../app";
import prisma from "../../prisma";
import { sendEmail } from "../../services/email/mailer";

const mockedPrisma = prisma as unknown as {
  creator: { findUnique: jest.Mock; findFirst: jest.Mock };
  user: { findUnique: jest.Mock };
  donation: { findMany: jest.Mock; count: jest.Mock; create: jest.Mock; upsert: jest.Mock };
  donationIdempotencyKey: {
    findMany: jest.Mock;
    deleteMany: jest.Mock;
    findUnique: jest.Mock;
    delete: jest.Mock;
    create: jest.Mock;
  };
  goal: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  $transaction: jest.Mock;
};

const mockedSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;

beforeEach(() => {
  jest.clearAllMocks();
  mockedPrisma.$transaction.mockImplementation((callback: (client: typeof mockedPrisma) => unknown) =>
    callback(mockedPrisma)
  );
  mockedPrisma.donation.count.mockResolvedValue(0);
  mockedPrisma.donationIdempotencyKey.findMany.mockResolvedValue([]);
  mockedPrisma.donationIdempotencyKey.findUnique.mockResolvedValue(null);
  // No expired idempotency keys to clean up unless a test says otherwise.
  mockedPrisma.donationIdempotencyKey.findMany.mockResolvedValue([]);
  mockedPrisma.donationIdempotencyKey.deleteMany.mockResolvedValue({ count: 0 });
  // Default: the second creator.findUnique call inside notifyDonationReceived
  // (keyed by id, with the user relation included) finds nothing, and the
  // supporter's wallet address is unknown — both notifications degrade to
  // "no recipient" rather than throwing, unless a test overrides this.
  mockedPrisma.user.findUnique.mockResolvedValue(null);
  // The supporter is not itself a known creator, so receipts fall back to the
  // truncated address rather than a display name.
  mockedPrisma.creator.findFirst.mockResolvedValue(null);
  mockedSendEmail.mockResolvedValue(undefined);
  // No matching active goals by default — applyDonationToGoals is a no-op
  // unless a test explicitly sets up goals to be updated.
  mockedPrisma.goal.findMany.mockResolvedValue([]);
});

describe("GET /api/donations", () => {
  it("returns all donations ordered by creation date", async () => {
    const donations = [{ id: 1, creatorId: 1, senderAddress: "GABC", amount: 5 }];
    mockedPrisma.donation.findMany.mockResolvedValue(donations);

    const res = await request(app).get("/api/donations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: donations, pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    expect(mockedPrisma.donation.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      where: { verified: true },
      skip: 0,
      take: 20,
    });
  });

  it("exposes the durable on-chain identity as eventId", async () => {
    mockedPrisma.donation.findMany.mockResolvedValue([
      { id: 1, transactionHash: "tx-1", onChainEventId: "tx-1:0:0" },
    ]);

    const res = await request(app).get("/api/donations");

    expect(res.body.items[0].eventId).toBe("tx-1:0:0");
  });

  it("filters by creatorUsername when provided as a query param", async () => {
    mockedPrisma.donation.findMany.mockResolvedValue([]);

    await request(app).get("/api/donations").query({ creatorUsername: "bob" });

    expect(mockedPrisma.donation.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      where: { creator: { username: "bob" }, verified: true },
      skip: 0,
      take: 20,
    });
  });
});

describe("POST /api/donations", () => {
  it("rejects a request without an idempotency key", async () => {
    const res = await request(app).post("/api/donations").send({
      creatorUsername: "bob",
      senderAddress:
        "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 10,
      transactionHash: "tx-no-key",
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
  });

  it("rejects a request missing required fields with a validation error", async () => {
    const res = await request(app).post("/api/donations").send({ amount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when the target creator does not exist", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    const res = await request(app).post("/api/donations").set("Idempotency-Key", "missing-creator").send({
      creatorUsername: "unknown",
      senderAddress:
        "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 10,
      transactionHash: "tx-missing-creator",
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  // Issue #258: a report with no transactionHash can never be corroborated
  // on-chain, so it must be rejected outright rather than stored as a
  // (fake) verified donation.
  it("rejects a donation report without a transactionHash", async () => {
    const res = await request(app).post("/api/donations").set("Idempotency-Key", "no-hash").send({
      creatorUsername: "bob",
      senderAddress:
        "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 10,
      message: "nice work",
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(mockedPrisma.donation.create).not.toHaveBeenCalled();
    expect(mockedPrisma.donation.upsert).not.toHaveBeenCalled();
  });

  it("stores a client-reported donation as verified: false", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, username: "bob" });
    const created = {
      id: 1,
      creatorId: 7,
      senderAddress:
        "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 10,
      currency: "XLM",
      transactionHash: "tx-1",
    };
    mockedPrisma.donation.upsert.mockResolvedValue(created);

    const res = await request(app).post("/api/donations").set("Idempotency-Key", "donation-1").send({
      creatorUsername: "bob",
      senderAddress:
        "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 10,
      message: "nice work",
      transactionHash: "tx-1",
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    // Only server-side verification (the event listener / subscription
    // executor) may mark a row verified — never the client report itself.
    expect(mockedPrisma.donation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ transactionHash: "tx-1", verified: false }),
      })
    );

    // ...and the public feed only ever serves verified rows, so a provisional
    // report does not appear there until it is verified.
    mockedPrisma.donation.findMany.mockResolvedValue([]);
    await request(app).get("/api/donations");
    expect(mockedPrisma.donation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { verified: true } })
    );
  });

  it("upserts a reported on-chain event by transaction and event index", async () => {
    const created = { id: 2, creatorId: 7, amount: 1.5, transactionHash: "tx-1" };
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, username: "bob" });
    mockedPrisma.donation.upsert.mockResolvedValue(created);

    const res = await request(app)
      .post("/api/donations")
      .set("Idempotency-Key", "donation-2")
      .send({
        creatorUsername: "bob",
        senderAddress:
          "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
        amount: 1.5,
        transactionHash: "tx-1",
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(mockedPrisma.donation.upsert).toHaveBeenCalledWith({
      where: {
        transactionHash_operationIndex_eventIndex: {
          transactionHash: "tx-1",
          operationIndex: 0,
          eventIndex: 0,
        },
      },
      update: {},
      create: expect.objectContaining({
        transactionHash: "tx-1",
        onChainEventId: "tx-1:0:0",
        operationIndex: 0,
        eventIndex: 0,
        verified: false,
      }),
    });
  });

  it("does not apply an unverified on-chain report to goals or send notifications (#260)", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, username: "bob" });
    // The listener has not yet verified this tx hash, so the row is
    // provisional and must not touch goal progress or trigger any email.
    mockedPrisma.donation.upsert.mockResolvedValue({
      id: 2,
      creatorId: 7,
      amount: 500,
      currency: "XLM",
      transactionHash: "tx-unverified",
      verified: false,
    });

    const res = await request(app)
      .post("/api/donations")
      .set("Idempotency-Key", "donation-unverified")
      .send({
        creatorUsername: "bob",
        senderAddress:
          "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
        amount: 500,
        currency: "XLM",
        transactionHash: "tx-unverified",
      });

    expect(res.status).toBe(201);
    expect(res.body.verified).toBe(false);
    expect(mockedPrisma.goal.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.goal.update).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it("returns the original donation for a repeated idempotency key", async () => {
    const original = { id: 1, creatorId: 7, amount: 10 };
    mockedPrisma.donationIdempotencyKey.findUnique.mockResolvedValue({
      key: "donation-1",
      expiresAt: new Date(Date.now() + 60_000),
      donation: original,
    });

    const res = await request(app)
      .post("/api/donations")
      .set("Idempotency-Key", "donation-1")
      .send({
        creatorUsername: "bob",
        senderAddress:
          "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
        amount: 99,
        transactionHash: "tx-replay",
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(original);
    expect(mockedPrisma.donation.create).not.toHaveBeenCalled();
    // A repeated idempotency key must not double-apply the donation to goal
    // progress — the original call already did.
    expect(mockedPrisma.goal.findMany).not.toHaveBeenCalled();
  });

  it("does not apply an unverified client report to goals", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, username: "bob" });
    mockedPrisma.donation.upsert.mockResolvedValue({
      id: 1,
      creatorId: 7,
      amount: 10,
      currency: "XLM",
    });
    // Two active XLM goals and one already-completed USDC goal — only the
    // active, currency-matching goals should be findMany'd/updated.
    const activeGoalXlm = { id: 1, creatorId: 7, currency: "XLM", currentAmount: 5, targetAmount: 100, recurring: false, status: "ACTIVE" };
    const activeGoalXlm2 = { id: 2, creatorId: 7, currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: false, status: "ACTIVE" };
    const goals = [activeGoalXlm, activeGoalXlm2];
    mockedPrisma.goal.findMany.mockResolvedValue(goals);
    // Claim (below-target guard) matches both fixtures; only goal 2 is at
    // or above its target when re-checked for the COMPLETED flip.
    mockedPrisma.goal.updateMany.mockImplementation(async ({ where, data }) => {
      const goal = goals.find((g) => g.id === where.id);
      if (where.currentAmount?.lt !== undefined) {
        return { count: goal && goal.currentAmount < where.currentAmount.lt ? 1 : 0 };
      }
      if (data.status === "COMPLETED") return { count: 1 };
      return { count: 0 };
    });
    mockedPrisma.goal.findUnique.mockImplementation(async ({ where }) =>
      where.id === 2 ? { ...activeGoalXlm2, currentAmount: 105 } : { ...activeGoalXlm }
    );

    const res = await request(app).post("/api/donations").set("Idempotency-Key", "donation-goal-1").send({
      creatorUsername: "bob",
      senderAddress: "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 10,
      currency: "XLM",
      transactionHash: "tx-goal-1",
    });

    expect(res.status).toBe(201);
    expect(mockedPrisma.goal.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.goal.updateMany).not.toHaveBeenCalled();
  });

  it("does not email goal progress for an unverified client report", async () => {
    const creator = { id: 7, username: "bob", user: { email: "bob@example.com" } };
    mockedPrisma.creator.findUnique.mockResolvedValue(creator);
    mockedPrisma.donation.upsert.mockResolvedValue({ id: 1, creatorId: 7, amount: 10, currency: "XLM" });
    const goal = { id: 2, creatorId: 7, title: "New mic", currency: "XLM", currentAmount: 95, targetAmount: 100, recurring: false, status: "ACTIVE" };
    mockedPrisma.goal.findMany.mockResolvedValue([goal]);
    mockedPrisma.goal.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.currentAmount?.lt !== undefined) return { count: 1 };
      if (data.status === "COMPLETED") return { count: 1 };
      return { count: 0 };
    });
    mockedPrisma.goal.findUnique.mockResolvedValue({ ...goal, currentAmount: 105 });

    const res = await request(app).post("/api/donations").set("Idempotency-Key", "donation-goal-reached").send({
      creatorUsername: "bob",
      senderAddress: "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 10,
      currency: "XLM",
      transactionHash: "tx-goal-reached",
    });

    expect(res.status).toBe(201);
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  // Issue #18: USDT is just another asset code — createDonationSchema's
  // `currency` field isn't an enum of known assets, so nothing here should
  // need special-casing for a new one to work end-to-end.
  it("records a provisional USDT donation without applying it to goals", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, username: "bob" });
    mockedPrisma.donation.upsert.mockResolvedValue({
      id: 1,
      creatorId: 7,
      amount: 25,
      currency: "USDT",
    });
    const activeGoalUsdt = {
      id: 3,
      creatorId: 7,
      currency: "USDT",
      currentAmount: 0,
      targetAmount: 100,
      recurring: false,
      status: "ACTIVE",
    };
    mockedPrisma.goal.findMany.mockResolvedValue([activeGoalUsdt]);
    // The claim matches (0 < 100) and the increment lands below the target,
    // so no COMPLETED flip follows and the goal simply keeps accumulating.
    mockedPrisma.goal.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.goal.findUnique.mockResolvedValue({ ...activeGoalUsdt, currentAmount: 25 });

    const res = await request(app).post("/api/donations").set("Idempotency-Key", "donation-usdt-1").send({
      creatorUsername: "bob",
      senderAddress: "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 25,
      currency: "USDT",
      transactionHash: "tx-usdt-1",
    });

    expect(res.status).toBe(201);
    expect(res.body.currency).toBe("USDT");
    expect(mockedPrisma.donation.upsert).toHaveBeenCalledWith({
      where: {
        transactionHash_operationIndex_eventIndex: {
          transactionHash: "tx-usdt-1",
          operationIndex: 0,
          eventIndex: 0,
        },
      },
      update: {},
      create: expect.objectContaining({ currency: "USDT", amount: 25 }),
    });
    expect(mockedPrisma.goal.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.goal.updateMany).not.toHaveBeenCalled();
  });

  it("does not apply a USDT donation to an XLM-denominated goal", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, username: "bob" });
    mockedPrisma.donation.upsert.mockResolvedValue({ id: 1, creatorId: 7, amount: 25, currency: "USDT" });
    // findMany is already scoped by currency in the query, so an XLM goal
    // would never be returned for a USDT donation — asserting the empty
    // result here confirms update is correctly skipped.
    mockedPrisma.goal.findMany.mockResolvedValue([]);

    await request(app).post("/api/donations").set("Idempotency-Key", "donation-usdt-2").send({
      creatorUsername: "bob",
      senderAddress: "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 25,
      currency: "USDT",
      transactionHash: "tx-usdt-2",
    });

    expect(mockedPrisma.goal.update).not.toHaveBeenCalled();
    expect(mockedPrisma.goal.updateMany).not.toHaveBeenCalled();
  });

  describe("donation notifications (#17)", () => {
    const SENDER_ADDRESS = "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW";
    const created = {
      id: 1,
      creatorId: 7,
      senderAddress: SENDER_ADDRESS,
      amount: 10,
      currency: "XLM",
      message: "nice work",
      transactionHash: "tx-notify",
      // The receipt template formats this date; without it rendering throws
      // and the (deliberately non-fatal) notification is skipped.
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    };

    function mockCreatorLookups(withEmail: boolean) {
      // creator.findUnique is called twice with different `where` clauses:
      // once by username inside the transaction, once by id (with the user
      // relation) inside notifyDonationReceived. Branch on the shape of
      // `where` to answer each correctly.
      mockedPrisma.creator.findUnique.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        if ("username" in where) return Promise.resolve({ id: 7, username: "bob" });
        return Promise.resolve({
          id: 7,
          username: "bob",
          displayName: "Bob",
          user: withEmail ? { email: "bob@example.com" } : { email: null },
        });
      });
    }

    it("does not email the creator before the donation is verified", async () => {
      mockCreatorLookups(true);
      mockedPrisma.donation.upsert.mockResolvedValue(created);

      const res = await request(app).post("/api/donations").set("Idempotency-Key", "notify-1").send({
        creatorUsername: "bob",
        senderAddress: SENDER_ADDRESS,
        amount: 10,
        message: "nice work",
        transactionHash: "tx-notify-1",
      });

      expect(res.status).toBe(201);
      expect(mockedSendEmail).not.toHaveBeenCalled();
    });

    it("does not email the creator when they have no email on file, and does not fail the request", async () => {
      mockCreatorLookups(false);
      mockedPrisma.donation.upsert.mockResolvedValue(created);

      const res = await request(app).post("/api/donations").set("Idempotency-Key", "notify-2").send({
        creatorUsername: "bob",
        senderAddress: SENDER_ADDRESS,
        amount: 10,
        transactionHash: "tx-notify-2",
      });

      expect(res.status).toBe(201);
      expect(mockedSendEmail).not.toHaveBeenCalled();
    });

    it("does not email the supporter before the donation is verified", async () => {
      mockCreatorLookups(false);
      mockedPrisma.donation.upsert.mockResolvedValue(created);
      mockedPrisma.user.findUnique.mockResolvedValue({
        id: 3,
        walletAddress: SENDER_ADDRESS,
        email: "supporter@example.com",
      });

      const res = await request(app).post("/api/donations").set("Idempotency-Key", "notify-3").send({
        creatorUsername: "bob",
        senderAddress: SENDER_ADDRESS,
        amount: 10,
        transactionHash: "tx-notify-3",
      });

      expect(res.status).toBe(201);
      expect(mockedSendEmail).not.toHaveBeenCalled();
    });

    it("does not send any notification when replaying an existing idempotency key (no new donation)", async () => {
      const original = { id: 1, creatorId: 7, amount: 10 };
      mockedPrisma.donationIdempotencyKey.findUnique.mockResolvedValue({
        key: "notify-4",
        expiresAt: new Date(Date.now() + 60_000),
        donation: original,
      });

      const res = await request(app).post("/api/donations").set("Idempotency-Key", "notify-4").send({
        creatorUsername: "bob",
        senderAddress: SENDER_ADDRESS,
        amount: 99,
        transactionHash: "tx-notify-4",
      });

      expect(res.status).toBe(201);
      expect(mockedSendEmail).not.toHaveBeenCalled();
    });

    it("returns 201 without attempting email delivery for an unverified donation", async () => {
      mockCreatorLookups(true);
      mockedPrisma.donation.upsert.mockResolvedValue(created);
      mockedSendEmail.mockRejectedValue(new Error("email provider down"));

      const res = await request(app).post("/api/donations").set("Idempotency-Key", "notify-5").send({
        creatorUsername: "bob",
        senderAddress: SENDER_ADDRESS,
        amount: 10,
        transactionHash: "tx-notify-5",
      });

      expect(res.status).toBe(201);
      expect(mockedSendEmail).not.toHaveBeenCalled();
      // The donation is already committed, so the client still gets it back —
      // compared through JSON because createdAt is a Date in the fixture and
      // a string once it has crossed the HTTP boundary.
      expect(res.body).toEqual(JSON.parse(JSON.stringify(created)));
    });
  });
});
