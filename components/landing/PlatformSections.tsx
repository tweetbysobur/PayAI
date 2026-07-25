"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ShieldCheck, Blocks, AtSign, Wallet, Database, Code2, ArrowUpRight, Layers } from "lucide-react";
import { TokenLogo, VolumeInline } from "@/components/TokenLogo";
import { MonadMark } from "@/components/MonadMark";

/**
 * Landing sections that describe the platform with REAL data only.
 *
 * Two of these are live: Supported Monad Tokens reads the same
 * /api/tokens registry the in-app token selector uses (every entry's
 * symbol/name/decimals confirmed on-chain), and Platform Statistics reads
 * the same /api/platform-stats aggregate the dashboard shows. Neither
 * renders invented numbers — while loading they show skeletons, and if a
 * fetch fails the section hides itself rather than showing zeros that would
 * read as "nobody uses this".
 *
 * The other two describe things that verifiably exist in this repo: real
 * API routes under app/api, and integrations that are genuinely wired
 * (NNS domain resolution, EIP-6963 wallet discovery, WalletConnect,
 * Monad mainnet). No partner logos, no claimed relationships that don't
 * exist yet.
 */

const SECTION = "border-t border-border py-24 sm:py-28";
const H2 = "text-3xl font-semibold tracking-tighter sm:text-4xl text-foreground";
const SUB = "mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground";

function SectionHead({ title, body }: { title: string; body: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45, ease: "easeOut" }}
      className="mb-12 text-center"
    >
      <h2 className={H2}>{title}</h2>
      <p className={SUB}>{body}</p>
    </motion.div>
  );
}

/* ── Supported Monad Tokens — live from the on-chain token registry ─────── */

interface TokenRow { address: string; symbol: string; name: string; decimals: number; verified: boolean; logoURI?: string | null }

export function SupportedTokens() {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/tokens")
      .then((r) => r.json())
      .then((j) => { if (j.success && Array.isArray(j.tokens)) setTokens(j.tokens); else setFailed(true); })
      .catch(() => setFailed(true));
  }, []);

  // Never render a fabricated list. A failed fetch hides the section.
  if (failed) return null;

  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-6xl px-6">
        <SectionHead
          title="Automate any token on Monad"
          body="The engine is token-agnostic. Every automation — recurring, scheduled, or bulk — can settle in MON or any fungible token on Monad. Decimals are read from the contract itself, never assumed."
        />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tokens === null
            ? Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 rounded-xl border border-border bg-panel/50 p-4">
                  <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-border/70" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-3 w-16 animate-pulse rounded bg-border/70" />
                    <div className="h-2.5 w-24 animate-pulse rounded bg-border/50" />
                  </div>
                </div>
              ))
            : tokens.map((t, i) => (
                <motion.div
                  key={t.address}
                  initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-40px" }}
                  transition={{ delay: Math.min(i * 0.05, 0.3), duration: 0.4, ease: "easeOut" }}
                  className="group flex items-center gap-3 rounded-xl border border-border bg-panel/50 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-panel"
                >
                  <TokenLogo token={t.symbol} logoURI={t.logoURI} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-semibold tracking-tight text-foreground">{t.symbol}</p>
                      {t.verified && <ShieldCheck size={12} className="shrink-0 text-primary-ink" aria-label="Verified" />}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{t.name}</p>
                  </div>
                  <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t.decimals}d
                  </span>
                </motion.div>
              ))}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Any other Monad token works too — paste its contract address in the app and PayAI reads its
          symbol, name, and decimals straight from the chain.
        </p>
      </div>
    </section>
  );
}

/* ── Platform Statistics — live aggregate, never fabricated ─────────────── */

interface Stats {
  totalPayments: number;
  volumeByToken: Record<string, number>;
  compliance: { approvalRate: number };
}

export function PlatformStatistics() {
  const [s, setS] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const load = () => fetch("/api/platform-stats").then((r) => r.json()).then(setS).catch(() => setFailed(true));
    load();
    // Keeps climbing as the product is actually used; paused when backgrounded.
    const t = setInterval(() => { if (!document.hidden) load(); }, 30000);
    return () => clearInterval(t);
  }, []);

  // Hide on a failed fetch AND on a successful-but-empty one. A fresh
  // environment (or an empty KV) legitimately returns zeros, and rendering
  // "0 payments settled · 0% approval" under a heading that claims real
  // mainnet usage is worse than showing nothing at all — it actively argues
  // against the product. Only render once there is genuine activity.
  const empty = s !== null && s.totalPayments === 0;
  if (failed || empty) return null;

  const approval = s ? Math.round(s.compliance.approvalRate * 100) : null;

  return (
    <section className={`${SECTION} bg-panel/20`}>
      <div className="mx-auto max-w-6xl px-6">
        <SectionHead
          title="Running on Monad Mainnet today"
          body="Live totals from the same engine that settles every automation. These are real payments, not a demo environment."
        />

        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile label="Payments settled" loading={!s}>
            <span className="tabular-nums">{s?.totalPayments.toLocaleString()}</span>
          </StatTile>
          <StatTile label="Total volume" loading={!s}>
            {s && <VolumeInline byToken={s.volumeByToken} size={16} />}
          </StatTile>
          <StatTile label="Compliance approval rate" loading={!s}>
            <span className="tabular-nums">{approval}%</span>
          </StatTile>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Aggregate and anonymized — counts and volume only, never a wallet address or an individual&apos;s history.
        </p>
      </div>
    </section>
  );
}

