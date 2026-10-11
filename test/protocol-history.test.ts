import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { protocolHistory } from "@/lib/sdk/protocolHistory";
import { computeMonthlyVolumeByFeature, sumActivityByToken, sumByToken } from "@/lib/platform/analytics";
import type { TxLogEntry } from "@/lib/platform/types";

/**
 * Wrap/unwrap MON and Aave supply/withdraw confirmed with no History row and
 * no notification. They now get one — phrased only from the receipt's own
 * verified details, and kept out of every volume figure.
 */
const USDC = { symbol: "USDC", decimals: 6 };
const resolve = async (a: string) => (a.toLowerCase() === "0xusdc" ? USDC : null);

describe("protocolHistory", () => {
  it.each([
    [{ protocolId: "wmon", actionId: "wrap", name: "Wrap MON" }, { status: "success", wrapped: "1.5" }, "Wrapped 1.5 MON into WMON", "MON"],
    [{ protocolId: "wmon", actionId: "unwrap", name: "Unwrap WMON" }, { status: "success", unwrapped: "2" }, "Unwrapped 2 WMON into MON", "WMON"],
    [{ protocolId: "aave-v3-monad", actionId: "supply", name: "Supply to Aave" }, { status: "success", reserve: "0xusdc", amount: "10000000" }, "Supplied 10 USDC to Aave V3", "USDC"],
    [{ protocolId: "aave-v3-monad", actionId: "withdraw", name: "Withdraw from Aave" }, { status: "success", reserve: "0xusdc", amount: "5500000" }, "Withdrew 5.5 USDC from Aave V3", "USDC"],
  ])("%j", async (ref, details, summary, token) => {
    expect(await protocolHistory(ref, details, resolve)).toEqual({ summary, token });
  });
  it("never invents an amount the receipt didn't verify", async () => {
    expect(await protocolHistory({ protocolId: "wmon", actionId: "wrap", name: "Wrap MON" }, { status: "success" }, resolve))
      .toEqual({ summary: "Wrap MON confirmed", token: "" });
    expect(await protocolHistory({ protocolId: "aave-v3-monad", actionId: "supply", name: "Supply to Aave" }, { reserve: "0xunknown", amount: "1" }, resolve))
      .toEqual({ summary: "Supply to Aave confirmed", token: "" });
    expect(await protocolHistory({ protocolId: "aave-v3-monad", actionId: "supply", name: "Supply to Aave" }, { reserve: "0xusdc", amount: "-1" }, resolve))
      .toEqual({ summary: "Supply to Aave confirmed", token: "" });
  });
});

describe("protocol rows never count as volume", () => {
  const row = (over: Partial<TxLogEntry>): TxLogEntry => ({
    id: "x", at: Date.now(), decision: "executed", action: "wrap", amount: 100, token: "MON", recipient: null,
    riskScore: null, compliance: null, summary: "", ...over,
  });
  it("even if one carried an amount", () => {
    const txs = [row({ feature: "protocol" })];
    expect(sumByToken(txs)).toEqual({});
    expect(sumActivityByToken(txs)).toEqual({});
    const months = computeMonthlyVolumeByFeature(txs, 1);
    expect(months[0].byFeature).toEqual({ payment: {}, swap: {}, automation: {}, bulk: {} });
  });
});

describe("the confirm route records it", () => {
  it("uses protocolHistory for actions with neither a trade nor recipients, with no amount, once per settlement", () => {
    const src = readFileSync(join(__dirname, "../app/api/ask/action/confirm/route.ts"), "utf8");
    expect(src).toMatch(/!action\.settledTrade && !action\.settledOutflows/);
    expect(src).toMatch(/protocolHistory\(/);
    expect(src).toMatch(/feature: "protocol",\s*amount: null,/);
  });
});
