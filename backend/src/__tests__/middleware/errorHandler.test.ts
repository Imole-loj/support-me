jest.mock("@sentry/node", () => ({
  captureException: jest.fn(),
}));

import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { z, ZodError } from "zod";
import * as Sentry from "@sentry/node";
import { errorHandler } from "../../middleware/errorHandler";
import { BadRequestError, NotFoundError } from "../../errors/AppError";

function mockReqRes(overrides: Partial<Request> = {}) {
  const req = { method: "GET", path: "/api/test", requestId: "req-123", ...overrides } as Request;
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  const next = jest.fn();
  return { req, res, status, json, next };
}

describe("errorHandler middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("maps an AppError to its own statusCode and code, echoing requestId", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new BadRequestError("bad input");

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "bad input", code: "BAD_REQUEST", requestId: "req-123" });
  });

  it("maps a NotFoundError (404) distinctly from a BadRequestError (400)", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new NotFoundError("missing");

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: "missing", code: "NOT_FOUND", requestId: "req-123" });
  });

  it("maps a body-parser entity.parse.failed error to a 400 VALIDATION_ERROR shape", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = { type: "entity.parse.failed", status: 400 };

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: [{ path: "", message: "Request body is not valid JSON" }],
      requestId: "req-123",
    });
  });

  it("maps a ZodError to a 400 VALIDATION_ERROR with one detail per issue", () => {
    const { req, res, status, json, next } = mockReqRes();
    const schema = z.object({ amount: z.number().positive() });
    let zodError: ZodError;
    try {
      schema.parse({ amount: -5 });
      throw new Error("expected schema.parse to throw");
    } catch (e) {
      zodError = e as ZodError;
    }

    errorHandler(zodError, req, res, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: [{ path: "amount", message: expect.any(String) }],
      requestId: "req-123",
    });
  });

  it("maps a Prisma P2002 unique constraint violation to 409 CONFLICT", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["email"] },
    });

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: "A record with this email already exists",
      code: "CONFLICT",
      requestId: "req-123",
    });
  });

  it("falls back to a generic conflict message when Prisma P2002 has no meta.target", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });

    errorHandler(err, req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "A record with this value already exists" })
    );
  });

  it("maps a Prisma P2025 record-not-found error to 404 NOT_FOUND", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new Prisma.PrismaClientKnownRequestError("Record not found", {
      code: "P2025",
      clientVersion: "test",
    });

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: "Record not found", code: "NOT_FOUND", requestId: "req-123" });
  });

  it("falls through to a 500 for a Prisma error code with no explicit mapping", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new Prisma.PrismaClientKnownRequestError("Some other failure", {
      code: "P2003",
      clientVersion: "test",
    });

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
      requestId: "req-123",
    });
  });

  it("maps an unknown/unexpected error to a generic 500, and reports it to Sentry", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new Error("something exploded");

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
      requestId: "req-123",
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: { requestId: "req-123", method: "GET", path: "/api/test" },
      })
    );
  });

  it("tags the Sentry report with 'unknown' requestId when none is set on the request", () => {
    const { req, res, next } = mockReqRes({ requestId: undefined });
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: expect.objectContaining({ requestId: "unknown" }) })
    );
  });

  it("omits requestId from the response payload when the request has none", () => {
    const { req, res, json, next } = mockReqRes({ requestId: undefined });
    const err = new BadRequestError("no id here");

    errorHandler(err, req, res, next);

    expect(json).toHaveBeenCalledWith({ error: "no id here", code: "BAD_REQUEST" });
  });

  it("does not report a known AppError to Sentry", () => {
    const { req, res, next } = mockReqRes();

    errorHandler(new BadRequestError("handled"), req, res, next);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
