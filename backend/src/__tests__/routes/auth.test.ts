jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    user: {
      upsert: jest.fn(),
    },
    creator: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock("../../services/magicLink", () => ({
  requestMagicLink: jest.fn(),
  verifyMagicLink: jest.fn(),
}));

jest.mock("../../services/twitterAuth", () => ({
  startTwitterAuth: jest.fn(),
  completeTwitterAuth: jest.fn(),
}));

import { createHash } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import request from "supertest";
import app from "../../app";
import prisma from "../../prisma";
import { requestMagicLink, verifyMagicLink } from "../../services/magicLink";
import { completeTwitterAuth, startTwitterAuth } from "../../services/twitterAuth";

const mockedPrisma = prisma as unknown as {
  user: { upsert: jest.Mock };
  creator: { findUnique: jest.Mock };
};
const mockedRequestMagicLink = requestMagicLink as jest.MockedFunction<typeof requestMagicLink>;
const mockedVerifyMagicLink = verifyMagicLink as jest.MockedFunction<typeof verifyMagicLink>;
const mockedStartTwitterAuth = startTwitterAuth as jest.MockedFunction<typeof startTwitterAuth>;
const mockedCompleteTwitterAuth = completeTwitterAuth as jest.MockedFunction<typeof completeTwitterAuth>;

const STELLAR_SIGNED_MESSAGE_PREFIX = "Stellar Signed Message:\n";

function signChallenge(keypair: Keypair, message: string): string {
  const payload = Buffer.concat([
    Buffer.from(STELLAR_SIGNED_MESSAGE_PREFIX, "utf-8"),
    Buffer.from(message, "utf-8"),
  ]);
  const hash = createHash("sha256").update(payload).digest();
  return keypair.sign(hash).toString("base64");
}

