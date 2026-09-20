import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { suiteFromOnchain } from "@/lib/monad/contractSuite";

/**
 * The wallets Security Center used to list PaymentExecutor + MerchantRegistry
 * and omit PayAIForwarder / PayAITradeExecutor — the contracts a user's wallet
 * actually pays and trades through. Public surfaces have to name those first.
 */

const live = {
  forwarder: "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D",
  forwarderExplorer: "https://monadexplorer.com/address/0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D",
  tradeExecutor: "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69",
  tradeExecutorExplorer: "https://monadexplorer.com/address/0xF17a916280321Ddb657c8EDd26B2a729F6E63b69",
  paymentExecutor: "0x5cAf11937aCbaaFd774c3906a5086A7507fae84D",
  executorExplorer: "https://monadexplorer.com/address/0x5cAf11937aCbaaFd774c3906a5086A7507fae84D",
  vault: "0xc4dEd0939E400f568472bee30C4B123a96F85b35",
  vaultExplorer: "https://monadexplorer.com/address/0xc4dEd0939E400f568472bee30C4B123a96F85b35",
  merchantRegistry: "0xadf04A50a2319D8B57245Db2aEB101DAb517AA72",
  merchantRegistryExplorer: "https://monadexplorer.com/address/0xadf04A50a2319D8B57245Db2aEB101DAb517AA72",
};

describe("live suite names PayAI contracts first", () => {
  const suite = suiteFromOnchain(live);

  it("starts with PayAIForwarder then PayAITradeExecutor", () => {
    expect(suite.map((s) => s.name)).toEqual([
      "PayAIForwarder",
      "PayAITradeExecutor",
      "PaymentExecutor",
      "AutomationVault",
      "MerchantRegistry",
    ]);
  });

  it("drops a contract whose address is missing rather than inventing one", () => {
    const partial = suiteFromOnchain({ ...live, tradeExecutor: null, tradeExecutorExplorer: null });
    expect(partial.map((s) => s.name)).not.toContain("PayAITradeExecutor");
    expect(partial[0].name).toBe("PayAIForwarder");
  });
});

describe("public surfaces list the PayAI-named contracts", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("wallets Security Center uses the shared suite, not a two-row PaymentExecutor list", () => {
    const src = read("../app/dashboard/wallets/page.tsx");
    expect(src).toMatch(/suiteFromOnchain/);
    expect(src).toMatch(/PayAIForwarder/);
    expect(src).toMatch(/PayAITradeExecutor/);
    expect(src).not.toMatch(/PaymentExecutor: \{short/);
  });

  it("footer names PayAIForwarder and PayAITradeExecutor", () => {
    const src = read("../components/landing/SiteFooter.tsx");
    expect(src).toMatch(/PayAIForwarder Live on Monad/);
    expect(src).toMatch(/PayAITradeExecutor Live on Monad/);
    expect(src).not.toMatch(/> Contract Live on Monad/);
  });

  it("/api/onchain exposes vault next to the rest of the suite", () => {
    const src = read("../app/api/onchain/route.ts");
    expect(src).toMatch(/vault: getAutomationVault\(\)/);
    expect(src).toMatch(/getPayAIForwarder/);
    expect(src).toMatch(/getPayAITradeExecutor/);
  });

  it("docs contracts page lists PayAIForwarder as the interactive path", () => {
    const src = read("../app/docs/contracts/page.tsx");
    expect(src).toMatch(/PayAIForwarder/);
    expect(src).toMatch(/not the contract your wallet sends an\s+interactive payment to/s);
  });
});
