"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { ShieldCheck, Blocks, AtSign, Wallet, Database, Code2 } from "lucide-react";
import { TokenLogo } from "@/components/TokenLogo";
import { MonadMark } from "@/components/MonadMark";
import { formatUsd } from "@/lib/hooks/useTokenPrices";
import type { RevenueFeature } from "@/lib/platform/types";
import { DOCS_ORIGIN } from "@/lib/hosts";

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
          title="Every token on Monad"
          body="The execution engine is token-agnostic. Any action — a payment, a trade, or a scheduled run — can settle in MON or any fungible token on Monad. Decimals are read from the contract itself, never assumed."
        />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tokens === null
            ? Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 rounded-xl surface-purple p-5">
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
                  className="group flex items-center gap-3 rounded-xl surface-purple p-5 transition-all duration-200"
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

interface MonthlyFeatureUsd {
  month: string; // YYYY-MM
  byFeature: Record<RevenueFeature, number | null>;
  total: number | null;
}

interface Stats {
  totalPayments: number;
  volumeByToken: Record<string, number>;
  settledVolumeUsd: number | null;
  settledVolumeMon: number | null;
  unpricedSettledTokens: string[];
  activityVolumeByToken: Record<string, number>;
  activityVolumeUsd: number | null;
  activityVolumeMon: number | null;
  unpricedTokens: string[];
  monthlyVolumeUsd: MonthlyFeatureUsd[];
  compliance: { approvalRate: number };
  trend?: { date: string; revenue: number; count: number }[];
}

/** Formats a MON amount the same way everywhere it's shown: more precision
 *  under 1 MON (so a small real amount doesn't collapse to "0.00"), fewer
 *  decimals above it, matching the existing formatUsd convention. */
function formatMon(v: number | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v.toLocaleString(undefined, { maximumFractionDigits: v > 0 && v < 1 ? 4 : 2 });
}

/**
 * Fixed categorical order + colors for the 4 features a transaction can
 * come from. These four hex pairs (dark-surface steps) are the validated
 * default categorical palette's first four slots, in the one order proven
 * (by running the CVD/contrast validator) to clear every adjacent-pair gate
 * for a stacked bar on this app's dark surface — not hand-picked. Kept local
 * to this chart rather than added as global design tokens, since nothing
 * else in the product needs a 4-way categorical split; every other surface
 * stays the single-purple brand palette.
 */
