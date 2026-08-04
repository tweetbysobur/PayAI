"use client";

import { useState } from "react";
import { decodeEventLog, encodeFunctionData, isHex, keccak256, stringToHex, type Hex } from "viem";
import { LifeBuoy, ExternalLink } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { AUTOMATION_VAULT_ABI } from "@/lib/monad/abi";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import type { WalletState } from "@/lib/wallet/useWallet";

/**
 * Recovery for reserved funds whose automation record no longer exists.
 *
 * WHY THIS IS NEEDED — the creation flow reserves on-chain BEFORE it saves
 * the automation:
 *
 *   1. browser calls AutomationVault.reserve()   <- money moves here
 *   2. browser POSTs /api/automations            <- record created here
 *
 * If step 2 fails (validation, a dropped request, a closed tab) the funds are
 * already in the vault while no record was ever written. refund() needs the
 * automationId, and that id only ever existed in the tab that generated it —
 * so on reload the money is stranded with no handle. Hard-deleting an
 * automation (deleteSchedule removes the row outright) strands it the same way.
 *
 * The id is not actually lost, though: reserve() emits
 * Reserved(automationId indexed, depositor indexed, ...), so the id is
 * permanently readable from the reserve transaction's own receipt. This tool
 * takes that transaction hash, decodes the id out of the event, checks the
 * live balance, and refunds it.
 *
 * Accepts a raw bytes32 automationId too, for anyone who already has it.
 *
 * The refund is sent from the user's own wallet — the vault authorizes
 * `msg.sender == r.depositor`, so recovery never depends on PayAI.
 */

type Found = { automationId: Hex; balance: string; token: string; recipient: string; depositor: string };

async function confirmTx(wallet: WalletState, to: string, data: string): Promise<string> {
  const hash = await wallet.sendTransaction({ to, data });
  const receipt = (await wallet.waitForReceipt(hash)) as { status?: string } | null;
  if (receipt && receipt.status !== "success") throw new Error("The refund transaction failed on-chain.");
  return hash;
}

