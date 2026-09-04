import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Phase 2B/2C: the protocol_action kind is discovered ONLY as a last resort,
 * never over a curated intent, and only for a registered + chain-compatible
 * action. These run against the REAL config (MONAD_NETWORK=mainnet makes
 * getWrappedNative() resolve the known WMON address with no env needed), so
 * the WMON action genuinely registers and routeRequest genuinely routes it.
 *
 * routeRequest is the deterministic front gate; for a detected protocol
 * action it returns the understanding directly with anthropic:false (proven
 * below), so no live model call is involved and the model can never be handed
 * a protocol action to (mis)interpret.
 */

let priorNetwork: string | undefined;

beforeEach(async () => {
  priorNetwork = process.env.MONAD_NETWORK;
  process.env.MONAD_NETWORK = "mainnet";
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});
afterEach(async () => {
  if (priorNetwork === undefined) delete process.env.MONAD_NETWORK;
  else process.env.MONAD_NETWORK = priorNetwork;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});

describe("protocol_action discovery — detected, deterministic, registry-gated", () => {
  it("'wrap 1 MON' resolves to the registered WMON wrap action, deterministically (no Anthropic)", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("wrap 1 MON", null);
    expect(r.anthropic).toBe(false);
    const u = r.understanding!;
    expect(u.outcome).toBe("complete");
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.kind).toBe("protocol_action");
    expect(u.slots.protocolId).toBe("wmon");
    expect(u.slots.actionId).toBe("wrap");
    expect(u.slots.actionVersion).toBe("1.0.0"); // pinned from the registry
    expect(u.slots.amount).toBe("1");
  });

  it("'unwrap 2.5 WMON' resolves to the WMON unwrap action with the exact amount", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("unwrap 2.5 WMON", null);
    const u = r.understanding!;
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.kind).toBe("protocol_action");
    expect(u.slots.actionId).toBe("unwrap");
    expect(u.slots.amount).toBe("2.5");
  });

  it("an action NOT registered is never surfaced — 'stake 1 MON' is not a protocol action", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("stake 1 MON", null);
    // Whatever this routes to, it must NOT be a protocol_action (no stake
    // action is registered).
    const kind = (r.understanding ?? r.fallback).kind;
    expect(kind).not.toBe("protocol_action");
  });
});

describe("curated intents always win over a superficially similar protocol action", () => {
  it("1. a payment ('send 10 MON to 0x…') stays send_payment", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("send 10 MON to 0x1111111111111111111111111111111111111111", null);
    expect((r.understanding ?? r.fallback).kind).toBe("send_payment");
  });

  it("2. a swap ('swap 1 MON to USDC') stays swap, not a wrap protocol action", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("swap 1 MON to USDC", null);
    expect((r.understanding ?? r.fallback).kind).toBe("swap");
  });

  it("2b. a trade phrase ('sell 50 MON for USDC') routes to a curated kind, never protocol_action", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("sell 50 MON for USDC", null);
    const kind = (r.understanding ?? r.fallback).kind;
    // trade or swap — both curated; the invariant under test is that a
    // buy/sell phrase is never hijacked into a protocol action.
    expect(kind).not.toBe("protocol_action");
    expect(["trade", "swap"]).toContain(kind);
  });

  it("a balance query stays wallet_balance", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("what's my balance", null);
    expect((r.understanding ?? r.fallback).kind).toBe("wallet_balance");
  });

  it("a token lookup (bare address) stays token_lookup", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("0xaaaabbbbccccddddeeeeffff0000111122223333", null);
    expect((r.understanding ?? r.fallback).kind).toBe("token_lookup");
  });
});

describe("the LLM can never emit protocol_action", () => {
  it("protocol_action is excluded from the classifier's allowed kinds", async () => {
    // A structural guard: the enum the Anthropic tool schema is built from
    // must not contain protocol_action. If a future edit re-includes it,
    // this goes red.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../lib/ask/intent/classify.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("const CLASSIFY_KINDS"), src.indexOf("const CLASSIFY_KINDS") + 300);
    expect(block).toContain('filter((k) => k !== "protocol_action")');
  });
});
