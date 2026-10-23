jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    creator: {
      update: jest.fn(),
    },
    donation: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    subscription: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    withdrawal: {
      findMany: jest.fn(),
    },
    magicLinkToken: {
      deleteMany: jest.fn(),
    },
    oAuthIdentity: {
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import request from "supertest";
import { Prisma } from "@prisma/client";
import app from "../../app";
import prisma from "../../prisma";
import { generateToken } from "../../middleware/auth";
import { exportRateLimiter, BATCH_SIZE } from "../../routes/account";

const mockedPrisma = prisma as unknown as {
  user: { findUnique: jest.Mock; update: jest.Mock };
  creator: { update: jest.Mock };
  donation: { findMany: jest.Mock; updateMany: jest.Mock };
  subscription: { findMany: jest.Mock; updateMany: jest.Mock };
  withdrawal: { findMany: jest.Mock };
  magicLinkToken: { deleteMany: jest.Mock };
  oAuthIdentity: { deleteMany: jest.Mock };
  $transaction: jest.Mock;
};

const token = generateToken(1, "GACCOUNTUSERADDRESS");

beforeEach(() => {
  exportRateLimiter.clear();
  mockedPrisma.$transaction.mockImplementation((operations: Promise<unknown>[]) =>
    Promise.all(operations)
  );
  mockedPrisma.donation.findMany.mockResolvedValue([]);
  mockedPrisma.subscription.findMany.mockResolvedValue([]);
  mockedPrisma.withdrawal.findMany.mockResolvedValue([]);
  mockedPrisma.donation.updateMany.mockResolvedValue({ count: 0 });
  mockedPrisma.subscription.updateMany.mockResolvedValue({ count: 0 });
  mockedPrisma.creator.update.mockResolvedValue({});
  mockedPrisma.magicLinkToken.deleteMany.mockResolvedValue({ count: 0 });
  mockedPrisma.oAuthIdentity.deleteMany.mockResolvedValue({ count: 0 });
  mockedPrisma.user.update.mockResolvedValue({
    id: 1,
    walletAddress: "GACCOUNTUSERADDRESS",
    email: null,
    deletedAt: new Date("2026-09-24T00:00:00.000Z"),
  });
});

describe("GET /api/account/export", () => {
  it("rejects requests without an auth token", async () => {
    const res = await request(app).get("/api/account/export");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("returns the caller's data as a downloadable JSON file", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 1,
      walletAddress: "GACCOUNTUSERADDRESS",
      email: "a@b.c",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      deletedAt: null,
      creator: null,
    });
    const sent = [
      { id: 9, senderAddress: "GACCOUNTUSERADDRESS", amount: 5, currency: "XLM", message: "hi" },
    ];
    mockedPrisma.donation.findMany.mockResolvedValue(sent);

    const res = await request(app)
      .get("/api/account/export")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename="supportme-export-\d{4}-\d{2}-\d{2}\.json"/
    );
    expect(res.body.user.walletAddress).toBe("GACCOUNTUSERADDRESS");
    expect(res.body.donations.sent).toEqual(sent);
    expect(res.body.donations.received).toEqual([]);
    expect(res.body.subscriptions.asSupporter).toEqual([]);
    expect(res.body.creator).toBeNull();
    expect(typeof res.body.exportedAt).toBe("string");
  });

  it("includes creator-scoped history when the caller has a profile", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 1,
      walletAddress: "GACCOUNTUSERADDRESS",
      email: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      creator: { id: 4, userId: 1, username: "alice", walletAddress: "GACCOUNTUSERADDRESS" },
    });
    const received = [{ id: 3, creatorId: 4, senderAddress: "GOTHER", amount: 10 }];
    const withdrawals = [{ id: 2, creatorId: 4, anchorTxId: "anchor-1" }];
    mockedPrisma.donation.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(received);
    mockedPrisma.withdrawal.findMany.mockResolvedValue(withdrawals);

    const res = await request(app)
      .get("/api/account/export")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.creator.username).toBe("alice");
    expect(res.body.donations.received).toEqual(received);
    expect(res.body.withdrawals).toEqual(withdrawals);
  });

  it("rate limits the export endpoint per user (#369)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 1,
      walletAddress: "GACCOUNTUSERADDRESS",
      email: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      creator: null,
    });

    // 5 requests allowed
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .get("/api/account/export")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    }

    // 6th request is rate-limited
    const limitedRes = await request(app)
      .get("/api/account/export")
      .set("Authorization", `Bearer ${token}`);
    expect(limitedRes.status).toBe(429);
    expect(limitedRes.body.code).toBe("TOO_MANY_REQUESTS");
    expect(limitedRes.headers["retry-after"]).toBeDefined();
  });

  it("pages through large datasets using cursor-based batches (#369)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 1,
      walletAddress: "GACCOUNTUSERADDRESS",
      email: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      creator: null,
    });

    // Simulate batch 1 of size BATCH_SIZE and batch 2 of size 1
    const batch1 = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      id: 1000 - i,
      senderAddress: "GACCOUNTUSERADDRESS",
      amount: 1,
    }));
    const batch2 = [{ id: 1000 - BATCH_SIZE, senderAddress: "GACCOUNTUSERADDRESS", amount: 2 }];

    mockedPrisma.donation.findMany
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2);

    const res = await request(app)
      .get("/api/account/export")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(mockedPrisma.donation.findMany).toHaveBeenCalledTimes(2);
    // Verify second call used cursor from end of first batch
    expect(mockedPrisma.donation.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: { id: batch1[batch1.length - 1].id },
        skip: 1,
        take: BATCH_SIZE,
      })
    );
    expect(res.body.donations.sent).toHaveLength(BATCH_SIZE + 1);
  });
});

