import express from "express";
import request from "supertest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import prisma from "../prisma";
import donationsRouter, { donationIpLimiter, donationSenderLimiter } from "../routes/donations";
import { errorHandler } from "../middleware/errorHandler";
import { SorobanEventListener, RawEvent } from "../services/sorobanEventListener";

// Only outbound notifications are replaced. Prisma, transactions, constraints,
// the HTTP handler and the event reconciliation all use the real database.
jest.mock("../services/donationNotifications", () => ({
  notifyDonationReceived: jest.fn().mockResolvedValue(undefined),
  notifyDonationConfirmation: jest.fn().mockResolvedValue(undefined),
  notifyGoalsReached: jest.fn().mockResolvedValue(undefined),
}));

const wallet = "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW";
const app = express();
app.use(express.json());
app.use("/api/donations", donationsRouter);
app.use(errorHandler);
let creatorId: number;

beforeEach(async () => {
  const schema = process.env.INTEGRATION_SCHEMA;
  if (!schema || !/^integration_[a-f0-9]{32}$/.test(schema)) {
    throw new Error("Use npm run test:integration to create an isolated schema");
  }
  const configuredSchema = new URL(process.env.DATABASE_URL!).searchParams.get("schema");
  if (configuredSchema !== schema) throw new Error("Refusing to truncate outside the integration schema");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "${schema}"."User", "${schema}"."Creator", "${schema}"."Donation", "${schema}"."DonationIdempotencyKey", "${schema}"."Goal" RESTART IDENTITY CASCADE`
  );
  donationIpLimiter.clear();
  donationSenderLimiter.clear();
  const creator = await prisma.creator.create({
    data: { username: "integration-creator", walletAddress: wallet, user: { create: { walletAddress: wallet } } },
  });
  creatorId = creator.id;
});

afterEach(async () => {
  // Let the listener's deferred notification batch finish before teardown.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

afterAll(async () => {
  donationIpLimiter.stopSweeping();
  donationSenderLimiter.stopSweeping();
  await prisma.$disconnect();
});

function report(key: string, transactionHash = "integration-transaction") {
  return request(app).post("/api/donations").set("Idempotency-Key", key).send({
    creatorUsername: "integration-creator", senderAddress: wallet,
    amount: 10, currency: "XLM", transactionHash,
  });
}

function event(): RawEvent {
  const encode = (value: unknown) => nativeToScVal(value).toXDR("base64");
  return {
    type: "contract", ledger: 1050, id: "integration-rpc-event", txHash: "integration-transaction",
    topic: [encode("donated"), encode(wallet), encode(wallet)],
    value: encode({ amount: 100000000n, memo: "Integration donation", timestamp: 1713182400n }),
  };
}

it("replays a transaction under the same or a different key without inserting another donation", async () => {
  const first = await report("first-key");
  const replay = await report("first-key");
  const newKey = await report("second-key");
  for (const response of [first, replay, newKey]) expect(response.status).toBe(201);
  expect(replay.body.id).toBe(first.body.id);
  expect(newKey.body.id).toBe(first.body.id);
  expect(await prisma.donation.count()).toBe(1);
});

it("handles concurrent requests with one Idempotency-Key atomically", async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => report("concurrent-key")));
  for (const response of responses) expect(response.status).toBe(201);
  expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
  expect(await prisma.donation.count()).toBe(1);
  expect(await prisma.donationIdempotencyKey.count()).toBe(1);
});

it("expires an old key and associates its replacement with a new donation", async () => {
  await report("expired-key", "old-transaction");
  await prisma.donationIdempotencyKey.update({
    where: { key: "expired-key" }, data: { expiresAt: new Date(0) },
  });
  const response = await report("expired-key", "new-transaction");
  expect(response.status).toBe(201);
  expect(response.body.transactionHash).toBe("new-transaction");
  expect(await prisma.donation.count()).toBe(2);
  expect(await prisma.donationIdempotencyKey.count()).toBe(1);
});

it.each([false, true])("replays listener events exactly once (client report first: %s)", async (clientFirst) => {
  const goal = await prisma.goal.create({ data: { creatorId, targetAmount: 100, currency: "XLM" } });
  if (clientFirst) expect((await report("client-first")).status).toBe(201);
  const listener = new SorobanEventListener();
  await listener.processEvent(event());
  await listener.processEvent(event());
  const donations = await prisma.donation.findMany();
  expect(donations).toHaveLength(1);
  expect(donations[0]).toMatchObject({ verified: true, rpcEventId: event().id });
  expect((await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).currentAmount).toBe(10);
});

it.each(["composite", "onChainEventId", "rpcEventId"])("enforces the %s unique constraint in Postgres", async (constraint) => {
  const data = { creatorId, senderAddress: wallet, amount: 10, transactionHash: "unique-transaction",
    operationIndex: 0, eventIndex: 0, onChainEventId: "unique-on-chain", rpcEventId: "unique-rpc" };
  await prisma.donation.create({ data });
  const duplicate = { ...data, transactionHash: "other-transaction", onChainEventId: "other-on-chain", rpcEventId: "other-rpc" };
  if (constraint === "composite") duplicate.transactionHash = data.transactionHash;
  if (constraint === "onChainEventId") duplicate.onChainEventId = data.onChainEventId;
  if (constraint === "rpcEventId") duplicate.rpcEventId = data.rpcEventId;
  await expect(prisma.donation.create({ data: duplicate })).rejects.toMatchObject({ code: "P2002" });
  expect(await prisma.donation.count()).toBe(1);
});

it("permits distinct operations and events within the same transaction", async () => {
  const data = { creatorId, senderAddress: wallet, amount: 10, transactionHash: "multi-event" };
  await prisma.donation.createMany({ data: [
    { ...data, operationIndex: 0, eventIndex: 0 },
    { ...data, operationIndex: 1, eventIndex: 0 },
    { ...data, operationIndex: 0, eventIndex: 1 },
  ] });
  expect(await prisma.donation.count()).toBe(3);
});
