import {
  sorobanEventListener,
  RawEvent,
} from "../../services/sorobanEventListener";
import {
  eventBus,
  DONATION_EVENT,
  SUBSCRIPTION_CREATED_EVENT,
  SUBSCRIPTION_CANCELLED_EVENT,
  GOAL_UPDATED_EVENT,
  DONATION_RECORDED_EVENT,
  DonationEvent,
  SubscriptionCreatedEvent,
  SubscriptionCancelledEvent,
  GoalUpdatedEvent,
  DonationRecordedEvent,
} from "../../services/eventBus";
import prisma from "../../prisma";
import {
  notifyDonationReceived,
  notifyDonationConfirmation,
  notifyGoalsReached,
} from "../../services/donationNotifications";
import { nativeToScVal } from "@stellar/stellar-sdk";

// Donation/goal notifications are fire-and-forget (setImmediate) and hit the
// mailer + extra Prisma lookups; stub them so reconciliation tests stay
// synchronous and deterministic.
jest.mock("../../services/donationNotifications", () => ({
  notifyDonationReceived: jest.fn().mockResolvedValue(false),
  notifyDonationConfirmation: jest.fn().mockResolvedValue(false),
  notifyGoalsReached: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../prisma", () => {
  // Kept separate from the outer object so `$transaction`'s callback type can
  // reference it without creating a circular `typeof` self-reference.
  const transactionClient = {
    subscription: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    creator: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn(),
    },
    donation: {
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    goal: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
  };
  const prismaMock = {
    ...transactionClient,
    // #268 — the persisted event-listener cursor, stored in the same
    // generic key/value table #278's reset detector already uses.
    networkCheckpoint: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn((callback: (client: typeof transactionClient) => unknown) =>
      callback(transactionClient)
    ),
  };
  return { __esModule: true, default: prismaMock };
});

jest.mock("../../services/networkReset", () => ({
  networkReset: {
    getState: jest.fn().mockReturnValue({ status: "ok" }),
    check: jest.fn().mockResolvedValue(false),
  },
}));

function toBase64Xdr(val: unknown): string {
  return nativeToScVal(val).toXDR("base64");
}

const mockedPrisma = prisma as unknown as {
  creator: { findFirst: jest.Mock };
  donation: {
    findFirst: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
  };
  goal: { findMany: jest.Mock; update: jest.Mock };
  networkCheckpoint: { findUnique: jest.Mock; upsert: jest.Mock; deleteMany: jest.Mock };
};
const mockedNotifyReceived = notifyDonationReceived as jest.Mock;
const mockedNotifyConfirmation = notifyDonationConfirmation as jest.Mock;
const mockedNotifyGoalsReached = notifyGoalsReached as jest.Mock;

/** Flushes the fire-and-forget `setImmediate` notification batch. */
async function flushNotifications(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function donatedRawEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    type: "contract",
    ledger: 1050,
    id: "0000000000001050-00000",
    txHash: "tx_hash_donated_123",
    topic: [toBase64Xdr("donated"), toBase64Xdr("GDONOR123"), toBase64Xdr("GCREATOR456")],
    value: toBase64Xdr({
      amount: 1500000000n,
      memo: "Coffee for dev",
      timestamp: 1713182400n,
    }),
    ...overrides,
  };
}

