import request from "supertest";
import app from "../../app";
import prisma from "../../prisma";
import { sitemapCache, SITEMAP_PAGE_SIZE } from "../../routes/seo";

jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    creator: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

describe("SEO Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sitemapCache.clear();
    (prisma.creator.count as jest.Mock).mockResolvedValue(0);
    (prisma.creator.findMany as jest.Mock).mockResolvedValue([]);
  });

  describe("GET /sitemap.xml", () => {
    it("returns valid XML with static pages and current dynamic creator profiles", async () => {
      (prisma.creator.count as jest.Mock).mockResolvedValue(2);
      (prisma.creator.findMany as jest.Mock).mockResolvedValueOnce([
        { username: "alice", updatedAt: new Date("2026-04-10T10:00:00Z") },
        { username: "bob_builder", updatedAt: new Date("2026-04-12T15:30:00Z") },
      ]);

      const res = await request(app).get("/sitemap.xml");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/xml");
      expect(res.text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(res.text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');

      // Verify static indexable pages have stable lastmod (#368)
      expect(res.text).toContain("<loc>https://supportme.app/</loc>");
      expect(res.text).toContain("<lastmod>2026-09-01</lastmod>");
      expect(res.text).toContain("<loc>https://supportme.app/discover</loc>");
      expect(res.text).toContain("<loc>https://supportme.app/activity</loc>");

      // Verify dynamic creator profile URLs
      expect(res.text).toContain("<loc>https://supportme.app/alice</loc>");
      expect(res.text).toContain("<lastmod>2026-04-10</lastmod>");
      expect(res.text).toContain("<loc>https://supportme.app/bob_builder</loc>");
      expect(res.text).toContain("<lastmod>2026-04-12</lastmod>");
    });

    it("caches generated XML with TtlCache and does not hit DB on subsequent requests (#368)", async () => {
      (prisma.creator.count as jest.Mock).mockResolvedValue(1);
      (prisma.creator.findMany as jest.Mock).mockResolvedValueOnce([
        { username: "cached_creator", updatedAt: new Date("2026-04-15T08:00:00Z") },
      ]);

      const firstRes = await request(app).get("/sitemap.xml");
      expect(firstRes.status).toBe(200);
      expect(prisma.creator.findMany).toHaveBeenCalledTimes(1);

      // Second request within TTL should hit cache and not hit findMany again
      const secondRes = await request(app).get("/sitemap.xml");
      expect(secondRes.status).toBe(200);
      expect(secondRes.text).toBe(firstRes.text);
      expect(prisma.creator.findMany).toHaveBeenCalledTimes(1);
    });

    it("splits into a sitemapindex when URL count exceeds threshold (#368)", async () => {
      // Mock creator count above threshold
      const excessCount = SITEMAP_PAGE_SIZE + 500;
      (prisma.creator.count as jest.Mock).mockResolvedValue(excessCount);
      (prisma.creator.findFirst as jest.Mock).mockResolvedValue({
        updatedAt: new Date("2026-10-01T12:00:00Z"),
      });

      const res = await request(app).get("/sitemap.xml");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/xml");
      expect(res.text).toContain("<sitemapindex");
      expect(res.text).toContain("<loc>https://supportme.app/sitemap-1.xml</loc>");
      expect(res.text).toContain("<loc>https://supportme.app/sitemap-2.xml</loc>");
      expect(res.text).toContain("<lastmod>2026-10-01</lastmod>");
    });

    it("serves paged partition /sitemap-1.xml when sitemap index is active (#368)", async () => {
      (prisma.creator.findMany as jest.Mock).mockResolvedValueOnce([
        { username: "paged_alice", updatedAt: new Date("2026-09-10T00:00:00Z") },
      ]);

      const res = await request(app).get("/sitemap-1.xml");
      expect(res.status).toBe(200);
      expect(res.text).toContain("<urlset");
      expect(res.text).toContain("<loc>https://supportme.app/paged_alice</loc>");
      expect(res.text).toContain("<loc>https://supportme.app/</loc>");
    });

    it("is also reachable at /api/sitemap.xml", async () => {
      (prisma.creator.count as jest.Mock).mockResolvedValue(0);
      (prisma.creator.findMany as jest.Mock).mockResolvedValueOnce([]);

      const res = await request(app).get("/api/sitemap.xml");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/xml");
    });
  });

  describe("GET /robots.txt", () => {
    it("allows public pages and disallows private/dashboard/auth routes and points to sitemap.xml", async () => {
      const res = await request(app).get("/robots.txt");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");

      // Verify allowed public routes
      expect(res.text).toContain("Allow: /");
      expect(res.text).toContain("Allow: /discover");
      expect(res.text).toContain("Allow: /activity");

      // Verify blocked private/auth routes
      expect(res.text).toContain("Disallow: /app");
      expect(res.text).toContain("Disallow: /dashboard");
      expect(res.text).toContain("Disallow: /settings");
      expect(res.text).toContain("Disallow: /auth");
      expect(res.text).toContain("Disallow: /admin");
      expect(res.text).toContain("Disallow: /api/");

      // Verify sitemap directive
      expect(res.text).toContain("Sitemap: https://supportme.app/sitemap.xml");
    });

    it("is also reachable at /api/robots.txt", async () => {
      const res = await request(app).get("/api/robots.txt");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
    });
  });
});
