import Link from "next/link";
import { ScrollText } from "lucide-react";
import { Logo } from "@/components/Logo";

const SECTIONS = [
  {
    title: "Who this is",
    body: "These terms cover the PayAI product at usepayai.xyz, operated by UsePayAI. PayAI is not affiliated with PayAI Network, payai.network, or the $PAYAI token. By using the app you agree to these terms.",
  },
  {
    title: "Provided as-is, your responsibility",
    body: "PayAI is provided as-is, without warranty of any kind. You are solely responsible for the wallet you connect and every transaction it signs. Smart-contract execution is final. PayAI cannot reverse, cancel, or recover a transaction once it is broadcast to Monad.",
  },
  {
    title: "On-chain execution is final",
    body: "Settlement is governed by the contracts deployed on Monad (PaymentExecutor, PayAIForwarder, AutomationVault, MerchantRegistry, PayAITradeExecutor, and their current versions), not by this interface. Always verify the recipient, asset, amount, and fee in your wallet before approving.",
  },
  {
    title: "Custody",
    body: "Interactive payments and trades in the web app are non-custodial: your wallet signs. Payment Automations use a capped on-chain agent and, for Reserved Funds, an isolated vault — still contract-bounded, not a PayAI hot wallet holding your balance. The Telegram trading bot is custodial: UsePayAI generates and holds an encrypted key for that chat so it can sign. Use of the bot is optional and at your own risk.",
  },
  {
    title: "Fees",
    body: "PayAI currently charges a 0.25% platform fee (25 basis points) on send-payment, Wallet Automation, and Reserved Funds executions, taken on-chain from the gross amount, with the remainder delivered to the recipient. Swaps currently have no platform fee. Monad network gas is always paid by the signer. The on-chain fee cannot exceed 1.00%. Live rates are at /api/fees and shown in the confirmation screen before you sign. Rates can change; the rate in the confirmation you signed is the rate that applies to that transaction.",
  },
  {
    title: "No advice, no guaranteed uptime",
    body: "PayAI does not provide investment, legal, or tax advice, and does not guarantee uptime of third-party RPC providers, wallets, LLM providers, Telegram, or the Monad network itself.",
  },
  {
    title: "Your compliance",
    body: "You are responsible for complying with the laws that apply to you when sending, receiving, automating, or trading on-chain. Recipients are screened against the OFAC SDN digital-currency address list. That is not a licensed KYC/AML programme and does not make a payment legal in your jurisdiction.",
  },
  {
    title: "Limitation of liability",
    body: "To the maximum extent permitted by law, UsePayAI is not liable for lost funds, failed or delayed transactions, smart-contract bugs, key compromise (including of a Telegram bot wallet or the automation agent), RPC faults, or any indirect, incidental, or consequential damages. On-chain transfers are irreversible.",
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
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center text-primary"><ScrollText size={30} /></div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Terms</h1>
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
          Questions? <a href="mailto:support@usepayai.xyz" className="text-primary-ink hover:underline">Email us</a>. See also our{" "}
          <Link href="/privacy" className="text-primary-ink hover:underline">Privacy</Link> and{" "}
          <Link href="/security" className="text-primary-ink hover:underline">Security</Link> pages.
        </p>
      </div>
    </main>
  );
}
