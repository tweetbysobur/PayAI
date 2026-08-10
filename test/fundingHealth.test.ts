import { describe, it, expect, vi } from "vitest";

/**
 * Ultrafuzz L-05: a reservation is only ever released/refunded against the
 * exact AutomationVault it was deposited into (see lib/monad/contracts.ts's
 * releaseFromVault/refundReservationViaAgent, both of which already prefer
 * the row's pinned vaultAddress). checkFundingHealth must read from that
 * SAME pinned vault, not whatever vault happens to be configured globally
 * right now -- otherwise rotating the global vault makes an existing
 * reservation's health check silently start inspecting the wrong contract.
 */
const VAULT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** Vault address -> reservedBalance to return for it, so the test can prove
 *  WHICH vault contract was actually queried by which balance comes back. */
let reservedByVault: Record<string, bigint> = {};

vi.mock("@/lib/monad/config", () => ({
  // The CURRENT global vault -- deliberately different from any row's
  // pinned vaultAddress in these tests, to prove the pin wins.
  getAutomationVault: () => VAULT_B,
}));

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      if (functionName !== "reservedBalance") throw new Error(`unexpected functionName: ${functionName}`);
      return reservedByVault[address.toLowerCase()] ?? 0n;
    },
  }),
}));

const { checkFundingHealth } = await import("@/lib/automation/fundingHealth");

function reservedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sch_test123456",
    merchantId: "merchant-1",
    fundingMode: "reserved" as const,
    amount: 10,
    token: "USDC",
    tokenDecimals: 6,
    vaultAddress: VAULT_A,
    ...overrides,
  } as Parameters<typeof checkFundingHealth>[0];
}

describe("checkFundingHealth — reserved mode reads the PINNED vault, not the current global one", () => {
  it("reads reservedBalance from the row's pinned vaultAddress, ignoring what's currently configured globally", async () => {
    // Vault A (pinned) genuinely holds the reservation; Vault B (the
    // "rotated to" global vault) has nothing under this id at all.
    reservedByVault = { [VAULT_A]: 10_000000n, [VAULT_B]: 0n };
    const health = await checkFundingHealth(reservedRow());
    expect(health).not.toBeNull();
    expect(health!.sufficient).toBe(true);
    expect(health!.available).toBe(10);
  });

  it("does not report false insufficiency just because the CURRENT global vault (not the pinned one) is empty", async () => {
    // If this read the global vault (B) instead of the pin (A), it would
    // see 0 and wrongly report "insufficient" for a fully-funded reservation.
    reservedByVault = { [VAULT_A]: 10_000000n, [VAULT_B]: 0n };
    const health = await checkFundingHealth(reservedRow());
    expect(health!.sufficient).toBe(true);
  });

  it("does not report false sufficiency just because the CURRENT global vault (not the pinned one) happens to hold funds", async () => {
    // The inverse danger: if the global vault (B) has balance under this
    // same automationId (e.g. reused after a redeploy) but the actual
    // pinned vault (A) does not, reading B would wrongly report healthy.
    reservedByVault = { [VAULT_A]: 0n, [VAULT_B]: 10_000000n };
    const health = await checkFundingHealth(reservedRow());
    expect(health!.sufficient).toBe(false);
    expect(health!.available).toBe(0);
  });

  it("falls back to the current global vault for legacy rows with no pinned vaultAddress", async () => {
    reservedByVault = { [VAULT_B]: 10_000000n };
    const health = await checkFundingHealth(reservedRow({ vaultAddress: undefined }));
    expect(health!.sufficient).toBe(true);
    expect(health!.available).toBe(10);
  });
});