function StatTile({ label, children, loading }: { label: string; children: React.ReactNode; loading: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }} transition={{ duration: 0.4, ease: "easeOut" }}
      className="rounded-xl border border-border bg-panel/60 p-6 text-center transition-colors duration-200 hover:border-primary/30"
    >
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-3 flex min-h-[2rem] items-center justify-center text-2xl font-semibold tracking-tight text-foreground">
        {loading ? <span className="h-7 w-24 animate-pulse rounded bg-border/70" /> : children}
      </div>
    </motion.div>
  );
}

/* ── API for Developers — real routes only ──────────────────────────────── */

const ENDPOINTS = [
  { method: "POST", path: "/api/merchants", body: "Self-serve merchant signup — returns the API key used below." },
  { method: "GET", path: "/api/tokens", body: "The verified Monad token registry, or resolve any contract address." },
  { method: "POST", path: "/api/automations", body: "Create a wallet-signed automation, single-recipient or bulk." },
  { method: "GET", path: "/api/automations", body: "List automations, their runs, and per-recipient results." },
  { method: "GET", path: "/api/onchain", body: "On-chain payment records straight from PaymentExecutor." },
  { method: "GET", path: "/api/health", body: "Engine, RPC, scheduler, and agent-wallet status." },
];

export function DeveloperApi() {
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-6xl px-6">
        <SectionHead
          title="Built to integrate"
          body="Every capability in the product is an HTTP endpoint, authenticated with an x-api-key or bearer token. The contracts and the full source are public."
        />

        <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
          <motion.div
            initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-40px" }} transition={{ duration: 0.45, ease: "easeOut" }}
            className="overflow-hidden rounded-xl border border-border bg-panel/60"
          >
            <div className="border-b border-border px-5 py-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Endpoints</p>
            </div>
            <div className="divide-y divide-border/70">
              {ENDPOINTS.map((e) => (
                <div key={e.method + e.path} className="flex items-start gap-3 px-5 py-3.5 transition-colors duration-150 hover:bg-white/[0.02]">
                  <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${e.method === "POST" ? "bg-exec-scheduled/15 text-exec-scheduled" : "bg-info/15 text-info"}`}>
                    {e.method}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-foreground">{e.path}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{e.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-40px" }} transition={{ delay: 0.08, duration: 0.45, ease: "easeOut" }}
            className="flex flex-col justify-center gap-4"
          >
            <DevPoint icon={Code2} title="Open source" body="The whole application, including the execution engine, is public on GitHub." />
            <DevPoint icon={Blocks} title="Verified contracts" body="PaymentExecutor, MerchantRegistry, and AutomationVault are deployed and verifiable on Monad mainnet." />
            <DevPoint icon={ShieldCheck} title="Idempotent by design" body="Every execution carries a request id enforced both in the app and on-chain, so a retry can never double-pay." />
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function DevPoint({ icon: Icon, title, body }: { icon: typeof Code2; title: string; body: string }) {
  return (
    <div className="flex gap-3.5 rounded-xl border border-border bg-panel/40 p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary-ink">
        <Icon size={16} />
      </span>
      <div>
        <p className="text-sm font-semibold tracking-tight text-foreground">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

/* ── Ecosystem — only what is genuinely wired ───────────────────────────── */

const INTEGRATIONS = [
  { icon: MonadMark, title: "Monad Mainnet", body: "Every payment and automation settles on Monad, with sub-second finality and fees low enough for recurring runs.", brand: true },
  { icon: AtSign, title: "Nad Name Service", body: "Pay a .nad or .nads name instead of a 42-character address. Resolved on-chain, then re-verified server-side before anything sends." },
  { icon: Wallet, title: "Any EIP-6963 wallet", body: "MetaMask, Rabby, Backpack, OKX, Coinbase and more are detected automatically — plus WalletConnect for mobile." },
  { icon: Database, title: "Durable scheduling", body: "Automations are indexed and persisted so a due payment survives restarts and fires on time, every time." },
];

export function EcosystemIntegrations() {
  return (
    <section className={`${SECTION} bg-panel/20`}>
      <div className="mx-auto max-w-6xl px-6">
        <SectionHead
          title="Part of the Monad stack"
          body="PayAI plugs into what the ecosystem already uses, so an automation works with the wallet and the name you already have."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          {INTEGRATIONS.map((it, i) => (
            <motion.div
              key={it.title}
              initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ delay: i * 0.07, duration: 0.45, ease: "easeOut" }}
              className="group flex gap-4 rounded-xl border border-border bg-panel/50 p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-panel"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary-ink transition-colors duration-200 group-hover:border-primary/30">
                {it.brand ? <MonadMark size={18} /> : <it.icon size={18} />}
              </span>
              <div className="min-w-0">
                <p className="text-base font-semibold tracking-tight text-foreground">{it.title}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{it.body}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
