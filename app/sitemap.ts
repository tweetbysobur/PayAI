import type { MetadataRoute } from "next";
import { DOCS_ORIGIN, MARKETING_ORIGIN } from "@/lib/hosts";

const BASE_URL = process.env.VERIPAYAI_PUBLIC_URL || MARKETING_ORIGIN;

/** Generates /sitemap.xml — only the public, crawlable pages (see robots.ts). */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const marketing = ["/", "/how-it-works", "/intents", "/product", "/security", "/privacy", "/terms"].map((path) => ({
    url: `${BASE_URL}${path === "/" ? "/" : path}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: path === "/" ? 1 : 0.7,
  }));
  const docs = ["/", "/getting-started", "/payments", "/automations", "/fees", "/ask", "/contracts", "/sdk"].map((path) => ({
    url: `${DOCS_ORIGIN}${path === "/" ? "/" : path}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: path === "/" ? 0.8 : 0.6,
  }));
  return [...marketing, ...docs];
}
