import { Router } from "express";
import prisma from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import { createSubscriptionSchema, listSubscriptionsQuerySchema } from "../schemas/subscriptions";
import { idParamSchema } from "../schemas/common";
import { NotFoundError, UnauthorizedError } from "../errors/AppError";

const router = Router();

router.get(
  "/",
  authMiddleware,
  validate({ query: listSubscriptionsQuerySchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const { creatorUsername, supporterAddress } = req.query as {
      creatorUsername?: string;
      supporterAddress?: string;
    };

    // Require explicit ownership: caller must be requesting their own subscriptions
    // or be the creator viewing subscribers.
    let targetSupporterAddress: string | null | undefined = supporterAddress;

    if (targetSupporterAddress && targetSupporterAddress !== req.user.walletAddress) {
      // Check if the caller is the target creator
      if (creatorUsername) {
        const creator = await prisma.creator.findUnique({ where: { username: creatorUsername } });
        if (!creator?.walletAddress || creator.walletAddress !== req.user.walletAddress) {
          throw new UnauthorizedError("You are not authorized to view these subscriptions");
        }
      } else {
        throw new UnauthorizedError("You can only view your own subscriptions");
      }
    } else if (!targetSupporterAddress && !creatorUsername) {
      targetSupporterAddress = req.user.walletAddress;
    }

    const subscriptions = await prisma.subscription.findMany({
      orderBy: { createdAt: "desc" },
      where: {
        ...(creatorUsername ? { creator: { username: creatorUsername } } : {}),
        ...(targetSupporterAddress ? { supporterAddress: targetSupporterAddress } : {}),
      },
      include: {
        creator: { select: { username: true, displayName: true, avatarUrl: true } },
      },
    });

    return res.json(subscriptions);
  })
);

router.post(
  "/",
  authMiddleware,
  validate({ body: createSubscriptionSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { creatorUsername, supporterAddress, token, amount, intervalSecs, onChainId, subscribeTxHash } =
      req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    // The subscription is created on-chain by the supporter's own wallet
    // signature; this just records it, so only the supporter who signed it
    // may report it under their own identity.
    if (req.user.walletAddress !== supporterAddress) {
      throw new UnauthorizedError("You can only record subscriptions you started yourself");
    }

    const creator = await prisma.creator.findUnique({ where: { username: creatorUsername } });
    if (!creator) {
      throw new NotFoundError("Creator not found");
    }

    // Idempotent on the on-chain subscription id, which is globally unique
    // (assigned by the donation contract's own counter).
    const existing = await prisma.subscription.findUnique({ where: { onChainId } });
    if (existing) {
      return res.status(200).json(existing);
    }

    const subscription = await prisma.subscription.create({
      data: {
        creatorId: creator.id,
        supporterAddress,
        token,
        amount,
        intervalSecs,
        onChainId,
        subscribeTxHash,
        nextChargeAt: new Date(Date.now() + intervalSecs * 1000),
      },
    });

    return res.status(201).json(subscription);
  })
);

router.post(
  "/:id/cancel",
  authMiddleware,
  validate({ params: idParamSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const { id } = req.params as unknown as { id: number };
    const subscription = await prisma.subscription.findUnique({ where: { id } });
    if (!subscription) {
      throw new NotFoundError("Subscription not found");
    }

    // Cancellation on-chain (revoking the allowance) is signed by the
    // supporter's own wallet; this just reflects that here, so only the
    // supporter who owns the subscription may report it cancelled.
    if (subscription.supporterAddress !== req.user.walletAddress) {
      throw new UnauthorizedError("You can only cancel your own subscriptions");
    }

    const updated = await prisma.subscription.update({
      where: { id },
      data: { active: false },
    });

    return res.status(200).json(updated);
  })
);

export default router;
