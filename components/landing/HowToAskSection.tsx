import { GUIDE, displayPrompt } from "@/components/landing/intentExamples";

/**
 * "How to ask" — on /how-it-works, right after the three steps (the old
 * /intents page and the capability grid merged into one, so each point is
 * made once). The steps already say that nothing runs until you approve,
 * and the examples below show "each" and chaining, so neither is repeated
 * here as a separate rule.
 *
 * Every prompt comes from GUIDE in intentExamples.ts and is run through the
 * real product in test/intent-examples.test.ts. The limits are the product's
 * real ones (lib/plan-adapter/grammar.ts, lib/ask/intent/compound.ts).
 */

const BASICS = [
  { title: "Name the essentials", body: "The action, the amount and token, and who it's for — a 0x address, a .nad name or a saved payee." },
  { title: "Leave something out, and it asks", body: "PayAI never guesses an amount or a recipient. If something is missing, it asks for just that." },
];

const LIMITS = [
  "“Send it” after a swap sends exactly what the swap returned. Amounts worked out between steps, like “half of it” or “the rest”, aren't supported yet.",
  "A swap's output can be sent on when it's USDC. MON received from a swap can't be passed to the next step yet.",
  "Scheduled and recurring payments aren't available in Ask PayAI right now — set them up in Payments & Automations instead.",
  "Sends in chat are MON or USDC. Trades work with any Monad token by its contract address.",
  "DeFi protocols aren't available from Ask yet — they're coming through partner integrations.",
  "If PayAI can't do something yet — staking or bridging, for example — it says so instead of guessing.",
];

export function HowToAskSection() {
  return (
    <section id="how-to-ask" aria-labelledby="how-to-ask-title" className="scroll-mt-6 border-t border-border">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-6 sm:py-24">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-primary-ink">How to ask</p>
        <h2 id="how-to-ask-title" className="mt-3 max-w-2xl text-balance text-2xl font-medium tracking-[-0.03em] text-foreground sm:text-4xl">
          Say what you want done.
        </h2>

        <ul className="mt-10 grid gap-8 sm:grid-cols-2 lg:gap-6">
          {BASICS.map((p, i) => (
            <li key={p.title} className="border-t border-border pt-5">
              <p className="font-mono text-[11px] font-medium tracking-[0.12em] text-muted-foreground">{String(i + 1).padStart(2, "0")}</p>
              <h3 className="mt-2 text-lg font-medium tracking-[-0.02em] text-foreground">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
            </li>
          ))}
        </ul>

        <ul className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-2">
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

        <div className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
          <h3 className="text-balance text-xl font-medium tracking-[-0.03em] text-foreground sm:text-2xl">Where today&apos;s limits are</h3>
          <ul className="divide-y divide-border border-y border-border">
            {LIMITS.map((t) => (
              <li key={t} className="py-4 text-[15px] leading-relaxed text-muted-foreground">{t}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
