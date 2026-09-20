import Link from "next/link";
import { Lock } from "lucide-react";
import { Logo } from "@/components/Logo";

const SECTIONS = [
  {
    title: "Who we are",
    body: "UsePayAI operates the PayAI product at usepayai.xyz. We are not affiliated with PayAI Network, payai.network, or the $PAYAI token. Questions: privacy@usepayai.xyz.",
  },
  {
    title: "Interactive payments are non-custodial",
    body: "In the browser app, PayAI is an interface to smart contracts on Monad. We never take the seed phrase of an embedded (passkey) or external wallet. Every interactive payment is signed by your own wallet. Payment Automations are the first exception: a dedicated agent wallet, capped on-chain, settles runs you already authorized. Reserved Funds sit in AutomationVault on-chain, not on our servers.",
  },
  {
    title: "Telegram bot is custodial",
    body: "If you use the PayAI Telegram trading bot, we generate a hot wallet for that Telegram user and store the private key encrypted at rest so the bot can sign trades and withdrawals from chat. That is custody. Do not deposit more than you are willing to trust to a bot. You can withdraw to your own address at any time.",
  },
  {
    title: "On-chain data is public",
    body: "Wallet addresses, transaction amounts, and payment status are public on-chain data, visible to anyone via the Monad block explorer, independent of this app.",
  },
  {
    title: "What we store off-chain",
    body: "If you create an account or merchant workspace, we store what is needed to run the product: session cookie, workspace name, API key, automations, activity, support tickets, and (for the Telegram bot) an encrypted wallet key. We do not sell this data. Persistence uses a hosted Redis when configured.",
  },
  {
    title: "Analytics",
    body: "Marketing pages may load Google Analytics when a measurement ID is configured, so we can see whether the public site is used. Dashboard routes do not load that script. The dashboard still reads balances and history from Monad RPC and PayAI contracts — that is product data, not an ad pixel.",
  },
  {
    title: "AI parsing",
    body: "If you type a natural-language instruction, the text may be sent to an LLM provider (Anthropic) to parse intent. Do not paste secrets, seed phrases, or private keys into Ask PayAI.",
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
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center text-primary"><Lock size={30} /></div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Privacy</h1>
          <p className="mt-2 text-xs text-muted-foreground">Last updated September 2026</p>
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
