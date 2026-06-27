"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { PipelineStepper } from "@/components/PipelineStepper";
import { RiskGauge } from "@/components/RiskGauge";
import { Badge, Button, Input } from "@/components/ui";
import { WalletBar } from "@/components/WalletBar";
import { useAgentConsole, DECISION, short, type AgentResult, type InfoResult } from "@/lib/hooks/useAgentConsole";

interface Message {
  role: "user" | "agent";
  text: string;
  result?: AgentResult;
  info?: InfoResult;
}

/**
 * Variant C — "Conversational Assistant" (Mercury-grade simplicity).
 *
 * The agent reads as a chat partner, not a form: every command becomes a
 * message bubble, every response renders as a rich card inline in the
 * stream (pipeline + compliance + risk + settlement collapsed by default,
 * expandable) rather than a fixed sidebar. This is the layout for someone
 * who wants to *talk* to the payment agent, with full verification depth
 * one click away instead of always-on screen real estate.
 */
export default function ConversationVariant() {
  const c = useAgentConsole();
  const [messages, setMessages] = useState<Message[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);

  async function send() {
    if (!c.intent || c.loading) return;
    const text = c.intent;
    setMessages((m) => [...m, { role: "user", text }]);
    c.setIntent("");
    await c.run(text);
  }

  // Mirror the hook's latest result into the message stream once it lands —
  // payment-pipeline results (AgentResult) and read-only query answers
  // (InfoResult, e.g. "show my history") both need a bubble; a chat surface
  // can't silently drop one of the two response shapes the backend returns.
  const lastResult = c.res;
  const resultAlreadyShown = messages.some((m) => m.result === lastResult);
  if (lastResult && !resultAlreadyShown) {
    setMessages((m) => [...m, { role: "agent", text: lastResult.intent.summary, result: lastResult }]);
  }
  const lastInfo = c.info;
  const infoAlreadyShown = messages.some((m) => m.info === lastInfo);
  if (lastInfo && !infoAlreadyShown) {
    const text = lastInfo.query === "show_history"
      ? `You have ${lastInfo.count ?? lastInfo.history?.length ?? 0} recorded transaction${(lastInfo.count ?? 0) === 1 ? "" : "s"}.`
      : lastInfo.compliance
        ? `${Math.round(lastInfo.compliance.approvalRate * 100)}% approval rate — ${lastInfo.compliance.approved} approved, ${lastInfo.compliance.review} in review, ${lastInfo.compliance.rejected} rejected, ${lastInfo.compliance.blocked} blocked.`
        : "No compliance activity recorded yet.";
    setMessages((m) => [...m, { role: "agent", text, info: lastInfo }]);
  }

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col px-6 py-8">
      <header className="mb-4 flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">PayAI <span className="text-primary">Assistant</span></h1>
          <p className="text-xs text-muted-foreground">Monad mainnet · talk to your payment agent</p>
        </div>
        <WalletBar
          address={c.wallet.address} isWrongNetwork={c.wallet.isWrongNetwork} busy={c.walletBusy} error={c.wallet.error}
          onConnect={() => { c.setWalletBusy(true); c.wallet.connect().catch(() => {}).finally(() => c.setWalletBusy(false)); }}
          onDisconnect={c.wallet.disconnect}
          onSwitchNetwork={() => { c.setWalletBusy(true); c.wallet.switchNetwork().catch(() => {}).finally(() => c.setWalletBusy(false)); }}
        />
      </header>

      <div className="flex-1 overflow-y-auto pr-1">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">Tell me what to pay — I&apos;ll verify, screen, and settle it.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {["Send 5 USDC to gentle.nads", "Send 1 MON to alice.nad", "Show my transaction history"].map((s) => (
                <button key={s} onClick={() => { c.setIntent(s); }} className="rounded-full border border-border bg-input px-3 py-1.5 text-xs text-muted-foreground hover:border-primary/50 hover:text-primary">{s}</button>
              ))}
            </div>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((m, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: "easeOut" }}
              className={`mb-3 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${m.role === "user" ? "bg-primary text-primary-foreground" : "border border-border bg-panel text-foreground"}`}>
                {m.role === "user" ? (
                  m.text
                ) : m.info ? (
                  <div>
                    <p>{m.text}</p>
                    {m.info.query === "show_history" && m.info.history && m.info.history.length > 0 && (
                      <ul className="mt-2 space-y-1 border-t border-border pt-2">
                        {m.info.history.slice(0, 5).map((h, hi) => (
                          <li key={hi} className="flex items-center justify-between gap-2 text-xs">
                            <Badge tone={DECISION[h.decision]?.tone ?? "neutral"}>{DECISION[h.decision]?.label ?? h.decision}</Badge>
                            <span className="text-muted-foreground">{h.amount ?? "—"} {h.token}</span>
                            {h.txHash && h.explorerUrl ? (
                              <a href={h.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline">{short(h.txHash)} ↗</a>
                            ) : <span className="text-muted-foreground/60">—</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <div>
                    <div className="mb-1.5 flex items-center gap-2">
                      <Badge tone={m.result ? DECISION[m.result.decision].tone : "neutral"}>{m.result ? DECISION[m.result.decision].label : "…"}</Badge>
                      {m.result?.transaction?.txHash && (
                        <a href={m.result.transaction.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-primary hover:underline">{short(m.result.transaction.txHash)} ↗</a>
                      )}
                    </div>
                    <p>{m.text}</p>
                    {m.result && (
                      <button onClick={() => setExpanded(expanded === i ? null : i)} className="mt-2 text-xs text-primary hover:underline">
                        {expanded === i ? "Hide verification details ▲" : "Show verification details ▼"}
                      </button>
                    )}
                    <AnimatePresence>
                      {expanded === i && m.result && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                          <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
                            <PipelineStepper steps={
                              ["intent", "guardrails", "compliance", "risk", "execution"].map((key) => {
                                const t = m.result!.trace.find((x) => x.step === key);
                                return { key, label: key, state: (t?.status === "ok" ? "ok" : t?.status === "warn" ? "warn" : t?.status === "blocked" ? "blocked" : "pending") as never, detail: t?.detail };
                              })
                            } />
                            {m.result.risk && <RiskGauge score={m.result.risk.score} level={m.result.risk.level} />}
                            {m.result.compliance && (
                              <ul className="space-y-1">
                                {m.result.compliance.checks.map((chk) => (
                                  <li key={chk.id} className="flex items-center gap-2 text-xs">
                                    <span className={chk.passed ? "text-success" : "text-danger"}>{chk.passed ? "✓" : "✕"}</span>
                                    <span className="text-muted-foreground">{chk.label}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {c.loading && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-3 flex justify-start">
            <div className="flex items-center gap-1.5 rounded-2xl border border-border bg-panel px-4 py-2.5">
              {[0, 1, 2].map((d) => (
                <motion.span key={d} className="h-1.5 w-1.5 rounded-full bg-primary" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: d * 0.15 }} />
              ))}
            </div>
          </motion.div>
        )}

        {c.err && (
          <div className="mb-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-2.5 text-sm text-danger">{c.err}</div>
        )}
      </div>

      <div className="mt-3 flex gap-2 border-t border-border pt-3">
        <Input
          value={c.intent} onChange={(e) => c.setIntent(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Send 20 USDC to 0x… for invoice #42" className="flex-1"
        />
        <Button onClick={send} disabled={c.loading || c.walletBusy || !c.intent}>
          {c.walletBusy ? "Sign…" : c.loading ? "…" : "Send"}
        </Button>
      </div>
    </main>
  );
}
