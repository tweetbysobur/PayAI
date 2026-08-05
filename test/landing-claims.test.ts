import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TEMPLATES } from "../lib/automation/templates";

/**
 * The landing page makes claims about what PayAI can do. Every one of them has
 * to survive the product changing underneath it.
 *
 * A marketing page that hardcodes its own feature list starts lying the day a
 * workflow ships or a credential is removed, and the person it lies to is
 * someone deciding whether to trust it with money. So the two lists that can
 * go stale — which workflows run, and which sign-in methods exist — are read
 * from the same sources the app reads. These tests hold that line.
 */

const overview = readFileSync(new URL("../components/landing/PlatformOverview.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

describe("workflow status comes from the product, not the page", () => {
  it("reads the template registry rather than listing workflows by hand", () => {
    expect(overview).toMatch(/from "@\/lib\/automation\/templates"/);
    expect(overview).toMatch(/TEMPLATES\.filter/);
  });

  it("derives the live count instead of stating a number", () => {
    // "5 of 28 workflows run today" must be computed. Typed as a literal it
    // is correct exactly once.
    expect(overview).toMatch(/TEMPLATES\.filter\(\(t\) => \(t\.status \?\? "available"\) === "available"\)\.length/);
    expect(overview).not.toMatch(/\b5 of 28\b/);
  });

  it("only links workflows that can actually run", () => {
    // A coming-soon workflow renders as a span, never a Link — sending someone
    // into the app to discover it doesn't work yet is a promise broken after
    // they already decided to trust us.
    expect(overview).toMatch(/ready \? \(\s*<Link/);
  });

  it("still has workflows in both states, so neither branch is dead code", () => {
    const live = TEMPLATES.filter((t) => (t.status ?? "available") === "available");
    const soon = TEMPLATES.filter((t) => t.status === "coming_soon");
    expect(live.length).toBeGreaterThan(0);
    expect(soon.length).toBeGreaterThan(0);
  });
});

describe("sign-in methods reflect this deployment", () => {
  it("asks the status endpoint rather than assuming", () => {
    // The same source the sign-in screen reads. Advertising "Continue with
    // Apple" on a deployment with no Apple credentials sends someone to a dead
    // end after they have already chosen to trust us.
    expect(overview).toMatch(/fetch\("\/api\/wallet-service\/status"\)/);
    expect(overview).toMatch(/authMethods/);
  });

  it("marks an unconfigured method rather than hiding or offering it", () => {
    expect(overview).toMatch(/Coming soon/);
  });

  it("never marks a method unavailable while the answer is still loading", () => {
    // methods === null means "not known yet". Rendering a badge then would
    // flash "Coming soon" onto a method that is in fact configured.
    expect(overview).toMatch(/methods !== null && !ready/);
  });
});

describe("the hero states the platform, not one feature", () => {
  it("leads with the full product", () => {
    expect(page).toMatch(/Everything You Need to Manage Payments on Monad/);
    expect(page).toMatch(/embedded wallets, payment workflows, smart swaps, bulk distributions/);
  });

  it("names all six products in the hero", () => {
    for (const p of [
      "AI Payment Operator", "Payment Automation", "Smart Swaps",
      "Bulk Distribution", "Embedded Wallet", "Analytics & Activity",
    ]) {
      expect(page, `hero is missing "${p}"`).toContain(p);
    }
  });

  it("does not offer a demo video that does not exist", () => {
    // The secondary CTA goes to the written walkthrough. A "Watch Demo"
    // button with no recording behind it is a promise broken on the first
    // click — restore the label the moment there is something to play.
    expect(page).not.toMatch(/Watch Demo/i);
    expect(page).toMatch(/See how it works/);
  });
});
