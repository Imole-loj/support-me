jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    user: { count: jest.fn() },
    creator: { count: jest.fn() },
    donation: { groupBy: jest.fn() },
  },
}));

import request from "supertest";
import app from "../../app";
import prisma from "../../prisma";
import { activityOverviewCache } from "../../routes/activity";

const mockedPrisma = prisma as unknown as {
  user: { count: jest.Mock };
  creator: { count: jest.Mock };
  donation: { groupBy: jest.Mock };
};

beforeEach(() => {
  activityOverviewCache.clear();
  jest.clearAllMocks();
  mockedPrisma.user.count.mockResolvedValue(100);
  mockedPrisma.creator.count.mockResolvedValue(20);
  mockedPrisma.donation.groupBy.mockResolvedValue([
    { currency: "XLM", _sum: { amount: 500 } },
    { currency: "USDC", _sum: { amount: 250 } },
  ]);
});

describe("GET /api/activity/overview (#371)", () => {
  it("returns platform aggregations with Cache-Control header", async () => {
    const res = await request(app).get("/api/activity/overview");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=30");
    expect(res.body).toEqual({
      totalSignups: 100,
      totalCreators: 20,
      earningsByCurrency: {
        XLM: 500,
        USDC: 250,
      },
    });
    expect(mockedPrisma.user.count).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.creator.count).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.donation.groupBy).toHaveBeenCalledTimes(1);
  });

  it("reuses cached aggregations within TTL without querying database again", async () => {
    const res1 = await request(app).get("/api/activity/overview");
    expect(res1.status).toBe(200);

    const res2 = await request(app).get("/api/activity/overview");
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual(res1.body);

    // Queries should only have run once
    expect(mockedPrisma.user.count).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.creator.count).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.donation.groupBy).toHaveBeenCalledTimes(1);
  });

  it("queries the database again once the cache is expired or cleared", async () => {
    await request(app).get("/api/activity/overview");
    expect(mockedPrisma.user.count).toHaveBeenCalledTimes(1);

    activityOverviewCache.clear();

    mockedPrisma.user.count.mockResolvedValue(105);
    const res = await request(app).get("/api/activity/overview");
    expect(res.status).toBe(200);
    expect(res.body.totalSignups).toBe(105);
    expect(mockedPrisma.user.count).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/activity/overview — aggregation edge cases", () => {
  beforeEach(() => {
    activityOverviewCache.clear();
    jest.clearAllMocks();
  });

  it("returns totalSignups, totalCreators and earningsByCurrency", async () => {
    mockedPrisma.user.count.mockResolvedValue(42);
    mockedPrisma.creator.count.mockResolvedValue(7);
    mockedPrisma.donation.groupBy.mockResolvedValue([
      { currency: "USDC", _sum: { amount: "123.4560000" } },
      { currency: "XLM", _sum: { amount: "9.0000000" } },
    ]);

    const res = await request(app).get("/api/activity/overview");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalSignups: 42,
      totalCreators: 7,
      earningsByCurrency: { USDC: 123.456, XLM: 9 },
    });
  });

  it("groups by currency, mapping each row's sum independently", async () => {
    mockedPrisma.user.count.mockResolvedValue(0);
    mockedPrisma.creator.count.mockResolvedValue(0);
    mockedPrisma.donation.groupBy.mockResolvedValue([
      { currency: "USDC", _sum: { amount: "100" } },
      { currency: "EURC", _sum: { amount: "50" } },
      { currency: "XLM", _sum: { amount: "25" } },
    ]);

    const res = await request(app).get("/api/activity/overview");

    expect(res.body.earningsByCurrency).toEqual({ USDC: 100, EURC: 50, XLM: 25 });
  });

  it("only aggregates verified donations", async () => {
    mockedPrisma.user.count.mockResolvedValue(1);
    mockedPrisma.creator.count.mockResolvedValue(1);
    mockedPrisma.donation.groupBy.mockResolvedValue([]);

    await request(app).get("/api/activity/overview");

    expect(mockedPrisma.donation.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { verified: true } })
    );
  });

  it("returns an empty earningsByCurrency map when there are no verified donations", async () => {
    mockedPrisma.user.count.mockResolvedValue(5);
    mockedPrisma.creator.count.mockResolvedValue(2);
    mockedPrisma.donation.groupBy.mockResolvedValue([]);

    const res = await request(app).get("/api/activity/overview");

    expect(res.status).toBe(200);
    expect(res.body.earningsByCurrency).toEqual({});
  });

  it("treats a null sum for a currency group as 0", async () => {
    mockedPrisma.user.count.mockResolvedValue(3);
    mockedPrisma.creator.count.mockResolvedValue(1);
    mockedPrisma.donation.groupBy.mockResolvedValue([{ currency: "USDC", _sum: { amount: null } }]);

    const res = await request(app).get("/api/activity/overview");

    expect(res.body.earningsByCurrency).toEqual({ USDC: 0 });
  });

  it("propagates a database error to the error handler as a 500", async () => {
    mockedPrisma.user.count.mockRejectedValue(new Error("db unreachable"));
    mockedPrisma.creator.count.mockResolvedValue(0);
    mockedPrisma.donation.groupBy.mockResolvedValue([]);

    const res = await request(app).get("/api/activity/overview");

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
  });
});
