import { ChallengeStore } from "../../services/challengeStore";

describe("ChallengeStore", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("stores and returns a challenge, and deletes it", () => {
    const store = new ChallengeStore();
    store.set("G1", { id: "challenge-1", walletAddress: "G1", message: "m", expiresAt: Date.now() + 1000 });
    expect(store.get("G1")?.message).toBe("m");
    store.delete("G1");
    expect(store.get("G1")).toBeUndefined();
  });

  it("keeps challenges distinct by id even when the same wallet requests another nonce", () => {
    const store = new ChallengeStore();
    const first = { id: "challenge-1", walletAddress: "G1", message: "first", expiresAt: Date.now() + 60_000 };
    const second = { id: "challenge-2", walletAddress: "G1", message: "second", expiresAt: Date.now() + 60_000 };

    store.set("G1", first);
    store.set("G1", second);

    expect(store.get("G1")?.id).toBe("challenge-2");
    expect(store.getById("challenge-1")).toBeUndefined();
    expect(store.getById("challenge-2")?.message).toBe("second");
  });

  it("sweep evicts expired challenges that were never verified and keeps live ones", () => {
    const store = new ChallengeStore();
    const now = 1_000_000;
    store.set("abandoned", { id: "abandoned", walletAddress: "abandoned", message: "a", expiresAt: now - 1 });
    store.set("live", { id: "live", walletAddress: "live", message: "b", expiresAt: now + 60_000 });

    expect(store.sweep(now)).toBe(1);
    expect(store.get("abandoned")).toBeUndefined();
    expect(store.get("live")).toBeDefined();
    expect(store.size).toBe(1);
  });

  it("evicts abandoned challenges on a timer without any /verify call", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const store = new ChallengeStore(100, 1000);
    store.startSweeping();
    store.set("abandoned", { id: "abandoned", walletAddress: "abandoned", message: "a", expiresAt: Date.now() + 500 });

    jest.advanceTimersByTime(2000);

    expect(store.size).toBe(0);
    store.stopSweeping();
  });

  it("is bounded: a flood of unexpired challenges drops the oldest instead of growing forever", () => {
    const store = new ChallengeStore(3);
    const expiresAt = Date.now() + 60_000;
    for (const id of ["G1", "G2", "G3", "G4"]) {
      store.set(id, { id, walletAddress: id, message: id, expiresAt });
    }

    expect(store.size).toBe(3);
    expect(store.get("G1")).toBeUndefined();
    expect(store.get("G4")).toBeDefined();
  });
});
