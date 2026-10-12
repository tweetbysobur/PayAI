import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The marketing pages make claims about what PayAI can do, and they have to
 * survive the product changing underneath them.
 *
 * Two rules are worth a test. First, the landing page stays the pitch: the
 * capability depth belongs on /product and /how-it-works, and the page has
 * already been slimmed down once for exactly this reason — a regression here
 * is a slow one, a section at a time, and nobody notices until the pitch is
 * buried again. Second, nothing offers a route that leads nowhere: not a
 * sign-in method the deployment cannot complete, not a demo that does not
 * exist.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const page = read("../app/page.tsx");
const product = read("../app/product/page.tsx");
const howItWorks = read("../app/how-it-works/page.tsx");
const overview = read("../components/landing/PlatformOverview.tsx");
const steps = read("../components/landing/HowItWorksSteps.tsx");

describe("the landing page stays the pitch", () => {
  it("renders none of the depth sections — no product-card grid, no capability deep-dives", () => {
    for (const deep of [
      "ProductOverviewSection", "HowPayAIWorksSection", "PaymentOperationsSection", "AIOperatorSection",
      "EmbeddedWalletSection", "TradingSection", "AnalyticsSection", "SecuritySection",
      "HowItWorksSteps", "CapabilityGrid", "WhyMonadSection",
    ]) {
      expect(page, `${deep} belongs on a depth page, not the landing page`).not.toContain(deep);
    }
  });

  it("puts the product depth on /product", () => {
    for (const s of ["PaymentOperationsSection", "TradingSection", "EmbeddedWalletSection", "AnalyticsSection"]) {
      expect(product, `/product is missing ${s}`).toContain(s);
    }
  });

  it("puts the steps, the capability grid and the mechanics on /how-it-works", () => {
    for (const s of ["<HowItWorksSteps />", "<CapabilityGrid />", "AIOperatorSection", "SecuritySection"]) {
      expect(howItWorks, `/how-it-works is missing ${s}`).toContain(s);
    }
  });

  it("does not render the same section on two pages", () => {
    // Duplication is how the split rots: a section lands on both, then the
    // landing page keeps the copy and the depth page is forgotten.
    const sections = [
      "PaymentOperationsSection", "AIOperatorSection", "EmbeddedWalletSection", "TradingSection",
      "AnalyticsSection", "HowItWorksSteps", "CapabilityGrid", "WhyMonadSection",
    ];
    for (const s of sections) {
      const on = [page.includes(s), product.includes(s), howItWorks.includes(s)].filter(Boolean).length;
      expect(on, `${s} is rendered on more than one page`).toBe(1);
    }
  });

  it("puts \"Why we chose Monad\" on /product, toward the end", () => {
    expect(product).toContain("<WhyMonadSection />");
    expect(howItWorks).not.toContain("WhyMonadSection");
    const order = ["<IntentExamplesSection />", "<WhyMonadSection />", "Describe it. Review it. Approve it."].map((m) => product.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("nothing offers a route that leads nowhere", () => {
  it("lists only sign-in methods this deployment has configured", () => {
    // The same source the sign-in screen reads. An unconfigured method is left
    // off rather than shown with a caveat — a caveat is still an offer, and
    // the reader has to work out that the thing in front of them does nothing.
    expect(overview).toMatch(/fetch\("\/api\/wallet-service\/status"\)/);
    expect(overview).toMatch(/social\.filter\(\(s\) => methods\?\.\[s\.key\] === true\)/);
  });

  it("says Coming Soon nowhere on the marketing pages", () => {
    const templates = read("../components/landing/TemplateShowcase.tsx");
    for (const [name, src] of Object.entries({ page, product, howItWorks, overview, templates })) {
      expect(src, `${name} still says Coming Soon`).not.toMatch(/Coming Soon/i);
    }
  });

  /* NOTE: TemplateShowcase, FeatureGroupsSection and SupportedTokens are all
     currently unmounted — /product was the only page rendering them, and the
     intent-layer restructure dropped all three (a template catalog and an
     "automate any token" pitch both argue for the old payment-automation
     positioning). The three tests below still read the component SOURCE
     rather than a rendered page, so they remain valid guards for the day one
     is mounted again; they are dormant, not vacuous. Delete the component and
     its test together if it is ever decided they are not coming back. */
  it("offers only templates that open when you click them", () => {
    // The showcase used to list all 28 with a badge on the unfinished ones.
    // Badging an offer you cannot take is still making the offer — it just
    // moves the disappointment one click later.
    const templates = read("../components/landing/TemplateShowcase.tsx");
    expect(templates).toMatch(/const ready = TEMPLATES\.filter\(\(t\) => workflowStatus\(t\) !== "coming_soon"\)/);
    expect(templates).toMatch(/ready\.filter\(\(t\) => t\.category === active\)/);
    // …and the count in the copy is derived from that same list.
    expect(templates).toMatch(/\{ready\.length\} ready to use today/);
  });

  it("hides the category tabs when there is only one category to pick", () => {
    // Filtering to ready templates can leave a single category. One tab is a
    // control that does nothing, and it invites the question of where the
    // others went.
    const templates = read("../components/landing/TemplateShowcase.tsx");
    expect(templates).toMatch(/categories\.length > 1 \? "flex" : "hidden"/);
  });

  it("does not offer a demo video that does not exist", () => {
    // The secondary CTA opens the written walkthrough. A button promising a
    // recording that isn't there is a promise broken on the first click —
    // restore the label the moment there is something to play.
    expect(page).not.toMatch(/Watch Demo/i);
    expect(page).toMatch(/See how it works/);
  });

  it("points every operation card at something that exists", () => {
    // Either a real template id, or the builder. Never a route invented to
    // make a card feel complete.
    const hrefs = [...overview.matchAll(/href=\{o\.template \? `([^`]+)` : "([^"]+)"\}/g)];
    expect(hrefs.length).toBe(1);
    expect(hrefs[0][1]).toContain("/dashboard/automations?template=");
    expect(hrefs[0][2]).toBe("/dashboard/automations");
  });
});

describe("the hero states the product: intent → onchain execution", () => {
  const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const hero = code.slice(code.indexOf("{/* Hero */}") >= 0 ? code.indexOf("{/* Hero */}") : 0, code.indexOf("<Section id=\"how\">"));

  it("uses the approved headline and supporting line, word for word", () => {
    // The headline is animated word by word, so the exact string lives in one
    // constant, rendered as the h1's accessible name and split for display.
    expect(page).toContain('const HEADLINE = "Turn your intent into onchain execution.";');
    expect(page).toMatch(/<h1 aria-label=\{HEADLINE\}/);
    expect(page).toMatch(/HEADLINE\.split\(" "\)/);
    expect(page).toContain('const SUBLINE = "Describe what you want in plain language. PayAI turns it into a plan you can review, approve, and execute with your wallet.";');
    expect(page).toMatch(/\{SUBLINE\}/);
  });

  it("the hero shows no example transaction, mock chat or fake approval", () => {
    const heroSrc = page.slice(page.indexOf("function Hero()"), page.indexOf("function Section("));
    expect(heroSrc).not.toMatch(/\b\d+(\.\d+)?\s*(USDC|MON)\b|\.nad\b|Approve<\/|IntentExample|Example/);
    expect(hero.length).toBeGreaterThan(0);
  });

  it("teaches the three steps on /how-it-works, and the landing page points there", () => {
    for (const s of ["Describe your intent", "Review the plan", "Approve and execute"]) expect(steps, s).toContain(s);
    expect(howItWorks).toContain("<HowItWorksSteps />");
    expect(page).toMatch(/href="\/how-it-works"/);
  });

  it("does not claim guarantees or zero risk", () => {
    // DeFi is named now that it is live (Aave V3 supply/withdraw, WMON); the
    // protocols themselves are named on /how-it-works, never "any protocol".
    expect(code).not.toMatch(/100% secure|zero risk|guarantee|any (defi )?protocol/i);
  });

  it("states the non-custodial nuance: automations use a capped agent wallet", () => {
    expect(page).toMatch(/capped agent wallet/);
  });

  it("enters the product through the existing /auth route, relative so each host routes it", () => {
    expect(page).toMatch(/const LAUNCH = "\/auth";/);
  });

  it("shows no example prompts itself: they live on /how-it-works and /intents, where each is tested", () => {
    // Every prompt the site shows comes from intentExamples.ts and is run
    // through the real product in test/intent-examples.test.ts.
    expect(code).not.toMatch(/\b\d+(\.\d+)?\s*(USDC|MON)\b/);
    expect(page).toMatch(/href="\/intents"/);
    expect(page).toMatch(/href=\{`\/how-it-works#capabilities`\}/);
  });
});