describe("POST /api/account/delete", () => {
  it("rejects requests without an auth token", async () => {
    const res = await request(app)
      .post("/api/account/delete")
      .send({ confirm: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("rejects a missing or incorrect confirmation word", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 1,
      walletAddress: "GACCOUNTUSERADDRESS",
      deletedAt: null,
      creator: null,
    });

    const missing = await request(app)
      .post("/api/account/delete")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("VALIDATION_ERROR");

    const wrong = await request(app)
      .post("/api/account/delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ confirm: "delete" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("VALIDATION_ERROR");
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("anonymizes personal data while preserving on-chain referenced records", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 1,
      walletAddress: "GACCOUNTUSERADDRESS",
      email: "a@b.c",
      deletedAt: null,
      creator: { id: 4, userId: 1, username: "alice" },
    });
    mockedPrisma.user.update.mockResolvedValue({
      id: 1,
      deletedAt: new Date("2026-09-24T00:00:00.000Z"),
    });

    const res = await request(app)
      .post("/api/account/delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ confirm: "DELETE" });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.deletedAt).toBe("2026-09-24T00:00:00.000Z");
    expect(res.body.preserved).toEqual(
      expect.arrayContaining(["walletAddress", "onChainDonationRecords", "onChainSubscriptionRecords"])
    );

    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { email: null, deletedAt: expect.any(Date) },
    });
    expect(mockedPrisma.oAuthIdentity.deleteMany).toHaveBeenCalledWith({
      where: { userId: 1 },
    });
    expect(mockedPrisma.magicLinkToken.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ userId: 1 }, { email: "a@b.c" }] },
    });
    expect(mockedPrisma.donation.updateMany).toHaveBeenCalledWith({
      where: { senderAddress: "GACCOUNTUSERADDRESS", message: { not: null } },
      data: { message: null },
    });
    expect(mockedPrisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { supporterAddress: "GACCOUNTUSERADDRESS", active: true },
      data: { active: false },
    });
    expect(mockedPrisma.creator.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: {
        displayName: null,
        bio: null,
        avatarUrl: null,
        socialLinks: Prisma.DbNull,
      },
    });
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("skips creator anonymization when the caller has no profile", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 1,
      walletAddress: "GACCOUNTUSERADDRESS",
      deletedAt: null,
      creator: null,
    });

    const res = await request(app)
      .post("/api/account/delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ confirm: "DELETE" });

    expect(res.status).toBe(200);
    expect(mockedPrisma.creator.update).not.toHaveBeenCalled();
  });

  it("is idempotent when the account was already deleted", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 1,
      walletAddress: "GACCOUNTUSERADDRESS",
      deletedAt: new Date("2026-09-01T00:00:00.000Z"),
      creator: null,
    });

    const res = await request(app)
      .post("/api/account/delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ confirm: "DELETE" });

    expect(res.status).toBe(200);
    expect(res.body.alreadyDeleted).toBe(true);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });
});
