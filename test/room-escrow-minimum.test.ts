import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

/**
 * PA-05 — PayAI Rooms' platform minimum contribution (approved 2026-10-10):
 * 0.5 USDC (500,000 base units, 6 decimals) and 1 MON (10^18 wei).
 *
 * Real: the Rooms service's form pricing (what the creation form and Ask PayAI
 * preview), its error messages and its fail-closed checks. Injected: the
 * escrow and token reads — nothing here is evidence of on-chain behaviour
 * (that is contracts/test/PayAIRoomEscrow.decisions.test.js).
 */

const ESCROW = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
const USDC = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const WALLET = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");

const chain = vi.hoisted(() => ({ decimals: 6, floors: new Map<string, bigint>() }));
vi.mock("@/lib/rooms/escrowRead", () => {
  class EscrowUnavailableError extends Error {}
  return {
    EscrowUnavailableError,
    readEscrowFeeTerms: async () => ({ feeBps: 50, treasury: "0xd46fe549ce3f36f22587f0bfe4b4ac435184f69c", escrow: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" }),
    readTokenSupported: async () => true,
    readTokenDecimals: async () => chain.decimals,
    readMinContributionFloor: async (t: string) => chain.floors.get(t.toLowerCase()) ?? 0n,
  };
});

const KEYS = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_ROOM_ESCROW", "PAYAI_ROOM_ESCROW_ENABLED", "MONAD_USDC_DECIMALS"] as const;
const SAVED: Record<string, string | undefined> = {};
beforeAll(async () => {
  for (const k of KEYS) SAVED[k] = process.env[k];
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.MONAD_MAINNET_ROOM_ESCROW = ESCROW;
  process.env.PAYAI_ROOM_ESCROW_ENABLED = "true";
  delete process.env.MONAD_USDC_DECIMALS;
  await import("@/lib/rooms/escrowService");
});
afterAll(() => { for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });
beforeEach(() => {
  chain.decimals = 6;
  chain.floors = new Map([["0x0000000000000000000000000000000000000000", 10n ** 18n], [USDC, 500_000n]]);
  delete process.env.MONAD_USDC_DECIMALS;
});

const base = { durationDays: 7, title: "Team dinner", description: "", publicListing: false };
const preview = async (form: Record<string, unknown>) => (await import("@/lib/rooms/escrowService")).previewEscrowRoom(WALLET, { ...base, ...form });
const code = async (form: Record<string, unknown>) => { try { await preview(form); return "OK"; } catch (e) { return `${(e as { code?: string }).code}: ${(e as Error).message}`; } };

describe("PA-05 minimum in room creation (service, used by the form and Ask PayAI)", () => {
  it.each([
    ["USDC", "0.499999", "0.5", "0.500001", "0.5 USDC"],
    ["MON", "0.999999999999999999", "1", "1.000000000000000001", "1 MON"],
  ])("%s fixed share: below the minimum is refused; at and above are accepted", async (token, below, at, above, text) => {
    expect(await code({ kind: "fixed", token, amount: below, participants: 3 })).toBe(`INVALID_INPUT: Each share must be at least ${text} — PayAI Rooms' minimum contribution.`);
    expect((await preview({ kind: "fixed", token, amount: at, participants: 3 })).share).toBe(at);
    expect((await preview({ kind: "fixed", token, amount: above, participants: 3 })).share).toBe(above);
  });

  it.each([
    ["USDC", "0.4", "0.5", "0.75", "0.5 USDC"],
    ["MON", "0.9", "1", "2", "1 MON"],
  ])("%s target room: minimum below / at / above; omitted → the platform minimum; target below it refused", async (token, below, at, above, text) => {
    expect(await code({ kind: "target", token, amount: "100", minContribution: below })).toBe(`INVALID_INPUT: The minimum contribution can't be below ${text} — PayAI Rooms' platform minimum.`);
    expect((await preview({ kind: "target", token, amount: "100", minContribution: at })).minContribution).toBe(at);
    expect((await preview({ kind: "target", token, amount: "100", minContribution: above })).minContribution).toBe(above);
    const p = await preview({ kind: "target", token, amount: "100" });
    expect(p.minContribution).toBe(at); // the default IS the platform minimum
    expect(p.conditions.join(" ")).toContain(`at least ${text}`);
    expect(p.conditions.join(" ")).toMatch(/exactly the final amount still needed/);
    expect(await code({ kind: "target", token, amount: below })).toBe(`INVALID_INPUT: The target must be at least ${text} — PayAI Rooms' minimum contribution.`);
  });

  it("refuses USDC rooms unless the live token reports 6 decimals (the 500,000-unit conversion is checked, not assumed)", async () => {
    chain.decimals = 18;
    expect(await code({ kind: "target", token: "USDC", amount: "100" })).toMatch(/^ESCROW_UNAVAILABLE: .*reports 18 decimals, but PayAI's 0.5 USDC minimum assumes 6/);
    chain.decimals = 6;
    process.env.MONAD_USDC_DECIMALS = "18"; // misconfigured app side
    expect(await code({ kind: "target", token: "USDC", amount: "100" })).toMatch(/^ESCROW_UNAVAILABLE: .*assumes 6 decimals/);
  });

  it("refuses to create rooms when the escrow's minimum is unset or differs from PayAI's", async () => {
    chain.floors.delete(USDC);
    expect(await code({ kind: "target", token: "USDC", amount: "100" })).toBe("ESCROW_UNAVAILABLE: New USDC rooms are unavailable: the escrow's minimum contribution (not set) doesn't match PayAI's 0.5 USDC.");
    chain.floors.set(USDC, 1_000_000n);
    expect(await code({ kind: "target", token: "USDC", amount: "100" })).toBe("ESCROW_UNAVAILABLE: New USDC rooms are unavailable: the escrow's minimum contribution (1 USDC) doesn't match PayAI's 0.5 USDC.");
    chain.floors.set("0x0000000000000000000000000000000000000000", 1n);
    expect(await code({ kind: "fixed", token: "MON", amount: "1", participants: 2 })).toMatch(/doesn't match PayAI's 1 MON/);
  });
});
