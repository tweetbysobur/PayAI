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

describe("Phase 8 — Aave V3 Monad supply/withdraw discovery", () => {
  // detectAaveAction only ever resolves the USDC branch, via the same
  // getStablecoin() real-address lookup detectSplitPayment's own USDC branch
  // uses — see test/sdk-split-payment-classify.test.ts's identical
  // MONAD_MAINNET_USDC set/restore pattern. Vitest does not load .env.local,
  // so this must be set explicitly per test, never assumed from ambient env.
  let priorUsdc: string | undefined;
  beforeEach(() => {
    priorUsdc = process.env.MONAD_MAINNET_USDC;
    process.env.MONAD_MAINNET_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
  });
  afterEach(() => {
    if (priorUsdc === undefined) delete process.env.MONAD_MAINNET_USDC;
    else process.env.MONAD_MAINNET_USDC = priorUsdc;
  });

  it("'Supply 100 USDC to Aave' resolves to the registered aave-v3-monad/supply action, deterministically", async () => {
    const { getStablecoin } = await import("@/lib/monad/config");
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("Supply 100 USDC to Aave", null);
    expect(r.anthropic).toBe(false);
    const u = r.understanding!;
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.kind).toBe("protocol_action");
    expect(u.slots.protocolId).toBe("aave-v3-monad");
    expect(u.slots.actionId).toBe("supply");
    expect(u.slots.actionVersion).toBe("1.0.0"); // pinned from the registry
    const inputs = u.slots.actionInputs!;
    expect(inputs.amount).toBe("100");
    expect(inputs.asset.toLowerCase()).toBe(getStablecoin().address.toLowerCase());
    // The detector never invents a destination — that is filled in later,
    // client-side, with the real connected wallet (see orchestrate.ts).
    expect(inputs.onBehalfOf).toBeUndefined();
  });

  it("'Supply 100 USDC to Aave V3' (with the explicit version suffix) also resolves", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("Supply 100 USDC to Aave V3", null);
    const u = r.understanding!;
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.slots.protocolId).toBe("aave-v3-monad");
    expect(u.slots.actionId).toBe("supply");
  });

  it("'Withdraw 50 USDC from Aave' resolves to the registered aave-v3-monad/withdraw action", async () => {
    const { getStablecoin } = await import("@/lib/monad/config");
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("Withdraw 50 USDC from Aave", null);
    expect(r.anthropic).toBe(false);
    const u = r.understanding!;
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.kind).toBe("protocol_action");
    expect(u.slots.protocolId).toBe("aave-v3-monad");
    expect(u.slots.actionId).toBe("withdraw");
    expect(u.slots.actionVersion).toBe("1.0.0");
    const inputs = u.slots.actionInputs!;
    expect(inputs.amount).toBe("50");
    expect(inputs.asset.toLowerCase()).toBe(getStablecoin().address.toLowerCase());
    expect(inputs.to).toBeUndefined();
  });

  it("'Withdraw 50 USDC from Aave V3' also resolves", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("Withdraw 50 USDC from Aave V3", null);
    const u = r.understanding!;
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.slots.protocolId).toBe("aave-v3-monad");
    expect(u.slots.actionId).toBe("withdraw");
  });

  it("an incomplete Aave phrase (no amount) never routes to protocol_action — fails closed, not guessed", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("Supply USDC to Aave", null);
    const kind = (r.understanding ?? r.fallback).kind;
    expect(kind).not.toBe("protocol_action");
  });

  it("a token this detector can't safely resolve (not MON, not the configured stablecoin) never routes to protocol_action", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("Supply 100 WBTC to Aave", null);
    const kind = (r.understanding ?? r.fallback).kind;
    expect(kind).not.toBe("protocol_action");
  });

  it("only ONE aave-v3-monad protocol is ever registered (Phase 7C consolidation, exercised via the real bootstrap path)", async () => {
    const { getProtocol } = await import("@/lib/sdk/registry");
    const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    ensureBuiltinsRegistered();
    const proto = getProtocol("aave-v3-monad");
    expect(proto).not.toBeNull();
    expect(proto!.actions.map((a) => a.actionId).sort()).toEqual(["supply", "withdraw"]);
  });

  it("both aave-v3-monad actions resolve from that one registered protocol", async () => {
    const { getAction } = await import("@/lib/sdk/registry");
    const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    ensureBuiltinsRegistered();
    expect(getAction("aave-v3-monad", "supply", "1.0.0")).not.toBeNull();
    expect(getAction("aave-v3-monad", "withdraw", "1.0.0")).not.toBeNull();
  });
});

describe("Phase 8 — existing routing stays unaffected by the new Aave detector", () => {
  it("WMON wrap still routes correctly", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("wrap 1 MON", null);
    const u = r.understanding!;
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.slots.protocolId).toBe("wmon");
    expect(u.slots.actionId).toBe("wrap");
  });

  it("split_payment still routes correctly", async () => {
    const A = "0x1111111111111111111111111111111111111111";
    const B = "0x2222222222222222222222222222222222222222";
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest(`split 0.03 MON between ${A} and ${B}`, null);
    const u = r.understanding!;
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.slots.protocolId).toBe("payai-settlement");
    expect(u.slots.actionId).toBe("split_payment");
  });

  it("a plain payment ('send 10 MON to 0x…') still stays send_payment, never Aave", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("send 10 MON to 0x1111111111111111111111111111111111111111", null);
    expect((r.understanding ?? r.fallback).kind).toBe("send_payment");
  });

  it("a trade phrase stays trade/swap, never Aave", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest("sell 50 MON for USDC", null);
    const kind = (r.understanding ?? r.fallback).kind;
    expect(kind).not.toBe("protocol_action");
    expect(["trade", "swap"]).toContain(kind);
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
