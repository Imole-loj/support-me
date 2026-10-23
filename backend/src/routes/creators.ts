import { Router } from "express";
import { Prisma, Creator } from "@prisma/client";
import prisma from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import {
  createCreatorParamsSchema,
  createCreatorSchema,
  leaderboardQuerySchema,
  listCreatorsQuerySchema,
  updateCreatorSchema,
  updateThemeSchema,
  usernameParamSchema,
} from "../schemas/creators";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../errors/AppError";
import { challenges } from "./auth";
import { verifyWalletOwnership } from "../services/walletProof";
import { TtlCache } from "../services/ttlCache";
import { toAmount } from "../lib/money";
import { getCreatorStats } from "../services/creatorStats";

const router = Router();

// Cache creator profile lookups by username with a 5-minute TTL.
// Profiles change infrequently, so this reduces DB load while staying fresh.
// Exported so tests can reset it between cases.
export const creatorProfileCache = new TtlCache<Creator>(5 * 60 * 1000);

interface LeaderboardEntry {
  rank: number;
  total: number;
  donationCount: number;
}

interface CreatorLeaderboardEntry extends LeaderboardEntry {
  creator: { id: number; username: string; displayName: string | null; avatarUrl: string | null };
}

interface SupporterLeaderboardEntry extends LeaderboardEntry {
  // Supporters are wallet addresses, not necessarily linked accounts —
  // most donors never create a SupportMe account at all.
  senderAddress: string;
}

// Aggregation scans every donation row for the chosen currency, which gets
// more expensive as donation volume grows (#16's own stated concern); a
// short TTL keeps the leaderboard responsive without needing a shared
// cache/Redis for a single-instance API, while still being fresh within a
// donation's-eye-view of "shortly after it happened". Exported so tests
// can reset it between cases instead of sharing state across the file.
export const leaderboardCache = new TtlCache<{ entries: LeaderboardEntry[]; total: number }>(30_000);

const WALLET_TAKEN_MESSAGE = "This wallet address is already linked to another creator profile";

// A creator profile may only be tied to a wallet its owner has proven control
// of (#276): either the wallet they signed in with, or another wallet for
// which they present a signature over a fresh /api/auth/challenge message.
function assertWalletOwnership(
  user: NonNullable<AuthRequest["user"]>,
  walletAddress: string,
  walletSignature: string | undefined
): void {
  if (walletAddress === user.walletAddress) return;
  if (!walletSignature) {
    throw new ForbiddenError(
      "Prove you control this wallet: sign a message from /api/auth/challenge and send it as walletSignature"
    );
  }
  verifyWalletOwnership(challenges, walletAddress, walletSignature);
}

