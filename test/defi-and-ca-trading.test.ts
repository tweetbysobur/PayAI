import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { routeRequest } from "@/lib/ask/intent/classify";
import { GUIDE } from "@/components/landing/intentExamples";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const CA = "0x1234567890abcdef1234567890abcdef12345678";

describe("trading any Monad token by its contract address", () => {
  it("pasting a CA identifies the token", async () => {
    const r = await routeRequest(CA, null);
    expect(r.understanding ?? r.fallback).toMatchObject({ kind: "token_lookup", outcome: "complete", slots: { tokenAddress: CA } });
  });
  it("then 'buy $20 of it' is a trade of exactly that token", async () => {
    const pending = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: CA } } as never;
    const r = await routeRequest("buy $20 of it", pending);
    const u = (r.understanding ?? r.fallback) as { kind: string; slots: { toAsset?: string | null } };
    expect(u.kind).toBe("trade");
    expect(u.slots.toAsset?.toLowerCase()).toBe(CA);
  });
  it("the site says so", () => {
    expect(GUIDE.find((g) => g.title === "Trade")?.body).toMatch(/any other Monad token.*contract address/);
    expect(read("components/landing/HowToAskSection.tsx")).toMatch(/Trades work with any Monad token by its contract address/);
  });
});

describe("no DeFi protocol is presented as live", () => {
  it("How to ask says DeFi protocols aren't available yet, and offers nothing to try", () => {
    expect(read("components/landing/HowToAskSection.tsx")).toMatch(/DeFi protocols aren't available from Ask yet/);
    expect(GUIDE.some((g) => /defi|protocol/i.test(g.title))).toBe(false);
  });
  it("no page or guide offers Aave, WMON or another protocol action to try", () => {
    expect(JSON.stringify({ GUIDE })).not.toMatch(/Aave|WMON|wrap|supply|protocol_action/i);
    for (const f of ["app/page.tsx", "components/landing/ProductSections.tsx", "components/landing/HowToAskSection.tsx", "components/landing/intentExamples.ts"]) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/Aave|"WMON"/);
    }
  });
  it("the SDK docs explain how a protocol integrates", () => {
    const sdk = read("app/docs/sdk/page.tsx");
    expect(sdk).toMatch(/id="integrate"/);
    expect(sdk).toMatch(/No DeFi protocol is live yet/);
    expect(sdk).toMatch(/Allowlisted contracts/);
  });
});
