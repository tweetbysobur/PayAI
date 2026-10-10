import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { feeOnTop, fromUnits } from "@/lib/payment/feeOnTop";
import { fundingSummary } from "@/lib/automation/fundingSummary";

/**
 * Fee disclosures say what the contracts actually do (fee = 0.25% of the
 * GROSS, rounded down, added on top), the automation summary reconciles, and
 * GET /api/fees can't be mistaken for authoritative on-chain rates.
 * Source-text checks for copy; the money math itself is lib/payment/feeOnTop
 * (test/fee-on-top.test.ts) and is not changed here.
 */

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
/** JSX source → the text a reader sees: entities decoded, {" "} and line wrapping collapsed. */
const text = (p: string) => src(p).replace(/&apos;/g, "'").replace(/\{" "\}/g, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

const GENERAL = "PayAI's fee is 0.25% of the gross amount handled by the contract, rounded down. For sends, swaps through PayAI's trade executor, and new automations, the fee is added on top so the recipient receives the amount you requested. Because the fee is calculated on the gross amount, the effective fee relative to the requested amount can be slightly higher than 0.25%. Your confirmation screen shows the exact fee and total before you sign.";
const EXAMPLE = "Sending 1 USDC costs 1.002506 USDC before network gas. The recipient receives 1 USDC.";
const SPLIT = "the PayAI fee is 0.25% of the recipients' total, rounded down, and is added on top";
const EXISTING = "Automations created before this change retain their original fee behaviour: the fee is deducted from each payment, so the recipient receives the payment amount minus the fee.";
const INDEX_CARD = "PayAI charges fees on sends, automations, split payments, and trades routed through PayAI's trade executor. Trades routed directly to a DEX do not incur a PayAI trade-executor fee.";

describe("public fee wording", () => {
  it("the worked example is the contract math, not a rounded guess", () => {
    const f = feeOnTop(1_000_000n, 25); // 1 USDC at the live 25 bps
    expect(fromUnits(f.gross, 6)).toBe("1.002506");
    expect(f.gross - (f.gross * 25n) / 10000n).toBe(1_000_000n); // the forwarder's own floor fee
  });

  it("docs/fees states the gross basis, the example, splits and existing automations", () => {
    const t = text("app/docs/fees/page.tsx");
    for (const s of [GENERAL, EXAMPLE, EXISTING]) expect(t).toContain(s);
    expect(t).toContain(`Split payments: ${SPLIT}`);
    expect(t).toContain("gross − floor(gross × 25 / 10,000)");
    expect(t).not.toMatch(/floor\(amount × 25/); // the fee is on the gross, never the amount
    expect(t).not.toMatch(/about 100\.25 USDC/);
    expect(t).not.toMatch(/the live rate is the API/i);
    expect(t).not.toMatch(/rate in the confirmation you signed is the rate that applies/i);
    expect(t).toMatch(/configured estimates/);
  });

  it("the docs index no longer says swaps are free", () => {
    const t = text("app/docs/page.tsx");
    expect(t).toContain(INDEX_CARD);
    expect(t).not.toMatch(/Swaps are currently free/);
  });

  it("help and terms say the same thing, and neither calls /api/fees live or authoritative", () => {
    const help = text("app/dashboard/help/page.tsx");
    for (const s of [GENERAL, EXISTING]) expect(help).toContain(s);
    expect(help).toContain("For split payments, the PayAI fee is 0.25% of the recipients' total, rounded down, and is added on top.");
    expect(help).toContain("sending 1 USDC costs 1.002506 USDC before network gas, and the recipient receives 1 USDC");
    const terms = text("app/terms/page.tsx");
    expect(terms).toMatch(/of the gross amount handled by the contract, rounded down/);
    expect(terms).toMatch(/split payments \(0\.25% of the recipients' total\)/);
    for (const t of [help, terms]) {
      expect(t).not.toMatch(/Live rates (are published )?at \/api\/fees/i);
      expect(t).not.toMatch(/rate in the confirmation you signed is the (one|rate) that applies/i);
    }
  });
});

describe("GET /api/fees is labelled as configured estimates", () => {
  it("keeps every feature key and shape, and adds an explicit not-authoritative description", async () => {
    const { GET } = await import("@/app/api/fees/route");
    const res = await GET();
    expect(res.headers.get("X-PayAI-Fee-Source")).toBe("configured-estimates; not-authoritative");
    const body = await res.json();
    for (const k of ["send_payment", "swap", "wallet_automation", "reserved_funds"]) {
      expect(body[k]).toMatchObject({ kind: expect.any(String), value: expect.any(Number) });
    }
    expect(body.about).toMatchObject({ kind: "configured_estimates", authoritative: false });
    expect(body.about.note).toMatch(/not read from the contracts and are not authoritative/);
    expect(body.about.note).toMatch(/on-chain feeBps\(\) when the transaction executes/);
    expect(Object.keys(body.about.authoritativeSource).sort()).toEqual(["reserved_funds", "send_payment", "split_payment", "swap", "wallet_automation"]);
  });

  it("does no chain reads (no invented live rate, no new RPC dependency)", () => {
    const route = src("app/api/fees/route.ts");
    expect(route).not.toMatch(/lib\/monad|readContract|getPublicClient|viem/);
  });
});

describe("automation summary reconciles: payments × (payment + fee) = total", () => {
  const per = (net: bigint) => feeOnTop(net, 25);

  it("a bounded schedule shows the payment, the fee per run and the exact total", () => {
    const f = per(10_000_000n); // 10 USDC
    const s = fundingSummary({ ...f, decimals: 6, symbol: "USDC", occurrences: 4, mode: "wallet" });
    expect(s.perPayment).toBe("10 USDC");
    expect(s.feePerPayment).toBe(`${fromUnits(f.fee, 6)} USDC`);
    expect(s.total).toBe(`${fromUnits(f.gross * 4n, 6)} USDC`);
    expect(s.line).toBe(`4 payments × (10 USDC + ${fromUnits(f.fee, 6)} USDC PayAI fee) = ${fromUnits(f.gross * 4n, 6)} USDC total authorized.`);
    // The old, non-reconciling form ("4 × 10 USDC = 40.1…") never appears.
    expect(s.line).not.toMatch(/× 10 USDC =/);
  });

  it("shows sub-0.0001 fees exactly instead of rounding them", () => {
    const f = per(100_000n); // 0.10 USDC → fee 0.00025
    const s = fundingSummary({ ...f, decimals: 6, symbol: "USDC", occurrences: 1, mode: "reserved" });
    expect(s.feePerPayment).toBe("0.00025 USDC");
    expect(s.line).toBe("1 payment × (0.1 USDC + 0.00025 USDC PayAI fee) = 0.10025 USDC total reserved up front.");
  });

  it("open-ended: Reserved Funds reserves just the next payment; Wallet Automation shows no fixed total", () => {
    const f = per(10n ** 18n); // 1 MON
    const r = fundingSummary({ ...f, decimals: 18, symbol: "MON", occurrences: null, mode: "reserved" });
    expect(r.total).toBe(`${fromUnits(f.gross, 18)} MON`);
    expect(r.line).toMatch(/sets aside only the next payment/);
    const w = fundingSummary({ ...f, decimals: 18, symbol: "MON", occurrences: null, mode: "wallet" });
    expect(w.total).toBeNull();
    expect(w.line).toMatch(new RegExp(`Each payment is 1 MON \\+ ${fromUnits(f.fee, 18).replace(".", "\\.")} MON PayAI fee`));
  });

  it("the creator renders this summary and itemizes the fee in the review", () => {
    const c = src("components/dashboard/AutomationCreator.tsx");
    expect(c).toMatch(/fundingSummary\(/);
    expect(c).toMatch(/PayAI fee per payment \(added on top\)/);
    expect(c).not.toMatch(/× \{money\(perPayment/);
  });
});
