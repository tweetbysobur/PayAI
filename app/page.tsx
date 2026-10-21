"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { geist, geistMono } from "@/components/landing/fonts";
import { ExecutionPath } from "@/components/landing/ExecutionPath";

/**
 * The landing page says one thing: turn your intent into onchain execution.
 *
 *   hero          the approved headline and line, the way in, and the
 *                 execution model as a static diagram (who does what)
 *   model         what PayAI does, and what stays with checks and your wallet
 *   faq · close
 *
 * Deliberately absent: mock chats, fake transaction previews, product-card
 * grids, glows, gradients, charts, live counters and claims of guaranteed
 * safety. The hero shows no example transaction. Nothing here is a live
 * figure or a simulated action.
 */

/** The product's existing entry point. Relative on purpose: the host proxy
 *  sends /auth on the marketing host to the app host, and local dev stays local. */
const LAUNCH = "/auth";

const FAQS = [
  { q: "What is PayAI?", a: "PayAI turns what you want done into onchain execution on Monad. You describe the outcome in plain language; PayAI turns it into a plan you can review, approve and execute with your wallet." },
  { q: "What can I ask it to do today?", a: "Send MON or USDC to an address, a .nad name or a saved payee; pay several people at once; trade any Monad token by its contract address; chain several actions into one plan; schedule or automate transfers; split a cost in a Room; and ask about your balances and activity. How to ask, on the How it works page, has examples of each." },
  { q: "What if PayAI misunderstands me?", a: "That's what the review step is for. You see exactly what PayAI understood — every action, amount and recipient, in order — before anything executes. If it's wrong, change it or cancel; nothing has moved." },
  { q: "Who controls my funds?", a: "You do. Actions you start are signed by your own wallet, and PayAI never holds your keys. Payment Automations run from a capped agent wallet, only within the limits you approve when you set them up." },
  { q: "What are the fees?", a: "PayAI charges a 0.25% fee on supported fee-bearing transactions. Network and protocol fees are separate." },
];

