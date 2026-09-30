import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Every "Try in Ask PayAI" phrase on /docs/sdk must actually route to the
 * action the page says it does — deterministically, with no model call. A
 * docs example that doesn't work is a broken promise, not a typo.
 *
 * Mirrors the setup of sdk-protocol-action-classify.test.ts: the real config on
 * mainnet, where every documented action registers.
 */
const USDC = "0x754704Bc059F5a0Ce29e278A6D0eBa96b6aafb60";
const R1 = "0x1111111111111111111111111111111111111111";
const R2 = "0x2222222222222222222222222222222222222222";

const saved: Record<string, string | undefined> = {};
async function reset() {
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
}
beforeEach(async () => {
  for (const k of ["MONAD_NETWORK", "MONAD_MAINNET_USDC"]) saved[k] = process.env[k];
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  await reset();
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await reset();
});

describe("/docs/sdk examples route to the documented actions", () => {
  it.each([
    ["wrap 1 MON", "wmon", "wrap"],
    ["unwrap 1 WMON", "wmon", "unwrap"],
    [`split 3 MON between ${R1} and ${R2}`, "payai-settlement", "split_payment"],
  ])("%s → %s/%s", async (text, protocolId, actionId) => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest(text, null);
    expect(r.anthropic, "no model call").toBe(false);
    const u = r.understanding!;
    expect(u.outcome).toBe("complete");
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.kind).toBe("protocol_action");
    expect(u.slots.protocolId).toBe(protocolId);
    expect(u.slots.actionId).toBe(actionId);
  });

  it("the contract addresses on the page are exactly what the registry allowlists", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../app/docs/sdk/page.tsx", import.meta.url), "utf8");
    const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    const { getProtocol } = await import("@/lib/sdk/registry");
    ensureBuiltinsRegistered();
    for (const id of ["wmon", "payai-settlement"]) {
      const protocol = getProtocol(id)!;
      expect(protocol, id).toBeTruthy();
      expect(protocol.allowedTargets, id).toHaveLength(1);
      expect(src, id).toContain(protocol.allowedTargets[0]);
    }
  });

  it("the documented actions exist at version 1.0.0 and are the only ones documented", async () => {
    const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    const { getCurrentActionVersion } = await import("@/lib/sdk/registry");
    ensureBuiltinsRegistered();
    for (const [protocolId, actionId] of [["wmon", "wrap"], ["wmon", "unwrap"], ["payai-settlement", "split_payment"]]) {
      expect(getCurrentActionVersion(protocolId, actionId), `${protocolId}/${actionId}`).toBe("1.0.0");
    }
  });

  it("the page shows exactly these phrases", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../app/docs/sdk/page.tsx", import.meta.url), "utf8");
    for (const phrase of ["wrap 1 MON", "unwrap 1 WMON", "split 3 MON between 0x… and 0x…"]) {
      expect(src, phrase).toContain(phrase);
    }
  });
});
