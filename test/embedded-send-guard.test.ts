import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The gas guard on embedded sends.
 *
 * A PayAI Wallet is brand new, so the most likely first action — create it,
 * then immediately send something — meets a wallet holding zero MON. Without
 * this guard that surfaces as a raw RPC string ("insufficient funds for gas *
 * price + value"), which tells a new user nothing about what to do. These
 * tests are about the message being actionable, not merely about refusing.
 */

let balance = 0n;
let gasEstimate = 21_000n;
let feePerGas = 1_000_000_000n; // 1 gwei
let balanceThrows = false;
let estimateThrows = false;
const sent: unknown[] = [];

vi.mock("@/lib/monad/browserClient", () => ({
  getBrowserPublicClient: async () => ({
    getBalance: async () => { if (balanceThrows) throw new Error("rpc down"); return balance; },
    estimateGas: async () => { if (estimateThrows) throw new Error("cannot estimate"); return gasEstimate; },
    estimateFeesPerGas: async () => ({ maxFeePerGas: feePerGas }),
  }),
}));

vi.mock("@/lib/wallet-service/providers/mera", () => ({
  isMeraSupported: () => true,
  storedCredential: () => null,
  forgetCredential: () => {},
  friendlyMeraError: (e: unknown) => String(e),
  createWallet: async () => { throw new Error("unused"); },
  recoverWallet: async () => { throw new Error("unused"); },
  exportPrivateKey: async () => "0x00",
  walletClientFor: async () => ({
    sendTransaction: async (tx: unknown) => { sent.push(tx); return "0xbroadcast"; },
  }),
}));

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;

/** Builds the handle the registry hands to the rest of the app. */
async function handle() {
  const mera = await import("@/lib/wallet-service/providers/mera");
  const { getEmbeddedProvider } = await import("@/lib/wallet-service/registry");
  const provider = getEmbeddedProvider();
  // create() runs the real toHandle() over a stub wallet.
  vi.spyOn(mera, "createWallet").mockResolvedValue({
    address: ADDRESS,
    credentialId: "c",
    account: { address: ADDRESS, signMessage: async () => "0xsig" },
    session: { end: () => {} },
  } as never);
  return provider.create("test");
}

describe("embedded send — affordability guard", () => {
  beforeEach(() => {
    vi.resetModules();
    balance = 0n; gasEstimate = 21_000n; feePerGas = 1_000_000_000n;
    balanceThrows = false; estimateThrows = false;
    sent.length = 0;
  });

  it("explains an empty wallet needs MON for fees, rather than leaking RPC wording", async () => {
    balance = 0n;
    const h = await handle();
    await expect(h.sendTransaction({ to: "0x2222222222222222222222222222222222222222" }))
      .rejects.toThrow(/no MON yet[\s\S]*network fees/i);
    expect(sent, "must not broadcast a transaction it knows will fail").toHaveLength(0);
  });

  it("names the shortfall when the balance can't cover value plus fees", async () => {
    balance = 1_000000000000000000n; // 1 MON
    const h = await handle();
    await expect(h.sendTransaction({
      to: "0x2222222222222222222222222222222222222222",
      value: `0x${(2_000000000000000000n).toString(16)}`, // asking to send 2 MON
    })).rejects.toThrow(/Not enough MON[\s\S]*holds 1 MON/i);
    expect(sent).toHaveLength(0);
  });

  it("counts the fee, so a send of the entire balance is refused", async () => {
    // Exactly the balance, which cannot be right — the fee has to come from
    // somewhere. Ignoring fees here would let it through and fail on-chain.
    balance = 1_000000000000000000n;
    const h = await handle();
    await expect(h.sendTransaction({
      to: "0x2222222222222222222222222222222222222222",
      value: `0x${(1_000000000000000000n).toString(16)}`,
    })).rejects.toThrow(/Not enough MON/i);
  });

  it("allows a send the wallet can afford", async () => {
    balance = 5_000000000000000000n;
    const h = await handle();
    const hash = await h.sendTransaction({
      to: "0x2222222222222222222222222222222222222222",
      value: `0x${(1_000000000000000000n).toString(16)}`,
    });
    expect(hash).toBe("0xbroadcast");
    expect(sent).toHaveLength(1);
  });

  it("does not block on its own uncertainty when the network is unreachable", async () => {
    // A guard that fails closed on a flaky connection would be worse than the
    // error it replaces — it would stop sends that would have succeeded.
    balanceThrows = true;
    const h = await handle();
    await expect(h.sendTransaction({ to: "0x2222222222222222222222222222222222222222" })).resolves.toBe("0xbroadcast");
  });

  it("still refuses on value alone when the fee can't be estimated", async () => {
    // Estimation usually fails for exactly the reason being checked, so its
    // failure proves nothing — but the value check still stands on its own.
    balance = 1_000000000000000000n;
    estimateThrows = true;
    const h = await handle();
    await expect(h.sendTransaction({
      to: "0x2222222222222222222222222222222222222222",
      value: `0x${(3_000000000000000000n).toString(16)}`,
    })).rejects.toThrow(/Not enough MON/i);
  });
});
