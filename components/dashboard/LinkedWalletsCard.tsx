"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowDownToLine, Check, KeyRound, Link2, Loader2, Plus, Unlink } from "lucide-react";
import { Card } from "@/components/ui";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { shortAddress } from "@/lib/platform/username";
import { useToast } from "@/components/Toast";
import dynamic from "next/dynamic";

const TopUpModal = dynamic(() => import("@/components/dashboard/TopUpModal").then((m) => m.TopUpModal), { ssr: false });

/**
 * External wallets attached to this PayAI account.
 *
 * A linked wallet is a convenience record and says so plainly — it grants
 * nothing, and neither wallet can spend from the other. What it buys is that
 * both stay reachable: the account no longer disappears the moment MetaMask
 * connects, and moving funds between the two never involves copying an
 * address by hand.
 *
 * Linking costs two approvals, which is stated up front rather than sprung on
 * the user halfway through: the external wallet proves it is theirs, and the
 * passkey proves they meant to attach it to this account.
 */
export function LinkedWalletsCard() {
  const wallet = useWallet();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [topUpOpen, setTopUpOpen] = useState(false);

  // Only an unlocked PayAI Wallet can sign the link, and only it has an
  // account for wallets to be linked *to*.
  const account = wallet.accountAddress;
  if (!account) return null;

  const external = wallet.externalAddress;
  const linkedHere = external
    ? wallet.linkedWallets.find((w) => w.address.toLowerCase() === external.toLowerCase())
    : undefined;
  const connectedButUnlinked = !!external && !linkedHere;

  async function link() {
    setError(null);
    setBusy("link");
    try {
      await wallet.linkExternalWallet();
      toast("Wallet linked to your account");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not link that wallet.");
    } finally {
      setBusy(null);
    }
  }

  async function unlink(address: string) {
    setError(null);
    setBusy(address);
    try {
      await wallet.unlinkWallet(address);
      toast("Wallet removed from your account");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove that wallet.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
          <Link2 size={14} />
        </span>
        <p className="text-sm font-semibold text-foreground">Linked wallets</p>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        Keep an external wallet alongside your PayAI Wallet and move between them
        whenever you like. Linking grants nothing — neither wallet can spend from
        the other.
      </p>

      {wallet.linkedLoading && wallet.linkedWallets.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-border px-3.5 py-3 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> Loading your wallets…
        </div>
      ) : wallet.linkedWallets.length > 0 ? (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {wallet.linkedWallets.map((w) => {
              const isConnected = external?.toLowerCase() === w.address.toLowerCase();
              return (
                <motion.li
                  key={w.address}
                  initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}
                  className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3"
                >
                  <KeyRound size={14} className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-xs font-medium text-foreground">
                      {w.label}
                      {isConnected && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-success/12 px-1.5 py-0.5 text-[10px] font-medium text-success">
                          <Check size={9} /> Connected
                        </span>
                      )}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{shortAddress(w.address)}</p>
                  </div>
                  {isConnected && (
                    <button
                      onClick={() => setTopUpOpen(true)}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ArrowDownToLine size={12} /> Add funds
                    </button>
                  )}
                  <button
                    onClick={() => unlink(w.address)}
                    disabled={busy === w.address}
                    aria-label={`Unlink ${w.label}`}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-danger/10 hover:text-danger disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {busy === w.address ? <Loader2 size={13} className="animate-spin" /> : <Unlink size={13} />}
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-3.5 py-4 text-center">
          <p className="text-xs text-muted-foreground">No wallets linked yet.</p>
        </div>
      )}

      {connectedButUnlinked ? (
        <div className="mt-3 rounded-xl border border-primary/25 bg-primary/[0.04] px-3.5 py-3">
          <p className="text-xs font-medium text-foreground">
            {shortAddress(external!)} is connected but not linked
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Linking takes two approvals: one in that wallet, one with your passkey.
            Both prove the wallet and the account belong to you.
          </p>
          <button
            onClick={link}
            disabled={busy === "link"}
            className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
          >
            {busy === "link" ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            {busy === "link" ? "Approving…" : "Link this wallet"}
          </button>
        </div>
      ) : !external ? (
        <a
          href="/connect"
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary-ink hover:underline"
        >
          <Plus size={12} /> Connect a wallet to link
        </a>
      ) : null}

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}

      <TopUpModal open={topUpOpen} onClose={() => setTopUpOpen(false)} />
    </Card>
  );
}
