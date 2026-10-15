"use client";

import { Suspense } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { MonadMark } from "@/components/MonadMark";
import { ExportWalletCard } from "@/components/dashboard/ExportWalletCard";
import { UsernameCard } from "@/components/dashboard/UsernameCard";
import { GoogleLinkCard } from "@/components/dashboard/GoogleLinkCard";
import { PageHeader, StatusIndicator } from "@/components/dashboard/primitives";
import { ThemePicker } from "@/components/ThemeToggle";

/** Settings is wallet-only, matching the rest of the product — there is no
 *  separate account/API-key system to sign into. It is grouped only by the
 *  categories that have real settings behind them today: Account, Sign-in,
 *  Appearance, Wallet and Security.
 *  Linked-wallet management is the Wallets tab next to this one. */
export default function Settings() {
  const wallet = useWallet();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="General" description="Your account is your wallet. A passkey is enough — Google is optional." />

      <SettingsSection id="account" title="Account">
        <Row
          label="Wallet"
          value={wallet.address
            ? <span className="font-mono">{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span>
            : <span className="text-muted-foreground">Connect a wallet to see your account here.</span>}
          detail={wallet.address ? (wallet.kind === "embedded" ? "PayAI Wallet — secured by your passkey" : "Connected wallet") : undefined}
          right={wallet.address ? <StatusIndicator tone="success" label="Active" /> : null}
        />
        <UsernameCard />
      </SettingsSection>

      <SettingsSection id="sign-in" title="Sign-in">
        <Suspense fallback={null}>
          <GoogleLinkCard />
        </Suspense>
      </SettingsSection>

      <SettingsSection id="appearance" title="Appearance">
        <Row
          label="Theme"
          value="Choose how PayAI looks"
          detail="Dark is the default. Light is white with PayAI purple. System follows your device."
          right={<ThemePicker />}
        />
      </SettingsSection>

      <SettingsSection id="wallet" title="Wallet">
        <Row
          label="Network"
          value={<span className="flex items-center gap-2"><MonadMark size={14} /> Monad Mainnet</span>}
          detail="All payments and automations settle here."
        />
        <Link href="/dashboard/wallets" className="group flex items-center justify-between gap-3 border-b border-border pb-4 text-sm transition-colors hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span>
            <span className="block text-foreground">Linked wallets</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">Add, switch and recover the wallets on your account.</span>
          </span>
          <ArrowRight size={15} aria-hidden className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </Link>
      </SettingsSection>

      <SettingsSection id="security" title="Security">
        <ExportWalletCard />
        <p className="text-sm text-muted-foreground">
          PayAI never asks for your seed phrase or private key. Your payments, automations and activity are scoped to your connected wallet address only.{" "}
          <Link href="/security" className="rounded-sm text-foreground underline decoration-border underline-offset-4 hover:decoration-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">How PayAI keeps your wallet safe</Link>
        </p>
      </SettingsSection>

      <SettingsSection id="support" title="Support">
        <Link href="/dashboard/help?tab=support" className="group flex items-center justify-between gap-3 border-b border-border pb-4 text-sm transition-colors hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span>
            <span className="block text-foreground">Report a problem or ask a question</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">Failed automations, missing refunds, payments, or your wallet.</span>
          </span>
          <ArrowRight size={15} aria-hidden className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </Link>
      </SettingsSection>
    </div>
  );
}

function SettingsSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`settings-${id}`} className="border-t border-border py-6 first-of-type:border-t-0 first-of-type:pt-0 [&:has(>div:empty)]:hidden">
      <h2 id={`settings-${id}`} className="mb-4 text-sm font-semibold text-foreground">{title}</h2>
      {/* The existing cards carry their own bottom margin; the last one's is
          absorbed here. A section whose only card renders nothing for this
          wallet (Google sign-in, for an external wallet) hides itself. */}
      <div className="space-y-4 [&>*:last-child]:mb-0">{children}</div>
    </section>
  );
}

function Row({ label, value, detail, right }: { label: string; value: React.ReactNode; detail?: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-0.5 text-sm text-foreground">{value}</div>
        {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
      </div>
      {right}
    </div>
  );
}
