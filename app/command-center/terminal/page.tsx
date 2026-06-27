"use client";

import { motion, AnimatePresence } from "motion/react";
import { Badge } from "@/components/ui";
import { WalletBar } from "@/components/WalletBar";
import { useAgentConsole, DECISION, short, STAGE_LABEL } from "@/lib/hooks/useAgentConsole";

/**
 * Variant B — "Terminal Ledger" (Bloomberg / trading-desk grade).
 *
 * Dense, monospace, three-pane layout: a slim command bar up top (CLI feel,
 * not a chat box), a live multi-column ledger as the dominant surface
 * (transaction + compliance + chain proof in one row per payment — no
 * tab-switching to see all four visibility types), and a thin right rail for
 * wallet + pipeline state. Built for someone monitoring volume all day, not
 * a one-off command.
 */
export default function TerminalVariant() {
  const c = useAgentConsole();
  const w = c.health?.wallet;

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 font-mono">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-primary">VERIPAY//AI</span>
          <span className="text-xs text-muted-foreground">monad-mainnet · chain {w?.chainId ?? "—"}</span>
          <span className={`h-1.5 w-1.5 rounded-full ${c.health?.verigate.connected ? "bg-success" : "bg-border"}`} />
        </div>
        <WalletBar
          address={c.wallet.address} isWrongNetwork={c.wallet.isWrongNetwork} busy={c.walletBusy} error={c.wallet.error}
          onConnect={() => { c.setWalletBusy(true); c.wallet.connect().catch(() => {}).finally(() => c.setWalletBusy(false)); }}
          onDisconnect={c.wallet.disconnect}
          onSwitchNetwork={() => { c.setWalletBusy(true); c.wallet.switchNetwork().catch(() => {}).finally(() => c.setWalletBusy(false)); }}
        />
      </header>

      {/* Command bar — CLI-style, not a chat box */}
      <div className="mb-4 flex items-center gap-2 rounded border border-border bg-panel px-3 py-2">
        <span className="text-primary">{">"}</span>
        <input
          value={c.intent} onChange={(e) => c.setIntent(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && c.intent && c.run(c.intent)}
          placeholder="send 20 usdc to 0x... | send 1 mon to alice.nad | show history"
          className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        <button
          onClick={() => c.intent && c.run(c.intent)} disabled={c.loading || c.walletBusy || !c.intent}
          className="rounded bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-40"
        >
          {c.walletBusy ? "SIGN" : c.loading ? "RUN…" : "EXEC"}
        </button>
      </div>

      <AnimatePresence>
        {c.err && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="mb-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{c.err}</motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        {/* Dense ledger — every row carries tx + compliance + chain proof */}
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border bg-panel text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 pl-3 pr-2">Time</th>
                <th className="px-2">Decision</th>
                <th className="px-2">Amount</th>
                <th className="px-2">Risk</th>
                <th className="px-2">Fee</th>
                <th className="px-2">Tx Hash</th>
                <th className="px-2 pr-3">Explorer</th>
              </tr>
            </thead>
            <tbody>
              {c.res && (
                <motion.tr initial={{ opacity: 0, backgroundColor: "rgba(34,211,238,0.08)" }} animate={{ opacity: 1, backgroundColor: "rgba(0,0,0,0)" }}
                  transition={{ duration: 1.2 }} className="border-b border-border/60">
                  <td className="py-2 pl-3 pr-2 text-muted-foreground">now</td>
                  <td className="px-2"><Badge tone={DECISION[c.res.decision].tone}>{DECISION[c.res.decision].label}</Badge></td>
                  <td className="px-2 text-foreground">{c.res.intent.amount ?? "—"} {c.res.intent.token}</td>
                  <td className="px-2 text-foreground">{c.res.riskScore ?? "—"}</td>
                  <td className="px-2 text-muted-foreground">{c.res.transaction?.gasFee ?? c.res.transaction?.gasEstimate ?? "—"}</td>
                  <td className="px-2 text-foreground">{short(c.res.transaction?.txHash)}</td>
                  <td className="px-2 pr-3">{c.res.transaction?.explorerUrl ? <a href={c.res.transaction.explorerUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">↗</a> : "—"}</td>
                </motion.tr>
              )}
              {c.history.map((h, i) => (
                <tr key={i} className="border-b border-border/40 hover:bg-input/30">
                  <td className="py-1.5 pl-3 pr-2 text-muted-foreground">{h.at}</td>
                  <td className="px-2"><Badge tone={DECISION[h.decision]?.tone ?? "neutral"}>{DECISION[h.decision]?.label ?? h.decision}</Badge></td>
                  <td className="px-2 text-foreground">{h.amount ?? "—"} {h.token}</td>
                  <td className="px-2 text-foreground">{h.risk ?? "—"}</td>
                  <td className="px-2 text-muted-foreground">{h.gasFee ?? "—"}</td>
                  <td className="px-2 text-foreground">{short(h.txHash)}</td>
                  <td className="px-2 pr-3">{h.explorerUrl ? <a href={h.explorerUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">↗</a> : "—"}</td>
                </tr>
              ))}
              {!c.res && c.history.length === 0 && (
                <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">no executions this session — run a command above</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Thin right rail — wallet + pipeline as status readouts */}
        <div className="flex flex-col gap-3">
          <div className="rounded border border-border bg-panel p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">agent wallet</p>
            <p className="mt-1 text-sm text-foreground">{w ? `${Number(w.nativeBalance).toFixed(3)} ${w.symbol}` : "—"}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/70">{w ? short(w.address) : "not configured"}</p>
          </div>

          <div className="rounded border border-border bg-panel p-3">
            <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">pipeline</p>
            <ul className="space-y-1.5">
              {c.steps.map((s) => (
                <li key={s.key} className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">{STAGE_LABEL[s.key]}</span>
                  <span className={
                    s.state === "ok" ? "text-success" : s.state === "warn" ? "text-warning" : s.state === "blocked" ? "text-danger" : s.state === "active" ? "text-primary" : "text-muted-foreground/40"
                  }>{s.state.toUpperCase()}</span>
                </li>
              ))}
            </ul>
          </div>

          {c.res?.compliance && (
            <div className="rounded border border-border bg-panel p-3">
              <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">compliance</p>
              {c.res.compliance.checks.map((chk) => (
                <div key={chk.id} className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">{chk.label}</span>
                  <span className={chk.passed ? "text-success" : "text-danger"}>{chk.passed ? "PASS" : "FAIL"}</span>
                </div>
              ))}
            </div>
          )}

          {c.onchain?.stats && (
            <div className="rounded border border-border bg-panel p-3">
              <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">on-chain (mainnet)</p>
              <div className="grid grid-cols-2 gap-1 text-[11px]">
                <span className="text-muted-foreground">payments</span><span className="text-right text-foreground">{c.onchain.stats.payments}</span>
                <span className="text-muted-foreground">volume</span><span className="text-right text-foreground">{c.onchain.stats.volume}</span>
                <span className="text-muted-foreground">approved</span><span className="text-right text-success">{c.onchain.stats.approved}</span>
                <span className="text-muted-foreground">rejected</span><span className="text-right text-danger">{c.onchain.stats.rejected}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
