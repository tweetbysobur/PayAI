import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CAPABILITIES, displayPrompt } from "@/components/landing/intentExamples";

/**
 * What PayAI does today, on /how-it-works — a card grid in place of the old
 * landing-page list. Three columns on desktop, two on tablets, one on phones;
 * every card the same structure (name, one line, one prompt in mono), so the
 * grid stays aligned however long a description runs.
 *
 * The cards and their prompts come from intentExamples.ts, where every prompt
 * is checked against the real product (test/intent-examples.test.ts).
 */
export function CapabilityGrid() {
  return (
    <section id="capabilities" aria-labelledby="capabilities-title" className="scroll-mt-6 border-t border-border">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-6 sm:py-24">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-primary-ink">What it does today</p>
            <h2 id="capabilities-title" className="mt-3 max-w-2xl text-balance text-2xl font-medium tracking-[-0.03em] text-foreground sm:text-4xl">
              One sentence in. Onchain execution out.
            </h2>
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
              Each of these starts from a plain-language request, and several can go into one plan — reviewed together, approved once, executed in order.
            </p>
          </div>
          <Link
            href="/intents"
            className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-sm text-sm font-medium text-primary-ink transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:self-auto"
          >
            How to ask PayAI <ArrowRight size={14} aria-hidden />
          </Link>
        </div>

        <ul className="mt-10 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((c) => (
            <li key={c.id} className="flex flex-col bg-background p-5 sm:p-6">
              <h3 className="text-base font-medium tracking-[-0.02em] text-foreground sm:text-lg">{c.name}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">{c.body}</p>
              {c.examples.map((e) => (
                <p
                  key={e.say}
                  className="mt-5 break-words border-l-2 border-primary/60 pl-3 font-mono text-[13px] leading-relaxed text-foreground/85"
                >
                  &ldquo;{displayPrompt(e.say)}&rdquo;
                </p>
              ))}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
