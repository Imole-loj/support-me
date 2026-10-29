jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("../../services/sorobanHealth", () => ({
  checkSorobanRpc: jest.fn().mockResolvedValue({ status: "ok", latencyMs: 4 }),
}));
jest.mock("../../services/networkReset", () => ({
  networkReset: {
    getState: jest.fn(() => ({
      status: "ok",
      reason: null,
      detectedAt: null,
      lastSeenLedger: null,
      latestLedger: null,
    })),
  },
}));

import request from "supertest";
import app, { sorobanRpcCache, healthIpLimiter } from "../../app";
import { executorHealth } from "../../services/executorHealth";

beforeEach(() => {
  executorHealth.reset();
  sorobanRpcCache.clear();
  healthIpLimiter.clear();
});

describe("GET /health", () => {
  it("returns 200 with an ok status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.network).toBe("ok");
    expect(typeof res.body.timestamp).toBe("string");
    expect(res.body.dependencies.sorobanRpc.status).toBe("ok");
  });

  it("reports reset_detected and unhealthy when a testnet reset was detected (#278)", async () => {
    const { networkReset } = await import("../../services/networkReset");
    (networkReset.getState as jest.Mock).mockReturnValueOnce({
      status: "reset_detected",
      reason: "latest ledger went backwards",
      detectedAt: "2026-01-01T00:00:00.000Z",
      lastSeenLedger: 900,
      latestLedger: 5,
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.network).toBe("reset_detected");
    expect(res.body.dependencies.network.status).toBe("reset_detected");
  });

  it("reports degraded status when Soroban RPC is unavailable", async () => {
    const { checkSorobanRpc } = await import("../../services/sorobanHealth");
    (checkSorobanRpc as jest.Mock).mockResolvedValueOnce({ status: "down" });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.dependencies.sorobanRpc.status).toBe("down");
  });

  it("includes the subscription executor's run status and recent charge outcomes", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true);
    executorHealth.recordCharge(7, "success");

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    const executor = res.body.dependencies.subscriptionExecutor;
    expect(executor.status).toBe("ok");
    expect(typeof executor.lastRunAt).toBe("string");
    expect(typeof executor.lastSuccessAt).toBe("string");
    expect(executor.recentCharges.successCount).toBe(1);
    expect(executor.recentCharges.failureCount).toBe(0);
  });

  it("reports an unhealthy overall status when the executor has stalled", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true, undefined, Date.now() - 5 * 60_000);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.dependencies.subscriptionExecutor.status).toBe("unhealthy");
  });

  it("reuses one RPC probe for repeated rapid /health requests inside the cache window (#373)", async () => {
    const { checkSorobanRpc } = await import("../../services/sorobanHealth");
    (checkSorobanRpc as jest.Mock).mockClear();

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.dependencies.sorobanRpc.status).toBe("ok");
    }

    expect(checkSorobanRpc).toHaveBeenCalledTimes(1);
  });

  it("rate limits rapid requests to /health beyond the configured cap (#373)", async () => {
    for (let i = 0; i < 60; i++) {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
    }

    const res = await request(app).get("/health");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_REQUESTS");
  });
});

describe("GET /health/live (#373)", () => {
  it("responds with 200 ok without calling Soroban RPC or touching dependencies", async () => {
    const { checkSorobanRpc } = await import("../../services/sorobanHealth");
    (checkSorobanRpc as jest.Mock).mockClear();

    const res = await request(app).get("/health/live");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(checkSorobanRpc).not.toHaveBeenCalled();
  });
});

describe("GET /health/executor", () => {
  it("returns the executor report with a healthy status after a successful run", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true);
    executorHealth.recordCharge(3, "failure", "insufficient balance");

    const res = await request(app).get("/health/executor");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.subscriptionExecutor.status).toBe("ok");
    expect(res.body.subscriptionExecutor.recentCharges.failureCount).toBe(1);
    expect(res.body.subscriptionExecutor.recentCharges.outcomes[0].error).toBe(
      "insufficient balance"
    );
  });

  it("returns unhealthy when the executor has not run within its expected interval", async () => {
    executorHealth.markEnabled(60_000);
    executorHealth.runFinished(true, undefined, Date.now() - 10 * 60_000);

    const res = await request(app).get("/health/executor");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.subscriptionExecutor.msSinceLastRun).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("reports disabled when the executor was never started", async () => {
    const res = await request(app).get("/health/executor");

    expect(res.status).toBe(200);
    expect(res.body.subscriptionExecutor.status).toBe("disabled");
    expect(res.body.status).toBe("ok");
  });
});

describe("unknown routes", () => {
  it("returns a structured 404", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);

    expect(res.body).toEqual(
      expect.objectContaining({ error: "Not Found", code: "NOT_FOUND" })
    );
    expect(typeof res.body.requestId).toBe("string");
  });
});
