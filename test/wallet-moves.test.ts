import { describe, expect, it } from "vitest";
import { mergeByTime, toWalletMoves } from "@/lib/hooks/walletMoves";

describe("deposits in History", () => {
  const events = [
    { type: "deposit_received", at: 300, detail: "25 USDC arrived in your wallet.", amount: 25, token: "USDC", txHash: "0xdep", explorerUrl: "https://x/tx/0xdep" },
    { type: "withdrawal_completed", at: 200, detail: "1 MON left your wallet in a transaction not made through PayAI.", amount: 1, token: "MON", txHash: "0xout" },
    { type: "deposit_received", at: 250, detail: "3 MON arrived in your wallet from a contract.", amount: 3, token: "MON", txHash: "internal:10-20" },
    { type: "wallet_connected", at: 100, detail: "Connected." },
  ];

  it("turns deposits and outside sends into rows, and nothing else", () => {
    const rows = toWalletMoves(events);
    expect(rows.map((r) => r.decision)).toEqual(["received", "sent_out", "received"]);
    expect(rows[0]).toMatchObject({ direction: "in", amount: 25, token: "USDC", txHash: "0xdep" });
  });

  it("never links a contract deposit's block-range marker as a transaction", () => {
    const internal = toWalletMoves(events)[2];
    expect(internal.txHash).toBeUndefined();
  });

  it("merges newest first, one row per transaction", () => {
    const payai: { at: number; txHash?: string }[] = [{ at: 280, txHash: "0xpay" }, { at: 150, txHash: "0xDEP" }];
    const merged = mergeByTime(payai, toWalletMoves(events));
    expect(merged.map((r) => r.at)).toEqual([280, 250, 200, 150]);
  });
});
