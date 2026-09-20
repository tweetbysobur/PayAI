import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Public copy is a claim. These pages used to say the full source was public
 * (the repo is private) and that PayAI never holds keys (the Telegram bot
 * does). A regression here is a trust bug, not a wording nit.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const MARKETING = [
  "../app/security/page.tsx",
  "../app/privacy/page.tsx",
  "../app/terms/page.tsx",
  "../app/how-it-works/page.tsx",
  "../app/docs/page.tsx",
  "../app/docs/api/page.tsx",
  "../app/docs/contracts/page.tsx",
  "../components/landing/PlatformSections.tsx",
  "../components/landing/MarketingSections.tsx",
  "../components/landing/PlatformOverview.tsx",
  "../components/landing/SiteFooter.tsx",
];

describe("public pages do not claim the source is public", () => {
  it("never says the full source / GitHub repo is public", () => {
    for (const rel of MARKETING) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/full source are public/i);
      expect(src, rel).not.toMatch(/is public on GitHub/i);
      expect(src, rel).not.toMatch(/is on GitHub/i);
      expect(src, rel).not.toMatch(/open source/i);
      expect(src, rel).not.toMatch(/code and the contracts are public/i);
      expect(src, rel).not.toMatch(/whole application[\s\S]{0,80}is public/i);
    }
  });

  it("security page says the application repository is private", () => {
    expect(read("../app/security/page.tsx")).toMatch(/repository is private/);
  });
});

describe("custody claims name the exceptions", () => {
  it("security page names Payment Automations and the Telegram bot", () => {
    const src = read("../app/security/page.tsx");
    expect(src).toMatch(/Payment Automations/);
    expect(src).toMatch(/Telegram trading bot/);
    expect(src).toMatch(/That path is custodial/);
  });

  it("privacy page names the Telegram bot as custodial", () => {
    expect(read("../app/privacy/page.tsx")).toMatch(/Telegram bot is custodial/i);
  });

  it("terms name fees, telegram custody, and the PayAI Network disambiguation", () => {
    const src = read("../app/terms/page.tsx");
    expect(src).toMatch(/0\.25%/);
    expect(src).toMatch(/Telegram trading bot is custodial/);
    expect(src).toMatch(/not affiliated with PayAI Network/);
  });
});

describe("fees copy matches production", () => {
  it("help center does not claim $0 platform fees", () => {
    const src = read("../app/dashboard/help/page.tsx");
    expect(src).not.toMatch(/charges \$0 in platform fees/);
    expect(src).toMatch(/0\.25% platform fee/);
  });
});

describe("analytics stays off the dashboard", () => {
  it("GoogleAnalytics skips /dashboard routes", () => {
    const src = read("../components/GoogleAnalytics.tsx");
    expect(src).toMatch(/pathname\?\.startsWith\("\/dashboard"\)/);
  });
});

describe("bulk import does not pull in SheetJS", () => {
  it("package.json has no xlsx dependency", () => {
    const pkg = JSON.parse(read("../package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.dependencies?.xlsx).toBeUndefined();
    expect(pkg.devDependencies?.xlsx).toBeUndefined();
  });

  it("BulkPaymentCreator does not import xlsx", () => {
    expect(read("../components/dashboard/BulkPaymentCreator.tsx")).not.toMatch(/from ["']xlsx["']/);
    expect(read("../components/dashboard/BulkPaymentCreator.tsx")).not.toMatch(/import\("xlsx"\)/);
  });
});

describe("Ultrafuzz is described as a protocol review", () => {
  it("security page does not call Ultrafuzz a full audit", () => {
    const src = read("../app/security/page.tsx");
    expect(src).toMatch(/DeltaV . Ultrafuzz protocol security/);
    expect(src).toMatch(/not a full commercial audit/);
  });
});

describe("canonical public URL is usepayai.xyz", () => {
  it("layout metadata does not fall back to the old VeriPay Vercel host", () => {
    const src = read("../app/layout.tsx");
    expect(src).not.toMatch(/veripayai\.vercel\.app/);
    expect(src).toMatch(/https:\/\/usepayai\.xyz/);
  });

  it("marketing does not publish session or automation API routes", () => {
    const src = read("../components/landing/PlatformSections.tsx");
    expect(src).not.toMatch(/\/api\/automations/);
    expect(src).not.toMatch(/x-api-key/);
    expect(src).not.toMatch(/bearer token/i);
  });

  it("public pages do not name the private GitHub account", () => {
    for (const rel of MARKETING) {
      expect(read(rel), rel).not.toMatch(/tweetbysobur/i);
      expect(read(rel), rel).not.toMatch(/github\.com\/tweetbysobur/i);
    }
  });
});
