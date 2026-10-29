jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    user: { create: jest.fn() },
    creator: { findUnique: jest.fn() },
    oAuthIdentity: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../services/twitterOAuth", () => ({
  ...jest.requireActual("../../services/twitterOAuth"),
  exchangeCodeForToken: jest.fn(),
  fetchTwitterProfile: jest.fn(),
  getTwitterOAuthConfig: jest.fn(),
}));

import prisma from "../../prisma";
import {
  exchangeCodeForToken,
  fetchTwitterProfile,
  getTwitterOAuthConfig,
} from "../../services/twitterOAuth";
import { completeTwitterAuth, startTwitterAuth } from "../../services/twitterAuth";

const mockedPrisma = prisma as unknown as {
  user: { create: jest.Mock };
  creator: { findUnique: jest.Mock };
  oAuthIdentity: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  $transaction: jest.Mock;
};
const mockedGetConfig = getTwitterOAuthConfig as jest.MockedFunction<typeof getTwitterOAuthConfig>;
const mockedExchange = exchangeCodeForToken as jest.MockedFunction<typeof exchangeCodeForToken>;
const mockedFetchProfile = fetchTwitterProfile as jest.MockedFunction<typeof fetchTwitterProfile>;

const CONFIG = {
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "https://supportme.app/callback",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetConfig.mockReturnValue(CONFIG);
  mockedPrisma.$transaction.mockImplementation((callback: (client: typeof mockedPrisma) => unknown) =>
    callback(mockedPrisma)
  );
});

