import { Router, Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import { deleteAccountSchema } from "../schemas/account";
import { TooManyRequestsError, UnauthorizedError } from "../errors/AppError";
import { RateLimiter } from "../services/rateLimiter";

const router = Router();

export const BATCH_SIZE = 500;

// Rate-limit exports to 5 per hour per user (#369)
export const exportRateLimiter = new RateLimiter(5, 60 * 60 * 1000);
exportRateLimiter.startSweeping();

async function streamBatchedArray<T extends { id: number }>(
  res: Response,
  fetchBatch: (cursorId: number | undefined, take: number) => Promise<T[]>,
  batchSize = BATCH_SIZE
): Promise<void> {
  let cursorId: number | undefined = undefined;
  let firstItem = true;

  while (true) {
    const rows = await fetchBatch(cursorId, batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (!firstItem) {
        res.write(",\n        ");
      } else {
        res.write("\n        ");
        firstItem = false;
      }
      res.write(JSON.stringify(row));
    }

    if (rows.length < batchSize) break;
    cursorId = rows[rows.length - 1].id;
  }
}

router.get(
  "/export",
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    if (!exportRateLimiter.attempt(`export:${req.user.id}`)) {
      const retryAfter = exportRateLimiter.retryAfterSeconds(`export:${req.user.id}`);
      res.setHeader("Retry-After", String(retryAfter));
      throw new TooManyRequestsError("Too many export requests, please try again later");
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { creator: true },
    });
    if (!user) {
      throw new UnauthorizedError("User not found");
    }

    const walletAddress = user.walletAddress ?? "";
    const filename = `supportme-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const userPayload = {
      id: user.id,
      walletAddress: user.walletAddress,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      deletedAt: user.deletedAt,
    };

    res.write("{\n");
    res.write(`  "exportedAt": ${JSON.stringify(new Date().toISOString())},\n`);
    res.write(`  "user": ${JSON.stringify(userPayload, null, 2).replace(/\n/g, "\n  ")},\n`);
    res.write(`  "creator": ${user.creator ? JSON.stringify(user.creator, null, 2).replace(/\n/g, "\n  ") : "null"},\n`);
    res.write('  "donations": {\n    "sent": [');

    // Stream sent donations
    await streamBatchedArray(res, async (cursorId, take) => {
      return prisma.donation.findMany({
        where: { senderAddress: walletAddress },
        orderBy: { id: "desc" },
        take,
        ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });
    });

    res.write('\n    ],\n    "received": [');

    // Stream received donations
    if (user.creator) {
      await streamBatchedArray(res, async (cursorId, take) => {
        return prisma.donation.findMany({
          where: { creatorId: user.creator!.id },
          orderBy: { id: "desc" },
          take,
          ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });
      });
    }

    res.write('\n    ]\n  },\n  "subscriptions": {\n    "asSupporter": [');

    // Stream subscriptions as supporter
    await streamBatchedArray(res, async (cursorId, take) => {
      return prisma.subscription.findMany({
        where: { supporterAddress: walletAddress },
        orderBy: { id: "desc" },
        take,
        ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
        include: {
          creator: { select: { username: true, displayName: true, walletAddress: true } },
        },
      });
    });

    res.write('\n    ],\n    "asCreator": [');

    // Stream subscriptions as creator
    if (user.creator) {
      await streamBatchedArray(res, async (cursorId, take) => {
        return prisma.subscription.findMany({
          where: { creatorId: user.creator!.id },
          orderBy: { id: "desc" },
          take,
          ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
          include: {
            creator: { select: { username: true, displayName: true, walletAddress: true } },
          },
        });
      });
    }

    res.write('\n    ]\n  },\n  "withdrawals": [');

    // Stream withdrawals
    if (user.creator) {
      await streamBatchedArray(res, async (cursorId, take) => {
        return prisma.withdrawal.findMany({
          where: { creatorId: user.creator!.id },
          orderBy: { id: "desc" },
          take,
          ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });
      });
    }

    res.write("\n  ]\n}\n");
    return res.end();
  })
);

router.post(
  "/delete",
  authMiddleware,
  validate({ body: deleteAccountSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { creator: true },
    });
    if (!user) {
      throw new UnauthorizedError("User not found");
    }

    if (user.deletedAt) {
      return res.json({
        deleted: true,
        deletedAt: user.deletedAt,
        alreadyDeleted: true,
        anonymized: [],
        preserved: [],
      });
    }

    // A wallet-less account (magic-link/OAuth sign-in) owns no wallet-linked
    // records; the empty string matches no address rows.
    const walletAddress = user.walletAddress ?? "";
    const creator = user.creator;

    const operations: Prisma.PrismaPromise<unknown>[] = [
      prisma.user.update({
        where: { id: user.id },
        data: { email: null, deletedAt: new Date() },
      }),
      prisma.oAuthIdentity.deleteMany({ where: { userId: user.id } }),
      ...(user.email
        ? [
            prisma.magicLinkToken.deleteMany({
              where: { OR: [{ userId: user.id }, { email: user.email }] },
            }),
          ]
        : [
            prisma.magicLinkToken.deleteMany({ where: { userId: user.id } }),
          ]),
      // Memos the holder wrote on their own donations are personal content;
      // the amounts and transaction hashes stay (they're on-chain referenced).
      prisma.donation.updateMany({
        where: { senderAddress: walletAddress, message: { not: null } },
        data: { message: null },
      }),
      // Stop the executor charging subscriptions the holder started. The rows
      // themselves (on-chain ids, tx hashes, addresses) are preserved.
      prisma.subscription.updateMany({
        where: { supporterAddress: walletAddress, active: true },
        data: { active: false },
      }),
    ];

    if (creator) {
      operations.push(
        prisma.creator.update({
          where: { id: creator.id },
          data: { displayName: null, bio: null, avatarUrl: null, socialLinks: Prisma.DbNull },
        })
      );
    }

    const results = await prisma.$transaction(operations);
    const updatedUser = results[0] as { deletedAt: Date | null };

    return res.json({
      deleted: true,
      deletedAt: updatedUser.deletedAt,
      anonymized: [
        "email",
        "profile.displayName",
        "profile.bio",
        "profile.avatarUrl",
        "profile.socialLinks",
        "donationMessages.sent",
        "activeSubscriptions.deactivated",
      ],
      preserved: [
        "walletAddress",
        "onChainDonationRecords",
        "onChainSubscriptionRecords",
        "withdrawalRecords",
        "creator.username",
      ],
    });
  })
);

export default router;
