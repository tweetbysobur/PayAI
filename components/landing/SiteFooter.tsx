"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Rocket, ShieldCheck, ScrollText, ExternalLink, LifeBuoy, Lock,
  BadgeCheck, Layers, Route, Mail,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { MonadMark } from "@/components/MonadMark";
import { XMark } from "@/components/BrandIcons";
import { MONAD_EXPLORER } from "@/lib/monad/public";
import pkg from "../../package.json";

/**
 * The marketing-site footer, shared by /, /product, and /how-it-works.
 *
 * Fetches its own /api/onchain rather than taking it as a prop: it's the only
 * consumer of that data on a marketing page, and threading it down from three
 * separate pages would mean three copies of the same fetch + state.
 *
 * Every link points at a real route in this app. No placeholder destinations,
 * nothing that 404s, and no entry that merely repeats another one — a footer
 * column that restates the column beside it is noise, not navigation.
 *
 * Nothing here discloses more than a visitor needs: no source repository (it
 * is private, so every such link 404s and the URL names a personal account),
 * and a role address rather than anyone's personal inbox.
 */

/* The source repository is private, so it is deliberately NOT linked from any
   public surface: every such link 404s for a visitor, and the URL also
   discloses the owner's personal account. Support runs through the in-app
   Support Center and a role address instead. */
const SUPPORT_EMAIL = "support@usepayai.xyz";
const X_URL = "https://x.com/usepayAI";

const FOOTER_COLUMNS = [
  {
    title: "Product",
    links: [
      // Onboarding is /auth now; /connect is the secondary external-wallet
      // path, so sending new visitors there skipped the primary experience.
      { label: "Launch App", href: "/auth", icon: Rocket, internal: true },
      { label: "Product", href: "/product", icon: Layers, internal: true },
      { label: "How it works", href: "/how-it-works", icon: Route, internal: true },
      { label: "Security", href: "/security", icon: ShieldCheck, internal: true },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Monad Explorer", href: MONAD_EXPLORER, icon: ExternalLink, internal: false },
      { label: "Support", href: "/dashboard/help?tab=support", icon: LifeBuoy, internal: true },
      { label: "Privacy Policy", href: "/privacy", icon: Lock, internal: true },
      { label: "Terms of Service", href: "/terms", icon: ScrollText, internal: true },
    ],
  },
];

interface Onchain {
  configured?: boolean;
  contracts?: { executorExplorer: string; forwarderExplorer?: string | null };
}

export function SiteFooter() {
  const [onchain, setOnchain] = useState<Onchain | null>(null);

  useEffect(() => {
    fetch("/api/onchain").then((r) => r.json()).then(setOnchain).catch(() => {});
  }, []);

  return (
    <footer className="border-t border-border bg-panel/40">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-3 lg:grid-cols-5">
          <div className="col-span-2 sm:col-span-3 lg:col-span-2">
            <Link href="/" className="flex items-center gap-2">
              <Logo size={26} />
              <span className="text-base font-semibold text-foreground">PayAI</span>
            </Link>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
              The payment automation layer on Monad. Send, swap, automate and distribute
              payments from one place, while your funds stay in your control.
            </p>
            <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/8 px-3 py-1.5 text-xs font-medium text-primary-ink">
              <MonadMark size={12} /> Built on Monad Mainnet
            </div>
          </div>

          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{col.title}</p>
              <ul className="mt-4 space-y-3">
                {col.links.map((l) => {
                  const external = !l.internal;
                  const Anchor = external ? "a" : Link;
                  return (
                    <li key={l.label}>
                      <Anchor
                        href={l.href}
                        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                        className="group flex items-center gap-2 rounded-sm text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      >
                        <l.icon size={14} className="text-muted-foreground/60 transition-colors duration-150 group-hover:text-primary-ink" />
                        {l.label}
                      </Anchor>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex items-center gap-3 border-t border-border pt-8">
          <a
            href={`mailto:${SUPPORT_EMAIL}`} aria-label="Email PayAI support"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Mail size={16} />
          </a>
          <a
            href={X_URL} target="_blank" rel="noreferrer" aria-label="PayAI on X"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XMark size={15} />
          </a>
        </div>

        <div className="mt-8 flex flex-col items-center justify-between gap-4 border-t border-border pt-6 text-xs text-muted-foreground/80 sm:flex-row">
          <p>© {new Date().getFullYear()} PayAI. All rights reserved.</p>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <span className="font-mono">v{pkg.version}</span>
            <span className="hidden h-3 w-px bg-border sm:inline" />
            <span className="flex items-center gap-1.5"><MonadMark size={11} /> Powered by Monad Mainnet</span>
            <span className="hidden h-3 w-px bg-border sm:inline" />
            {onchain?.configured && onchain.contracts && (onchain.contracts.forwarderExplorer || onchain.contracts.executorExplorer) ? (
              // One live-contract badge. Prefer the interactive-payment
              // forwarder (the contract users' own payments flow through);
              // fall back to the executor if the forwarder isn't configured.
              <a
                href={onchain.contracts.forwarderExplorer || onchain.contracts.executorExplorer}
                target="_blank" rel="noreferrer"
                className="flex items-center gap-1.5 text-success transition-colors hover:text-success/80"
              >
                <BadgeCheck size={13} /> Contract Live on Monad
              </a>
            ) : (
              <span className="flex items-center gap-1.5 text-muted-foreground/60">
                <BadgeCheck size={13} /> Contract status unavailable
              </span>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}
