"use client";

import { motion, AnimatePresence } from "motion/react";
import { PipelineStepper } from "@/components/PipelineStepper";
import { RiskGauge } from "@/components/RiskGauge";
import { Badge, Button, Card, Input } from "@/components/ui";
import { WalletBar } from "@/components/WalletBar";
import { useAgentConsole, DECISION, short } from "@/lib/hooks/useAgentConsole";

const SAMPLES = [
  "Send 20 USDC to 0x1234567890abcdef1234567890abcdef12345678",
  "Send 10 USDC to gentle.nads",
  "Send 1 MON to alice.nad",
  "Show my transaction history",
];

/**
 * Variant A — "Dashboard Console" (Stripe/Mercury-grade).
 *
 * Persistent top KPI strip (volume, approvals, risk posture, on-chain
 * payments) gives at-a-glance trust signals before any command runs — the
 * thing the original single-column page never showed until after a result.
 * Left rail: command input + live activity feed. Right rail: a tabbed
 * inspector (Pipeline / Compliance / Chain) so all four required visibility
 * types — transaction, compliance, wallet, blockchain — are simultaneously
 * on-screen, not buried in scroll order.
 */
export default function ConsoleVariant() {
  const c = useAgentConsole();
  const w = c.health?.wallet;
  const stats = c.onchain?.stats;

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <motion.header
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
        className="mb-6 flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2L4 6v6c0 5 4 8 8 10 4-2 8-5 8-10V6l-8-4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">PayAI <span className="text-muted-foreground">/ Command Center</span></h1>
            <p className="text-xs text-muted-foreground">Monad mainnet · real-time agent payments</p>
          </div>
        </div>
        <WalletBar
          address={c.wallet.address} isWrongNetwork={c.wallet.isWrongNetwork} busy={c.walletBusy} error={c.wallet.error}
          onConnect={() => { c.setWalletBusy(true); c.wallet.connect().catch(() => {}).finally(() => c.setWalletBusy(false)); }}
          onDisconnect={c.wallet.disconnect}
          onSwitchNetwork={() => { c.setWalletBusy(true); c.wallet.switchNetwork().catch(() => {}).finally(() => c.setWalletBusy(false)); }}
        />
      </motion.header>

      {/* KPI strip — wallet + on-chain visibility, always on screen */}
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.35 }}
        className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        {[
          { label: "Agent wallet", value: w ? `${Number(w.nativeBalance).toFixed(2)} ${w.symbol}` : "—", sub: w ? short(w.address) : "not configured", tone: w?.configured ? "success" : "neutral" },
          { label: "On-chain volume", value: stats ? `${stats.volume.toLocaleString()} USDC` : "—", sub: stats ? `${stats.payments} payments` : "no executor", tone: "primary" },
          { label: "Approval rate", value: stats && stats.payments ? `${Math.round((stats.approved / Math.max(1, stats.approved + stats.rejected)) * 100)}%` : "—", sub: stats ? `${stats.rejected} rejected` : "—", tone: "success" },
          { label: "Network", value: w?.network ?? "—", sub: c.health?.verigate.connected ? "RPC reachable" : "checking…", tone: c.health?.verigate.connected ? "success" : "warning" },
        ].map((k) => (
          <Card key={k.label} className="p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{k.label}</p>
            <p className="mt-1 text-xl font-semibold text-foreground">{k.value}</p>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/70">{k.sub}</p>
          </Card>
        ))}
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        {/* Left rail */}
        <div className="flex flex-col gap-4">
          <Card>
            <label className="mb-2 block text-sm font-medium text-foreground">Command</label>
            <div className="flex gap-2">
              <Input
                value={c.intent} onChange={(e) => c.setIntent(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && c.intent && c.run(c.intent)}
                placeholder="Send 20 USDC to 0x… for invoice #42" className="flex-1"
              />
              <Button onClick={() => c.intent && c.run(c.intent)} disabled={c.loading || c.walletBusy || !c.intent}>
                {c.walletBusy ? "Sign in wallet…" : c.loading ? "Verifying…" : "Run"}
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {SAMPLES.map((s) => (
                <button key={s} onClick={() => { c.setIntent(s); c.run(s); }}
                  className="rounded-full border border-border bg-input px-3 py-1 text-xs text-muted-foreground transition hover:border-primary/50 hover:text-primary">
                  {s.length > 36 ? s.slice(0, 34) + "…" : s}
                </button>
              ))}
            </div>
          </Card>

          <AnimatePresence>
            {c.err && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{c.err}</motion.div>
            )}
          </AnimatePresence>

          {c.res && (
            <Card>
              <div className="mb-2 flex items-center justify-between">
                <Badge tone={DECISION[c.res.decision].tone}>{DECISION[c.res.decision].label}</Badge>
                <span className="text-xs text-muted-foreground">{Math.round(c.res.confidence * 100)}% confidence</span>
              </div>
              <p className="text-sm text-foreground">{c.res.intent.summary}</p>
              {c.res.transaction?.txHash && (
                <a href={c.res.transaction.explorerUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block font-mono text-xs text-primary hover:underline">
                  {short(c.res.transaction.txHash)} — verify on-chain ↗
                </a>
              )}
            </Card>
          )}

          <Card title="Live activity">
            {c.history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet — run a command to see it stream in here.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {c.history.map((h, i) => (
                  <motion.li key={i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 5) * 0.04 }}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-input/40 px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge tone={DECISION[h.decision]?.tone ?? "neutral"}>{DECISION[h.decision]?.label ?? h.decision}</Badge>
                      <span className="text-muted-foreground">{h.amount ?? "—"} {h.token}</span>
                    </div>
                    {h.txHash ? (
                      <a href={h.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-primary hover:underline">{short(h.txHash)} ↗</a>
                    ) : <span className="text-xs text-muted-foreground">{h.at}</span>}
                  </motion.li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Right rail — inspector */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-10 lg:self-start">
          <Card title="Verification pipeline">
            <PipelineStepper steps={c.steps} />
          </Card>

          {c.res?.compliance && (
            <Card title="Compliance">
              <p className="mb-2 text-sm text-foreground">{c.res.compliance.summary}</p>
              <ul className="space-y-1.5">
                {c.res.compliance.checks.map((chk) => (
                  <li key={chk.id} className="flex items-start gap-2 text-xs">
                    <span className={chk.passed ? "text-success" : "text-danger"}>{chk.passed ? "✓" : "✕"}</span>
                    <span className="text-muted-foreground">{chk.label}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {c.res?.risk && (
            <Card title="Risk">
              <RiskGauge score={c.res.risk.score} level={c.res.risk.level} />
            </Card>
          )}

          {c.onchain?.contracts && (
            <Card title="Chain">
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between"><dt className="text-muted-foreground">PaymentExecutor</dt>
                  <dd><a href={c.onchain.contracts.executorExplorer} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline">{short(c.onchain.contracts.paymentExecutor)} ↗</a></dd>
                </div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Total payments</dt><dd className="text-foreground">{stats?.payments ?? "—"}</dd></div>
              </dl>
            </Card>
          )}
        </div>
      </div>
    </main>
  );
}
