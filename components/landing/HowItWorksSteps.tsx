/**
 * The three steps of PayAI, on /how-it-works: large numbered rows on the dark
 * page, white headings, purple numerals, thin rules between them.
 *
 * Step 03 is worded for what actually happens: each transaction in a plan is
 * confirmed by your wallet (a passkey or a connected wallet), so "approve
 * once" is never promised for signing — only for the plan.
 */
export const HOW_STEPS = [
  {
    n: "01",
    title: "Describe your intent",
    body: "Tell PayAI what you want done, in your own words — one action or several.",
  },
  {
    n: "02",
    title: "Review the plan",
    body: "See exactly what PayAI understood — every action, amount and recipient, in order — before anything executes.",
  },
  {
    n: "03",
    title: "Approve and execute",
    body: "Your wallet authorizes each transaction. PayAI carries the plan out on Monad, step by step, and checks every result on-chain.",
  },
] as const;

export function HowItWorksSteps() {
  return (
    <section id="steps" aria-labelledby="steps-title" className="scroll-mt-6">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-6 sm:py-24">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-primary-ink">How PayAI works</p>
        <h2 id="steps-title" className="mt-3 max-w-2xl text-balance text-2xl font-medium tracking-[-0.03em] text-foreground sm:text-4xl">
          You say what you want. You approve what runs.
        </h2>
        <ol className="mt-12 border-b border-border">
          {HOW_STEPS.map((s) => (
            <li
              key={s.n}
              className="grid gap-3 border-t border-border py-8 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-8 sm:py-10 lg:grid-cols-[8rem_minmax(0,20rem)_minmax(0,1fr)] lg:items-baseline"
            >
              <span className="font-mono text-3xl font-medium leading-none tracking-[-0.04em] text-primary-ink sm:text-4xl">{s.n}</span>
              <h3 className="text-xl font-medium tracking-[-0.025em] text-foreground sm:text-2xl">{s.title}</h3>
              <p className="max-w-xl text-[15px] leading-relaxed text-muted-foreground sm:col-start-2 sm:text-base lg:col-start-auto">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
