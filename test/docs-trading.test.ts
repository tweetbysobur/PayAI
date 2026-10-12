import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DOCS_NAV } from "@/lib/docs/nav";
import { isDocsSlugPath } from "@/lib/hosts";
import { DEFAULT_SLIPPAGE, MAX_SLIPPAGE, MAX_PRICE_IMPACT } from "@/lib/monad/swap";

/** Trading is documented, linked, and its numbers match the engine. */
describe("Trading docs", () => {
  const page = readFileSync("app/docs/trading/page.tsx", "utf8");
  const sdk = readFileSync("app/docs/sdk/page.tsx", "utf8");

  it("is in the docs menu and served on the docs host", () => {
    expect(DOCS_NAV.flatMap((g) => g.items).some((i) => i.href === "/docs/trading")).toBe(true);
    expect(isDocsSlugPath("/trading")).toBe(true);
  });
  it("states the engine's real limits", () => {
    expect(page).toContain(`${DEFAULT_SLIPPAGE * 100}% by default`);
    expect(page).toContain(`up to ${MAX_SLIPPAGE * 100}%`);
    expect(page).toContain(`above ${MAX_PRICE_IMPACT * 100}%`);
    expect(page).toMatch(/contract address \(CA\)/);
    expect(page).toMatch(/exact-input/);
  });
  it("the SDK page covers the swap action and points to Trading", () => {
    expect(sdk).toMatch(/"Swap",\s*"Swap MON ⇄ USDC through PayAI's trade executor/);
    expect(sdk).toMatch(/href="\/docs\/trading"/);
  });
});
