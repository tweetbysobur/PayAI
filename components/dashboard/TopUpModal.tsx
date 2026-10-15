"use client";

import { announceTransaction } from "@/lib/hooks/useSync";
import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowDown, Fingerprint, KeyRound, Loader2, X } from "lucide-react";
import { AmountHero, ReceiptRow, StatusText, TxLink } from "@/components/receipt/ReceiptKit";
import { parseEther, parseUnits, encodeFunctionData } from "viem";
import { Badge } from "@/components/ui";
import { MonadMark } from "@/components/MonadMark";
import { TokenLogo } from "@/components/TokenLogo";
import { useModalA11y } from "@/lib/hooks/useModalA11y";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { shortAddress } from "@/lib/platform/username";
import { useToast } from "@/components/Toast";
import { MONAD_CHAIN_NAME, MONAD_EXPLORER, MONAD_USDC, MONAD_USDC_DECIMALS } from "@/lib/monad/public";

/**
 * Move funds from a connected external wallet into the PayAI Wallet.
 *
 * This is the first thing a linked wallet is actually *for*: someone whose
 * money lives in MetaMask now has an account wallet that starts empty, and
 * copying an address between two wallets by hand is where people paste the
 * wrong thing. Both ends are known here, so neither address is ever typed.
 *
 * It is an ordinary transfer, signed by the external wallet — PayAI never
 * holds anything and the account wallet is only a destination.
 */

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Native sends must leave enough behind to pay for themselves. Matches the
 *  reserve the payment path checks against. */
const GAS_RESERVE_MON = 0.01;

type Phase = "idle" | "signing" | "confirming" | "done" | "error";

