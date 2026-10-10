"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowDownToLine, Check, Copy, ExternalLink, Fingerprint, KeyRound, Loader2,
  Pencil, Plus, Repeat, Send, Unlink, X,
} from "lucide-react";
import { Card } from "@/components/ui";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { shortAddress } from "@/lib/platform/username";
import { useToast } from "@/components/Toast";
import { useCopy } from "@/lib/hooks/useCopy";
import { MONAD_CHAIN_NAME, MONAD_EXPLORER } from "@/lib/monad/public";
import dynamic from "next/dynamic";
import { AddWalletModal } from "@/components/dashboard/AddWalletModal";

const TopUpModal = dynamic(() => import("@/components/dashboard/TopUpModal").then((m) => m.TopUpModal), { ssr: false });

/**
 * Wallet Manager — every wallet on this account, what each is for, and which
 * one moves money.
 *
 * Two defaults, deliberately separate. A one-off payment is something you are
 * watching happen; an automation runs at 3am while you are asleep. Letting the
 * second inherit a choice you made for the first — or worse, inherit whichever
 * wallet happened to be active when you filled in a form — is how a recurring
 * payment ends up drawing from a wallet its owner never intended. PayAI never
 * switches wallets on its own; these are the only place that decision is made.
 *
 * "Last connected" is a record, not a live status. A linked wallet is an entry
 * in a list, not an open session, and saying otherwise would imply PayAI can
 * reach a wallet it cannot.
 */

type Busy = null | { kind: "rename" | "unlink" | "default"; key: string };

