import { describe, it, expect } from "vitest";
import { createSecp256k1SigningSession, getEvmAddress } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { recoverMessageAddress, recoverTypedDataAddress, keccak256, toHex } from "viem";

/**
 * The embedded wallet's whole security story rests on one chain:
 *
 *   passkey PRF output (32 bytes) → secp256k1 session → EVM address
 *                                                     → viem account → signature
 *
 * The passkey half needs a real authenticator and is exercised in the browser.
 * THIS half is pure and deterministic, so it is pinned here: if Mera ever
 * changed how it derives an address, or if the viem adapter signed with a
 * different key than the address advertises, every automation signature PayAI
 * stores would verify against the wrong wallet — silently. These tests fail
 * loudly instead.
 */

/** Stand-in for a PRF output: any 32-byte value is a valid secp256k1 scalar. */
const PRF_OUTPUT = new Uint8Array(32).fill(7);

describe("Mera signing chain", () => {
  it("derives the same address from the session as the viem account reports", () => {
    const session = createSecp256k1SigningSession({ privateKey: PRF_OUTPUT });
    const derived = getEvmAddress(session.publicKey);
    const account = toViemAccount(session);
    // If these ever diverge, PayAI would show one address and sign with another.
    expect(account.address).toBe(derived);
    expect(derived).toMatch(/^0x[0-9a-fA-F]{40}$/);
    session.end();
  });

  it("produces a signature that recovers back to the wallet's own address", async () => {
    const session = createSecp256k1SigningSession({ privateKey: PRF_OUTPUT });
    const account = toViemAccount(session);
    const message = "PayAI automation authorization";

    const signature = await account.signMessage({ message });
    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/); // r+s+v, 65 bytes

    // This is exactly what the server does when it verifies an automation's
    // signature (see verifyMutation in app/api/automations/route.ts).
    const recovered = await recoverMessageAddress({ message, signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    session.end();
  });

  it("signs EIP-712 typed data back to the same address", async () => {
    const session = createSecp256k1SigningSession({ privateKey: PRF_OUTPUT });
    const account = toViemAccount(session);
    const typedData = {
      domain: { name: "PayAI", version: "1", chainId: 143 },
      types: { Payment: [{ name: "amount", type: "uint256" }, { name: "to", type: "address" }] },
      primaryType: "Payment" as const,
      message: { amount: 1000000n, to: "0x1111111111111111111111111111111111111111" as `0x${string}` },
    };
    const signature = await account.signTypedData(typedData);
    const recovered = await recoverTypedDataAddress({ ...typedData, signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    session.end();
  });

  it("is deterministic — the same PRF output always yields the same wallet", () => {
    // The property that makes recovery work and duplicate wallets impossible.
    const a = createSecp256k1SigningSession({ privateKey: new Uint8Array(32).fill(9) });
    const b = createSecp256k1SigningSession({ privateKey: new Uint8Array(32).fill(9) });
    expect(getEvmAddress(a.publicKey)).toBe(getEvmAddress(b.publicKey));

    // ...and a different passkey must never collide onto the same wallet.
    const c = createSecp256k1SigningSession({ privateKey: new Uint8Array(32).fill(10) });
    expect(getEvmAddress(c.publicKey)).not.toBe(getEvmAddress(a.publicKey));
    a.end(); b.end(); c.end();
  });

  it("refuses to sign once the session is ended", async () => {
    const session = createSecp256k1SigningSession({ privateKey: PRF_OUTPUT });
    const account = toViemAccount(session);
    session.end(); // zeroes the key — what sign-out and tab-close rely on
    await expect(account.signMessage({ message: "after end" })).rejects.toThrow();
    await expect(session.signDigest(new Uint8Array(32))).rejects.toThrow();
  });

  it("signs a raw 32-byte digest, and rejects anything else", async () => {
    const session = createSecp256k1SigningSession({ privateKey: PRF_OUTPUT });
    const digest = keccak256(toHex("payai"));
    const sig = await session.signDigest(Buffer.from(digest.slice(2), "hex"));
    expect(sig.compact).toHaveLength(64);
    expect([0, 1]).toContain(sig.recovery);
    await expect(session.signDigest(new Uint8Array(31))).rejects.toThrow();
    session.end();
  });
});
