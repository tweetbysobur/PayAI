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

describe("the landing page stays the pitch", () => {
  it("carries the six-product overview and nothing deeper", () => {
    expect(page).toMatch(/<ProductOverviewSection \/>/);
    for (const deep of [
      "HowPayAIWorksSection", "PaymentOperationsSection", "AIOperatorSection",
      "EmbeddedWalletSection", "SmartSwapsSection", "AnalyticsSection", "SecuritySection",
    ]) {
      expect(page, `${deep} belongs on a depth page, not the landing page`).not.toContain(deep);
    }
  });

  it("puts the product depth on /product", () => {
    for (const s of ["PaymentOperationsSection", "SmartSwapsSection", "EmbeddedWalletSection", "AnalyticsSection"]) {
      expect(product, `/product is missing ${s}`).toContain(s);
    }
  });

  it("puts the mechanics on /how-it-works", () => {
    for (const s of ["HowPayAIWorksSection", "AIOperatorSection", "SecuritySection"]) {
      expect(howItWorks, `/how-it-works is missing ${s}`).toContain(s);
    }
  });

  it("does not render the same section on two pages", () => {
    // Duplication is how the split rots: a section lands on both, then the
    // landing page keeps the copy and the depth page is forgotten.
    const sections = [
      "HowPayAIWorksSection", "PaymentOperationsSection", "AIOperatorSection",
      "EmbeddedWalletSection", "SmartSwapsSection", "AnalyticsSection",
    ];
    for (const s of sections) {
      const on = [product.includes(s), howItWorks.includes(s)].filter(Boolean).length;
      expect(on, `${s} is rendered on both depth pages`).toBe(1);
    }
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

describe("the hero states the platform, not one feature", () => {
  it("leads with the headline", () => {
    // No subheadline paragraph under the H1 — removed on request. The
    // breadth claim — six products, not one — lives in the chip row below
    // the CTAs instead (covered by the next test).
    expect(page).toMatch(/Automate Every Payment on Monad/);
  });

  it("names all six products in the hero", () => {
    for (const p of [
      "AI Payment Operator", "Payment Automation", "Smart Swaps",
      "Bulk Distribution", "Embedded Wallet", "Analytics & Activity",
    ]) {
      expect(page, `hero is missing "${p}"`).toContain(p);
    }
  });
});
