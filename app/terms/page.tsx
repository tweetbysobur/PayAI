import Link from "next/link";
import { ScrollText } from "lucide-react";
import { Logo } from "@/components/Logo";

const SECTIONS = [
  {
    title: "Provided as-is, your responsibility",
    body: "PayAI is provided as-is, without warranty of any kind. You are solely responsible for the wallet you connect and every transaction it signs. PayAI cannot reverse, cancel, or recover a transaction once it is broadcast to Monad.",
  },
  {
    title: "On-chain execution is final",
    body: "Smart contract execution (PaymentExecutor, MerchantRegistry) is final and governed by the code deployed on-chain, not by this interface. Always verify the recipient address and amount in your wallet before approving a transaction.",
  },
  {
    title: "No custody, no advice",
    body: "PayAI does not custody funds, provide investment advice, or guarantee uptime of third-party RPC providers, wallets, or the Monad network itself.",
  },
  {
    title: "Your compliance",
    body: "By using PayAI you confirm you are responsible for complying with the laws applicable to you when sending or receiving on-chain payments.",
  },
];

export default function Terms() {
  return (
    <main className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2"><Logo size={28} /><span className="text-sm font-semibold text-foreground">PayAI</span></Link>
        <Link href="/" className="text-sm text-muted-foreground transition-colors hover:text-foreground">Back to home</Link>
      </header>

      <div className="mx-auto max-w-3xl px-6 pb-20 pt-6">
        <div className="mb-8">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink"><ScrollText size={24} /></div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Terms</h1>
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
          Questions? <a href="mailto:buharisobur22@gmail.com" className="text-primary-ink hover:underline">Email us</a>. See also our{" "}
          <Link href="/privacy" className="text-primary-ink hover:underline">Privacy</Link> and{" "}
          <Link href="/security" className="text-primary-ink hover:underline">Security</Link> pages.
        </p>
      </div>
    </main>
  );
}