describe("SorobanEventListener event processing & reconciliation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("processes 'donated' event with token and emits DONATION_EVENT", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const emittedEvents: DonationEvent[] = [];
    const handler = (evt: DonationEvent) => emittedEvents.push(evt);
    eventBus.on(DONATION_EVENT, handler);

    const rawEvent: RawEvent = {
      type: "contract",
      ledger: 1050,
      id: "0000000000001050-00000",
      txHash: "tx_hash_donated_123",
      topic: [
        toBase64Xdr("donated"),
        toBase64Xdr("GDONOR123"),
        toBase64Xdr("GCREATOR456"),
      ],
      value: toBase64Xdr({
        amount: 1500000000n,
        memo: "Coffee for dev",
        timestamp: 1713182400n,
        token: "CUSDC...",
        donation_id: 10n,
        fee_amount: 0n,
        subscription_id: null,
      }),
    };

    const handled = await sorobanEventListener.processEvent(rawEvent);

    expect(handled).toBe(true);
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]).toMatchObject({
      donor: "GDONOR123",
      creator: "GCREATOR456",
      token: "CUSDC...",
      amount: "1500000000",
      memo: "Coffee for dev",
      timestamp: 1713182400,
      ledger: 1050,
      txHash: "tx_hash_donated_123",
      donationId: 10,
      feeAmount: "0",
    });

    eventBus.off(DONATION_EVENT, handler);
    warn.mockRestore();
  });

  it("processes recurring 'donated' event with subscription_id and reconciles subscription state", async () => {
    const emittedEvents: DonationEvent[] = [];
    const handler = (evt: DonationEvent) => emittedEvents.push(evt);
    eventBus.on(DONATION_EVENT, handler);

    const rawEvent: RawEvent = {
      type: "contract",
      ledger: 1055,
      id: "0000000000001055-00000",
      txHash: "tx_hash_donated_sub_123",
      topic: [
        toBase64Xdr("donated"),
        toBase64Xdr("GSUPPORTER"),
        toBase64Xdr("GCREATOR"),
      ],
      value: toBase64Xdr({
        amount: 500000000n,
        memo: "",
        timestamp: 1713182500n,
        token: "CUSDC...",
        donation_id: 11n,
        fee_amount: 0n,
        subscription_id: 42n,
      }),
    };

    const handled = await sorobanEventListener.processEvent(rawEvent);

    expect(handled).toBe(true);
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]).toMatchObject({
      donor: "GSUPPORTER",
      creator: "GCREATOR",
      amount: "500000000",
      donationId: 11,
      subscriptionId: 42,
    });

    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { onChainId: 42 },
      data: {
        lastChargeTxHash: "tx_hash_donated_sub_123",
        lastChargedAt: new Date(1713182500 * 1000),
        lastError: null,
        failureCount: 0,
      },
    });

    eventBus.off(DONATION_EVENT, handler);
  });

  it("processes 'subscribed' event with schedule details and emits SUBSCRIPTION_CREATED_EVENT", async () => {
    const emittedEvents: SubscriptionCreatedEvent[] = [];
    const handler = (evt: SubscriptionCreatedEvent) => emittedEvents.push(evt);
    eventBus.on(SUBSCRIPTION_CREATED_EVENT, handler);

    const rawEvent: RawEvent = {
      type: "contract",
      ledger: 1060,
      id: "0000000000001060-00000",
      txHash: "tx_hash_sub_123",
      topic: [
        toBase64Xdr("subscribed"),
        toBase64Xdr("GSUPPORTER"),
        toBase64Xdr("GCREATOR"),
      ],
      value: toBase64Xdr({
        subscription_id: 42n,
        token: "USDC",
        amount: 100000000n,
        interval_secs: 2592000n,
        next_charge_at: 1715774400n,
      }),
    };

    const handled = await sorobanEventListener.processEvent(rawEvent);

    expect(handled).toBe(true);
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]).toMatchObject({
      supporter: "GSUPPORTER",
      creator: "GCREATOR",
      subscriptionId: 42,
      token: "USDC",
      amount: "100000000",
      intervalSecs: 2592000,
      nextChargeAt: 1715774400,
    });

    eventBus.off(SUBSCRIPTION_CREATED_EVENT, handler);
  });

  it("processes 'sub_cancelled' event and reconciles database subscription state without polling", async () => {
    const emittedEvents: SubscriptionCancelledEvent[] = [];
    const handler = (evt: SubscriptionCancelledEvent) => emittedEvents.push(evt);
    eventBus.on(SUBSCRIPTION_CANCELLED_EVENT, handler);

    const rawEvent: RawEvent = {
      type: "contract",
      ledger: 1070,
      id: "0000000000001070-00000",
      txHash: "tx_hash_cancel_123",
      topic: [
        toBase64Xdr("sub_cancelled"),
        toBase64Xdr("GSUPPORTER"),
        toBase64Xdr("GCREATOR"),
      ],
      value: toBase64Xdr({
        subscription_id: 42n,
      }),
    };

    const handled = await sorobanEventListener.processEvent(rawEvent);

    expect(handled).toBe(true);
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]).toMatchObject({
      supporter: "GSUPPORTER",
      creator: "GCREATOR",
      subscriptionId: 42,
    });

    // Verify event-driven reconciliation was triggered in Prisma
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { onChainId: 42 },
      data: { active: false },
    });

    eventBus.off(SUBSCRIPTION_CANCELLED_EVENT, handler);
  });

  it("processes 'goal_upd' event and reconciles creator donation goal in database", async () => {
    const emittedEvents: GoalUpdatedEvent[] = [];
    const handler = (evt: GoalUpdatedEvent) => emittedEvents.push(evt);
    eventBus.on(GOAL_UPDATED_EVENT, handler);

    const rawEvent: RawEvent = {
      type: "contract",
      ledger: 1080,
      id: "0000000000001080-00000",
      txHash: "tx_hash_goal_123",
      topic: [toBase64Xdr("goal_upd"), toBase64Xdr("GCREATOR_WALLET")],
      value: toBase64Xdr({
        goal_amount: 5000n,
        updated_at: 1713183000n,
      }),
    };

    const handled = await sorobanEventListener.processEvent(rawEvent);

    expect(handled).toBe(true);
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]).toMatchObject({
      creator: "GCREATOR_WALLET",
      goalAmount: "5000",
      updatedAt: 1713183000,
    });

    // Verify creator goal was reconciled in database
    expect(prisma.creator.updateMany).toHaveBeenCalledWith({
      where: { walletAddress: "GCREATOR_WALLET" },
      data: { donationGoal: 5000 },
    });

    eventBus.off(GOAL_UPDATED_EVENT, handler);
  });

  it("processes 'don_rec' event and emits DONATION_RECORDED_EVENT", async () => {
    const emittedEvents: DonationRecordedEvent[] = [];
    const handler = (evt: DonationRecordedEvent) => emittedEvents.push(evt);
    eventBus.on(DONATION_RECORDED_EVENT, handler);

    const rawEvent: RawEvent = {
      type: "contract",
      ledger: 1090,
      id: "0000000000001090-00000",
      txHash: "tx_hash_don_rec_123",
      topic: [toBase64Xdr("don_rec"), toBase64Xdr("GCREATOR_WALLET")],
      value: toBase64Xdr({
        amount: 250000000n,
        total_donations: 7500000000n,
        donation_count: 15,
      }),
    };

    const handled = await sorobanEventListener.processEvent(rawEvent);

    expect(handled).toBe(true);
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]).toMatchObject({
      creator: "GCREATOR_WALLET",
      amount: "250000000",
      totalDonations: "7500000000",
      donationCount: 15,
    });

    eventBus.off(DONATION_RECORDED_EVENT, handler);
  });
});