describe("startTwitterAuth (#14)", () => {
  it("throws a 503 when Twitter OAuth is not configured", () => {
    mockedGetConfig.mockReturnValue(null);
    expect(() => startTwitterAuth()).toThrow(
      expect.objectContaining({ statusCode: 503 })
    );
  });

  it("returns a twitter.com authorize URL with a state param when configured", () => {
    const url = new URL(startTwitterAuth());
    expect(url.hostname).toBe("twitter.com");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("generates a different state on every call", () => {
    const first = new URL(startTwitterAuth()).searchParams.get("state");
    const second = new URL(startTwitterAuth()).searchParams.get("state");
    expect(first).not.toBe(second);
  });
});

describe("completeTwitterAuth (#14)", () => {
  it("throws a 503 when Twitter OAuth is not configured", async () => {
    mockedGetConfig.mockReturnValue(null);
    await expect(completeTwitterAuth("code", "state")).rejects.toMatchObject({ statusCode: 503 });
  });

  it("rejects a missing code or state before touching the provider", async () => {
    await expect(completeTwitterAuth("", "state")).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedExchange).not.toHaveBeenCalled();
  });

  it("rejects a state that was never issued (or already used)", async () => {
    await expect(completeTwitterAuth("code", "never-issued-state")).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(mockedExchange).not.toHaveBeenCalled();
  });

  it("rejects the same state used twice (single-use, mirroring the wallet challenge)", async () => {
    const authorizeUrl = new URL(startTwitterAuth());
    const state = authorizeUrl.searchParams.get("state")!;

    mockedExchange.mockResolvedValue({ accessToken: "at" });
    mockedFetchProfile.mockResolvedValue({ id: "1", username: "alice", name: "Alice" });
    mockedPrisma.oAuthIdentity.findUnique.mockResolvedValue(null);
    mockedPrisma.user.create.mockResolvedValue({ id: 1, walletAddress: null, email: null });
    mockedPrisma.oAuthIdentity.create.mockResolvedValue({});
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    await completeTwitterAuth("code", state);
    await expect(completeTwitterAuth("code", state)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("creates a new account and links the Twitter identity for a first-time sign-in", async () => {
    const authorizeUrl = new URL(startTwitterAuth());
    const state = authorizeUrl.searchParams.get("state")!;

    mockedExchange.mockResolvedValue({ accessToken: "at-1", refreshToken: "rt-1" });
    mockedFetchProfile.mockResolvedValue({ id: "twitter-id-1", username: "alice", name: "Alice" });
    mockedPrisma.oAuthIdentity.findUnique.mockResolvedValue(null);
    mockedPrisma.user.create.mockResolvedValue({ id: 42, walletAddress: null, email: null });
    mockedPrisma.oAuthIdentity.create.mockResolvedValue({});
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    const session = await completeTwitterAuth("auth-code", state);

    expect(mockedPrisma.user.create).toHaveBeenCalledWith({ data: {} });
    expect(mockedPrisma.oAuthIdentity.create).toHaveBeenCalledWith({
      data: {
        provider: "twitter",
        providerAccountId: "twitter-id-1",
        userId: 42,
      },
    });
    expect(session.user).toEqual({ id: 42, walletAddress: null });
    expect(session.hasProfile).toBe(false);
    expect(typeof session.token).toBe("string");
  });

  it("matches a returning user by (provider, providerAccountId) without storing tokens (#367)", async () => {
    const authorizeUrl = new URL(startTwitterAuth());
    const state = authorizeUrl.searchParams.get("state")!;

    mockedExchange.mockResolvedValue({ accessToken: "new-at" });
    mockedFetchProfile.mockResolvedValue({ id: "twitter-id-2", username: "bob", name: "Bob" });
    mockedPrisma.oAuthIdentity.findUnique.mockResolvedValue({
      id: 5,
      provider: "twitter",
      providerAccountId: "twitter-id-2",
      userId: 7,
      user: { id: 7, walletAddress: "GABC", email: null },
    });
    mockedPrisma.oAuthIdentity.update.mockResolvedValue({});
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 1, username: "bob" });

    const session = await completeTwitterAuth("auth-code", state);

    expect(mockedPrisma.user.create).not.toHaveBeenCalled();
    expect(mockedPrisma.oAuthIdentity.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { updatedAt: expect.any(Date) },
    });
    expect(session.user).toEqual({ id: 7, walletAddress: "GABC" });
    expect(session.hasProfile).toBe(true);
    expect(session.username).toBe("bob");
  });

  it("never persists accessToken or refreshToken in OAuthIdentity rows (#367)", async () => {
    const authorizeUrl = new URL(startTwitterAuth());
    const state = authorizeUrl.searchParams.get("state")!;

    mockedExchange.mockResolvedValue({ accessToken: "secret-token", refreshToken: "secret-refresh" });
    mockedFetchProfile.mockResolvedValue({ id: "safe-twitter-id", username: "safe", name: "Safe" });
    mockedPrisma.oAuthIdentity.findUnique.mockResolvedValue(null);
    mockedPrisma.user.create.mockResolvedValue({ id: 99, walletAddress: null, email: null });
    mockedPrisma.oAuthIdentity.create.mockResolvedValue({});
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    await completeTwitterAuth("code", state);

    const createCall = mockedPrisma.oAuthIdentity.create.mock.calls[0][0];
    expect(createCall.data).not.toHaveProperty("accessToken");
    expect(createCall.data).not.toHaveProperty("refreshToken");
  });

  it("refuses to sign in a returning user whose account has been soft-deleted (#270)", async () => {
    const authorizeUrl = new URL(startTwitterAuth());
    const state = authorizeUrl.searchParams.get("state")!;

    mockedExchange.mockResolvedValue({ accessToken: "new-at" });
    mockedFetchProfile.mockResolvedValue({ id: "twitter-id-3", username: "deleted", name: "Deleted" });
    // Account deletion never removes the OAuthIdentity row, so this lookup
    // still matches the deleted user.
    mockedPrisma.oAuthIdentity.findUnique.mockResolvedValue({
      id: 6,
      provider: "twitter",
      providerAccountId: "twitter-id-3",
      userId: 8,
      user: { id: 8, walletAddress: null, email: null, deletedAt: new Date() },
    });

    await expect(completeTwitterAuth("auth-code", state)).rejects.toMatchObject({ statusCode: 401 });
    expect(mockedPrisma.oAuthIdentity.update).not.toHaveBeenCalled();
  });

  it("looks up the OAuth identity by the exact (provider, providerAccountId) compound key", async () => {
    const authorizeUrl = new URL(startTwitterAuth());
    const state = authorizeUrl.searchParams.get("state")!;

    mockedExchange.mockResolvedValue({ accessToken: "at" });
    mockedFetchProfile.mockResolvedValue({ id: "abc123", username: "carol", name: "Carol" });
    mockedPrisma.oAuthIdentity.findUnique.mockResolvedValue(null);
    mockedPrisma.user.create.mockResolvedValue({ id: 1, walletAddress: null, email: null });
    mockedPrisma.oAuthIdentity.create.mockResolvedValue({});
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    await completeTwitterAuth("code", state);

    expect(mockedPrisma.oAuthIdentity.findUnique).toHaveBeenCalledWith({
      where: { provider_providerAccountId: { provider: "twitter", providerAccountId: "abc123" } },
      include: { user: true },
    });
  });
});
