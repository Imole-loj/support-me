import { z } from "zod";
import { assetCode, stellarAddress } from "./common";
import { contrastRatio, WCAG_AA_TEXT } from "../lib/contrast";
import { avatarUrlSchema, socialLinksSchema } from "./profileUrls";

export const usernameParamSchema = z.object({
  username: z.string().min(1, "username is required"),
});

export const listCreatorsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["newest", "most-supported"]).optional().default("newest"),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(50).optional().default(20),
});

export const leaderboardQuerySchema = z.object({
  // "creators" ranks by total received; "supporters" ranks by total given.
  type: z.enum(["creators", "supporters"]).optional().default("creators"),
  // Donations across different currencies are never summed together (1 XLM
  // and 1 USDC are not the same value), so a single currency is ranked at a
  // time — defaulting to XLM, the platform's default asset.
  currency: assetCode.optional().default("XLM"),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

const usernamePattern = /^[a-zA-Z0-9_-]{3,30}$/;

// Base64 signature of the message returned by POST /api/auth/challenge for the
// wallet being linked. Only needed to use a payout wallet other than the one
// the user signed in with (#276).
const walletSignature = z.string().min(1).max(512);

export const createCreatorSchema = z.object({
  // Defaults to the authenticated user's wallet. Accept the old signup form's
  // empty sentinel for compatibility, but normalize it before persistence.
  walletAddress: stellarAddress.or(z.literal("")).nullable().optional(),
  walletSignature: walletSignature.optional(),
  displayName: z.string().max(80).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: avatarUrlSchema.optional(),
});

export const createCreatorParamsSchema = z.object({
  username: z
    .string()
    .regex(usernamePattern, "username must be 3-30 characters (letters, numbers, _ or -)"),
});

export const updateCreatorSchema = z.object({
  displayName: z.string().max(80).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: avatarUrlSchema.optional(),
  walletAddress: stellarAddress.optional(),
  walletSignature: walletSignature.optional(),
  socialLinks: socialLinksSchema.optional(),
  acceptsXlm: z.boolean().optional(),
  acceptsUsdc: z.boolean().optional(),
  acceptsUsdt: z.boolean().optional(),
  // Deprecated alongside Creator.donationGoal (see prisma/schema.prisma) —
  // still accepted here so an already-deployed frontend that hasn't picked
  // up the multi-goal UI doesn't break, but new goals should go through
  // POST /api/goals/:username instead. null clears a previously-set goal; a
  // positive integer sets it.
  donationGoal: z.number().int().positive().nullable().optional(),
  // Quick-select amounts for the donate page's preset buttons (#120).
  // Capped at 6 so the row of buttons stays usable on a small screen; an
  // empty array explicitly clears a creator's customization, falling back
  // to the frontend's hardcoded defaults.
  presetAmounts: z.array(z.number().positive()).max(6).optional(),
});

// Custom profile theme (#227). The profile renders text in whichever of the
// design system's two ink colors (light-mode near-black, dark-mode off-white)
// contrasts better with the chosen background, and primary buttons as white
// text on the accent — so those are the pairs that must meet WCAG AA.
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #7c3aed");
const INK_COLORS = ["#0a0a0a", "#f4f2ec"];
const BUTTON_TEXT_COLOR = "#ffffff";

export const themeSchema = z
  .object({
    backgroundColor: hexColor,
    accentColor: hexColor,
    font: z.enum(["default", "serif", "mono", "system"]),
    layout: z.enum(["default", "compact", "centered"]),
  })
  .refine(
    ({ backgroundColor }) =>
      Math.max(...INK_COLORS.map((ink) => contrastRatio(backgroundColor, ink))) >= WCAG_AA_TEXT,
    { message: "Background color leaves too little contrast for text (WCAG AA)", path: ["backgroundColor"] }
  )
  .refine(({ accentColor }) => contrastRatio(accentColor, BUTTON_TEXT_COLOR) >= WCAG_AA_TEXT, {
    message: "Accent color leaves too little contrast for button text (WCAG AA)",
    path: ["accentColor"],
  });

// null resets the profile to the default design.
export const updateThemeSchema = z.object({
  theme: themeSchema.nullable(),
});
