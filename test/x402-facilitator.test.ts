import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getAddress, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { checkPaymentPolicy } from "@/lib/x402/policy";
import { readFacilitatorConfig, X402_USDC } from "@/lib/x402/config";

/**
 * PayAI's self-hosted x402 facilitator.
 *
 * Payloads here are REAL: signed by a viem local account through the stock
 * x402 v2 client, exactly as a paying agent produces them. The facilitator is
 * the REAL SDK ExactEvmScheme. Only the chain is fake: its signer answers
 * reads from a table and "broadcasts" by returning a fixed hash, so no RPC is
 * touched and no funds exist anywhere.
 */

vi.setConfig({ testTimeout: 20_000 });

const PAYER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const FACILITATOR_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as const;
const AGENT_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const FACILITATOR = privateKeyToAccount(FACILITATOR_KEY);
const MERCHANT_WALLET = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const STRANGER = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
const USDC = getAddress(X402_USDC.mainnet);
const NETWORK = "eip155:143" as const;
const TX = `0x${"cd".repeat(32)}` as Hex;
const MERCHANT_KEY = "mk_test_merchant";

function requirements(o: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: USDC,
    amount: "1000", // 0.001 USDC
    payTo: MERCHANT_WALLET,
    maxTimeoutSeconds: 120,
    extra: { name: "USDC", version: "2" },
    ...o,
  };
}

async function signedPayload(req: PaymentRequirements): Promise<PaymentPayload> {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: PAYER, networks: [NETWORK] });
  return client.createPaymentPayload({ x402Version: 2, resource: { url: "https://merchant.example/api/data" }, accepts: [req] } as never);
}

// ── The fake chain the facilitator's signer talks to ──────────────────────
const chain = {
  balance: 10n ** 12n,
  nonceUsed: false,
  receiptStatus: "success",
  simulateOk: true,
  writes: [] as unknown[],
};
const fakeSigner: FacilitatorEvmSigner = {
  getAddresses: () => [FACILITATOR.address],
  readContract: async ({ functionName, args }) => {
    if (functionName === "balanceOf") return chain.balance;
    if (functionName === "authorizationState") return chain.nonceUsed;
    if (functionName === "name") return "USDC";
    if (functionName === "version") return "2";
    if (functionName === "allowance") return 0n;
    // The SDK simulates the transfer as an eth_call before trusting it. Like
    // real USDC, the call reverts on a used nonce or an insufficient balance.
    if (functionName === "transferWithAuthorization") {
      const value = BigInt(String(args?.[2] ?? 0));
      if (!chain.simulateOk || chain.nonceUsed || chain.balance < value) throw new Error("execution reverted");
      return undefined;
    }
    throw new Error(`unexpected read ${functionName}`);
  },
  verifyTypedData: (args) => verifyTypedData(args as Parameters<typeof verifyTypedData>[0]),
  writeContract: async (args) => {
    chain.writes.push(args);
    return TX;
  },
  sendTransaction: async () => TX,
  waitForTransactionReceipt: async () => ({ status: chain.receiptStatus }),
  // USDC is a contract; every other address here is an EOA.
  getCode: async ({ address }) => (address.toLowerCase() === USDC.toLowerCase() ? "0x6080" : undefined),
};

// Production scheme settings (buildFacilitator), fake chain underneath.
vi.mock("@/lib/x402/facilitator", async (orig) => {
  const real = await orig<typeof import("@/lib/x402/facilitator")>();
  return { ...real, getFacilitator: (cfg: { network: "eip155:143" }) => real.buildFacilitator(cfg.network, fakeSigner) };
});

const merchants = new Map<string, { id: string; name: string; apiKey: string; wallet?: string; createdAt: number }>();
vi.mock("@/lib/platform/merchants", () => ({
  DEMO_TENANT: "demo",
  getMerchantByApiKey: async (k: string) => merchants.get(k) ?? null,
}));