describe("SorobanEventListener donated reconciliation (#259)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default the creator lookup to unknown so a test that forgets to stub it
    // fails loudly (no row written) rather than silently creating one.
    mockedPrisma.creator.findFirst.mockResolvedValue(null);
  });

  it("creates and verifies a Donation row for an event with no client report", async () => {
    mockedPrisma.creator.findFirst.mockResolvedValue({ id: 7 });
    mockedPrisma.donation.findFirst.mockResolvedValue(null);
    const created = {
      id: 9,
      creatorId: 7,
      senderAddress: "GDONOR123",
      amount: 150,
      currency: "XLM",
      message: "Coffee for dev",
      transactionHash: "tx_hash_donated_123",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    mockedPrisma.donation.create.mockResolvedValue(created);

    const handled = await sorobanEventListener.processEvent(donatedRawEvent());
    await flushNotifications();

    expect(handled).toBe(true);
    // Stroops are converted to whole units (1500000000 / 1e7) and the row is
    // written already verified.
    expect(mockedPrisma.donation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creatorId: 7,
        senderAddress: "GDONOR123",
        amount: 150,
        currency: "XLM",
        transactionHash: "tx_hash_donated_123",
        rpcEventId: "0000000000001050-00000",
        verified: true,
      }),
    });
    // The donation is applied to the creator's goals exactly once ...
    expect(mockedPrisma.goal.findMany).toHaveBeenCalledWith({
      where: { creatorId: 7, currency: "XLM", status: "ACTIVE" },
    });
    // ... and the donation/goal notices fire once.
    expect(mockedNotifyReceived).toHaveBeenCalledTimes(1);
    expect(mockedNotifyConfirmation).toHaveBeenCalledTimes(1);
    expect(mockedNotifyGoalsReached).toHaveBeenCalledTimes(1);
  });

  it("verifies a pending client report and backfills the authoritative event data", async () => {
    mockedPrisma.creator.findFirst.mockResolvedValue({ id: 7 });
    mockedPrisma.donation.findFirst.mockResolvedValue({ id: 5, verified: false });
    mockedPrisma.donation.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.donation.findUniqueOrThrow.mockResolvedValue({
      id: 5,
      creatorId: 7,
      senderAddress: "GDONOR123",
      amount: 150,
      currency: "XLM",
      verified: true,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    await sorobanEventListener.processEvent(donatedRawEvent());
    await flushNotifications();

    // The conditional guard (`verified: false`) is what makes the flip
    // atomic, so a concurrent reconciliation can't apply the row twice.
    expect(mockedPrisma.donation.updateMany).toHaveBeenCalledWith({
      where: { id: 5, verified: false },
      data: expect.objectContaining({
        verified: true,
        rpcEventId: "0000000000001050-00000",
        amount: 150,
        currency: "XLM",
      }),
    });
    expect(mockedPrisma.donation.create).not.toHaveBeenCalled();
    expect(mockedPrisma.goal.findMany).toHaveBeenCalledTimes(1);
    expect(mockedNotifyReceived).toHaveBeenCalledTimes(1);
  });

  it("treats a replay of an already-verified event as a no-op", async () => {
    mockedPrisma.creator.findFirst.mockResolvedValue({ id: 7 });
    mockedPrisma.donation.findFirst.mockResolvedValue({ id: 5, verified: true });

    await sorobanEventListener.processEvent(donatedRawEvent());
    await flushNotifications();

    expect(mockedPrisma.donation.create).not.toHaveBeenCalled();
    expect(mockedPrisma.donation.updateMany).not.toHaveBeenCalled();
    // No double-counting: neither goals nor notifications are touched.
    expect(mockedPrisma.goal.findMany).not.toHaveBeenCalled();
    expect(mockedNotifyReceived).not.toHaveBeenCalled();
    expect(mockedNotifyGoalsReached).not.toHaveBeenCalled();
  });

  it("skips (with a warning) an event for an unknown creator wallet", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockedPrisma.creator.findFirst.mockResolvedValue(null);

    await sorobanEventListener.processEvent(donatedRawEvent());

    expect(mockedPrisma.donation.create).not.toHaveBeenCalled();
    expect(mockedPrisma.donation.findFirst).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown creator wallet"));
    warn.mockRestore();
  });
});