export function TopUpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallet = useWallet();
  const { toast } = useToast();
  useModalA11y(open, onClose);
  const balances = useWalletBalances(wallet.externalAddress);
  const [token, setToken] = useState<"MON" | "USDC">("MON");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const from = wallet.externalAddress;
  const to = wallet.accountAddress;
  const available = token === "MON" ? balances.mon : balances.usdc;

  const max = useMemo(() => {
    const bal = Number(available ?? 0);
    if (!Number.isFinite(bal) || bal <= 0) return 0;
    return token === "MON" ? Math.max(0, Number((bal - GAS_RESERVE_MON).toFixed(6))) : bal;
  }, [available, token]);

  const value = Number(amount);
  const overBalance = amount !== "" && Number.isFinite(value) && value > max;
  const canSend =
    !!from && !!to && Number.isFinite(value) && value > 0 && !overBalance && phase !== "signing" && phase !== "confirming";

  async function send() {
    if (!canSend || !from || !to) return;
    setError(null);
    setPhase("signing");
    try {
      const tx =
        token === "MON"
          ? { to, value: `0x${parseEther(amount).toString(16)}` }
          : {
              to: MONAD_USDC,
              data: encodeFunctionData({
                abi: ERC20_TRANSFER_ABI,
                functionName: "transfer",
                args: [to as `0x${string}`, parseUnits(amount, MONAD_USDC_DECIMALS)],
              }),
            };

      // Explicitly FROM the external wallet: the PayAI Wallet is the
      // destination here, so "whichever wallet is active" is the one thing
      // this must not use.
      const hash = await wallet.sendTransactionFrom("external", tx);
      setTxHash(hash);
      setPhase("confirming");
      await wallet.waitForReceipt(hash);
      setPhase("done");
      balances.refresh();
      announceTransaction();
      toast(`${amount} ${token} sent to your PayAI Wallet`);
    } catch (e) {
      setPhase("error");
      const message = e instanceof Error ? e.message : "The transfer didn't go through.";
      setError(/user rejected|denied/i.test(message) ? "Not sent — you cancelled it in your wallet." : message);
    }
  }

  function reset() {
    setAmount("");
    setPhase("idle");
    setTxHash(null);
    setError(null);
  }

  if (!open) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 px-4 sm:backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        role="dialog" aria-modal="true" aria-label="Add funds to your PayAI Wallet"
        initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm overflow-hidden rounded-2xl surface-purple shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <p className="text-sm font-semibold text-foreground">Add funds</p>
          <div className="flex items-center gap-2">
            <Badge tone="neutral"><span className="flex items-center gap-1"><MonadMark size={10} /> {MONAD_CHAIN_NAME}</span></Badge>
            <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted-foreground transition hover:bg-input hover:text-foreground">
              <X size={16} />
            </button>
          </div>
        </div>

        {phase === "done" ? (
          <div className="px-5 py-5">
            <div className="flex items-start justify-between gap-3">
              <AmountHero eyebrow="Sent" amount={amount} token={token} />
              <StatusText tone="success">Confirmed</StatusText>
            </div>
            <dl className="mt-3 divide-y divide-border/60 border-t border-border/60">
              <ReceiptRow label="Network">{MONAD_CHAIN_NAME}</ReceiptRow>
              {txHash && <ReceiptRow label="Transaction"><TxLink hash={txHash} href={`${MONAD_EXPLORER}/tx/${txHash}`} /></ReceiptRow>}
            </dl>
            <div className="mt-4 flex gap-2">
              <button onClick={reset} className="flex-1 rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-foreground transition hover:bg-input/40">
                Send more
              </button>
              <button onClick={onClose} className="flex-1 rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="px-5 py-5">
            {/* From → to, both known, so no address is ever typed. */}
            <div className="rounded-xl border border-border">
              <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                <KeyRound size={14} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] text-muted-foreground">From</span>
                  <span className="block truncate font-mono text-xs text-foreground">{from ? shortAddress(from) : "—"}</span>
                </span>
              </div>
              <div className="relative border-t border-border">
                <span className="absolute -top-2.5 left-4 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-panel text-muted-foreground">
                  <ArrowDown size={11} />
                </span>
              </div>
              <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                <Fingerprint size={14} className="shrink-0 text-primary-ink" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] text-muted-foreground">To your PayAI Wallet</span>
                  <span className="block truncate font-mono text-xs text-foreground">{to ? shortAddress(to) : "—"}</span>
                </span>
              </div>
            </div>

            <label className="mb-1.5 mt-4 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Amount
            </label>
            <div className="flex items-end gap-3 border-b border-border pb-3">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0.00"
                inputMode="decimal"
                className="w-full bg-transparent text-3xl font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground/40"
              />
              <div className="flex shrink-0 gap-1 rounded-full border border-border bg-input p-1">
                {(["MON", "USDC"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => { setToken(t); setAmount(""); }}
                    className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium transition ${
                      token === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <TokenLogo token={t} size={13} /> {t}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-2 flex items-center gap-2 text-xs">
              {balances.loading ? (
                <span className="text-muted-foreground">Reading balance…</span>
              ) : (
                <>
                  <span className={overBalance ? "text-danger" : "text-muted-foreground"}>
                    {available != null ? `${Number(available).toFixed(token === "MON" ? 4 : 2)} ${token} available` : "—"}
                  </span>
                  {max > 0 && (
                    <button
                      type="button"
                      onClick={() => setAmount(String(max))}
                      className="rounded-full border border-border px-2 py-0.5 font-medium text-primary-ink transition hover:border-primary/40"
                    >
                      Max
                    </button>
                  )}
                </>
              )}
            </div>
            {token === "MON" && max > 0 && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Max leaves {GAS_RESERVE_MON} MON behind to cover the network fee.
              </p>
            )}
            {error && <p className="mt-3 text-xs text-danger">{error}</p>}

            <button
              onClick={send}
              disabled={!canSend}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {(phase === "signing" || phase === "confirming") && <Loader2 size={14} className="animate-spin" />}
              {phase === "signing" ? "Confirm in your wallet…" : phase === "confirming" ? "Confirming…" : "Send to PayAI Wallet"}
            </button>
            <p className="mt-3 text-center text-[11px] leading-relaxed text-muted-foreground">
              Signed by your connected wallet. PayAI never holds your funds.
            </p>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
