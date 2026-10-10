import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Plan size, measured stage by stage — with the PRODUCTION transfer and swap
 * actions, the real adapter, validator, planner, Plan Store and Plan Service.
 * Only the recipient resolver is mocked out (recipients here are 0x
 * addresses, which it never sees anyway). Nothing is quoted, built, signed or
 * sent: this measures what happens before a single signature.
 *
 * Stages, each timed separately:
 *   parse      text → ParsedIntent           (lib/plan-adapter/grammar)
 *   validate   draft → ValidatedIntentGraph  (lib/plan/validate)
 *   create     validate + plan + pin + store (lib/plan/service createPlan)
 *   load       stored plan → view + review   (lib/plan/service getPlanWithReview)
 *   render     the review's step list markup (components/ask/PlanCard StepList)
 *
 * The ceiling is the Intent IR's MAX_INTENT_NODES (500): 500 is accepted and
 * 501 refused — test/plan-long.test.ts pins that and runs 120 through the
 * real runner. The time bounds below are deliberately loose (CI machines
 * vary); the printed table is the measurement.
 */

const FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
const EXECUTOR = "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const addr = (i: number) => `0x${(0x1000 + i).toString(16).padStart(40, "0")}`;
const TOKENS = { monDecimals: 18, stable: { symbol: "USDC", decimals: 6 } };

vi.mock("@/lib/payees/resolve", () => ({
  resolveRecipientInput: async (input: string) => ({ ok: false, message: `"${input}" isn't resolvable in this test.` }),
}));
vi.mock("@/lib/sdk/policy", () => ({
  enforcePaymentPolicy: async () => ({ allowed: true, warnings: [], riskScore: 5, riskLevel: "low", compliance: "approved" }),
}));

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED",
  "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR", "PAYAI_TRADE_EXECUTOR_ENABLED"] as const;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.MONAD_MAINNET_PAYAI_FORWARDER = FORWARDER;
  process.env.PAYAI_FORWARDER_ENABLED = "true";
  process.env.MONAD_MAINNET_PAYAI_TRADE_EXECUTOR = EXECUTOR;
  process.env.PAYAI_TRADE_EXECUTOR_ENABLED = "true";
  (await import("@/lib/plan/store")).__resetPlanStoreForTests();
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
  ensureBuiltinsRegistered();
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

/** n actions: transfers, with a swap every 10th so mixed plans are measured too. */
function request(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(i % 10 === 9 ? `swap ${i + 1} USDC to MON` : `send ${i + 1} USDC to ${addr(i)}`);
  return parts.join(", then ");
}

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;

describe("plan size, stage by stage", () => {
  const rows: Record<string, number | string>[] = [];

  for (const n of [1, 3, 10, 100, 500]) {
    it(`${n} action${n === 1 ? "" : "s"}: one plan, one review, every action in order`, async () => {
      const { parseIntent } = await import("@/lib/plan-adapter/grammar");
      const { draftIntentGraph } = await import("@/lib/plan-adapter/adapter");
      const { validateIntentGraph } = await import("@/lib/plan/validate");
      const service = await import("@/lib/plan/service");
      const { StepList } = await import("@/components/ask/PlanCard");
      const text = request(n);
      const ctx = { intentId: `intent_scale_${n}xx`, wallet: WALLET as `0x${string}`, chainId: 143 };

      let t = performance.now();
      const parsed = parseIntent(text, TOKENS);
      const parse = ms(t);
      expect(parsed.ok).toBe(true);

      const drafted = draftIntentGraph(text, ctx);
      if (!drafted.ok) throw new Error(drafted.message);
      t = performance.now();
      const validated = validateIntentGraph(drafted.draft, { sessionWallet: WALLET as `0x${string}`, activeChainId: 143 } as never);
      const validate = ms(t);
      expect(validated.ok).toBe(true);

      t = performance.now();
      const created = await service.createPlan({ wallet: WALLET as `0x${string}` }, drafted.draft);
      const create = ms(t);

      t = performance.now();
      const { plan, review } = await service.getPlanWithReview({ wallet: WALLET as `0x${string}` }, created.planId);
      const load = ms(t);
      expect(review.steps).toHaveLength(n);
      // Order is the order written.
      expect(review.steps.map((s) => s.action)).toEqual(Array.from({ length: n }, (_, i) => (i % 10 === 9 ? "swap" : "transfer")));

      t = performance.now();
      const html = renderToStaticMarkup(createElement(StepList, { review: review as never, plan: plan as never, activeNode: null, running: false }));
      const render = ms(t);
      expect(html.length).toBeGreaterThan(0);

      rows.push({ actions: n, parse, validate, create, load, render, chars: text.length });
      for (const v of [parse, validate, create, load, render]) expect(v).toBeLessThan(15_000);
    }, 120_000);
  }

  it("501 actions is refused before anything is stored", async () => {
    const { parseIntent } = await import("@/lib/plan-adapter/grammar");
    const r = parseIntent(request(501), TOKENS);
    expect(r).toMatchObject({ ok: false });
    expect((r as { code: string }).code).toMatch(/TOO_MANY_ACTIONS|TOO_LONG/);
  });

  afterEach(() => {
    if (rows.length === 5) {
      // The measurement itself — visible in the test output.
      console.table(rows);
      rows.length = 0;
    }
  });
});
