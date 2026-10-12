import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { routeRequest } from "@/lib/ask/intent/classify";
import { CAPABILITIES, GUIDE } from "@/components/landing/intentExamples";

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
    expect(CAPABILITIES.find((c) => c.id === "trade")?.body).toMatch(/any Monad token.*contract address/);
  });
});

describe("no DeFi protocol is presented as live", () => {
  it("the capability card is 'coming soon' with no example to try", () => {
    const defi = CAPABILITIES.find((c) => c.id === "protocols")!;
    expect(defi.name).toMatch(/coming soon/i);
    expect(defi.examples).toHaveLength(0);
  });
  it("no page or guide offers Aave, WMON or another protocol action to try", () => {
    expect(JSON.stringify({ CAPABILITIES, GUIDE })).not.toMatch(/Aave|WMON|wrap|supply|protocol_action/i);
    for (const f of ["app/page.tsx", "components/landing/ProductSections.tsx", "app/intents/page.tsx", "components/landing/intentExamples.ts"]) {
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
