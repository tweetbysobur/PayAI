import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { resolveTenantId } from "@/lib/platform/tenant";
import { createMerchant, DEMO_TENANT } from "@/lib/platform/merchants";

/**
 * Naming a tenant requires proving you own it.
 *
 * Every read and write in the platform is namespaced by the merchant id
 * `resolveTenantId` returns — transaction log, payment links, analytics,
 * automations. An `x-merchant-id` header used to select a tenant on its own,
 * which made a merchant id a credential. It isn't one: it is derived partly
 * from the merchant's own name and appears wherever their account does. The
 * secret apiKey is the only thing that may choose a tenant.
 */
function reqWith(headers: Record<string, string>): NextRequest {
  return new NextRequest("https://usepayai.xyz/api/analytics", { headers });
}

describe("tenant resolution", () => {
  it("resolves a merchant from its secret api key", async () => {
    const m = await createMerchant("Acme Coffee");
    expect(await resolveTenantId(reqWith({ "x-merchant-key": m.apiKey }))).toBe(m.id);
  });

  it("refuses to select a tenant from an unauthenticated merchant id", async () => {
    const victim = await createMerchant("Victim Corp");
    // Knowing the id is not knowing the key. This must fall back to the shared
    // demo tenant, never hand over the victim's namespace.
    const resolved = await resolveTenantId(reqWith({ "x-merchant-id": victim.id }));
    expect(resolved).not.toBe(victim.id);
    expect(resolved).toBe(DEMO_TENANT);
  });

  it("ignores a merchant id even when a bad key is presented alongside it", async () => {
    const victim = await createMerchant("Victim Two");
    const resolved = await resolveTenantId(
      reqWith({ "x-merchant-key": "vpk_not_a_real_key", "x-merchant-id": victim.id }),
    );
    expect(resolved).toBe(DEMO_TENANT);
  });

  it("falls back to the demo tenant with no headers at all", async () => {
    expect(await resolveTenantId(reqWith({}))).toBe(DEMO_TENANT);
  });
});

/**
 * The apiKey is the only credential that unlocks a tenant, so it has to be
 * unguessable. `Math.random()` is not: V8's generator is recoverable from a
 * handful of outputs, and it promises nothing about unpredictability even
 * without that.
 */
describe("merchant api keys", () => {
  it("does not repeat across merchants", async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 40; i++) keys.add((await createMerchant(`Shop ${i}`)).apiKey);
    expect(keys.size).toBe(40);
  });

  it("uses the full alphabet rather than a biased slice of it", async () => {
    // Rejection sampling keeps every character equally likely. A naive
    // `byte % 36` would over-represent the first few letters; across this many
    // characters that would show up as a missing tail of the alphabet.
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      for (const c of (await createMerchant(`Bias ${i}`)).apiKey.slice(4)) seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(30);
  });

  it("is long enough that guessing is hopeless", async () => {
    const m = await createMerchant("Length Check");
    expect(m.apiKey).toMatch(/^vpk_[a-z0-9]{32}$/);
  });
});
