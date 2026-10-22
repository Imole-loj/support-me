jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
  },
}));

import { Response } from "express";
import prisma from "../../prisma";
import { authMiddleware, generateToken, AuthRequest } from "../../middleware/auth";

const mockedPrisma = prisma as unknown as { user: { findUnique: jest.Mock } };

function fakeRequest(token?: string, cookieToken?: string, method = "GET", origin?: string): AuthRequest {
  return {
    method,
    headers: {
      authorization: token ? `Bearer ${token}` : undefined,
      cookie: cookieToken ? `token=${cookieToken}` : undefined,
      origin,
    },
  } as unknown as AuthRequest;
}

function fakeResponse(): Response {
  return {} as Response;
}

/**
 * authMiddleware is wrapped in asyncHandler, which fires the inner promise
 * without returning it (Express never awaits middleware), so a test must
 * wait on `next` being called instead of awaiting the authMiddleware call
 * itself.
 */
function runMiddleware(req: AuthRequest): Promise<unknown> {
  return new Promise((resolve) => {
    authMiddleware(req, fakeResponse(), resolve as never);
  });
}

describe("authMiddleware (#270, #366)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects a request with no token", async () => {
    const error = await runMiddleware(fakeRequest());

    expect(error).toMatchObject({ statusCode: 401 });
  });

  it("rejects a malformed token", async () => {
    const error = await runMiddleware(fakeRequest("not-a-real-jwt"));

    expect(error).toMatchObject({ statusCode: 401 });
  });

  it("accepts a valid token for a never-deleted user", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ deletedAt: null });
    const token = generateToken(101, null);
    const req = fakeRequest(token);

    const result = await runMiddleware(req);

    expect(result).toBeUndefined(); // next() called with no error
    expect(req.user).toMatchObject({ id: 101, walletAddress: null });
  });

  it("authenticates via httpOnly cookie (#366)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ deletedAt: null });
    const token = generateToken(101, null);
    const req = fakeRequest(undefined, token);

    const result = await runMiddleware(req);

    expect(result).toBeUndefined();
    expect(req.user).toMatchObject({ id: 101, walletAddress: null });
  });

  it("blocks cookie-based state-changing requests with invalid origin (CSRF protection #366)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ deletedAt: null });
    const token = generateToken(101, null);
    const req = fakeRequest(undefined, token, "POST", "https://evil-attacker.example");

    const error = await runMiddleware(req);

    expect(error).toMatchObject({ statusCode: 401, message: "Cross-site request forgery blocked" });
  });

  it("allows cookie-based state-changing requests with valid origin (#366)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ deletedAt: null });
    const token = generateToken(101, null);
    const req = fakeRequest(undefined, token, "POST", "http://localhost:3000");

    const result = await runMiddleware(req);

    expect(result).toBeUndefined();
    expect(req.user).toMatchObject({ id: 101, walletAddress: null });
  });

  it("rejects a token issued for a user who has since been soft-deleted", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ deletedAt: new Date() });
    const token = generateToken(102, null);

    const error = await runMiddleware(fakeRequest(token));

    expect(error).toMatchObject({ statusCode: 401 });
  });

  it("rejects a token whose user id no longer exists at all", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    const token = generateToken(103, null);

    const error = await runMiddleware(fakeRequest(token));

    expect(error).toMatchObject({ statusCode: 401 });
  });

  it("caches the deletedAt lookup: a second request for the same user does not re-query the database", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ deletedAt: null });
    const token = generateToken(104, null);

    await runMiddleware(fakeRequest(token));
    await runMiddleware(fakeRequest(token));

    expect(mockedPrisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("forwards a database error to next() instead of hanging the request", async () => {
    mockedPrisma.user.findUnique.mockRejectedValue(new Error("connection refused"));
    const token = generateToken(105, null);

    const error = await runMiddleware(fakeRequest(token));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("connection refused");
  });
});
