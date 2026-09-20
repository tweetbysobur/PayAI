"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck, Lock, Eye, KeyRound, FileCheck2, ExternalLink, Repeat, Gauge, Signature, Ban, Bot } from "lucide-react";
import { Logo } from "@/components/Logo";
import { MonadMark } from "@/components/MonadMark";
import { MONAD_EXPLORER } from "@/lib/monad/public";

const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-8)}`;

interface Onchain {
  contracts?: {
    paymentExecutor: string;
    executorExplorer: string;
    forwarder?: string;
    forwarderExplorer?: string | null;
    tradeExecutor?: string;
    tradeExecutorExplorer?: string | null;
  };
}

export default function Security() {
  const [onchain, setOnchain] = useState<Onchain | null>(null);
  useEffect(() => {
    fetch("/api/onchain").then((r) => r.json()).then(setOnchain).catch(() => {});
  }, []);
  const contract = onchain?.contracts ?? null;

  return (
    <main className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2"><Logo size={28} /><span className="text-sm font-semibold text-foreground">PayAI</span></Link>
        <Link href="/" className="text-sm text-muted-foreground transition-colors hover:text-foreground">Back to home</Link>
      </header>

      <div className="mx-auto max-w-4xl px-6 pb-20 pt-6">
        <div className="mb-10">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center text-primary"><ShieldCheck size={30} /></div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Security & trust</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            PayAI (operated by UsePayAI at usepayai.xyz) is non-custodial for interactive payments
            and trades: you hold the keys, you approve the transaction, and settlement is a real
            Monad transaction you can look up. Here is exactly how that works — including the
            two places it is not that simple.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { icon: KeyRound, title: "You own interactive funds", body: "Your wallet, your keys. PayAI never asks for a seed phrase. Interactive payments and trades are signed by you." },
            { icon: Eye, title: "You can verify it", body: "Every payment settles on Monad Mainnet with a transaction hash anyone can look up. Nothing is hidden or simulated." },
            { icon: Signature, title: "You approve it", body: "No interactive payment moves without your signature. PayAI proposes a transaction; your wallet decides." },
          ].map((p) => (
            <div key={p.title} className="rounded-xl border border-border bg-panel p-5">
              <div className="mb-3 flex h-10 w-10 items-center justify-center text-primary"><p.icon size={22} /></div>
              <h2 className="text-sm font-semibold text-foreground">{p.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>

        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Non-custodial — and the two exceptions</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            You connect your own wallet and approve every interactive payment yourself. PayAI never
            takes the seed phrase of an embedded or external wallet. Two paths cannot wait for you
            to click Approve, and we do not pretend they are the same as the rest of the app:
          </p>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li className="rounded-xl border border-border bg-panel p-4">
              <span className="font-semibold text-foreground">Payment Automations.</span>{" "}
              Because you are not there to sign each run, they settle through a dedicated agent
              wallet bounded by per-transaction and daily limits enforced on-chain in PaymentExecutor.
              Wallet Automation pulls from an allowance you approved. Reserved Funds sit in
              AutomationVault, which can only pay the committed recipient or refund you.
            </li>
            <li className="rounded-xl border border-border bg-panel p-4">
              <span className="font-semibold text-foreground">Telegram trading bot.</span>{" "}
              If you use the Telegram bot, PayAI generates a hot wallet for that chat and stores
              the key encrypted at rest so trades can sign from chat. That path is custodial.
              Do not send it more than you are willing to trust to a bot. Withdraw anytime with /withdraw.
              Interactive PayAI in the browser is a different model.
            </li>
          </ul>
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Built-in safeguards</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {[
              { icon: Signature, title: "Your signature is required", body: "Interactive payments are signed by your own wallet. PayAI can build a transaction but cannot send it." },
              { icon: Repeat, title: "Replay protection", body: "Each payment carries a unique key the contract marks as used, so a retried or duplicated request can never settle twice." },
              { icon: Gauge, title: "On-chain spend limits", body: "Per-transaction and daily caps are enforced by the smart contract itself, not just in the app." },
              { icon: Ban, title: "Sanctions screening", body: "Every recipient is checked against the OFAC SDN digital-currency address list before a payment can settle. Flagged addresses are blocked. This is address screening, not a licensed KYC/AML programme." },
              { icon: FileCheck2, title: "Checked before you sign", body: "Every payment is validated for the right recipient, amount, and limits before it ever reaches your wallet." },
              { icon: Bot, title: "Typed trade execution", body: "Interactive trades go through a typed executor with allowlisted venues — not arbitrary target or calldata from the model." },
            ].map((s) => (
              <div key={s.title} className="flex gap-3 rounded-xl border border-border bg-panel p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center text-primary"><s.icon size={19} /></div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{s.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">What PayAI never does</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {[
              "Ask for your seed phrase",
              "Move interactive funds without your signature",
              "Let the agent exceed the on-chain caps you authorized",
              "Sell your payment history",
            ].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-danger/12 text-danger">✕</span>
                {t}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10 rounded-2xl border border-border bg-panel/60 p-6">
          <h2 className="text-lg font-semibold text-foreground">Verify the contracts yourself</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Deployed PayAI contracts are verified on the Monad explorer. The application source
            repository is private — we will not link a 404 and call it public. What you can
            verify today is every live contract and every transaction.
          </p>
          <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
            {contract?.executorExplorer && (
              <a href={contract.executorExplorer} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border bg-panel px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
                <span className="flex items-center gap-2"><MonadMark size={14} /> Settlement contract</span>
                <span className="flex items-center gap-1.5 font-mono text-xs text-primary-ink">{short(contract.paymentExecutor)} <ExternalLink size={12} /></span>
              </a>
            )}
            {contract?.forwarderExplorer && contract.forwarder && (
              <a href={contract.forwarderExplorer} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border bg-panel px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
                <span className="flex items-center gap-2"><MonadMark size={14} /> Payment forwarder</span>
                <span className="flex items-center gap-1.5 font-mono text-xs text-primary-ink">{short(contract.forwarder)} <ExternalLink size={12} /></span>
              </a>
            )}
            {contract?.tradeExecutorExplorer && contract.tradeExecutor && (
              <a href={contract.tradeExecutorExplorer} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border bg-panel px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
                <span className="flex items-center gap-2"><MonadMark size={14} /> Trade executor</span>
                <span className="flex items-center gap-1.5 font-mono text-xs text-primary-ink">{short(contract.tradeExecutor)} <ExternalLink size={12} /></span>
              </a>
            )}
            <a href={MONAD_EXPLORER} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border bg-panel px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
              <span className="flex items-center gap-2"><Eye size={15} className="text-primary-ink" /> Monad block explorer</span>
              <ExternalLink size={14} className="text-muted-foreground" />
            </a>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Independent review</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            In August 2026 the PayAI contracts completed the DeltaV × Ultrafuzz protocol security
            program. That review found no critical vulnerability that could drain user funds.
            Medium and low findings — fee-on-transfer accounting, a sender-surcharge vault gap,
            native request lifecycle, and registrar privilege — were patched and redeployed.
            Ultrafuzz is an independent protocol review, not a full commercial audit of the
            application. A formal third-party audit remains on the roadmap.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Browser security (CSP)</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Every response sets frame-ancestors none, HSTS, and a Content-Security-Policy that
            pins <span className="font-mono text-xs">connect-src</span> to this origin and the
            Monad RPCs so injected script cannot exfiltrate a key over fetch. Two honest limits:
            Next.js still requires <span className="font-mono text-xs">script-src 'unsafe-inline'</span>{" "}
            (no nonce middleware yet), and token logos load from arbitrary HTTPS URLs. The
            embedded wallet keeps a live key in the page — XSS containment matters more here
            than on a brochure site.
          </p>
        </section>

        <section className="mt-10 flex flex-col items-start gap-2 rounded-2xl border border-border bg-panel p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center text-primary"><Lock size={22} /></div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Found a security issue?</h2>
              <p className="text-xs text-muted-foreground">Report it privately. Do not open a public issue for anything exploitable.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href="mailto:security@usepayai.xyz" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90">Email us</a>
            <Link href="/dashboard/help?tab=support" className="rounded-lg border border-border px-4 py-2 text-sm text-foreground transition hover:bg-input">Contact support</Link>
          </div>
        </section>
      </div>
    </main>
  );
}
