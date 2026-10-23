import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { asyncHandler } from "../middleware/asyncHandler";
import { TtlCache } from "../services/ttlCache";

const router = Router();

export const SITEMAP_PAGE_SIZE = 10_000;
const SITEMAP_TTL_MS = 10 * 60 * 1000; // 10 minutes cache (#368)
const STATIC_LASTMOD = "2026-09-01"; // Stable lastmod for static pages (#368)

export const sitemapCache = new TtlCache<string>(SITEMAP_TTL_MS);

const getBaseUrl = (): string =>
  (process.env.APP_URL || "https://supportme.app").replace(/\/$/, "");

/**
 * Escapes XML special characters for safety in sitemap XML.
 */
function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getStaticPages(baseUrl: string) {
  return [
    { loc: `${baseUrl}/`, changefreq: "daily", priority: "1.0", lastmod: STATIC_LASTMOD },
    { loc: `${baseUrl}/discover`, changefreq: "daily", priority: "0.8", lastmod: STATIC_LASTMOD },
    { loc: `${baseUrl}/activity`, changefreq: "hourly", priority: "0.7", lastmod: STATIC_LASTMOD },
  ];
}

function buildUrlSetXml(
  pages: Array<{ loc: string; lastmod: string; changefreq: string; priority: string }>
): string {
  const xmlUrls = pages
    .map(
      (page) => `  <url>
    <loc>${escapeXml(page.loc)}</loc>
    <lastmod>${page.lastmod}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${xmlUrls}
</urlset>`;
}

function buildSitemapIndexXml(baseUrl: string, totalPages: number, lastmod: string): string {
  const sitemaps = Array.from({ length: totalPages }, (_, i) => {
    const pageNum = i + 1;
    return `  <sitemap>
    <loc>${escapeXml(`${baseUrl}/sitemap-${pageNum}.xml`)}</loc>
    <lastmod>${lastmod}</lastmod>
  </sitemap>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps}
</sitemapindex>`;
}

/**
 * GET /sitemap.xml
 * Returns dynamic sitemap.xml or sitemap index when URLs exceed threshold.
 * Cached with TtlCache (10 mins) to prevent repeated database queries (#368).
 */
router.get(
  "/sitemap.xml",
  asyncHandler(async (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl();

    const cached = sitemapCache.get("sitemap-root");
    if (cached) {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      return res.send(cached);
    }

    const staticPages = getStaticPages(baseUrl);
    const creatorCount = await prisma.creator.count();
    const totalUrls = staticPages.length + creatorCount;

    if (totalUrls <= SITEMAP_PAGE_SIZE) {
      const creators = await prisma.creator.findMany({
        select: {
          username: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
      });

      const creatorPages = creators.map((c) => ({
        loc: `${baseUrl}/${encodeURIComponent(c.username)}`,
        lastmod: (c.updatedAt ? new Date(c.updatedAt) : new Date()).toISOString().split("T")[0],
        changefreq: "weekly",
        priority: "0.9",
      }));

      const xml = buildUrlSetXml([...staticPages, ...creatorPages]);
      sitemapCache.set("sitemap-root", xml);
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      return res.send(xml);
    }

    // Split into sitemap index when exceeding threshold (#368)
    const totalPages = Math.ceil(totalUrls / SITEMAP_PAGE_SIZE);
    const latestCreator = await prisma.creator.findFirst({
      select: { updatedAt: true },
      orderBy: { updatedAt: "desc" },
    });
    const lastmod = (latestCreator?.updatedAt ? new Date(latestCreator.updatedAt) : new Date())
      .toISOString()
      .split("T")[0];

    const indexXml = buildSitemapIndexXml(baseUrl, totalPages, lastmod);
    sitemapCache.set("sitemap-root", indexXml);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    return res.send(indexXml);
  })
);

/**
 * GET /sitemap-:page.xml
 * Returns paged partition of sitemap URLs when index splitting is active (#368).
 */
router.get(
  "/sitemap-:page.xml",
  asyncHandler(async (req: Request, res: Response) => {
    const pageNum = parseInt(req.params.page, 10);
    if (isNaN(pageNum) || pageNum < 1) {
      return res.status(404).send("Not Found");
    }

    const cacheKey = `sitemap-page-${pageNum}`;
    const cached = sitemapCache.get(cacheKey);
    if (cached) {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      return res.send(cached);
    }

    const baseUrl = getBaseUrl();
    const staticPages = pageNum === 1 ? getStaticPages(baseUrl) : [];
    const staticOffset = staticPages.length;
    const skip = pageNum === 1 ? 0 : (pageNum - 1) * SITEMAP_PAGE_SIZE - getStaticPages(baseUrl).length;
    const take = SITEMAP_PAGE_SIZE - staticOffset;

    const creators = await prisma.creator.findMany({
      select: {
        username: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      skip: Math.max(0, skip),
      take: Math.max(0, take),
    });

    if (staticPages.length === 0 && creators.length === 0) {
      return res.status(404).send("Not Found");
    }

    const creatorPages = creators.map((c) => ({
      loc: `${baseUrl}/${encodeURIComponent(c.username)}`,
      lastmod: (c.updatedAt ? new Date(c.updatedAt) : new Date()).toISOString().split("T")[0],
      changefreq: "weekly",
      priority: "0.9",
    }));

    const xml = buildUrlSetXml([...staticPages, ...creatorPages]);
    sitemapCache.set(cacheKey, xml);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    return res.send(xml);
  })
);

/**
 * GET /robots.txt
 * Instructs search crawlers which paths may be indexed (public pages) and
 * points at the sitemap / sitemap index.
 */
router.get("/robots.txt", (_req: Request, res: Response) => {
  const baseUrl = getBaseUrl();

  const robotsTxt = `# SupportMe Robots Exclusion Standard
User-agent: *
Allow: /
Allow: /discover
Allow: /activity

# Disallow private user spaces and administrative routes
Disallow: /app
Disallow: /app/
Disallow: /dashboard
Disallow: /dashboard/
Disallow: /settings
Disallow: /settings/
Disallow: /auth
Disallow: /auth/
Disallow: /admin
Disallow: /admin/
Disallow: /api/

# Sitemap location
Sitemap: ${baseUrl}/sitemap.xml
`;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.send(robotsTxt);
});

export default router;
