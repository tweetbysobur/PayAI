"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowRight, CheckCircle2, AlertTriangle, Clock3, XCircle,
  ChevronDown, ShieldCheck, ExternalLink, Wallet as WalletIcon, Loader2,
  ReceiptText, Copy, Check,
} from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { PipelineStepper } from "@/components/PipelineStepper";
import { useAgentConsole, DECISION, friendlyError } from "@/lib/hooks/useAgentConsole";
import { amountError, recipientError, isValidAmount, isValidRecipient } from "@/lib/validation";
import { MONAD_CHAIN_NAME } from "@/lib/monad/public";

const NEXT_STEP: Record<string, string> = {
  needs_review: "This payment is being reviewed — you'll be notified once it clears.",
  blocked: "This payment did not clear compliance and was not sent.",
  refused: "This payment was declined before settlement.",
  error: "Something interrupted settlement. No funds were moved.",
};

const STATUS_ICON: Record<string, typeof CheckCircle2> = {
  executed: CheckCircle2,
  needs_review: Clock3,
  blocked: XCircle,
  refused: XCircle,
  error: AlertTriangle,
};

const STATUS_COLOR: Record<string, string> = {
  executed: "text-success bg-success/12",
  needs_review: "text-warning bg-warning/12",
  blocked: "text-danger bg-danger/12",
  refused: "text-danger bg-danger/12",
  error: "text-muted-foreground bg-input",
};