const FEATURE_ORDER: RevenueFeature[] = ["payment", "swap", "automation", "bulk"];
const FEATURE_LABEL: Record<RevenueFeature, string> = {
  payment: "Payments",
  swap: "Swaps",
  automation: "Automations",
  bulk: "Bulk distributions",
};
// Drawn on the purple panel, so light tints: each is 4.2:1 or better
// against it, and they stay apart by hue.
const FEATURE_COLOR: Record<RevenueFeature, string> = {
  payment: "#ffffff",
  swap: "#fde68a",
  automation: "#a7f3d0",
  bulk: "#bae6fd",
};

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
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
  const hasSettledRaw = s ? Object.values(s.volumeByToken).some((v) => v > 0) : false;
  const hasActivityRaw = s ? Object.values(s.activityVolumeByToken).some((v) => v > 0) : false;
  const trend = s?.trend ?? [];
  const peak = Math.max(1, ...trend.map((d) => d.count));

  const monthly = s?.monthlyVolumeUsd ?? [];
  const hasMonthly = monthly.some((m) => (m.total ?? 0) > 0);
  const maxMonthTotal = Math.max(1, ...monthly.map((m) => m.total ?? 0));
  const CHART_H = 144; // px — matches h-36; kept as a JS constant so bar/segment
  // heights are computed as real px numbers rather than nested CSS percentages
  // (a percentage height on a flex child only resolves against a DIRECT
  // ancestor with a definite height — see the h-24 comment on the 7-day
  // sparkline above; computing px in JS sidesteps that constraint entirely).
  const GAP_PX = 2; // the stacked-segment "surface gap" spec

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
          className="overflow-hidden rounded-2xl surface-purple"
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

          {/* Volume bands — ONE number in MON plus its $ worth, not a
              per-token list. Converting each asset to USD first and summing
              THAT is a real common unit; the old per-token cells existed
              because adding raw MON + raw USDC directly would have been the
              fabrication this codebase refuses elsewhere (5 MON + 5 USDC is
              not 10 of anything). Live-quoted off the same DEX the swap
              engine prices against (lib/monad/prices.ts) — approximate, and
              any token that can't be confidently priced is excluded and
              named, never guessed into the total. */}
          <VolumeBand
            label="Total volume settled"
            mon={s?.settledVolumeMon ?? null}
            usd={s?.settledVolumeUsd ?? null}
            unpriced={s?.unpricedSettledTokens ?? []}
            loading={!s}
            hasRaw={hasSettledRaw}
            emptyText="No settled volume yet."
          />

          {/* A second, separate band — NOT added to the one above. "Total
              volume settled" is money paid to someone (revenue); a swap
              moves a user's own funds between tokens they already hold, so
              it can't be folded into that figure without misrepresenting it.
              This band is every completed transaction on every feature —
              payments, swaps, automations, bulk distributions. */}
          <VolumeBand
            label="Total activity volume · every feature, incl. swaps"
            mon={s?.activityVolumeMon ?? null}
            usd={s?.activityVolumeUsd ?? null}
            unpriced={s?.unpricedTokens ?? []}
            loading={!s}
            hasRaw={hasActivityRaw}
            emptyText="No activity yet."
          />

          {/* Monthly breakdown — same activity total as the band above, over
              time and split by feature, so it lives in the same panel
              rather than repeating the headline number in a second card. */}
          {hasMonthly && (
            <div className="border-t border-border/70 bg-background/40 px-6 py-6 sm:px-7">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Monthly volume by feature
                </p>
                {/* Legend — the dependable identity channel for 4 series;
                    never make the reader rely on color-matching alone. */}
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {FEATURE_ORDER.map((f) => (
                    <div key={f} className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                      <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: FEATURE_COLOR[f] }} />
                      {FEATURE_LABEL[f]}
                    </div>
                  ))}
                </div>
              </div>

              <div
                className="flex items-end gap-3 sm:gap-4"
                role="img"
                aria-label={`Monthly platform activity volume in USD over the last ${monthly.length} months, by feature: ${monthly
                  .map((m) => `${monthLabel(m.month)} ${m.total != null ? formatUsd(m.total) : "unavailable"}`)
                  .join(", ")}`}
              >
                {monthly.map((m) => {
                  const activeFeatures = FEATURE_ORDER.filter((f) => (m.byFeature[f] ?? 0) > 0);
                  const barHeightPx = m.total ? Math.max(6, (m.total / maxMonthTotal) * CHART_H) : 3;
                  const totalGapPx = Math.max(0, activeFeatures.length - 1) * GAP_PX;
                  const usableH = Math.max(0, barHeightPx - totalGapPx);
                  return (
                    <div key={m.month} className="flex flex-1 flex-col items-center gap-2">
                      <div className="flex flex-col items-center justify-end" style={{ height: CHART_H }}>
                        {m.total != null && m.total > 0 && (
                          <span className="mb-1 whitespace-nowrap text-[10px] font-medium tabular-nums text-muted-foreground">
                            {formatUsd(m.total)}
                          </span>
                        )}
                        <div
                          className="flex w-full flex-col-reverse gap-0.5 rounded-t-md bg-border/20"
                          style={{ height: barHeightPx }}
                        >
                          {/* NOT overflow-hidden: that would also clip the hover
                              tooltip, which needs to float above this box. Only
                              the topmost segment (last in flex-col-reverse
                              order) gets the rounded corner directly, instead
                              of clipping the whole stack to get it. */}
                          {activeFeatures.map((f, i) => {
                            const usd = m.byFeature[f] ?? 0;
                            const px = (usd / (m.total || 1)) * usableH;
                            const isTop = i === activeFeatures.length - 1;
                            return (
                              <div
                                key={f}
                                className={`group/seg relative w-full ${isTop ? "rounded-t-md" : ""}`}
                                style={{ height: Math.max(1, px), backgroundColor: FEATURE_COLOR[f] }}
                              >
                                <span className="pointer-events-none absolute -top-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-panel px-2 py-1 text-[10px] font-medium text-foreground opacity-0 shadow-lg transition-opacity group-hover/seg:opacity-100">
                                  {FEATURE_LABEL[f]} · {formatUsd(usd)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <span className="text-[9px] tabular-nums text-muted-foreground">{monthLabel(m.month)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </motion.div>

        <p className="mt-5 text-center text-xs text-muted-foreground">
          Aggregate and anonymized — counts and volume only, never a wallet address or an individual&apos;s history.
          Volume is shown in MON with its dollar value alongside, live-quoted off the same DEX the swap engine
          prices against — approximate, and any token PayAI can&apos;t confidently price is excluded and named
          rather than guessed into the total. Activity volume includes swaps; volume settled does not, since a
          swap isn&apos;t money paid to anyone else.
        </p>
      </div>
    </section>
  );
}

function VolumeBand({
  label, mon, usd, unpriced, loading, hasRaw, emptyText,
}: {
  label: string; mon: number | null; usd: number | null; unpriced: string[];
  loading: boolean; hasRaw: boolean; emptyText: string;
}) {
  return (
    <div className="border-t border-border/70 bg-background/40 px-6 py-5 sm:px-7">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-3 flex flex-wrap items-baseline gap-3">
        {loading ? (
          <span className="h-8 w-40 animate-pulse rounded bg-border/70" />
        ) : mon == null ? (
          <span className="text-sm text-muted-foreground">{hasRaw ? "Not enough priced activity yet." : emptyText}</span>
        ) : (
          <>
            <div className="flex items-center gap-2.5">
              <TokenLogo token="MON" size={22} />
              <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground sm:text-3xl">
                {formatMon(mon)}
              </span>
              <span className="text-xs font-medium text-muted-foreground">MON</span>
            </div>
            {usd != null && <span className="text-sm text-muted-foreground">≈ {formatUsd(usd)}</span>}
          </>
        )}
      </div>
      {!loading && unpriced.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Excludes {unpriced.join(", ")} — not confidently priceable right now.
        </p>
      )}
    </div>
  );
}

function Cell({ label, children, loading }: { label: string; children: React.ReactNode; loading: boolean }) {
  return (
    <div className="px-6 py-7 transition-colors duration-200 hover:bg-glass/[0.015] sm:px-7">
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
  { method: "GET", path: "/api/fees", body: "Configured fee estimates (not authoritative; contracts charge their on-chain rate)." },
  { method: "GET", path: "/api/onchain", body: "Live contract addresses on this deployment." },
  { method: "GET", path: "/api/tokens", body: "Verified Monad token registry." },
  { method: "GET", path: "/api/health", body: "Liveness: network connected or not." },
];

export function DeveloperApi() {
  return (
    <section className={SECTION}>
      <div className="mx-auto max-w-6xl px-6">
        <SectionHead
          title="Public docs, not a private map"
          body="A few GET routes are public on purpose. Anything that can move funds stays behind a session in the app. The rest is not a partner API."
        />

        <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
          <motion.div
            initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-40px" }} transition={{ duration: 0.45, ease: "easeOut" }}
            className="overflow-hidden rounded-xl surface-purple"
          >
            <div className="border-b border-border px-5 py-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Public endpoints</p>
            </div>
            <div className="divide-y divide-border/70">
              {ENDPOINTS.map((e) => (
                <div key={e.method + e.path} className="flex items-start gap-3 px-5 py-3.5 transition-colors duration-150 hover:bg-glass/[0.02]">
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
            <DevPoint icon={Code2} title="HTTP, documented" body="The public GET routes and merchant key live in the docs. Session routes that move money are the app backend, not a published SDK." />
            <DevPoint icon={Blocks} title="Verified contracts" body="PayAIForwarder, PayAITradeExecutor, PaymentExecutor, MerchantRegistry, and AutomationVault are on Monad and linked from the docs." />
            <DevPoint icon={ShieldCheck} title="Idempotent by design" body="Every execution carries a request id enforced in the app and on-chain, so a retry can never double-pay." />
            <Link href={`${DOCS_ORIGIN}/api`} className="text-sm font-medium text-primary-ink hover:underline">
              Read the API docs →
            </Link>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function DevPoint({ icon: Icon, title, body }: { icon: typeof Code2; title: string; body: string }) {
  return (
    <div className="flex gap-3.5 rounded-xl surface-purple p-6 sm:p-7 transition-all duration-200">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary-ink">
        <Icon size={16} />
      </span>
      <div>
        <p className="text-base font-semibold tracking-tight text-foreground">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

/* ── Ecosystem — only what is genuinely wired ───────────────────────────── */

const INTEGRATIONS = [
  { icon: MonadMark, title: "Monad Mainnet", body: "Every payment and automation settles on Monad, with fast confirmation and fees low enough for recurring runs.", brand: true },
  { icon: AtSign, title: "Nad Name Service", body: "Pay a .nad or .nads name instead of a 42-character address. Resolved on-chain, then re-verified server-side before anything sends." },
  { icon: Wallet, title: "Any EIP-6963 wallet", body: "MetaMask, Rabby, Backpack, OKX, Coinbase and more are detected automatically — plus WalletConnect for mobile." },
  { icon: Database, title: "Durable scheduling", body: "Automations are indexed and persisted, so a due payment survives restarts and runs when it's due." },
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
              className="group flex gap-4 rounded-xl surface-purple p-6 transition-all duration-200"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary-ink transition-colors duration-200 group-hover:border-primary/30">
                {it.brand ? <MonadMark size={18} /> : <it.icon size={18} />}
              </span>
              <div className="min-w-0">
                <p className="text-base font-semibold tracking-tight text-foreground">{it.title}</p>
                <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{it.body}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
