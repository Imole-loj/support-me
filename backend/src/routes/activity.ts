import { Router } from "express";
import prisma from "../prisma";
import { asyncHandler } from "../middleware/asyncHandler";
import { toAmount } from "../lib/money";
import { TtlCache } from "../services/ttlCache";

const router = Router();

type EarningsByCurrency = Record<string, number>;

export interface ActivityOverview {
  totalSignups: number;
  totalCreators: number;
  earningsByCurrency: EarningsByCurrency;
}

export const activityOverviewCache = new TtlCache<ActivityOverview>(30_000);

// Public, unauthenticated platform totals for the /activity page (#147, #371).
// Deliberately aggregate-only: no names, wallet addresses, join dates or
// per-creator earnings are exposed here. Per-user financial data is not shown
// publicly without the user's explicit opt-in, and no such opt-in exists yet.
router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=30");

    const data = await activityOverviewCache.getOrSet("overview", async () => {
      const [totalSignups, totalCreators, totalByCurrency] = await Promise.all([
        prisma.user.count(),
        prisma.creator.count(),
        prisma.donation.groupBy({
          where: { verified: true },
          by: ["currency"],
          _sum: { amount: true },
        }),
      ]);

      const earningsByCurrency: EarningsByCurrency = {};
      for (const row of totalByCurrency) {
        earningsByCurrency[row.currency] = toAmount(row._sum.amount);
      }

      return { totalSignups, totalCreators, earningsByCurrency };
    });

    return res.json(data);
  })
);

export default router;
