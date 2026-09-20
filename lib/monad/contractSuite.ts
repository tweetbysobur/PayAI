/**
 * The live PayAI contract roster, in the order public pages should show it.
 *
 * PayAI-named contracts first: those are what a user actually signs against
 * for interactive payments and trades. PaymentExecutor / AutomationVault /
 * MerchantRegistry are the automation + record-keeping suite — real, but not
 * the "main PayAI contract" people look for on the explorer.
 *
 * Addresses come from `/api/onchain` (env on the running deployment). Never
 * hardcode a mainnet address here.
 */

export interface OnchainContractFields {
  paymentExecutor?: string | null;
  executorExplorer?: string | null;
  merchantRegistry?: string | null;
  merchantRegistryExplorer?: string | null;
  forwarder?: string | null;
  forwarderExplorer?: string | null;
  tradeExecutor?: string | null;
  tradeExecutorExplorer?: string | null;
  vault?: string | null;
  vaultExplorer?: string | null;
}

export interface SuiteEntry {
  id: "forwarder" | "tradeExecutor" | "paymentExecutor" | "vault" | "merchantRegistry";
  name: string;
  blurb: string;
  address: string;
  explorer: string;
}

const CATALOG: {
  id: SuiteEntry["id"];
  name: string;
  blurb: string;
  address: (c: OnchainContractFields) => string | null | undefined;
  explorer: (c: OnchainContractFields) => string | null | undefined;
}[] = [
  {
    id: "forwarder",
    name: "PayAIForwarder",
    blurb: "Interactive payments. You sign; payer → forwarder → recipient.",
    address: (c) => c.forwarder,
    explorer: (c) => c.forwarderExplorer,
  },
  {
    id: "tradeExecutor",
    name: "PayAITradeExecutor",
    blurb: "Interactive trades through allowlisted venues.",
    address: (c) => c.tradeExecutor,
    explorer: (c) => c.tradeExecutorExplorer,
  },
  {
    id: "paymentExecutor",
    name: "PaymentExecutor",
    blurb: "Automations, request ids, on-chain spend caps.",
    address: (c) => c.paymentExecutor,
    explorer: (c) => c.executorExplorer,
  },
  {
    id: "vault",
    name: "AutomationVault",
    blurb: "Reserved Funds. Pays the committed recipient or refunds you.",
    address: (c) => c.vault,
    explorer: (c) => c.vaultExplorer,
  },
  {
    id: "merchantRegistry",
    name: "MerchantRegistry",
    blurb: "On-chain merchant directory the executor records against.",
    address: (c) => c.merchantRegistry,
    explorer: (c) => c.merchantRegistryExplorer,
  },
];

export function suiteFromOnchain(c: OnchainContractFields | null | undefined, explorerBase?: string): SuiteEntry[] {
  if (!c) return [];
  const base = (explorerBase || "").replace(/\/$/, "");
  const out: SuiteEntry[] = [];
  for (const row of CATALOG) {
    const address = row.address(c);
    if (!address) continue;
    const explorer = row.explorer(c) || (base ? `${base}/address/${address}` : "");
    out.push({ id: row.id, name: row.name, blurb: row.blurb, address, explorer });
  }
  return out;
}
