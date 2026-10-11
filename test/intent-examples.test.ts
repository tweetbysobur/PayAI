import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseIntent } from "@/lib/plan-adapter/grammar";
import { parseScheduleIntent } from "@/lib/agent/brain";
import { toPlanText } from "@/lib/ask/planFastPath";
import {
  ASK_STARTERS, CAPABILITIES, CORE_EXAMPLES, GUIDE, OPERATOR_EXAMPLES, PRODUCT_EXAMPLES, type IntentExample,
} from "@/components/landing/intentExamples";

/**
 * Every example prompt on the marketing site is something a visitor will type
 * into Ask PayAI. Each is run here through the real code path it claims:
 *
 *   plan      Ask's framing/"each" rewrite, then the Plan API's own grammar,
 *             producing exactly the stated number of actions;
 *   schedule  the schedule parser, with a usable time and the stated cadence;
 *   route     Ask's router, ending complete in the stated intent kind (the
 *             deterministic understanding — what Ask answers with even when
 *             the model is unavailable).
 *
 * An example that would come back as a question, a refusal or the wrong
 * action fails here instead of on the site.
 */

const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const TOKENS = { monDecimals: 18, stable: { symbol: "USDC", decimals: 6 } };
const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests(); __resetBootstrapForTests(); ensureBuiltinsRegistered();
});
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

async function holds(ex: IntentExample) {
  const c = ex.check;
  if (c.kind === "plan") {
    const r = parseIntent(toPlanText(ex.say), TOKENS);
    expect(r.ok, `${ex.say} → ${r.ok ? "" : r.code}`).toBe(true);
    if (r.ok) expect(r.steps, ex.say).toHaveLength(c.actions);
    return;
  }
  if (c.kind === "schedule") {
    const s = parseScheduleIntent(ex.say);
    expect(s, ex.say).not.toBeNull();
    expect(s, ex.say).toMatchObject({ needsTime: false, cadence: c.cadence });
    expect(s?.amount, ex.say).toBeGreaterThan(0);
    expect(s?.recipient, ex.say).toBeTruthy();
    return;
  }
  const { routeRequest } = await import("@/lib/ask/intent/classify");
  const r = await routeRequest(ex.say, null);
  const u = (r.understanding ?? r.fallback) as { kind: string; outcome: string } | null;
  expect(u, ex.say).not.toBeNull();
  expect(u?.kind, ex.say).toBe(c.intent);
  expect(u?.outcome, ex.say).toBe("complete");
}

const all: [string, IntentExample][] = [
  ...CAPABILITIES.flatMap((c) => c.examples.map((e) => [`capability ${c.name}`, e] as [string, IntentExample])),
  ...GUIDE.flatMap((g) => g.examples.map((e) => [`guide ${g.title}`, e] as [string, IntentExample])),
  ...OPERATOR_EXAMPLES.map((e) => ["operator", e] as [string, IntentExample]),
  ...PRODUCT_EXAMPLES.map((e) => ["product", e] as [string, IntentExample]),
  ...Object.entries(CORE_EXAMPLES).map(([k, e]) => [`core ${k}`, e] as [string, IntentExample]),
  ...ASK_STARTERS.map((e) => [`ask starter ${e.label}`, e] as [string, IntentExample]),
];

describe("every example prompt on the site does what it says", () => {
  it.each(all)("%s: %j", async (_where, ex) => {
    await holds(ex);
  });
});

describe("the data is what the pages render", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  it("no page hard-codes its own example prompts", () => {
    // Examples come from intentExamples.ts so they are all tested. A literal
    // "Send … to …" sentence in a page would bypass that.
    const sources = {
      landing: read("../app/page.tsx"),
      how: read("../app/how-it-works/page.tsx"),
      intents: read("../app/intents/page.tsx"),
      product: read("../components/landing/ProductSections.tsx"),
      operator: read("../components/landing/PlatformOverview.tsx"),
      grid: read("../components/landing/CapabilityGrid.tsx"),
      askWelcome: read("../components/ask/AskEmptyState.tsx"),
    };
    // A prompt: an action verb, then (within a few words) an amount and a token.
    const sentence = /["'`](?:Send|Swap|Pay|Buy|Sell|Supply|Withdraw|Wrap|Create|Trade)\b[^"'`.;]{0,40}?\$?\d[\d.,]*\s*(?:of\s+)?(?:USDC|MON)\b[^"'`]*["'`]/;
    for (const [name, src] of Object.entries(sources)) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, `${name} hard-codes an example prompt`).not.toMatch(sentence);
    }
  });
  it("Rooms are never described as escrow, and the capability list names no feature that isn't live", () => {
    const text = JSON.stringify({ CAPABILITIES, GUIDE });
    expect(text).not.toMatch(/escrow|refund|guarantee|stak|bridg|lend\b|borrow|any token|every token/i);
  });
});
