import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { geist, geistMono } from "@/components/landing/fonts";
import { GUIDE, displayPrompt } from "@/components/landing/intentExamples";

/**
 * /intents — how to ask PayAI to get something done.
 *
 * Every prompt on this page comes from GUIDE in intentExamples.ts and is run
 * through the real product in test/intent-examples.test.ts. The limits listed
 * under "Good to know" are the product's real ones (the plan grammar in
 * lib/plan-adapter/grammar.ts and Ask's compound guard in
 * lib/ask/intent/compound.ts) — written so a visitor isn't surprised by them.
 */

export const metadata: Metadata = {
  title: "How to ask PayAI · PayAI",
  description: "How to phrase a request so PayAI can plan it: sending, paying several people, trading, chaining actions, scheduling, Rooms and Monad protocols — with examples PayAI acts on today.",
};

const PRINCIPLES = [
  { title: "Name the essentials", body: "The action, the amount and token, and who it's for — a 0x address, a .nad name or a saved payee." },
  { title: "Leave something out, and it asks", body: "PayAI never guesses an amount or a recipient. If something is missing, it asks for just that." },
  { title: "Several actions, one message", body: "Join them with “and” or “then”. They run in the order you wrote them, and each waits for the one before it." },
  { title: "You stay in control", body: "Nothing moves until you approve the plan, and your wallet confirms each transaction." },
];

const GOOD_TO_KNOW = [
  "Say “each” when everyone gets the same amount. Without it, PayAI asks you to make each person's amount clear.",
  "“Send it” after a swap sends exactly what the swap returned. Amounts worked out between steps, like “half of it” or “the rest”, aren't supported yet.",
  "A swap's output can be sent on when it's USDC. MON received from a swap can't be passed to the next step yet.",
  "Scheduled and recurring payments go in their own message — they can't be combined with other actions yet.",
  "Sends in chat are MON or USDC. Trades work with other Monad tokens too.",
  "DeFi protocols aren't available from Ask yet — they're coming through partner integrations.",
  "If PayAI can't do something yet — staking or bridging, for example — it says so instead of guessing.",
];

export default function IntentsPage() {
  return (
    <main
      className={`${geist.className} ${geistMono.variable} min-h-screen overflow-x-hidden bg-background antialiased`}
      style={{ "--font-mono": "var(--font-geist-mono)" } as React.CSSProperties}
    >
      <SiteNav />

      <section className="border-b border-border">
        <div className="mx-auto max-w-7xl px-5 pb-14 pt-10 sm:px-6 sm:pb-20 sm:pt-16">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-primary-ink">How to ask PayAI</p>
          <h1 className="mt-4 max-w-3xl text-balance text-[clamp(2.1rem,8vw,3.6rem)] font-medium leading-[0.98] tracking-[-0.045em] text-foreground lg:text-[4.2rem]">
            Say what you want done.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            PayAI turns plain language into a plan you review before anything runs. Every request below is one it acts on today — use it as written, or say it your own way.
          </p>
        </div>
      </section>

      <section aria-labelledby="principles-title" className="border-b border-border">
        <div className="mx-auto max-w-7xl px-5 py-16 sm:px-6 sm:py-20">
          <h2 id="principles-title" className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-primary-ink">The basics</h2>
          <ul className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
            {PRINCIPLES.map((p, i) => (
              <li key={p.title} className="border-t border-border pt-5">
                <p className="font-mono text-[11px] font-medium tracking-[0.12em] text-muted-foreground">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="mt-2 text-lg font-medium tracking-[-0.02em] text-foreground">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="examples-title" className="border-b border-border">
        <div className="mx-auto max-w-7xl px-5 py-16 sm:px-6 sm:py-20">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-primary-ink">Examples</p>
          <h2 id="examples-title" className="mt-3 max-w-2xl text-balance text-2xl font-medium tracking-[-0.03em] text-foreground sm:text-4xl">
            By what you want done.
          </h2>
          <ul className="mt-10 grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-2">
            {GUIDE.map((g) => (
              <li key={g.title} className="flex flex-col bg-background p-5 sm:p-6">
                <h3 className="text-base font-medium tracking-[-0.02em] text-foreground sm:text-lg">{g.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{g.body}</p>
                <ul className="mt-4 space-y-2">
                  {g.examples.map((e) => (
                    <li key={e.say} className="break-words border-l-2 border-primary/60 pl-3 font-mono text-[13px] leading-relaxed text-foreground/85">
                      &ldquo;{displayPrompt(e.say)}&rdquo;
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="limits-title" className="border-b border-border">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 py-16 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-primary-ink">Good to know</p>
            <h2 id="limits-title" className="mt-3 text-balance text-2xl font-medium tracking-[-0.03em] text-foreground sm:text-3xl">
              Where today&apos;s limits are.
            </h2>
          </div>
          <ul className="divide-y divide-border border-y border-border">
            {GOOD_TO_KNOW.map((t) => (
              <li key={t} className="py-4 text-[15px] leading-relaxed text-muted-foreground">{t}</li>
            ))}
          </ul>
        </div>
      </section>

      <section>
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-6 px-5 py-16 sm:flex-row sm:items-end sm:justify-between sm:px-6 sm:py-20">
          <h2 className="max-w-xl text-balance text-3xl font-medium leading-[1.02] tracking-[-0.04em] text-foreground sm:text-4xl">
            Try one in Ask PayAI.
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/auth" className="inline-flex h-12 items-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              Launch PayAI <ArrowRight size={15} aria-hidden />
            </Link>
            <Link href="/how-it-works" className="inline-flex h-12 items-center rounded-md border border-border px-6 text-sm font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              See how it works
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
