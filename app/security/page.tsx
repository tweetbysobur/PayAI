"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck, Lock, Eye, KeyRound, FileCheck2, ExternalLink, Repeat, Gauge, Signature, Ban } from "lucide-react";
import { Logo } from "@/components/Logo";
import { MonadMark } from "@/components/MonadMark";
import { GitHubMark } from "@/components/BrandIcons";
import { MONAD_EXPLORER } from "@/lib/monad/public";

const GITHUB_URL = "https://github.com/tweetbysobur/PayAI";
const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-8)}`;

interface Onchain { contracts?: { paymentExecutor: string; executorExplorer: string } }

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
        {/* Intro */}
        <div className="mb-10">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary"><ShieldCheck size={24} /></div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Security &amp; trust</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            PayAI is non-custodial. You hold your own money, you approve every payment, and every payment is a
            real transaction you can verify on-chain. Here is exactly how that works, in plain terms.
          </p>
        </div>

        {/* Core pillars */}
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { icon: KeyRound, title: "You own it", body: "Your wallet, your keys, your funds. PayAI never takes custody and never asks for your seed phrase." },
            { icon: Eye, title: "You can verify it", body: "Every payment settles on Monad Mainnet with a transaction hash anyone can look up. Nothing is hidden or simulated." },
            { icon: Signature, title: "You approve it", body: "No money moves without your signature. PayAI proposes a transaction; your wallet decides." },
          ].map((p) => (
            <div key={p.title} className="rounded-xl border border-border bg-panel p-5">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary"><p.icon size={18} /></div>
              <h2 className="text-sm font-semibold text-foreground">{p.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>

        {/* Non-custodial detail */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Non-custodial by design</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            You connect your own wallet and approve every payment yourself. PayAI never holds your funds and never
            has access to your private keys or seed phrase. The one exception is Payment Automations:
            because you are not there to sign each run, they settle through a dedicated agent that can only spend
            within the per-transaction and daily limits you set on-chain. It cannot exceed those limits, and it
            cannot touch anything you did not automate and confirm.
          </p>
        </section>

        {/* Safeguards */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Built-in safeguards</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {[
              { icon: Signature, title: "Your signature is required", body: "Interactive payments are signed by your own wallet. PayAI can build a transaction but cannot send it." },
              { icon: Repeat, title: "Replay protection", body: "Each payment carries a unique key the contract marks as used, so a retried or duplicated request can never settle twice." },
              { icon: Gauge, title: "On-chain spend limits", body: "Per-transaction and daily caps are enforced by the smart contract itself, not just in the app." },
              { icon: Ban, title: "Sanctions screening", body: "Every recipient is checked against the OFAC sanctions list before a payment can settle. Flagged addresses are blocked automatically." },
              { icon: FileCheck2, title: "Checked before you sign", body: "Every payment is validated for the right recipient, amount, and limits before it ever reaches your wallet." },
            ].map((s) => (
              <div key={s.title} className="flex gap-3 rounded-xl border border-border bg-panel p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-input text-primary"><s.icon size={16} /></div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{s.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* What we never do */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">What PayAI never does</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {[
              "Take custody of your funds",
              "Ask for your seed phrase or private keys",
              "Move money without your signature",
              "Sell or share your data",
            ].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-danger/12 text-danger">✕</span>
                {t}
              </li>
            ))}
          </ul>
        </section>

        {/* Verify it yourself */}
        <section className="mt-10 rounded-2xl border border-border bg-panel/60 p-6">
          <h2 className="text-lg font-semibold text-foreground">Verify it yourself</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">Do not take our word for it. The code and the contracts are public.</p>
          <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
            {contract && (
              <a href={contract.executorExplorer} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border bg-panel px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
                <span className="flex items-center gap-2"><MonadMark size={14} /> Settlement contract</span>
                <span className="flex items-center gap-1.5 font-mono text-xs text-primary">{short(contract.paymentExecutor)} <ExternalLink size={12} /></span>
              </a>
            )}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border bg-panel px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
              <span className="flex items-center gap-2"><GitHubMark className="h-4 w-4 text-foreground" /> Open-source code</span>
              <ExternalLink size={14} className="text-muted-foreground" />
            </a>
            <a href={`${GITHUB_URL}/tree/main/contracts`} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border bg-panel px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
              <span className="flex items-center gap-2"><FileCheck2 size={15} className="text-primary" /> Smart contracts</span>
              <ExternalLink size={14} className="text-muted-foreground" />
            </a>
            <a href={MONAD_EXPLORER} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border bg-panel px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
              <span className="flex items-center gap-2"><Eye size={15} className="text-primary" /> Monad block explorer</span>
              <ExternalLink size={14} className="text-muted-foreground" />
            </a>
          </div>
        </section>

        {/* Honest about the edges */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Straight about where we are</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            PayAI runs on Monad Mainnet today and its code is covered by an automated test suite that runs on every
            change. Recipients are screened against the OFAC sanctions list before every payment. We are also honest
            about what is still ahead: a formal third-party security audit, and a fuller licensed compliance
            programme beyond sanctions screening, remain on the roadmap. We would rather tell you that than imply
            otherwise.
          </p>
        </section>

        {/* Report */}
        <section className="mt-10 flex flex-col items-start gap-2 rounded-2xl border border-border bg-panel p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary"><Lock size={18} /></div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Found a security issue?</h2>
              <p className="text-xs text-muted-foreground">Report it privately and we will respond quickly.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href="mailto:buharisobur22@gmail.com" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90">Email us</a>
            <a href={`${GITHUB_URL}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer" className="rounded-lg border border-border px-4 py-2 text-sm text-foreground transition hover:bg-input">Security policy</a>
          </div>
        </section>
      </div>
    </main>
  );
}
