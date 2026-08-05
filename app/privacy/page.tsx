import Link from "next/link";
import { Lock } from "lucide-react";
import { Logo } from "@/components/Logo";

const SECTIONS = [
  {
    title: "Non-custodial by design",
    body: "PayAI is a non-custodial interface to smart contracts on Monad. We never hold your funds and never have access to your private keys or seed phrase. Every payment is signed by your own wallet.",
  },
  {
    title: "On-chain data is public",
    body: "Wallet addresses, transaction amounts, and payment status are public on-chain data, visible to anyone via the Monad block explorer, independent of this app.",
  },
  {
    title: "Merchant workspaces",
    body: "If you create a merchant workspace, we store the workspace name and an API key locally in your browser and on our server to associate your payment links and on-chain registrations with your account. We do not sell or share this data with third parties.",
  },
  {
    title: "No tracking on the dashboard",
    body: "The dashboard reads balances and transaction history directly from Monad RPC nodes and the PaymentExecutor contract. No separate tracking or analytics pixels are used on dashboard pages.",
  },
];

export default function Privacy() {
  return (
    <main className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2"><Logo size={28} /><span className="text-sm font-semibold text-foreground">PayAI</span></Link>
        <Link href="/" className="text-sm text-muted-foreground transition-colors hover:text-foreground">Back to home</Link>
      </header>

      <div className="mx-auto max-w-3xl px-6 pb-20 pt-6">
        <div className="mb-8">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink"><Lock size={24} /></div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Privacy</h1>
          <p className="mt-2 text-xs text-muted-foreground">Last updated July 2026</p>
        </div>

        <div className="space-y-3">
          {SECTIONS.map((s) => (
            <section key={s.title} className="rounded-xl border border-border bg-panel p-5">
              <h2 className="text-sm font-semibold text-foreground">{s.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </section>
          ))}
        </div>

        <p className="mt-8 text-xs text-muted-foreground">
          Questions? <a href="mailto:privacy@usepayai.xyz" className="text-primary-ink hover:underline">Email us</a>. See also our{" "}
          <Link href="/terms" className="text-primary-ink hover:underline">Terms</Link> and{" "}
          <Link href="/security" className="text-primary-ink hover:underline">Security</Link> pages.
        </p>
      </div>
    </main>
  );
}
