jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    subscription: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    donation: {
      upsert: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../services/subscriptionNotifications", () => ({
  notifySubscriptionPaymentFailed: jest.fn(),
  notifySubscriptionRenewed: jest.fn(),
}));

jest.mock("../../services/goalService", () => ({
  applyDonationToGoals: jest.fn(),
}));

jest.mock("../../services/donationNotifications", () => ({
  notifyGoalsReached: jest.fn(),
}));

import { Subscription } from "@prisma/client";
import prisma from "../../prisma";
import { SubscriptionExecutor } from "../../services/subscriptionExecutor";
import {
  notifySubscriptionPaymentFailed,
  notifySubscriptionRenewed,
} from "../../services/subscriptionNotifications";
import { applyDonationToGoals } from "../../services/goalService";
import { notifyGoalsReached } from "../../services/donationNotifications";

// `charge` and `submitCharge` are private; this type exposes exactly those
// two members for the tests below to call directly, instead of casting the
// whole executor instance to `any` and losing type-checking on everything
// else these tests touch on it.
type ExecutorTestAccess = {
  submitCharge: (subscription: Subscription) => Promise<string>;
  charge: (subscription: Subscription) => Promise<void>;
};

const mockedPrisma = prisma as unknown as {
  subscription: { findMany: jest.Mock; update: jest.Mock };
  donation: { upsert: jest.Mock };
  $transaction: jest.Mock;
};
const mockedRenewed = notifySubscriptionRenewed as jest.Mock;
const mockedPaymentFailed = notifySubscriptionPaymentFailed as jest.Mock;
const mockedApplyToGoals = applyDonationToGoals as jest.Mock;
const mockedNotifyGoalsReached = notifyGoalsReached as jest.Mock;

const subscription = {
  id: 4,
  creatorId: 7,
  supporterAddress: "G supporter",
  token: "XLM",
  amount: 2.5,
  intervalSecs: 60,
  onChainId: 11,
  active: true,
  nextChargeAt: new Date(0),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastChargeTxHash: null,
  lastChargedAt: null,
  lastError: null,
  failureNotifiedAt: null,
  subscribeTxHash: null,
} as never;

describe("SubscriptionExecutor donation indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrisma.donation.upsert.mockResolvedValue({ id: 1 });
    mockedPrisma.subscription.update.mockResolvedValue(subscription);
    mockedPrisma.$transaction.mockImplementation(
      async (callback: ((client: typeof mockedPrisma) => Promise<unknown>) | Promise<unknown>[]) => {
        if (typeof callback === "function") {
          return callback(mockedPrisma);
        }
        return Promise.all(callback);
      }
    );
    mockedRenewed.mockResolvedValue(undefined);
    mockedApplyToGoals.mockResolvedValue([]);
    mockedNotifyGoalsReached.mockResolvedValue(undefined);
  });

  it("upserts a confirmed recurring charge by its on-chain identity", async () => {
    const executor = new SubscriptionExecutor() as unknown as ExecutorTestAccess;
    executor.submitCharge = jest.fn().mockResolvedValue("charge-tx");

    await executor.charge(subscription);

    expect(mockedPrisma.donation.upsert).toHaveBeenCalledWith({
      where: {
        transactionHash_operationIndex_eventIndex: {
          transactionHash: "charge-tx",
          operationIndex: 0,
          eventIndex: 0,
        },
      },
      update: {},
      create: expect.objectContaining({
        transactionHash: "charge-tx",
        onChainEventId: "charge-tx:0:0",
        operationIndex: 0,
        eventIndex: 0,
      }),
    });
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("notifies the creator about goals the recurring charge carried to their target", async () => {
    const reachedGoal = { id: 3, creatorId: 7, title: "New mic", targetAmount: 100, currency: "XLM" };
    mockedApplyToGoals.mockResolvedValue([reachedGoal]);
    const executor = new SubscriptionExecutor() as unknown as ExecutorTestAccess;
    executor.submitCharge = jest.fn().mockResolvedValue("charge-tx");

    await executor.charge(subscription);

    expect(mockedApplyToGoals).toHaveBeenCalledWith(mockedPrisma, 7, "XLM", 2.5);
    expect(mockedNotifyGoalsReached).toHaveBeenCalledWith([reachedGoal]);
  });
});

describe("SubscriptionExecutor executor-side failures (#279)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrisma.subscription.update.mockResolvedValue(subscription);
    mockedPaymentFailed.mockResolvedValue(true);
  });

  it("does not penalize the subscriber when the executor account is unfunded", async () => {
    const executor = new SubscriptionExecutor() as unknown as ExecutorTestAccess;
    executor.submitCharge = jest
      .fn()
      .mockRejectedValue(new Error("Account not found: G-EXECUTOR"));

    await executor.charge(subscription);

    expect(mockedPaymentFailed).not.toHaveBeenCalled();
    expect(mockedPrisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { lastError: "Account not found: G-EXECUTOR" },
    });
    expect(mockedPrisma.subscription.update.mock.calls[0][0].data.failureCount).toBeUndefined();
  });

  it("does not penalize the subscriber when the executor cannot cover the fee", async () => {
    const executor = new SubscriptionExecutor() as unknown as ExecutorTestAccess;
    executor.submitCharge = jest.fn().mockRejectedValue(new Error("insufficient fee"));

    await executor.charge(subscription);

    expect(mockedPaymentFailed).not.toHaveBeenCalled();
    expect(mockedPrisma.subscription.update.mock.calls[0][0].data.failureCount).toBeUndefined();
  });

  it("still records a genuine on-chain failure against the subscriber and emails once", async () => {
    const executor = new SubscriptionExecutor() as unknown as ExecutorTestAccess;
    executor.submitCharge = jest
      .fn()
      .mockRejectedValue(new Error("Transaction abc failed on-chain"));

    await executor.charge(subscription);

    expect(mockedPaymentFailed).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.subscription.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ failureCount: 1 })
    );
  });
});