export default function Payments() {
  const c = useAgentConsole();
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<"MON" | "USDC">("MON");
  const [recipient, setRecipient] = useState("");
  const [showChecks, setShowChecks] = useState(false);
  const [copied, setCopied] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchErr, setSwitchErr] = useState<string | null>(null);

  async function handleSwitchNetwork() {
    setSwitchErr(null); setSwitching(true);
    try { await c.wallet.switchNetwork(); }
    catch { setSwitchErr(`Couldn't switch automatically — switch to ${MONAD_CHAIN_NAME} in your wallet.`); }
    finally { setSwitching(false); }
  }

  const amountErr = amountError(amount);
  const recipientErr = recipientError(recipient);
  const wallet = c.wallet;
  const available = token === "MON" ? c.balances.mon : c.balances.usdc;
  const insufficientBalance =
    wallet.address != null && !c.balances.loading && available != null &&
    isValidAmount(amount) && Number(amount) > Number(available);
  const canSubmit = isValidAmount(amount) && isValidRecipient(recipient) && !c.loading && !insufficientBalance && !wallet.isWrongNetwork;

  function submit() {
    if (!canSubmit) return;
    setShowChecks(false);
    setCopied(false);
    c.run(`Send ${amount} ${token} to ${recipient}`);
  }
  function copyHash(hash: string) {
    navigator.clipboard?.writeText(hash).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }
  const StatusIcon = c.res ? STATUS_ICON[c.res.decision] ?? AlertTriangle : null;

  const hasResultArea = c.loading || c.err || c.res || c.history.length > 0;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-foreground">Send Payment</h1>
      <p className="mb-6 text-sm text-muted-foreground">Pay any wallet address or .nads domain on Monad.</p>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        {/* LEFT — composer */}
        <div>
      {/* Sender context — trust: who is paying, from where */}
      <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-panel/60 px-4 py-2.5 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <WalletIcon size={13} className={wallet.address ? "text-primary" : ""} />
          {wallet.address ? (
            <span className="font-mono text-foreground">{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span>
          ) : (
            <span>No wallet connected</span>
          )}
        </div>
        <Badge tone={wallet.address ? "success" : "neutral"}>{wallet.isWrongNetwork ? "Wrong network" : "Monad"}</Badge>
      </div>

      {wallet.isWrongNetwork && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-xs text-warning">
          <span>You&apos;re connected to the wrong network. Switch to {MONAD_CHAIN_NAME} to send payments.</span>
          <button
            onClick={handleSwitchNetwork}
            disabled={switching}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-warning/40 px-2.5 py-1.5 font-medium text-warning transition hover:bg-warning/10 disabled:opacity-60"
          >
            {switching ? <Loader2 size={12} className="animate-spin" /> : null}
            {switching ? "Switching…" : "Switch network"}
          </button>
        </div>
      )}
      {switchErr && <p className="mb-3 text-xs text-danger">{switchErr}</p>}

      {/* Payment composer */}
      <Card className="p-6">
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">Amount</label>
        <div className="mb-5 flex items-end gap-3 border-b border-border pb-4">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.00"
            inputMode="decimal"
            className="w-full bg-transparent text-4xl font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground/40"
          />
          <div className="flex shrink-0 gap-1 rounded-full border border-border bg-input p-1">
            {(["MON", "USDC"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setToken(t)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  token === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {amountErr && <p className="-mt-4 mb-4 text-xs text-danger">{amountErr}</p>}
        {!amountErr && insufficientBalance && (
          <p className="-mt-4 mb-4 text-xs text-danger">
            Insufficient {token} balance — you have {Number(available).toFixed(token === "MON" ? 4 : 2)} {token}.
          </p>
        )}
        {!amountErr && wallet.address && !c.balances.loading && available != null && !insufficientBalance && isValidAmount(amount) && (
          <p className="-mt-4 mb-4 text-xs text-muted-foreground">
            Balance: {Number(available).toFixed(token === "MON" ? 4 : 2)} {token}
          </p>
        )}

        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">To</label>
        <Input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="gentle.nads or 0x…"
          className="w-full"
        />
        {recipientErr && <p className="mt-1.5 text-xs text-danger">{recipientErr}</p>}

        <Button onClick={submit} disabled={!canSubmit} className="mt-5 flex w-full items-center justify-center gap-2 py-3 text-sm">
          {c.loading ? "Processing…" : <>Send Payment <ArrowRight size={15} /></>}
        </Button>
        {!wallet.address && <p className="mt-2 text-center text-xs text-warning">Connect your wallet from the top bar to sign on-chain payments.</p>}
      </Card>
        </div>

        {/* RIGHT — live verification, receipt, recent */}
        <div className="space-y-4">
      {/* Empty state — keeps the two-column layout balanced before a payment */}
      {!hasResultArea && (
        <Card className="flex min-h-[18rem] flex-col items-center justify-center p-6 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-input text-muted-foreground">
            <ReceiptText size={22} />
          </div>
          <p className="text-sm font-medium text-foreground">Your receipt appears here</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Enter an amount and recipient, then send — the on-chain proof, compliance checks, and explorer link land here.
          </p>
        </Card>
      )}

      {/* Live verification — compliance visibility, real-time */}
      {c.loading && (
        <Card>
          <p className="mb-4 text-sm font-medium text-foreground">Verifying your payment</p>
          <PipelineStepper steps={c.steps} />
        </Card>
      )}

      {c.err && <Card><p className="text-sm text-danger">{friendlyError(c.err)}</p></Card>}

      {/* Receipt / result */}
      <AnimatePresence>
        {c.res && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: "easeOut" }}>
            <Card className="p-6 text-center">
              <motion.div
                initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.1, duration: 0.35, ease: "easeOut" }}
                className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full ${STATUS_COLOR[c.res.decision] ?? "bg-input text-muted-foreground"}`}
              >
                {StatusIcon && <StatusIcon size={26} />}
              </motion.div>
              <p className="text-lg font-semibold text-foreground">{DECISION[c.res.decision].label}</p>
              {c.res.intent.amount != null && (
                <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
                  {c.res.intent.amount} {c.res.intent.token}
                </p>
              )}
              <p className="mt-1 text-sm text-muted-foreground">{c.res.intent.summary}</p>
              {NEXT_STEP[c.res.decision] && <p className="mt-2 text-xs text-muted-foreground">{NEXT_STEP[c.res.decision]}</p>}
              {c.res.guardrail.violations.length > 0 && <p className="mt-2 text-xs text-danger">{c.res.guardrail.violations.join(" ")}</p>}

              {/* Compliance visibility — expandable */}
              {c.res.compliance && (
                <div className="mt-4 border-t border-border pt-4 text-left">
                  <button onClick={() => setShowChecks((s) => !s)} className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground">
                    <span className="flex items-center gap-1.5"><ShieldCheck size={13} className="text-success" /> Compliance {c.res.compliance.status}</span>
                    <ChevronDown size={13} className={`transition ${showChecks ? "rotate-180" : ""}`} />
                  </button>
                  <AnimatePresence>
                    {showChecks && (
                      <motion.ul initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-2 space-y-1.5 overflow-hidden">
                        {c.res.compliance.checks.map((chk) => (
                          <li key={chk.id} className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">{chk.label}</span>
                            <Badge tone={chk.passed ? "success" : "danger"}>{chk.passed ? "Passed" : "Failed"}</Badge>
                          </li>
                        ))}
                      </motion.ul>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* Blockchain transparency — on-chain proof shown plainly, hash front and centre */}
              {c.res.transaction?.txHash && (
                <div className="mt-4 border-t border-border pt-4 text-left">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">On-chain proof</p>

                  <div className="rounded-lg border border-border bg-input/40 p-3">
                    <p className="mb-1 text-[11px] text-muted-foreground">Transaction hash</p>
                    <div className="flex items-center gap-2">
                      <a
                        href={c.res.transaction.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={c.res.transaction.txHash}
                        className="block flex-1 break-all font-mono text-xs text-primary hover:underline"
                      >
                        {c.res.transaction.txHash}
                      </a>
                      <button
                        onClick={() => copyHash(c.res!.transaction!.txHash!)}
                        aria-label="Copy transaction hash"
                        className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground transition hover:border-primary/40 hover:text-primary"
                      >
                        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Block</span>
                    <span className="font-mono text-foreground">{c.res.transaction.blockNumber != null ? c.res.transaction.blockNumber : "—"}</span>
                  </div>

                  <a href={c.res.transaction.explorerUrl} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-1 text-xs text-primary hover:underline">
                    View on explorer <ExternalLink size={11} />
                  </a>
                </div>
              )}
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {c.history.length > 0 && (
        <Card title="Recent">
          <ul className="space-y-2 text-sm">
            {c.history.map((h, i) => (
              <li key={i} className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-none last:pb-0">
                <span className="truncate text-foreground">{h.summary}</span>
                <Badge tone={DECISION[h.decision]?.tone ?? "neutral"}>{h.decision}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
        </div>
      </div>
    </div>
  );
}
