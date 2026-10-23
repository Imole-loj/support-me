jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    subscription: { update: jest.fn() },
    networkCheckpoint: {},
  },
}));

jest.mock("../../services/sorobanRpc", () => ({
  withSorobanRpcServer: jest.fn(),
  callSorobanRpc: jest.fn(),
}));

jest.mock("../../services/sorobanContracts", () => ({
  getAccountBalanceXlm: jest.fn(),
  contractInstanceExists: jest.fn(),
}));

jest.mock("../../services/networkReset", () => ({
  networkReset: {
    getState: () => ({
      status: "ok",
      reason: null,
      detectedAt: null,
      lastSeenLedger: null,
      latestLedger: null,
    }),
  },
}));

jest.mock("@sentry/node", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
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

import { Keypair } from "@stellar/stellar-sdk";
import {
  SubscriptionExecutor,
  isExecutorSideChargeError,
} from "../../services/subscriptionExecutor";
import { withSorobanRpcServer } from "../../services/sorobanRpc";
import { getAccountBalanceXlm } from "../../services/sorobanContracts";
import { executorHealth } from "../../services/executorHealth";

const mockedWithServer = withSorobanRpcServer as jest.Mock;
const mockedBalance = getAccountBalanceXlm as jest.Mock;

type ExecutorFundingTestAccess = {
  keypair: Keypair;
  ensureExecutorFunded(): Promise<void>;
};

function makeExecutor(): { keypair: Keypair; ensureExecutorFunded(): Promise<void> } {
  const executor = new SubscriptionExecutor() as unknown as ExecutorFundingTestAccess;
  executor.keypair = Keypair.random();
  return executor;
}

describe("executor account funding (#279)", () => {
  const originalEnv = {
    network: process.env.STELLAR_NETWORK,
    friendbot: process.env.FRIENDBOT_URL,
    threshold: process.env.EXECUTOR_LOW_BALANCE_XLM,
  };
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    executorHealth.reset();
    process.env.STELLAR_NETWORK = "testnet";
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    delete process.env.FRIENDBOT_URL;
    delete process.env.EXECUTOR_LOW_BALANCE_XLM;
    mockedBalance.mockResolvedValue("100.0000000");
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
  });

  afterAll(() => {
    global.fetch = originalFetch;
    for (const [key, value] of [
      ["STELLAR_NETWORK", originalEnv.network],
      ["FRIENDBOT_URL", originalEnv.friendbot],
      ["EXECUTOR_LOW_BALANCE_XLM", originalEnv.threshold],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("funds an unfunded executor account via Friendbot on testnet", async () => {
    mockedWithServer
      .mockRejectedValueOnce(new Error("Account not found: G-EXECUTOR"))
      .mockResolvedValueOnce({ accountId: () => "G-EXECUTOR" });

    const executor = makeExecutor();
    await executor.ensureExecutorFunded();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain("friendbot.stellar.org?addr=");
    expect(url).toContain(executor.keypair.publicKey());
    expect(mockedBalance).toHaveBeenCalledWith(executor.keypair.publicKey());
    expect(executorHealth.getHealth().balanceXlm).toBe("100.0000000");
  });

  it("honors a configured FRIENDBOT_URL", async () => {
    process.env.FRIENDBOT_URL = "https://friendbot.example/";
    mockedWithServer
      .mockRejectedValueOnce(new Error("Account not found: G-EXECUTOR"))
      .mockResolvedValueOnce({});

    await makeExecutor().ensureExecutorFunded();

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url.startsWith("https://friendbot.example?addr=")).toBe(true);
  });

  it("does not call Friendbot when the executor account already exists", async () => {
    mockedWithServer.mockResolvedValueOnce({ accountId: () => "G-EXECUTOR" });

    await makeExecutor().ensureExecutorFunded();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockedBalance).toHaveBeenCalled();
  });

  it("never calls Friendbot on mainnet", async () => {
    process.env.STELLAR_NETWORK = "mainnet";
    mockedWithServer.mockRejectedValueOnce(new Error("Account not found: G-EXECUTOR"));
    mockedBalance.mockResolvedValue("0.0000000");

    await makeExecutor().ensureExecutorFunded();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("surfaces a Friendbot failure instead of silently continuing", async () => {
    mockedWithServer.mockRejectedValueOnce(new Error("Account not found: G-EXECUTOR"));
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 502 });

    await expect(makeExecutor().ensureExecutorFunded()).rejects.toThrow(
      /Friendbot funding failed/
    );
  });

  it("does not treat a transport error as an unfunded account", async () => {
    mockedWithServer.mockRejectedValueOnce(new Error("request timed out after 10000ms"));

    await expect(makeExecutor().ensureExecutorFunded()).rejects.toThrow(/timed out/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reports lowBalance when the balance is below the configured threshold", async () => {
    process.env.EXECUTOR_LOW_BALANCE_XLM = "5";
    mockedWithServer.mockResolvedValueOnce({ accountId: () => "G-EXECUTOR" });
    mockedBalance.mockResolvedValue("1.0000000");

    await makeExecutor().ensureExecutorFunded();

    const health = executorHealth.getHealth();
    expect(health.balanceXlm).toBe("1.0000000");
    expect(health.lowBalance).toBe(true);
  });
});

describe("isExecutorSideChargeError (#279)", () => {
  it("classifies an unfunded executor account and fee errors as executor-side", () => {
    expect(isExecutorSideChargeError("Account not found: G-EXECUTOR")).toBe(true);
    expect(isExecutorSideChargeError("insufficient fee")).toBe(true);
    expect(isExecutorSideChargeError("txInsufficientFee")).toBe(true);
  });

  it("does not classify a genuine on-chain revert as executor-side", () => {
    expect(isExecutorSideChargeError("Transaction abc failed on-chain")).toBe(false);
    expect(isExecutorSideChargeError("charge_subscription reverted")).toBe(false);
  });
});
