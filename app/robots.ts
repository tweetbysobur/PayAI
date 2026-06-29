import type { MetadataRoute } from "next";

const BASE_URL = process.env.VERIPAYAI_PUBLIC_URL || "https://veripayai.vercel.app";

/**
 * Generates /robots.txt. Public marketing/product pages are crawlable;
 * /api, /dashboard (wallet-gated, no useful content without a connected
 * wallet), and the merchant checkout page (/pay/[id], unique per-link, not
 * meant for indexing) are excluded.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/dashboard", "/pay/"],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
