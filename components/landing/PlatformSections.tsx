"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ShieldCheck, Blocks, AtSign, Wallet, Database, Code2 } from "lucide-react";
import { TokenLogo } from "@/components/TokenLogo";
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
  trend?: { date: string; revenue: number; count: number }[];
}

/**
 * Platform statistics.
 *
 * Presented as ONE bordered panel with divided cells rather than three
 * floating cards. The reason is the volume figure: PayAI never blends MON and
 * USDC into a single meaningless total, so "total volume" is inherently N
 * numbers, not one. Cramming two tokens into a tile sized for one big number
 * is what made the old version look wrong — the tile promised a headline
 * figure and delivered a squeezed list.
 *
 * So volume gets its own full-width band where each token has its own cell
 * and room to breathe, while the genuinely-single-number stats (count,
 * approval rate) sit in the compact row above it. Adding a token widens the
 * band instead of crushing a tile.
 */
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
  // "0 payments settled · 0% approval" is worse than showing nothing — it
  // actively argues against the product.
  const empty = s !== null && s.totalPayments === 0;
  if (failed || empty) return null;

  const approval = s ? Math.round(s.compliance.approvalRate * 100) : null;
  const tokens = s ? Object.entries(s.volumeByToken).filter(([, v]) => v > 0) : [];
  const trend = s?.trend ?? [];
  const peak = Math.max(1, ...trend.map((d) => d.count));

  return (
    <section className={`${SECTION} bg-panel/20`}>
      <div className="mx-auto max-w-6xl px-6">
        <SectionHead
          title="Platform metrics"
          body="Live figures from the engine that settles every automation, updating as the product is used. Real payments on Monad Mainnet, not a demo environment."
        />

        <motion.div
          initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-50px" }} transition={{ duration: 0.5, ease: "easeOut" }}
          className="overflow-hidden rounded-2xl border border-border bg-panel/60 shadow-2xl shadow-black/20"
        >
          {/* Hairline highlight along the top edge — the premium-surface tell. */}
          <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

          {/* Single-number stats + a 7-day activity sparkline. */}
          <div className="grid divide-y divide-border/70 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Cell label="Payments settled" loading={!s}>
              <Figure>{s?.totalPayments.toLocaleString()}</Figure>
            </Cell>

            <Cell label="Compliance approval rate" loading={!s}>
              <Figure>{approval}%</Figure>
            </Cell>

            <Cell label="Activity · last 7 days" loading={!s}>
              {/* Real per-day payment counts from the same payload. Bars, not a
                  smoothed line: the values are small integers, and a curve
                  through them would imply precision that isn't there. */}
              <div className="flex h-9 items-end gap-1.5" role="img" aria-label={`Payments per day over the last 7 days, ${trend.map((d) => d.count).join(", ")}`}>
                {trend.map((d) => (
                  <div key={d.date} className="group/bar relative flex-1">
                    <div
                      className="w-full rounded-sm bg-primary/70 transition-colors group-hover/bar:bg-primary"
                      style={{ height: Math.max(2, (d.count / peak) * 36) }}
                    />
                  </div>
                ))}
              </div>
            </Cell>
          </div>

          {/* Volume band — one cell per token, never blended into one number. */}
          <div className="border-t border-border/70 bg-background/40 px-6 py-5 sm:px-7">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Total volume settled
            </p>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-10 gap-y-4">
              {!s
                ? Array.from({ length: 2 }).map((_, i) => (
                    <span key={i} className="h-8 w-32 animate-pulse rounded bg-border/70" />
                  ))
                : tokens.length === 0
                  ? <span className="text-sm text-muted-foreground">No settled volume yet.</span>
                  : tokens.map(([token, v]) => (
                      <div key={token} className="flex items-center gap-2.5">
                        <TokenLogo token={token} size={22} />
                        <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground sm:text-3xl">
                          {v.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                        <span className="text-xs font-medium text-muted-foreground">{token}</span>
                      </div>
                    ))}
            </div>
          </div>
        </motion.div>

        <p className="mt-5 text-center text-xs text-muted-foreground">
          Aggregate and anonymized — counts and volume only, never a wallet address or an individual&apos;s history.
          MON and USDC are shown separately because a blended total would be meaningless.
        </p>
      </div>
    </section>
  );
}

function Cell({ label, children, loading }: { label: string; children: React.ReactNode; loading: boolean }) {
  return (
    <div className="px-6 py-7 transition-colors duration-200 hover:bg-white/[0.015] sm:px-7">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-3 flex min-h-[2.25rem] items-end">
        {loading ? <span className="h-8 w-24 animate-pulse rounded bg-border/70" /> : children}
      </div>
    </div>
  );
}

function Figure({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-3xl font-semibold tabular-nums tracking-tight text-foreground sm:text-4xl">
      {children}
    </span>
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
