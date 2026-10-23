import { z } from "zod";
import { config } from "../config";

function httpUrl(value: string): URL | null {
  // Reject browser-normalized malformed URLs, credentials and control chars.
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password) return null;
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export const avatarUrlSchema = z.string().trim().max(2048).refine((value) => {
  const url = httpUrl(value);
  const cloud = config.cloudinaryCloudName;
  return Boolean(
    cloud && /^[a-zA-Z0-9_-]+$/.test(cloud) && url &&
    url.protocol === "https:" && url.hostname === "res.cloudinary.com" && !url.port &&
    url.pathname.startsWith(`/${cloud}/`) && url.pathname.length > cloud.length + 2
  );
}, "avatarUrl must be an HTTPS URL in the configured Cloudinary cloud");

function socialUrl(prefix?: string, handlePattern = /^@?[a-zA-Z0-9_.-]+$/) {
  return z.string().trim().min(1).max(300).transform((value, ctx) => {
    if (httpUrl(value)) return value;
    // A handle cannot contain a scheme, slashes, query or fragment. The one
    // path-shaped exception is LinkedIn's conventional in/<username> form.
    if (prefix && handlePattern.test(value)) return prefix + value.replace(/^@/, "");
    ctx.addIssue({ code: "custom", message: "Must be an absolute http(s) URL or a valid platform handle" });
    return z.NEVER;
  });
}

// Match the settings form's platform keys. Strictness caps the set at eight
// known platforms and prevents arbitrary JSON keys from being stored as links.
export const socialLinksSchema = z.object({
  twitter: socialUrl("https://x.com/").optional(),
  instagram: socialUrl("https://instagram.com/").optional(),
  youtube: socialUrl("https://youtube.com/@").optional(),
  tiktok: socialUrl("https://tiktok.com/@").optional(),
  github: socialUrl("https://github.com/").optional(),
  linkedin: socialUrl("https://linkedin.com/", /^in\/[a-zA-Z0-9_-]+$/).optional(),
  telegram: socialUrl("https://t.me/").optional(),
  website: socialUrl().optional(),
}).strict();
