import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Tall screens (a phone in "Desktop site" mode lays out ~980px wide and
 * ~2100px tall) must not open with a screen of empty space. That happened
 * when content was centred inside a full-viewport-height box. Viewport-height
 * sizing is allowed only when capped (min(...)) or not combined with centring.
 */
const read = (p: string) => readFileSync(p, "utf8");

describe("no screen-tall empty space", () => {
  it("the landing hero's height is capped", () => {
    const page = read("app/page.tsx");
    expect(page).toMatch(/lg:min-h-\[min\(calc\(100svh-5\.5rem\),48rem\)\]/);
    expect(page).not.toMatch(/min-h-\[calc\(100svh/);
  });
  it("sign-in and connect start the card near the top instead of centring it in the full height", () => {
    for (const f of ["app/auth/page.tsx", "app/connect/page.tsx"]) {
      expect(read(f), f).toMatch(/flex flex-1 items-start justify-center [^"]*pt-\[clamp\(2rem,7vh,6rem\)\]/);
    }
  });
});

describe("How to ask lives on How it works", () => {
  it("is not a top-navigation link", () => {
    const nav = read("components/landing/SiteNav.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(nav).not.toMatch(/\/intents|How to ask/);
  });
  it("is a section of /how-it-works, and /intents redirects to it", () => {
    expect(read("app/how-it-works/page.tsx")).toMatch(/<HowToAskSection \/>/);
    expect(read("components/landing/HowToAskSection.tsx")).toMatch(/id="how-to-ask"/);
    expect(read("app/intents/page.tsx")).toMatch(/permanentRedirect\("\/how-it-works#how-to-ask"\)/);
  });
  it("each point is made once: no repeated rules beside the steps and examples", () => {
    const ask = read("components/landing/HowToAskSection.tsx");
    expect(ask).not.toMatch(/You stay in control|Several actions, one message|Say “each”/);
    expect(read("app/how-it-works/page.tsx")).not.toMatch(/AIOperatorSection|CapabilityGrid/);
  });
});

describe("landing close", () => {
  it("reads 'Make intent. Get your onchain execution done' on one line, with Launch PayAI below it", () => {
    const page = read("app/page.tsx");
    const close = page.slice(page.indexOf("{/* Close */}"), page.indexOf("<SiteFooter />"));
    expect(close).toMatch(/Make intent\. Get your onchain execution done/);
    expect(close).toMatch(/flex max-w-7xl flex-col items-start/);
    expect(close).toMatch(/<h2 className="whitespace-nowrap text-\[clamp\(/);
    expect(close.indexOf("</h2>")).toBeLessThan(close.indexOf("Launch PayAI"));
  });
});