describe("POST /api/auth/challenge", () => {
  it("rejects a malformed wallet address", async () => {
    const res = await request(app)
      .post("/api/auth/challenge")
      .send({ walletAddress: "not-a-real-address" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("issues a signable challenge message for a valid address", async () => {
    const keypair = Keypair.random();

    const res = await request(app)
      .post("/api/auth/challenge")
      .send({ walletAddress: keypair.publicKey() });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain(`Address: ${keypair.publicKey()}`);
  });
});

describe("POST /api/auth/verify", () => {
  it("rejects verification when no challenge was requested first", async () => {
    const keypair = Keypair.random();

    const res = await request(app).post("/api/auth/verify").send({
      walletAddress: keypair.publicKey(),
      signedMessage: "bogus",
    });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("rejects an invalid signature", async () => {
    const keypair = Keypair.random();
    const otherKeypair = Keypair.random();

    const challengeRes = await request(app)
      .post("/api/auth/challenge")
      .send({ walletAddress: keypair.publicKey() });
    const { message } = challengeRes.body;

    // Sign with the wrong keypair so the signature won't match walletAddress.
    const badSignature = signChallenge(otherKeypair, message);

    const res = await request(app).post("/api/auth/verify").send({
      walletAddress: keypair.publicKey(),
      signedMessage: badSignature,
    });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("issues a token for a correctly signed challenge", async () => {
    const keypair = Keypair.random();

    const challengeRes = await request(app)
      .post("/api/auth/challenge")
      .send({ walletAddress: keypair.publicKey() });
    const { message } = challengeRes.body;

    const signedMessage = signChallenge(keypair, message);

    mockedPrisma.user.upsert.mockResolvedValue({ id: 1, walletAddress: keypair.publicKey() });
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    const res = await request(app).post("/api/auth/verify").send({
      walletAddress: keypair.publicKey(),
      signedMessage,
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toEqual({ id: 1, walletAddress: keypair.publicKey() });
    expect(res.body.hasProfile).toBe(false);
  });

  it("refuses to sign in a wallet that belongs to a soft-deleted account (#270)", async () => {
    const keypair = Keypair.random();

    const challengeRes = await request(app)
      .post("/api/auth/challenge")
      .send({ walletAddress: keypair.publicKey() });
    const { message } = challengeRes.body;
    const signedMessage = signChallenge(keypair, message);

    // walletAddress survives a soft delete (only email is cleared), so the
    // upsert still matches the same row and returns it with deletedAt set.
    mockedPrisma.user.upsert.mockResolvedValue({
      id: 1,
      walletAddress: keypair.publicKey(),
      deletedAt: new Date(),
    });

    const res = await request(app).post("/api/auth/verify").send({
      walletAddress: keypair.publicKey(),
      signedMessage,
    });

    expect(res.status).toBe(401);
    expect(mockedPrisma.creator.findUnique).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/magic-link (#15)", () => {
  beforeEach(() => {
    mockedRequestMagicLink.mockReset();
  });

  it("rejects an invalid email", async () => {
    const res = await request(app).post("/api/auth/magic-link").send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(mockedRequestMagicLink).not.toHaveBeenCalled();
  });

  it("returns a generic success message for a valid email", async () => {
    mockedRequestMagicLink.mockResolvedValue(undefined);

    const res = await request(app).post("/api/auth/magic-link").send({ email: "a@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/sign-in link/i);
    expect(mockedRequestMagicLink).toHaveBeenCalledWith("a@example.com");
  });

  it("returns the same generic message shape whether or not the email has an account (no enumeration)", async () => {
    mockedRequestMagicLink.mockResolvedValue(undefined);

    const knownRes = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "known@example.com" });
    const unknownRes = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "unknown@example.com" });

    expect(knownRes.body).toEqual(unknownRes.body);
  });

  it("surfaces a 429 when the rate limit is exceeded", async () => {
    const { TooManyRequestsError } = await import("../../errors/AppError");
    mockedRequestMagicLink.mockRejectedValue(new TooManyRequestsError());

    const res = await request(app).post("/api/auth/magic-link").send({ email: "a@example.com" });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_REQUESTS");
  });
});

describe("POST /api/auth/magic-link/verify (#15)", () => {
  beforeEach(() => {
    mockedVerifyMagicLink.mockReset();
  });

  it("rejects a missing token", async () => {
    const res = await request(app).post("/api/auth/magic-link/verify").send({});

    expect(res.status).toBe(400);
    expect(mockedVerifyMagicLink).not.toHaveBeenCalled();
  });

  it("returns a session matching the wallet-auth response shape for a valid token", async () => {
    mockedVerifyMagicLink.mockResolvedValue({
      user: { id: 1, email: "a@example.com", walletAddress: null },
      token: "signed.jwt.token",
      hasProfile: false,
    });

    const res = await request(app)
      .post("/api/auth/magic-link/verify")
      .send({ token: "raw-token" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: 1, email: "a@example.com", walletAddress: null },
      token: "signed.jwt.token",
      hasProfile: false,
    });
  });

  it("rejects an expired or already-used token with a clear error", async () => {
    const { UnauthorizedError } = await import("../../errors/AppError");
    mockedVerifyMagicLink.mockRejectedValue(new UnauthorizedError("This magic link has expired"));

    const res = await request(app)
      .post("/api/auth/magic-link/verify")
      .send({ token: "expired-token" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("This magic link has expired");
  });
});

describe("GET /api/auth/twitter (#14)", () => {
  beforeEach(() => {
    mockedStartTwitterAuth.mockReset();
  });

  it("returns the redirect URL to start the OAuth flow", async () => {
    mockedStartTwitterAuth.mockReturnValue("https://twitter.com/i/oauth2/authorize?client_id=x");

    const res = await request(app).get("/api/auth/twitter");

    expect(res.status).toBe(200);
    expect(res.body.redirectUrl).toBe("https://twitter.com/i/oauth2/authorize?client_id=x");
  });

  it("returns a 503 when Twitter sign-in is not configured", async () => {
    const { ServiceUnavailableError } = await import("../../errors/AppError");
    mockedStartTwitterAuth.mockImplementation(() => {
      throw new ServiceUnavailableError("Twitter sign-in is not configured");
    });

    const res = await request(app).get("/api/auth/twitter");

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("GET /api/auth/twitter/callback (#14)", () => {
  beforeEach(() => {
    mockedCompleteTwitterAuth.mockReset();
  });

  it("rejects a callback missing code or state", async () => {
    const res = await request(app).get("/api/auth/twitter/callback").query({ code: "only-code" });

    expect(res.status).toBe(400);
    expect(mockedCompleteTwitterAuth).not.toHaveBeenCalled();
  });

  it("returns a session matching the wallet-auth response shape on success", async () => {
    mockedCompleteTwitterAuth.mockResolvedValue({
      user: { id: 5, walletAddress: null },
      token: "signed.jwt.token",
      hasProfile: false,
    });

    const res = await request(app)
      .get("/api/auth/twitter/callback")
      .query({ code: "auth-code", state: "state-value" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: 5, walletAddress: null },
      token: "signed.jwt.token",
      hasProfile: false,
    });
    expect(mockedCompleteTwitterAuth).toHaveBeenCalledWith("auth-code", "state-value");
  });

  it("returns a clear error for an invalid or expired OAuth state", async () => {
    const { UnauthorizedError } = await import("../../errors/AppError");
    mockedCompleteTwitterAuth.mockRejectedValue(
      new UnauthorizedError("Invalid or expired OAuth state, please try again")
    );

    const res = await request(app)
      .get("/api/auth/twitter/callback")
      .query({ code: "auth-code", state: "bad-state" });

    expect(res.status).toBe(401);
  });

  it("returns a clear error when Twitter denies or the exchange fails", async () => {
    mockedCompleteTwitterAuth.mockRejectedValue(new Error("Twitter token exchange failed (400): access_denied"));

    const res = await request(app)
      .get("/api/auth/twitter/callback")
      .query({ code: "auth-code", state: "state-value" });

    expect(res.status).toBe(500);
  });
});

describe("POST /api/auth/logout & Cookie Sessions (#366)", () => {
  it("clears the auth cookie on logout", async () => {
    const res = await request(app).post("/api/auth/logout");

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Logged out successfully");
    const cookieHeader = res.headers["set-cookie"];
    expect(cookieHeader).toBeDefined();
    expect(cookieHeader[0]).toMatch(/token=;/);
  });

  it("sets httpOnly cookie on successful magic link verification", async () => {
    mockedVerifyMagicLink.mockResolvedValueOnce({
      user: { id: 10, walletAddress: null, email: "cookie@example.com" },
      token: "mock-session-jwt",
      hasProfile: false,
    });

    const res = await request(app)
      .post("/api/auth/magic-link/verify")
      .send({ token: "valid-token" });

    expect(res.status).toBe(200);
    const cookieHeader = res.headers["set-cookie"];
    expect(cookieHeader).toBeDefined();
    expect(cookieHeader[0]).toContain("token=mock-session-jwt");
    expect(cookieHeader[0]).toContain("HttpOnly");
    expect(cookieHeader[0]).toContain("SameSite=Lax");
  });
});
