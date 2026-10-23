import { z } from "zod";
import { stellarAddress } from "./common";

export const challengeSchema = z.object({
  walletAddress: stellarAddress,
});

export const verifySchema = z.object({
  walletAddress: stellarAddress,
  challengeId: z.string().min(1, "challengeId is required when provided").optional(),
  signedMessage: z.string().min(1, "signedMessage is required"),
});

export const magicLinkRequestSchema = z.object({
  email: z.string().trim().email("Must be a valid email address"),
});

export const magicLinkVerifySchema = z.object({
  token: z.string().min(1, "token is required"),
});

export const twitterCallbackSchema = z.object({
  code: z.string().min(1, "code is required"),
  state: z.string().min(1, "state is required"),
});
