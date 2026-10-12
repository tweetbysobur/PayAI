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

/* The passkey ceremony that must precede every signature. `approvals` counts
   the prompts, `approvalDeclines` simulates the user dismissing one, and
   `approvedAddress` simulates them picking a passkey for a different wallet. */
let approvals = 0;
let approvalDeclines = false;
let approvedAddress: string | null = null;
const endedSessions: string[] = [];

vi.mock("@/lib/monad/browserClient", () => ({
  getBrowserPublicClient: async () => ({
    getBalance: async () => { if (balanceThrows) throw new Error("rpc down"); return balance; },
    estimateGas: async () => { if (estimateThrows) throw new Error("cannot estimate"); return gasEstimate; },
    estimateFeesPerGas: async () => ({ maxFeePerGas: feePerGas }),
  }),
}));

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;

vi.mock("@/lib/wallet-service/providers/mera", () => ({
  isMeraSupported: () => true,
  storedCredential: () => null,
  storedAddress: () => null,
  forgetCredential: () => {},
  friendlyMeraError: (e: unknown) => String(e),
  friendlyApprovalError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  createWallet: async () => { throw new Error("unused"); },
  recoverWallet: async () => { throw new Error("unused"); },
  exportPrivateKey: async () => "0x00",
  // Stands in for the real passkey ceremony: derives a wallet and refuses if
  // it isn't the one the caller expected.
  authorizeWallet: async (expected: string) => {
    approvals++;
    if (approvalDeclines) throw new Error("passkey declined");
    const address = approvedAddress ?? expected;
    if (address.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`That passkey unlocks a different wallet (${address}).`);
    }
    return {
      address,
      credentialId: "c",
      account: { address, signMessage: async () => "0xsig" },
      session: { end: () => endedSessions.push(address) },
    };
  },
  walletClientFor: async () => ({
    sendTransaction: async (tx: unknown) => { sent.push(tx); return "0xbroadcast"; },
  }),
}));

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
    approvals = 0; approvalDeclines = false; approvedAddress = null;
    endedSessions.length = 0;
  });

  it("explains an empty wallet needs MON for fees, rather than leaking RPC wording", async () => {
    balance = 0n;
    const h = await handle();
    await expect(h.sendTransaction({ to: "0x2222222222222222222222222222222222222222" }))
      .rejects.toThrow(/no MON yet[\s\S]*network fees/i);
    expect(sent, "must not broadcast a transaction it knows will fail").toHaveLength(0);
    expect(approvals, "must not spend the user's biometric on a doomed send").toBe(0);
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

/**
 * Approval on every signature.
 *
 * An external wallet shows a confirmation pop-up for each transaction.
 * Unlocking the embedded wallet once and then signing silently would make the
 * option PayAI recommends to newcomers the weaker of the two — an unlocked tab
 * left open, or a script with a foothold in the page, could move money with no
 * human in the loop. These tests are the guarantee that it can't.
 */
describe("embedded signing — approval on every signature", () => {
  const TO = "0x2222222222222222222222222222222222222222";

  beforeEach(() => {
    vi.resetModules();
    balance = 100_000000000000000000n; // funded, so affordability never interferes
    gasEstimate = 21_000n; feePerGas = 1_000_000_000n;
    balanceThrows = false; estimateThrows = false;
    sent.length = 0;
    approvals = 0; approvalDeclines = false; approvedAddress = null;
    endedSessions.length = 0;
  });

  it("asks for approval before broadcasting a transaction", async () => {
    const h = await handle();
    await h.sendTransaction({ to: TO });
    expect(approvals).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("asks again for a second transaction — one unlock is not a blank cheque", async () => {
    const h = await handle();
    await h.sendTransaction({ to: TO });
    await h.sendTransaction({ to: TO });
    expect(approvals).toBe(2);
  });

  it("asks for approval before signing a message", async () => {
    const h = await handle();
    await expect(h.signMessage("claim username")).resolves.toBe("0xsig");
    expect(approvals).toBe(1);
  });

  it("broadcasts nothing when the user declines the passkey", async () => {
    approvalDeclines = true;
    const h = await handle();
    await expect(h.sendTransaction({ to: TO })).rejects.toThrow(/declined/i);
    expect(sent, "a declined approval must not move money").toHaveLength(0);
  });

  it("refuses to sign when the approved passkey belongs to another wallet", async () => {
    // A user with several PayAI passkeys can pick the wrong one at the prompt.
    // That derives a perfectly valid but DIFFERENT wallet, and signing with it
    // would quietly spend from an account they didn't choose.
    approvedAddress = "0x9999999999999999999999999999999999999999";
    const h = await handle();
    await expect(h.sendTransaction({ to: TO })).rejects.toThrow(/different wallet/i);
    expect(sent).toHaveLength(0);
  });

  it("zeroes the approved key material once the operation finishes", async () => {
    // The key derived for a signature must not outlive it — otherwise "approve
    // every time" would still leave a usable key sitting in memory.
    const h = await handle();
    await h.sendTransaction({ to: TO });
    expect(endedSessions).toEqual([ADDRESS]);
  });

  it("zeroes the approved key material even when the broadcast fails", async () => {
    const mera = await import("@/lib/wallet-service/providers/mera");
    vi.spyOn(mera, "walletClientFor").mockResolvedValue({
      sendTransaction: async () => { throw new Error("rpc rejected"); },
    } as never);
    const h = await handle();
    await expect(h.sendTransaction({ to: TO })).rejects.toThrow(/rpc rejected/i);
    expect(endedSessions).toEqual([ADDRESS]);
  });

  it("signs with the freshly approved key, never the one held since unlock", async () => {
    // The unlock session is only a marker that the wallet is open. If it were
    // what signed, revoking or rotating approval would mean nothing.
    const unlockSigner = vi.fn();
    const mera = await import("@/lib/wallet-service/providers/mera");
    const { getEmbeddedProvider } = await import("@/lib/wallet-service/registry");
    vi.spyOn(mera, "createWallet").mockResolvedValue({
      address: ADDRESS,
      credentialId: "c",
      account: { address: ADDRESS, signMessage: unlockSigner },
      session: { end: () => {} },
    } as never);
    const h = await getEmbeddedProvider().create("test");
    await h.signMessage("hello");
    expect(unlockSigner, "the unlock session must never be what signs").not.toHaveBeenCalled();
    expect(approvals).toBe(1);
  });
});

describe("the approval prompt isn't held back by a slow network", () => {
  it("opens the passkey prompt after a short head start, and still refuses to sign if the slow check then fails", async () => {
    vi.useFakeTimers();
    try {
      balance = 0n; // will fail — but only after a slow RPC
      const mod = await import("@/lib/monad/browserClient");
      const slow = vi.spyOn(mod, "getBrowserPublicClient").mockImplementation(async () => ({
        getBalance: () => new Promise<bigint>((r) => setTimeout(() => r(0n), 5_000)),
        estimateGas: async () => gasEstimate,
        estimateFeesPerGas: async () => ({ maxFeePerGas: feePerGas }),
      }) as never);
      const before = approvals;
      const h = await handle();
      const p = h.sendTransaction({ to: "0x2222222222222222222222222222222222222222" });
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(500);
      expect(approvals - before, "prompt must open without waiting 5 s for the RPC").toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).rejects.toThrow(/no MON yet/i);
      expect(sent).toHaveLength(0);
      expect(endedSessions.length).toBeGreaterThan(0);
      slow.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