export default function LandingPage() {
  return (
    // Geist across the landing page; font-mono details use Geist Mono.
    <main
      className={`${geist.className} ${geistMono.variable} min-h-screen overflow-x-hidden bg-background antialiased`}
      style={{ "--font-mono": "var(--font-geist-mono)" } as React.CSSProperties}
    >
      <SiteNav />

      {/* Hero */}
      <Hero />

      {/* Execution model / trust */}
      <Section>
        <SectionTitle title="PayAI reads your intent. It doesn't get the last word." />
        <div className="mt-10 grid gap-10 md:grid-cols-2 md:gap-16">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">What PayAI does</p>
            <ul className="mt-4 space-y-4">
              <Fact title="Interprets your request">It works out the actions, amounts, recipients and order you meant.</Fact>
              <Fact title="Prepares an exact plan">Every action, amount and recipient, in order — and for swaps, an exact quote before you sign.</Fact>
              <Fact title="Carries out what you approved">In order, step by step, and checked against the chain afterwards.</Fact>
            </ul>
          </div>
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-primary-ink">What stays with you</p>
            <ul className="mt-4 space-y-4">
              <Fact yours title="The decision">Nothing executes until you&apos;ve reviewed the plan and approved it. If PayAI misread you, you change it or cancel.</Fact>
              <Fact yours title="The signature">Actions you start are signed by your own wallet. PayAI never holds your keys.</Fact>
              <Fact yours title="The limits">Automations run from a capped agent wallet, only within the limits you approve when you set them up.</Fact>
            </ul>
          </div>
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
          <SectionTitle title="Questions" />
          <div className="divide-y divide-border border-y border-border">
            {FAQS.map((f) => <FaqItem key={f.q} q={f.q} a={f.a} />)}
          </div>
        </div>
      </Section>

      {/* Close */}
      <section className="border-t border-border">
        {/* The line on one row, sized to fit the screen; the button below it. */}
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-6 px-5 py-16 sm:gap-8 sm:px-6 sm:py-24">
          <h2 className="whitespace-nowrap text-[clamp(0.8rem,4.2vw,3.25rem)] font-medium leading-tight tracking-[-0.03em] text-foreground">
            Make intent. Get your onchain execution done
          </h2>
          <Link href={LAUNCH} className="inline-flex h-12 shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            Launch PayAI <ArrowRight size={15} aria-hidden />
          </Link>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

/** Approved hero copy — final; tests check it word for word. */
const HEADLINE = "Turn natural language intent into onchain execution.";
const SUBLINE = "Describe what you want in plain language. PayAI turns it into a plan you can review, approve, and execute with your wallet.";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * The hero, in two halves: the approved copy on the left, set large and
 * editorial; the Execution Path on the right — PayAI's signature drawing of
 * an intent becoming a reviewed, approved, executed action.
 *
 * The two are choreographed together: "Turn natural language intent" rises first, and as
 * "onchain execution." decodes from hex, the scattered strokes on the right
 * gather into the route. The copy and the actions follow once the headline
 * has resolved. Reduced motion renders the finished composition at once.
 */
function Hero() {
  const reduce = usePrefersReducedMotion();
  const t = (duration: number, delay: number) => (reduce ? { duration: 0, delay: 0 } : { duration, delay, ease: EASE as unknown as [number, number, number, number] });
  const appear = (delay: number) => ({
    initial: reduce ? false as const : { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    transition: t(0.7, delay),
  });
  const words = HEADLINE.split(" ");            // Turn natural language intent into onchain execution.
  const lineOne = words.slice(0, 4);            // Turn natural language intent
  const rise = (w: string, delay: number, key: string) => (
    <span key={key} aria-hidden className="inline-block overflow-hidden pb-[0.1em] align-bottom">
      <motion.span className="inline-block" initial={reduce ? false : { y: "112%" }} animate={{ y: "0%" }} transition={t(0.85, delay)}>
        {w}
      </motion.span>
    </span>
  );

  return (
    // Keyed on the motion preference: it is only known after the first
    // client render, and remounting lands reduced motion on the final state.
    <section key={reduce ? "still" : "moving"} className="relative border-b border-border">
      <div className="mx-auto grid max-w-7xl items-center gap-y-12 px-5 pb-14 pt-8 sm:px-6 sm:pb-20 sm:pt-14 lg:min-h-[min(calc(100svh-5.5rem),48rem)] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-x-12 lg:pb-16 lg:pt-6">
        <div className="relative z-10">
          <h1 aria-label={HEADLINE}
            className="text-[clamp(2.15rem,10.2vw,3.6rem)] font-medium leading-[0.94] tracking-[-0.045em] text-foreground sm:text-[4.1rem] lg:text-[clamp(3.6rem,5.6vw,5.4rem)]"
          >
            <span className="block">{lineOne.map((w, i) => rise(w, 0.1 + i * 0.08, `a${i}`)).flatMap((el) => [el, " "])}</span>
            <span className="block">
              {rise(words[4], 0.46, "b0")}{" "}
              <span aria-hidden className="relative inline-block whitespace-nowrap pb-[0.1em] align-bottom"><Decode text={words[5]} start={0.75} reduce={reduce} /></span>
            </span>
            <span className="block">
              <span aria-hidden className="relative inline-block whitespace-nowrap pb-[0.1em] align-bottom"><Decode text={words[6]} start={1.0} reduce={reduce} /></span>
            </span>
          </h1>

          <motion.p {...appear(1.45)} className="mt-8 max-w-[34rem] text-base leading-relaxed text-muted-foreground sm:text-lg">
            {SUBLINE}
          </motion.p>

          <motion.div {...appear(1.6)} className="mt-9 grid gap-3 min-[360px]:flex min-[360px]:flex-wrap min-[360px]:items-center">
            <Link href={LAUNCH} className="group inline-flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              Launch PayAI <ArrowRight size={15} aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
            <Link href="/how-it-works" className="inline-flex h-12 items-center justify-center rounded-md border border-border px-6 text-sm font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              See how it works
            </Link>
          </motion.div>
        </div>

        <motion.figure {...appear(0.2)} className="relative mx-auto w-full max-w-[30rem] lg:max-w-[34rem]">
          <ExecutionPath reduce={reduce} className="h-auto w-full" />
          <figcaption className="mt-2 flex items-center justify-end font-mono text-[10px] uppercase tracking-[0.18em] text-tick">
            <span>Intent → Execution</span>
          </figcaption>
        </motion.figure>
      </div>
    </section>
  );
}

/** The OS "reduce motion" setting, read straight from the media query and
 *  kept in sync if it changes. False on the server, so the first client
 *  render can correct it. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

const DECODE_GLYPHS = "0123456789abcdef";
/** Seconds between one character locking in and the next. */
const DECODE_STEP = 0.045;
/** Seconds each character keeps cycling before it locks. */
const DECODE_SETTLE = 0.35;

/**
 * Text that starts as cycling hex and locks in left to right. The real text
 * is laid out invisibly underneath so the line never changes width while it
 * decodes; the cycling copy sits on top. Static for reduced motion.
 */
function Decode({ text, start, reduce }: { text: string; start: number; reduce: boolean }) {
  // Starts blank (not the final text) so the phrase doesn't flash in fully
  // before it decodes; null once every character has locked.
  const [shown, setShown] = useState<string | null>("");

  useEffect(() => {
    if (reduce) return;
    let raf = 0;
    const t0 = performance.now() + start * 1000;
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      if (t < 0) { setShown(""); raf = requestAnimationFrame(tick); return; }
      let out = "";
      let done = true;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const lockAt = i * DECODE_STEP + DECODE_SETTLE;
        if (ch === " " || t >= lockAt) { out += ch; continue; }
        done = false;
        out += t >= i * DECODE_STEP ? DECODE_GLYPHS[Math.floor(Math.random() * DECODE_GLYPHS.length)] : "\u00a0";
      }
      setShown(done ? null : out);
      if (!done) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, start, reduce]);

  if (reduce || shown === null) return <span>{text}</span>;
  return (
    <span className="relative inline-block">
      <span className="invisible">{text}</span>
      <span className="absolute inset-0 whitespace-nowrap text-left">
        {shown.split("").map((c, i) => (
          <span key={i} className={c === text[i] ? undefined : "text-primary-ink"}>{c}</span>
        ))}
      </span>
    </span>
  );
}

function Section({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 border-t border-border">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-6 sm:py-24">{children}</div>
    </section>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <div>
      <h2 className="max-w-2xl text-balance text-2xl font-medium tracking-[-0.03em] text-foreground sm:text-4xl">{title}</h2>
    </div>
  );
}

function Fact({ title, children, yours = false }: { title: string; children: React.ReactNode; yours?: boolean }) {
  return (
    // What stays with the user is drawn in the route's purple; what PayAI does stays neutral.
    <li className={`border-l-2 pl-4 ${yours ? "border-primary" : "border-border"}`}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</p>
    </li>
  );
}

/** Accessible FAQ row — a plain disclosure, keyboard-operable. */
function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="text-sm font-medium text-foreground sm:text-base">{q}</span>
        <ChevronDown size={16} aria-hidden className={`shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <p className="pb-5 pr-8 text-sm leading-relaxed text-muted-foreground">{a}</p>}
    </div>
  );
}
