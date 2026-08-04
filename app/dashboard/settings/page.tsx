"use client";

import Link from "next/link";
import { Wallet, ShieldCheck, LifeBuoy, ArrowRight } from "lucide-react";
import { Card, Badge } from "@/components/ui";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { MonadMark } from "@/components/MonadMark";
import { ExportWalletCard } from "@/components/dashboard/ExportWalletCard";

/** Settings is wallet-only, matching the rest of the product — there is no
 *  separate account/API-key system to sign into. Everything here reflects
 *  the connected wallet's own identity and network. */
export default function Settings() {
  const wallet = useWallet();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
      <p className="mb-6 text-sm text-muted-foreground">Your account is your wallet — nothing else to sign in to.</p>

      <Card title="Account" className="mb-4">
        {wallet.address ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><Wallet size={18} /></div>
              <div>
                <p className="font-mono text-sm text-foreground">{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</p>
                <p className="text-xs text-muted-foreground">
                  {wallet.kind === "embedded" ? "PayAI Wallet — secured by your passkey" : "Connected wallet"}
                </p>
              </div>
            </div>
            <Badge tone="success">Active</Badge>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Connect a wallet to see your account here.</p>
        )}
      </Card>

      <Card title="Network">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><MonadMark size={18} /></div>
          <div>
            <p className="text-sm text-foreground">Monad Mainnet</p>
            <p className="text-xs text-muted-foreground">All payments and automations settle here.</p>
          </div>
        </div>
      </Card>

      <ExportWalletCard />

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent p-4 text-xs text-muted-foreground">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-primary-ink" />
        <p>PayAI never asks for your seed phrase or private key. Your data — payments, automations, activity — is scoped to your connected wallet address only.</p>
      </div>

      <Card title="Support" className="mt-4">
        <Link href="/dashboard/support" className="flex items-center justify-between gap-3 rounded-lg transition-colors hover:bg-input/40">
          <div className="flex items-center gap-3 p-1">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><LifeBuoy size={18} /></div>
            <div>
              <p className="text-sm text-foreground">Report a problem or ask a question</p>
              <p className="text-xs text-muted-foreground">Failed automations, missing refunds, payments, or your wallet.</p>
            </div>
          </div>
          <ArrowRight size={15} className="mr-1 shrink-0 text-muted-foreground" />
        </Link>
      </Card>
    </div>
  );
}
