import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Support used to be its own top-level sidebar destination, sitting right
 * next to Help Center — two entries for the same underlying need ("I have a
 * question" vs "something's wrong"). Support is now a tab inside Help
 * Center (app/dashboard/help/page.tsx) instead of a competing nav item.
 * /dashboard/support itself is kept only as a redirect so every existing
 * deep link (automations' "Report issue", notifications, activity, the
 * settings card, the security page, the marketing footer) still lands
 * somewhere real. Source-level assertions, matching this repo's existing
 * approach for nav/component wiring (see ask-mark.test.ts).
 */

const sidebarSrc = readFileSync(new URL("../components/dashboard/Sidebar.tsx", import.meta.url), "utf8");
const helpSrc = readFileSync(new URL("../app/dashboard/help/page.tsx", import.meta.url), "utf8");
const supportSrc = readFileSync(new URL("../app/dashboard/support/page.tsx", import.meta.url), "utf8");
const panelSrc = readFileSync(new URL("../components/dashboard/SupportPanel.tsx", import.meta.url), "utf8");

describe("Support is no longer a standalone sidebar destination", () => {
  it("the sidebar's NAV has no /dashboard/support entry", () => {
    expect(sidebarSrc).not.toMatch(/href:\s*"\/dashboard\/support"/);
  });

  it("Help Center is still the one Settings-section entry that covers both", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/dashboard\/help",\s*label:\s*"Help Center"/);
  });
});

describe("Support lives inside Help Center as a tab", () => {
  it("renders the SupportPanel component, not a re-implementation", () => {
    expect(helpSrc).toMatch(/from "@\/components\/dashboard\/SupportPanel"/);
    expect(helpSrc).toMatch(/<SupportPanel \/>/);
  });

  it("offers a visible Browse Help / Support tab switcher", () => {
    expect(helpSrc).toMatch(/Browse Help/);
    expect(helpSrc).toMatch(/>\s*Support\s*</);
  });

  it("a ?tab=support deep link opens straight to the Support tab", () => {
    expect(helpSrc).toMatch(/params\.get\("tab"\) === "support"/);
  });

  it("the in-page 'Still stuck?' CTA switches tabs instead of navigating to a separate page", () => {
    expect(helpSrc).toMatch(/onClick=\{\(\) => setTab\("support"\)\}/);
    expect(helpSrc).not.toMatch(/href="\/dashboard\/support"/);
  });
});

describe("/dashboard/support forwards old deep links into Help Center's Support tab", () => {
  it("redirects to /dashboard/help with tab=support, not a dead end or a duplicate page", () => {
    expect(supportSrc).toMatch(/redirect\(`\/dashboard\/help\?\$\{qs\.toString\(\)\}`\)/);
    expect(supportSrc).toMatch(/qs\.set\("tab", "support"\)/);
  });

  it("is a real server-side redirect (next/navigation's redirect), not a client effect that can race or fail silently", () => {
    expect(supportSrc).toMatch(/import \{ redirect \} from "next\/navigation"/);
    expect(supportSrc).not.toMatch(/"use client"/);
    expect(supportSrc).not.toMatch(/useEffect/);
  });

  it("preserves whatever query params it was given (automationId, category) rather than dropping them", () => {
    expect(supportSrc).toMatch(/await searchParams/);
  });

  it("no longer duplicates the report form / ticket logic -- that only exists in SupportPanel now", () => {
    expect(supportSrc).not.toMatch(/CATEGORIES/);
    expect(supportSrc).not.toMatch(/Report an issue/);
  });
});

describe("every real entry point that used to link straight to /dashboard/support now points at the merged destination", () => {
  const SITES: [string, string][] = [
    ["../app/dashboard/automations/page.tsx", "the Report Failed Automation / Report Missing Refund link"],
    ["../app/dashboard/settings/page.tsx", "the settings page's Support card"],
    ["../app/security/page.tsx", "the security page's Contact support CTA"],
    ["../components/landing/SiteFooter.tsx", "the marketing footer"],
    ["../lib/hooks/useNotifications.ts", "the support-ticket-submitted notification"],
    ["../lib/hooks/useActivity.ts", "the support activity-feed entry"],
  ];

  for (const [rel, desc] of SITES) {
    it(`${desc} points at /dashboard/help?tab=support`, () => {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(src).not.toMatch(/["'`]\/dashboard\/support(?!\w)/);
      expect(src).toMatch(/\/dashboard\/help\?tab=support/);
    });
  }
});

describe("SupportPanel carries the real report/contact/history logic, unchanged", () => {
  it("still submits to /api/support and reads the wallet's own ticket history", () => {
    expect(panelSrc).toMatch(/fetch\("\/api\/support"/);
    expect(panelSrc).toMatch(/fetch\(`\/api\/support\?wallet=\$\{wallet\.address\}`\)/);
  });

  it("still prefills from automationId/category query params for deep links", () => {
    expect(panelSrc).toMatch(/params\.get\("automationId"\)/);
    expect(panelSrc).toMatch(/params\.get\("category"\)/);
  });
});