function ago(ms?: number): string {
  if (!ms) return "Not seen yet";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "Just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function WalletManager() {
  const wallet = useWallet();
  const { toast } = useToast();
  const [busy, setBusy] = useState<Busy>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const { copy, copied } = useCopy();
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [defaults, setDefaults] = useState<{ payment: string | null; automation: string | null }>({
    payment: null, automation: null,
  });

  const account = wallet.accountAddress;
  const external = wallet.externalAddress;

  // Report the connected wallet on the read so "last connected" stays honest
  // without a heartbeat nobody would trust.
  useEffect(() => {
    if (!account) return;
    const q = external ? `&connected=${external}` : "";
    fetch(`/api/linked-wallets?account=${account}${q}`)
      .then((r) => r.json())
      .then((j) => { if (j?.defaults) setDefaults(j.defaults); })
      .catch(() => {});
  }, [account, external, wallet.linkedWallets.length]);

  const rows = useMemo(() => {
    if (!account) return [];
    return [
      {
        address: account,
        label: "PayAI Wallet",
        type: "Embedded · passkey",
        icon: Fingerprint,
        primary: true,
        linked: true,
        lastConnectedAt: undefined as number | undefined,
      },
      ...wallet.linkedWallets.map((w) => ({
        address: w.address,
        label: w.label,
        type: "External · self-custody",
        icon: KeyRound,
        primary: false,
        linked: true,
        lastConnectedAt: w.lastConnectedAt,
      })),
    ];
  }, [account, wallet.linkedWallets]);

  /** Every settings change is signed by the account — see the API route. */
  async function patch(body: Record<string, unknown>, label: string) {
    if (!account) return;
    setError(null);
    try {
      const { walletSettingsMessage } = await import("@/lib/platform/linkMessages");
      const payload = { account, ...body };
      const accountSignature = await wallet.signMessage(walletSettingsMessage(account, payload));
      const r = await fetch("/api/linked-wallets", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, accountSignature }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not save that.");
      if (j?.defaults) setDefaults(j.defaults);
      toast(label);
      return j;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that.");
    }
  }

  async function saveRename(address: string) {
    const label = draft.trim();
    if (!label) return;
    setBusy({ kind: "rename", key: address });
    await patch({ rename: { external: address, label } }, "Wallet renamed");
    await wallet.refreshLinkedWallets();
    setEditing(null);
    setBusy(null);
  }

  async function setDefault(kind: "payment" | "automation", address: string | null) {
    setBusy({ kind: "default", key: `${kind}:${address ?? "none"}` });
    await patch({ defaults: { [kind]: address } }, `Default ${kind} wallet updated`);
    setBusy(null);
  }

  async function unlink(address: string) {
    setBusy({ kind: "unlink", key: address });
    setError(null);
    try {
      await wallet.unlinkWallet(address);
      toast("Wallet removed from your account");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove that wallet.");
    }
    setBusy(null);
  }

  if (!account) return null;

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
          <KeyRound size={14} />
        </span>
        <p className="text-sm font-semibold text-foreground">Wallet manager</p>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        Every wallet on this account, and which one moves money. PayAI never
        switches wallets on its own — these choices are yours.
      </p>

      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {rows.map((row) => {
            const Icon = row.icon;
            const isConnected = external?.toLowerCase() === row.address.toLowerCase();
            const isActive = wallet.activeKind === (row.primary ? "embedded" : "external") && (row.primary || isConnected);
            const isPaymentDefault = defaults.payment?.toLowerCase() === row.address.toLowerCase();
            const isAutomationDefault = defaults.automation?.toLowerCase() === row.address.toLowerCase();

            return (
              <motion.li
                key={row.address}
                layout
                initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}
                className="rounded-xl border border-border px-3.5 py-3"
              >
                <div className="flex items-start gap-3">
                  <Icon size={15} className={`mt-0.5 shrink-0 ${row.primary ? "text-primary-ink" : "text-muted-foreground"}`} />
                  <div className="min-w-0 flex-1">
                    {editing === row.address ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          value={draft}
                          onChange={(e) => setDraft(e.target.value.slice(0, 32))}
                          onKeyDown={(e) => { if (e.key === "Enter") void saveRename(row.address); if (e.key === "Escape") setEditing(null); }}
                          autoFocus
                          aria-label="Wallet name"
                          className="min-w-0 flex-1 rounded-md border border-border bg-input px-2 py-1 text-base text-foreground outline-none focus:border-primary/40 sm:text-xs"
                        />
                        <button onClick={() => void saveRename(row.address)} aria-label="Save name" className="rounded-md p-1 text-success transition hover:bg-input">
                          {busy?.kind === "rename" && busy.key === row.address ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                        </button>
                        <button onClick={() => setEditing(null)} aria-label="Cancel" className="rounded-md p-1 text-muted-foreground transition hover:bg-input">
                          <X size={13} />
                        </button>
                      </div>
                    ) : (
                      <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-foreground">
                        {row.label}
                        {row.primary && (
                          <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[9px] font-medium text-primary-ink">Primary</span>
                        )}
                        {isActive && (
                          <span className="rounded-full bg-success/12 px-1.5 py-0.5 text-[9px] font-medium text-success">Active</span>
                        )}
                        {!row.primary && (
                          <button
                            onClick={() => { setEditing(row.address); setDraft(row.label); }}
                            aria-label={`Rename ${row.label}`}
                            className="rounded p-0.5 text-muted-foreground transition hover:text-foreground"
                          >
                            <Pencil size={10} />
                          </button>
                        )}
                      </p>
                    )}
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {shortAddress(row.address)}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {row.type} · {MONAD_CHAIN_NAME}
                      {!row.primary && ` · ${isConnected ? "Connected now" : ago(row.lastConnectedAt)}`}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <button onClick={() => void copy(row.address, "Address copied")} aria-label="Copy address" className="rounded-md p-1.5 text-muted-foreground transition hover:bg-input hover:text-foreground">
                      {copied === row.address ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                    </button>
                    <a
                      href={`${MONAD_EXPLORER}/address/${row.address}`} target="_blank" rel="noreferrer"
                      aria-label="View on explorer"
                      className="rounded-md p-1.5 text-muted-foreground transition hover:bg-input hover:text-foreground"
                    >
                      <ExternalLink size={12} />
                    </a>
                    {!row.primary && (
                      <button
                        onClick={() => void unlink(row.address)}
                        disabled={busy?.kind === "unlink" && busy.key === row.address}
                        aria-label={`Unlink ${row.label}`}
                        className="rounded-md p-1.5 text-muted-foreground transition hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                      >
                        {busy?.kind === "unlink" && busy.key === row.address ? <Loader2 size={12} className="animate-spin" /> : <Unlink size={12} />}
                      </button>
                    )}
                  </div>
                </div>

                {/* What this wallet is for. Two independent choices, because a
                    payment you watch and an automation that runs unattended
                    are not the same decision. */}
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-border pt-2.5">
                  <button
                    onClick={() => void setDefault("payment", isPaymentDefault ? null : row.address)}
                    disabled={busy?.kind === "default"}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition disabled:opacity-50 ${
                      isPaymentDefault ? "border-primary/40 bg-primary/10 text-primary-ink" : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Send size={9} /> {isPaymentDefault ? "Default for payments" : "Use for payments"}
                  </button>
                  <button
                    onClick={() => void setDefault("automation", isAutomationDefault ? null : row.address)}
                    disabled={busy?.kind === "default"}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition disabled:opacity-50 ${
                      isAutomationDefault ? "border-primary/40 bg-primary/10 text-primary-ink" : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Repeat size={9} /> {isAutomationDefault ? "Default for automations" : "Use for automations"}
                  </button>
                  {isConnected && (
                    <button
                      onClick={() => setTopUpOpen(true)}
                      className="ml-auto inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-foreground transition hover:border-primary/40"
                    >
                      <ArrowDownToLine size={9} /> Move to PayAI Wallet
                    </button>
                  )}
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      {!external && (
        // In place (AddWalletModal): a link to /connect ended the passkey
        // session and dropped the user into the external wallet instead.
        <button type="button" onClick={() => setAddOpen(true)} className="mt-3 inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Plus size={12} /> Connect another wallet
        </button>
      )}
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      <AddWalletModal open={addOpen} onClose={() => setAddOpen(false)} />

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Defaults decide which wallet is proposed — never which one signs. Every
        payment still shows you the wallet it will come from before you approve.
      </p>

      <TopUpModal open={topUpOpen} onClose={() => setTopUpOpen(false)} />
    </Card>
  );
}
