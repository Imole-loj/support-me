/**
 * src/__tests__/services/sorobanEventListenerCursor.test.ts
 *
 * Cursor persistence and out-of-retention recovery for SorobanEventListener
 * (#268). Kept in its own file because DONATION_CONTRACT_ID is read once as
 * a top-level `const` when the module is first imported, so it must be set
 * in `process.env` before that import happens — before Jest even loads this
 * file's other imports, not inside a `beforeEach`.
 */

process.env.NEXT_PUBLIC_DONATION_CONTRACT_ID = "CDONATIONCONTRACT";

jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    networkCheckpoint: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

jest.mock("../../services/networkReset", () => ({
  networkReset: {
    getState: jest.fn().mockReturnValue({ status: "ok" }),
    check: jest.fn().mockResolvedValue(false),
  },
}));

import prisma from "../../prisma";
import { SorobanEventListener } from "../../services/sorobanEventListener";
import { eventListenerHealth } from "../../services/eventListenerHealth";

const mockedCheckpoint = (
  prisma as unknown as {
    networkCheckpoint: { findUnique: jest.Mock; upsert: jest.Mock; deleteMany: jest.Mock };
  }
).networkCheckpoint;

/** Builds a `global.fetch` mock that answers Soroban JSON-RPC calls by method name. */
function mockRpc(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  return jest.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      method: string;
      params: Record<string, unknown>;
    };
    const handler = handlers[body.method];
    if (!handler) throw new Error(`unexpected RPC method ${body.method}`);
    const outcome = handler(body.params);
    return { json: async () => outcome } as Response;
  }) as unknown as typeof fetch;
}

/** Runs one poll tick (start, let the initial poll settle, stop) and returns. */
async function runOnePoll(listener: SorobanEventListener, ticks = 1): Promise<void> {
  listener.start();
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  listener.stop();
}

describe("SorobanEventListener cursor persistence (#268)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedCheckpoint.findUnique.mockResolvedValue(null);
    mockedCheckpoint.upsert.mockResolvedValue({});
    mockedCheckpoint.deleteMany.mockResolvedValue({ count: 0 });
    eventListenerHealth.reset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("loads the persisted cursor on first poll and uses it instead of the lookback window", async () => {
    mockedCheckpoint.findUnique.mockResolvedValue({ value: "cursor-abc" });
    const getLatestLedger = jest.fn();
    global.fetch = mockRpc({
      getLatestLedger,
      getEvents: (params) => {
        expect((params.pagination as Record<string, unknown>).cursor).toBe("cursor-abc");
        return { result: { events: [] } };
      },
    });

    await runOnePoll(new SorobanEventListener());

    expect(getLatestLedger).not.toHaveBeenCalled();
    expect(mockedCheckpoint.findUnique).toHaveBeenCalledTimes(1);
  });

  it("falls back to the lookback window when no cursor is stored yet", async () => {
    let sawStartLedger: unknown;
    let sawCursor: unknown;
    global.fetch = mockRpc({
      getLatestLedger: () => ({ result: { sequence: 5000 } }),
      getEvents: (params) => {
        sawStartLedger = params.startLedger;
        sawCursor = (params.pagination as Record<string, unknown>).cursor;
        return { result: { events: [] } };
      },
    });

    await runOnePoll(new SorobanEventListener());

    expect(sawStartLedger).toBeDefined();
    expect(sawCursor).toBeUndefined();
  });

  it("saves the cursor after processing a batch, and a fresh instance (simulating a restart) reuses it", async () => {
    let storedValue: string | null = null;
    mockedCheckpoint.findUnique.mockImplementation(() =>
      Promise.resolve(storedValue ? { value: storedValue } : null)
    );
    mockedCheckpoint.upsert.mockImplementation(
      ({ create }: { create: { value: string } }) => {
        storedValue = create.value;
        return Promise.resolve({});
      }
    );

    global.fetch = mockRpc({
      getLatestLedger: () => ({ result: { sequence: 5000 } }),
      getEvents: () => ({
        result: {
          events: [
            { type: "contract", ledger: 1, id: "cursor-after-batch", txHash: "tx", topic: [], value: "" },
          ],
        },
      }),
    });

    await runOnePoll(new SorobanEventListener());

    expect(storedValue).toBe("cursor-after-batch");

    // Simulate a restart: a brand-new instance, same (now-populated) DB checkpoint.
    const getEventsSecondRun = jest.fn(() => ({ result: { events: [] } }));
    global.fetch = mockRpc({
      getEvents: (params) => {
        expect((params.pagination as Record<string, unknown>).cursor).toBe("cursor-after-batch");
        return getEventsSecondRun();
      },
    });

    await runOnePoll(new SorobanEventListener());

    expect(getEventsSecondRun).toHaveBeenCalledTimes(1);
  });

  it("recovers from an out-of-retention cursor by restarting from the oldest retained ledger, and flags the gap", async () => {
    mockedCheckpoint.findUnique.mockResolvedValue({ value: "stale-cursor" });

    let getEventsCallCount = 0;
    global.fetch = mockRpc({
      getHealth: () => ({ result: { oldestLedger: 4000 } }),
      getEvents: (params) => {
        getEventsCallCount++;
        if (getEventsCallCount === 1) {
          // Still using the stale cursor: rejected as out of retention.
          return { error: { message: "start is before oldest ledger" } };
        }
        expect(params.startLedger).toBe(4000);
        return { result: { events: [] } };
      },
    });

    await runOnePoll(new SorobanEventListener(), 2);

    expect(getEventsCallCount).toBe(2);
    const health = eventListenerHealth.getHealth();
    expect(health.gapDetected).toBe(true);
    expect(health.recoveredFromLedger).toBe(4000);
  });

  it("does not treat an unrelated RPC error as an out-of-retention recovery", async () => {
    mockedCheckpoint.findUnique.mockResolvedValue({ value: "some-cursor" });
    const getHealth = jest.fn();
    global.fetch = mockRpc({
      getHealth,
      getEvents: () => ({ error: { message: "internal server error" } }),
    });

    await runOnePoll(new SorobanEventListener());

    expect(getHealth).not.toHaveBeenCalled();
    expect(eventListenerHealth.getHealth().gapDetected).toBe(false);
  });

  it("drains multiple full pages within one poll tick instead of waiting for the next interval", async () => {
    let getEventsCallCount = 0;
    const makePage = (size: number, idPrefix: string) =>
      Array.from({ length: size }, (_, i) => ({
        type: "contract",
        ledger: 1,
        id: `${idPrefix}-${i}`,
        txHash: "tx",
        topic: [],
        value: "",
      }));

    global.fetch = mockRpc({
      getLatestLedger: () => ({ result: { sequence: 5000 } }),
      getEvents: () => {
        getEventsCallCount++;
        // Two full pages (50 events, the page size limit) then a partial
        // page that ends the drain.
        if (getEventsCallCount <= 2) {
          return { result: { events: makePage(50, `page${getEventsCallCount}`) } };
        }
        return { result: { events: makePage(3, "page3") } };
      },
    });

    await runOnePoll(new SorobanEventListener(), 3);

    expect(getEventsCallCount).toBe(3);
  });

  it("resetCursor clears both the persisted cursor and any recorded gap", async () => {
    eventListenerHealth.recordGap(123);

    const listener = new SorobanEventListener();
    await listener.resetCursor();

    expect(mockedCheckpoint.deleteMany).toHaveBeenCalledTimes(1);
    const health = eventListenerHealth.getHealth();
    expect(health.gapDetected).toBe(false);
    expect(health.lastCursor).toBeNull();
  });
});