// Two profiles must never share a payout wallet: donations and the
// goal-update reconciliation are keyed by wallet address.
async function assertWalletAvailable(walletAddress: string, excludeCreatorId?: number) {
  const holder = await prisma.creator.findFirst({
    where: {
      walletAddress,
      ...(excludeCreatorId === undefined ? {} : { id: { not: excludeCreatorId } }),
    },
    select: { id: true },
  });
  if (holder) {
    throw new ConflictError(WALLET_TAKEN_MESSAGE);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Discovery/search: browse creators by name or username, sorted by newest
// or by donation count ("most supported" — a currency-agnostic proxy for
// popularity, since a creator's donations can span multiple assets).
router.get(
  "/",
  validate({ query: listCreatorsQuerySchema }),
  asyncHandler(async (req, res) => {
    const { q, sort, page, limit } = req.query as unknown as {
      q?: string;
      sort: "newest" | "most-supported";
      page: number;
      limit: number;
    };

    const where: Prisma.CreatorWhereInput = {
      walletAddress: { not: null },
      ...(q
        ? {
            OR: [
              { username: { contains: q, mode: "insensitive" as const } },
              { displayName: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const orderBy =
      sort === "most-supported"
        ? { donations: { _count: "desc" as const } }
        : { createdAt: "desc" as const };

    const [creators, total] = await Promise.all([
      prisma.creator.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { donations: { where: { verified: true } } } },
        },
      }),
      prisma.creator.count({ where }),
    ]);

    return res.json({
      items: creators,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

router.get(
  "/me",
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const creator = await prisma.creator.findUnique({ where: { userId: req.user.id } });
    if (!creator) {
      throw new NotFoundError("Creator not found");
    }

    return res.json(creator);
  })
);

// Dashboard metrics for the signed-in creator (#224). Computed in the database
// over all verified donations, not just the page the dashboard has loaded.
router.get(
  "/me/stats",
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const creator = await prisma.creator.findUnique({ where: { userId: req.user.id } });
    if (!creator) {
      throw new NotFoundError("Creator not found");
    }

    return res.json(await getCreatorStats(creator.id));
  })
);

// Leaderboard (#16): top creators by total received, or top supporters by
// total given, for one currency at a time. Must be registered before
// "/:username" or Express would match "/leaderboard" as a username.
router.get(
  "/leaderboard",
  validate({ query: leaderboardQuerySchema }),
  asyncHandler(async (req, res) => {
    const { type, currency, page, limit } = req.query as unknown as {
      type: "creators" | "supporters";
      currency: string;
      page: number;
      limit: number;
    };

    const cacheKey = `${type}:${currency}`;
    const { entries: allRanked, total } = await leaderboardCache.getOrSet(cacheKey, async () => {
      if (type === "creators") {
        const grouped = await prisma.donation.groupBy({
          by: ["creatorId"],
          where: { currency, creator: { walletAddress: { not: null } } },
          _sum: { amount: true },
          _count: { _all: true },
          orderBy: { _sum: { amount: "desc" } },
        });

        const creators = await prisma.creator.findMany({
          where: { id: { in: grouped.map((g) => g.creatorId) } },
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        });
        const creatorById = new Map(creators.map((c) => [c.id, c]));

        const entries: CreatorLeaderboardEntry[] = grouped
          .filter((g) => creatorById.has(g.creatorId))
          .map((g, index) => ({
            rank: index + 1,
            total: toAmount(g._sum.amount),
            donationCount: g._count._all,
            creator: creatorById.get(g.creatorId)!,
          }));

        return { entries, total: entries.length };
      }

      const grouped = await prisma.donation.groupBy({
        by: ["senderAddress"],
        where: { currency },
        _sum: { amount: true },
        _count: { _all: true },
        orderBy: { _sum: { amount: "desc" } },
      });

      const entries: SupporterLeaderboardEntry[] = grouped.map((g, index) => ({
        rank: index + 1,
        total: toAmount(g._sum.amount),
        donationCount: g._count._all,
        senderAddress: g.senderAddress,
      }));

      return { entries, total: entries.length };
    });

    const items = allRanked.slice((page - 1) * limit, (page - 1) * limit + limit);

    return res.json({
      items,
      currency,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

router.get(
  "/:username",
  validate({ params: usernameParamSchema }),
  asyncHandler(async (req, res) => {
    const { username } = req.params;

    try {
      const creator = await creatorProfileCache.getOrSet(username, async () => {
        const profile = await prisma.creator.findUnique({
          where: { username },
        });
        if (!profile) {
          throw new NotFoundError("Creator not found");
        }
        return profile;
      });

      return res.json(creator);
    } catch (error) {
      // If cache fails, fall back to direct DB read
      if (error instanceof NotFoundError) {
        throw error;
      }
      const creator = await prisma.creator.findUnique({
        where: { username },
      });

      if (!creator) {
        throw new NotFoundError("Creator not found");
      }

      return res.json(creator);
    }
  })
);

router.post(
  "/:username/create",
  authMiddleware,
  validate({ params: createCreatorParamsSchema, body: createCreatorSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { username } = req.params;
    const { walletAddress, walletSignature, displayName, bio, avatarUrl } = req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const existing = await prisma.creator.findUnique({ where: { username } });
    if (existing) {
      throw new ConflictError("Username already exists");
    }

    const userCreator = await prisma.creator.findUnique({
      where: { userId: req.user.id },
    });
    if (userCreator) {
      throw new ConflictError("User already has a creator profile");
    }

    // Default to the wallet the user signed in with; a magic-link/OAuth user
    // with no wallet yet gets null (payout wallet connected later).
    const payoutWallet: string | null = walletAddress || req.user.walletAddress || null;
    if (payoutWallet) {
      assertWalletOwnership(req.user, payoutWallet, walletSignature);
      await assertWalletAvailable(payoutWallet);
    }

    let creator: Creator;
    try {
      creator = await prisma.creator.create({
        data: {
          userId: req.user.id,
          username,
          walletAddress: payoutWallet,
          displayName,
          bio,
          avatarUrl,
        },
      });
    } catch (err) {
      // Lost a race with another request claiming the same wallet.
      if (isUniqueViolation(err)) throw new ConflictError(WALLET_TAKEN_MESSAGE);
      throw err;
    }

    return res.status(201).json(creator);
  })
);

router.put(
  "/:username",
  authMiddleware,
  validate({ params: usernameParamSchema, body: updateCreatorSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { username } = req.params;
    const { walletSignature, ...updates } = req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const existing = await prisma.creator.findUnique({ where: { username } });
    if (!existing) {
      throw new NotFoundError("Creator not found");
    }

    // A profile can only be edited by its owner — otherwise anyone could
    // overwrite another creator's payout wallet and redirect their donations.
    if (existing.userId !== req.user.id) {
      throw new UnauthorizedError("You can only edit your own profile");
    }

    // Re-pointing the payout wallet needs proof of control and must not
    // collide with another profile.
    if (updates.walletAddress !== undefined && updates.walletAddress !== existing.walletAddress) {
      assertWalletOwnership(req.user, updates.walletAddress, walletSignature);
      await assertWalletAvailable(updates.walletAddress, existing.id);
    }

    let creator: Creator;
    try {
      creator = await prisma.creator.update({
        where: { username },
        data: updates,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(WALLET_TAKEN_MESSAGE);
      throw err;
    }

    // Invalidate cache when profile is updated
    creatorProfileCache.clear();
    leaderboardCache.clear();

    return res.json(creator);
  })
);

// Saves (or, with `theme: null`, resets) the creator's public profile theme.
router.patch(
  "/:username/theme",
  authMiddleware,
  validate({ params: usernameParamSchema, body: updateThemeSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { username } = req.params;
    const { theme } = req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const existing = await prisma.creator.findUnique({ where: { username } });
    if (!existing) {
      throw new NotFoundError("Creator not found");
    }
    if (existing.userId !== req.user.id) {
      throw new UnauthorizedError("You can only edit your own profile");
    }

    const creator = await prisma.creator.update({
      where: { username },
      data: { theme: theme ?? Prisma.DbNull },
    });

    creatorProfileCache.clear();

    return res.json(creator);
  })
);

export default router;