const sanctioned = new Set<string>();
vi.mock("@/lib/payment/sanctions", () => ({
  ensureSanctionsLoaded: async () => {},
  isSanctionedAddress: (a: string) => sanctioned.has(a.toLowerCase()),
}));

function setEnv(o: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ENABLED = {
  X402_FACILITATOR_ENABLED: "true",
  X402_FACILITATOR_PRIVATE_KEY: FACILITATOR_KEY,
  MONAD_AGENT_PRIVATE_KEY: AGENT_KEY,
  MONAD_NETWORK: "mainnet",
  X402_USDC_ADDRESS: undefined,
  X402_MAX_AMOUNT_ATOMIC: undefined,
};

let ipCounter = 0;
function post(kind: "verify" | "settle", body: unknown, key: string | null = MERCHANT_KEY) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-real-ip": `10.0.0.${++ipCounter % 250}` };
  if (key) headers["x-merchant-key"] = key;
  return new NextRequest(`http://localhost/api/x402/${kind}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function call(kind: "verify" | "settle", body: unknown, key?: string | null) {
  const mod = kind === "verify" ? await import("@/app/api/x402/verify/route") : await import("@/app/api/x402/settle/route");
  const res = await mod.POST(post(kind, body, key));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  setEnv(ENABLED);
  chain.balance = 10n ** 12n;
  chain.nonceUsed = false;
  chain.receiptStatus = "success";
  chain.simulateOk = true;
  chain.writes = [];
  sanctioned.clear();
  merchants.clear();
  merchants.set(MERCHANT_KEY, { id: "m_1", name: "Test Merchant", apiKey: MERCHANT_KEY, wallet: MERCHANT_WALLET, createdAt: 0 });
});

// ── Config ────────────────────────────────────────────────────────────────
describe("readFacilitatorConfig fails closed", () => {
  it("is off unless explicitly enabled", () => {
    expect(readFacilitatorConfig({ ...process.env, X402_FACILITATOR_ENABLED: undefined })).toEqual({ ok: false, reason: "disabled" });
  });
  it("refuses to start without its own key", () => {
    expect(readFacilitatorConfig({ ...process.env, X402_FACILITATOR_PRIVATE_KEY: "" })).toEqual({ ok: false, reason: "no_key" });
    expect(readFacilitatorConfig({ ...process.env, X402_FACILITATOR_PRIVATE_KEY: "0x1234" })).toEqual({ ok: false, reason: "bad_key" });
  });
  it("refuses to reuse the automation agent key, with or without 0x or case changes", () => {
    const bare = AGENT_KEY.slice(2).toUpperCase();
    expect(readFacilitatorConfig({ ...process.env, X402_FACILITATOR_PRIVATE_KEY: bare })).toEqual({ ok: false, reason: "shared_key" });
  });
  it("rejects a malformed asset or cap", () => {
    expect(readFacilitatorConfig({ ...process.env, X402_USDC_ADDRESS: "usdc" })).toEqual({ ok: false, reason: "bad_asset" });
    expect(readFacilitatorConfig({ ...process.env, X402_MAX_AMOUNT_ATOMIC: "0" })).toEqual({ ok: false, reason: "bad_cap" });
    expect(readFacilitatorConfig({ ...process.env, X402_MAX_AMOUNT_ATOMIC: "1e6" })).toEqual({ ok: false, reason: "bad_cap" });
  });
  it("follows MONAD_NETWORK for network and default USDC", () => {
    const main = readFacilitatorConfig();
    expect(main.ok && main.config.network).toBe("eip155:143");
    expect(main.ok && main.config.asset).toBe(X402_USDC.mainnet);
    setEnv({ MONAD_NETWORK: "testnet" });
    const test = readFacilitatorConfig();
    expect(test.ok && test.config.network).toBe("eip155:10143");
    expect(test.ok && test.config.asset).toBe(X402_USDC.testnet);
  });
});

// ── Policy on real signed payloads ────────────────────────────────────────
describe("checkPaymentPolicy", () => {
  async function policy(o: { req?: PaymentRequirements; payload?: PaymentPayload; merchantWallet?: string; cap?: bigint; version?: unknown } = {}) {
    const req = o.req ?? requirements();
    const payload = o.payload ?? (await signedPayload(req));
    return checkPaymentPolicy({
      x402Version: o.version ?? 2,
      paymentPayload: payload,
      paymentRequirements: req,
      merchantWallet: o.merchantWallet ?? MERCHANT_WALLET,
      network: NETWORK,
      asset: USDC,
      maxAmountAtomic: o.cap ?? 100_000_000n,
      facilitatorAddresses: [FACILITATOR.address],
      isSanctioned: (a) => sanctioned.has(a.toLowerCase()),
    });
  }

  it("accepts a stock x402 v2 client payment to the merchant's wallet", async () => {
    expect(await policy()).toEqual({ ok: true, payer: PAYER.address, amountAtomic: 1000n });
  });
  it("rejects v1", async () => {
    expect(await policy({ version: 1 })).toMatchObject({ ok: false, reason: "unsupported_version" });
  });
  it("rejects another network or asset", async () => {
    const payload = await signedPayload(requirements());
    expect(await policy({ payload, req: requirements({ network: "eip155:8453" }) })).toMatchObject({ ok: false, reason: "unsupported_network" });
    expect(await policy({ payload, req: requirements({ asset: STRANGER }) })).toMatchObject({ ok: false, reason: "unsupported_asset" });
  });
  it("rejects payTo that isn't the calling merchant's wallet", async () => {
    expect(await policy({ merchantWallet: STRANGER })).toMatchObject({ ok: false, reason: "payee_not_merchant" });
  });
  it("rejects a payload signed for different requirements than the ones submitted", async () => {
    const cheap = await signedPayload(requirements({ amount: "1" }));
    expect(await policy({ payload: cheap })).toMatchObject({ ok: false, reason: "requirements_mismatch" });
  });
  it("rejects an authorization that pays someone else, even with matching requirements", async () => {
    const real = await signedPayload(requirements());
    const tampered = structuredClone(real);
    (tampered.payload as { authorization: { to: string } }).authorization.to = STRANGER;
    expect(await policy({ payload: tampered })).toMatchObject({ ok: false, reason: "recipient_mismatch" });
  });
  it("rejects an authorization amount that differs from the requirement", async () => {
    const tampered = structuredClone(await signedPayload(requirements()));
    (tampered.payload as { authorization: { value: string } }).authorization.value = "999";
    expect(await policy({ payload: tampered })).toMatchObject({ ok: false, reason: "amount_mismatch" });
  });
  it("rejects zero and over-cap amounts", async () => {
    expect(await policy({ req: requirements({ amount: "0" }) })).toMatchObject({ ok: false, reason: "invalid_amount" });
    expect(await policy({ cap: 999n })).toMatchObject({ ok: false, reason: "amount_over_cap" });
  });
  it("rejects non-EIP-3009 payloads", async () => {
    const real = await signedPayload(requirements());
    expect(await policy({ payload: { ...real, payload: { permit2Authorization: {} } } })).toMatchObject({ ok: false, reason: "unsupported_payload" });
  });
  it("rejects a sanctioned payer or payee", async () => {
    sanctioned.add(PAYER.address.toLowerCase());
    expect(await policy()).toMatchObject({ ok: false, reason: "sanctioned_address" });
  });
  it("never relays to or from the facilitator's own wallet", async () => {
    const req = requirements({ payTo: FACILITATOR.address });
    expect(await policy({ req, merchantWallet: FACILITATOR.address })).toMatchObject({ ok: false, reason: "facilitator_address" });
  });
});

// ── Routes ────────────────────────────────────────────────────────────────
describe("POST /api/x402/verify and /settle", () => {
  async function body(req = requirements()) {
    return { x402Version: 2, paymentPayload: await signedPayload(req), paymentRequirements: req };
  }

  it("is 404 while disabled", async () => {
    setEnv({ X402_FACILITATOR_ENABLED: undefined });
    expect((await call("verify", await body())).status).toBe(404);
  });

  it("requires a real merchant key with a payout wallet", async () => {
    const b = await body();
    expect(await call("settle", b, null)).toMatchObject({ status: 401, body: { success: false, errorReason: "unauthorized" } });
    expect(await call("settle", b, "nope")).toMatchObject({ status: 401 });
    merchants.set("mk_nowallet", { id: "m_2", name: "No Wallet", apiKey: "mk_nowallet", createdAt: 0 });
    expect(await call("settle", b, "mk_nowallet")).toMatchObject({ status: 403, body: { errorReason: "no_payout_wallet" } });
    expect(chain.writes).toHaveLength(0);
  });

  it("verifies a valid payment without broadcasting", async () => {
    const r = await call("verify", await body());
    expect(r).toMatchObject({ status: 200, body: { isValid: true, payer: PAYER.address } });
    expect(chain.writes).toHaveLength(0);
  });

  it("reports an underfunded payer as invalid, from the SDK's own checks", async () => {
    chain.balance = 1n;
    const r = await call("verify", await body());
    expect(r.status).toBe(200);
    expect(r.body.isValid).toBe(false);
  });

  it("reports a transfer that would revert on-chain as invalid, and never broadcasts it", async () => {
    chain.simulateOk = false;
    const r = await call("verify", await body());
    expect(r.body).toMatchObject({ isValid: false, invalidReason: "invalid_exact_evm_transaction_simulation_failed" });
    expect(chain.writes).toHaveLength(0);
  });

  it("settles a valid payment: one transferWithAuthorization, then the tx hash", async () => {
    const r = await call("settle", await body());
    expect(r).toMatchObject({ status: 200, body: { success: true, transaction: TX, network: NETWORK, payer: PAYER.address } });
    expect(chain.writes).toHaveLength(1);
    expect(chain.writes[0]).toMatchObject({ address: USDC, functionName: "transferWithAuthorization" });
  });

  it("does not report success when the transfer reverts on-chain", async () => {
    chain.receiptStatus = "reverted";
    const r = await call("settle", await body());
    expect(r.body.success).toBe(false);
  });

  it("refuses to relay an authorization whose nonce is already used", async () => {
    chain.nonceUsed = true;
    const r = await call("settle", await body());
    expect(r.body.success).toBe(false);
    expect(chain.writes).toHaveLength(0);
  });

  it("refuses to settle a policy violation before any broadcast", async () => {
    merchants.set(MERCHANT_KEY, { id: "m_1", name: "Test Merchant", apiKey: MERCHANT_KEY, wallet: STRANGER, createdAt: 0 });
    const r = await call("settle", await body());
    expect(r).toMatchObject({ status: 200, body: { success: false, errorReason: "payee_not_merchant", transaction: "" } });
    expect(chain.writes).toHaveLength(0);
  });

  it("rejects malformed bodies", async () => {
    expect(await call("verify", { x402Version: 2 })).toMatchObject({ status: 400, body: { isValid: false, invalidReason: "invalid_request" } });
  });
});

describe("GET /api/x402/supported", () => {
  it("lists only x402 v2 exact on PayAI's network, with the facilitator's signer", async () => {
    const { GET } = await import("@/app/api/x402/supported/route");
    const res = await GET(new NextRequest("http://localhost/api/x402/supported", { headers: { "x-real-ip": "10.9.9.9" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kinds).toEqual([{ x402Version: 2, scheme: "exact", network: NETWORK }]);
    expect(Object.values(body.signers).flat()).toEqual([FACILITATOR.address]);
  });
  it("is 404 while disabled", async () => {
    setEnv({ X402_FACILITATOR_ENABLED: undefined });
    const { GET } = await import("@/app/api/x402/supported/route");
    expect((await GET(new NextRequest("http://localhost/api/x402/supported"))).status).toBe(404);
  });
});