export function ReservationRecovery({ vault, explorerBase }: { vault: string | null; explorerBase: string }) {
  const wallet = useWallet();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!vault) return null;
  // Narrowed local: the early return above doesn't narrow `vault` inside the
  // async closures below.
  const vaultAddr: string = vault;

  async function check() {
    const raw = input.trim();
    if (!raw) return;
    setChecking(true); setError(null); setFound(null);
    try {
      const { getBrowserPublicClient } = await import("@/lib/monad/browserClient");
      const client = await getBrowserPublicClient();

      // Work out the automationId.
      //
      // A transaction hash and a bytes32 automationId are BOTH 32 bytes, so
      // they are indistinguishable by length — an earlier version keyed off
      // `length === 66` and therefore treated every pasted reserve tx hash as
      // an id, looked up a reservation that never existed, and told the user
      // "no reservation exists" while their funds sat in the vault. There is
      // no way to tell them apart by inspection, so try both: resolve as a
      // transaction first (that is what users are told to paste), and fall
      // back to treating the same string as an id.
      let automationId: Hex | null = null;
      if (isHex(raw) && raw.length === 42) {
        setError("That looks like a wallet address. Paste the reserve transaction hash instead.");
        return;
      } else if (isHex(raw) && raw.length === 66) {
        try {
          const receipt = await client.getTransactionReceipt({ hash: raw as Hex });
          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== vaultAddr.toLowerCase()) continue;
            try {
              const d = decodeEventLog({ abi: AUTOMATION_VAULT_ABI, data: log.data, topics: log.topics });
              if (d.eventName === "Reserved") {
                automationId = (d.args as unknown as { automationId: Hex }).automationId;
                break;
              }
            } catch { /* not the Reserved event */ }
          }
        } catch {
          /* Not a transaction on this chain — fall through and try it as an id. */
        }
        // Either it wasn't a tx, or it was a tx with no Reserved event. Either
        // way the same 32 bytes may still be a valid reservation id.
        if (!automationId) automationId = raw as Hex;
      } else if (/^sch_[a-zA-Z0-9-]{8,}$/.test(raw)) {
        // The app's own id format — hashed the same way the creation flow did.
        automationId = keccak256(stringToHex(raw));
      } else {
        setError("Paste the reserve transaction hash, or the automation id if you have it.");
        return;
      }

      const r = (await client.readContract({
        address: vaultAddr as Hex, abi: AUTOMATION_VAULT_ABI, functionName: "reservations", args: [automationId],
      })) as readonly [string, string, string, bigint, boolean];
      const [depositor, token, recipient, balance, exists] = r;

      if (!exists) {
        setError(
          "No reservation found. If you pasted a transaction hash, check it's the transaction that reserved the funds (the one that sent MON to the vault) and that it succeeded.",
        );
        return;
      }
      if (balance === 0n) { setError("That reservation has already been fully released or refunded."); return; }
      if (wallet.address && depositor.toLowerCase() !== wallet.address.toLowerCase()) {
        setError(`These funds were reserved by ${depositor.slice(0, 8)}…${depositor.slice(-6)}. Only that wallet can refund them.`);
        return;
      }

      const isNative = /^0x0+$/.test(token);
      setFound({
        automationId,
        // Native MON is 18dp. A non-native token's decimals are read below only
        // for display; the refund itself moves the full on-chain balance
        // regardless, so an unknown-decimals token can still be recovered.
        balance: isNative ? (Number(balance) / 1e18).toString() : balance.toString(),
        token: isNative ? "MON" : token,
        recipient, depositor,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not look that up.");
    } finally {
      setChecking(false);
    }
  }

  async function refund() {
    if (!found || !wallet.address) return;
    setRefunding(true);
    try {
      if (wallet.isWrongNetwork) await wallet.switchNetwork();
      const data = encodeFunctionData({ abi: AUTOMATION_VAULT_ABI, functionName: "refund", args: [found.automationId] });
      const hash = await confirmTx(wallet, vaultAddr, data);
      toast("Reserved funds refunded to your wallet");
      setFound(null); setInput("");
      window.open(`${explorerBase}/tx/${hash}`, "_blank", "noreferrer");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Refund failed");
    } finally {
      setRefunding(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-panel/40 p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 text-left"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary-ink">
          <LifeBuoy size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">Recover reserved funds</span>
          <span className="block text-xs text-muted-foreground">
            For funds still in the vault from an automation that was never created, or was deleted.
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{open ? "Hide" : "Open"}</span>
      </button>

      {open && (
        <div className="mt-4 border-t border-border/60 pt-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Paste the transaction that reserved the funds. PayAI reads the reservation id from that
            transaction&apos;s on-chain event, then refunds it to the wallet that deposited it.
            You can also paste an automation id directly.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              value={input}
              onChange={(e) => { setInput(e.target.value); setError(null); setFound(null); }}
              placeholder="0x… reserve transaction hash"
              className="w-full font-mono text-xs"
            />
            <Button variant="secondary" onClick={check} disabled={checking || !input.trim()} className="shrink-0">
              {checking ? "Checking…" : "Check"}
            </Button>
          </div>

          {error && <p className="mt-2.5 text-xs text-danger">{error}</p>}

          {found && (
            <div className="mt-3 rounded-lg border border-exec-scheduled/35 bg-exec-scheduled/[0.07] p-3.5">
              <p className="text-sm font-semibold text-foreground">
                {Number(found.balance).toLocaleString(undefined, { maximumFractionDigits: 6 })}{" "}
                {found.token === "MON" ? "MON" : "tokens"} available to refund
              </p>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                Reservation {found.automationId.slice(0, 12)}…{found.automationId.slice(-8)}
              </p>
              {found.token !== "MON" && (
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Token {found.token}</p>
              )}
              <Button onClick={refund} disabled={refunding} className="mt-3 w-full sm:w-auto">
                {refunding ? "Refunding…" : "Refund to my wallet"}
              </Button>
            </div>
          )}

          <a
            href={`${explorerBase}/address/${vault}`}
            target="_blank" rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs text-primary-ink hover:underline"
          >
            View the vault contract <ExternalLink size={11} />
          </a>
        </div>
      )}
    </div>
  );
}
