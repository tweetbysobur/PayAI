"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowRight, CheckCircle2, AlertTriangle, Clock3, XCircle,
  ChevronDown, ShieldCheck, ExternalLink, Wallet as WalletIcon, Loader2,
  ReceiptText, Copy, Check, Share2, Fingerprint,
} from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { TokenLogo } from "@/components/TokenLogo";
import { PipelineStepper } from "@/components/PipelineStepper";
import { ConfirmDetails } from "@/components/dashboard/ConfirmDetails";
import { useAgentConsole, DECISION, friendlyError, phraseSummary, short } from "@/lib/hooks/useAgentConsole";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { useCopy } from "@/lib/hooks/useCopy";
import { amountError, recipientError, isValidAmount, isValidRecipient } from "@/lib/validation";
import { MONAD_CHAIN_NAME, MONAD_EXPLORER } from "@/lib/monad/public";
import { buildReceipt } from "@/lib/payment/feeEngine";

const NEXT_STEP: Record<string, string> = {
  needs_review: "This payment is being reviewed. You'll be notified once it clears.",
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

/**
 * The most this wallet can actually send.
 *
 * "Max" used to fill in the entire MON balance, which is the one amount a
 * native send can never succeed with — the fee has to come from somewhere, so
 * the request was always refused ("you need X plus ~0.01 for gas"). A button
 * whose only outcome is an error is worse than no button. Leaves the same
 * reserve the server checks against (lib/monad/balance.ts), so pressing Max
 * and sending works. ERC-20 sends spend no balance on gas, so they keep the
 * full amount.
 */
const GAS_RESERVE_MON = 0.01;
function maxSendable(available: string | null, token: "MON" | "USDC"): string {
  const balance = Number(available ?? 0);
  if (!Number.isFinite(balance) || balance <= 0) return "0";
  if (token !== "MON") return String(balance);
  const spendable = balance - GAS_RESERVE_MON;
  return spendable > 0 ? String(Number(spendable.toFixed(6))) : "0";
}

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
  const { copy, copied } = useCopy();
  const [switching, setSwitching] = useState(false);
  const [switchErr, setSwitchErr] = useState<string | null>(null);
  // Clicking Send Payment switches the page away from the composer to a
  // focused confirmation view — the composer reappearing beside a pending
  // signature (or a just-sent receipt) made it look like a second payment
  // was still queued up. Amount/recipient live in separate state above, so
  // switching back here never loses what was typed.
  const [composing, setComposing] = useState(true);
  function backToCompose() {
    c.reset();
    setComposing(true);
  }

  async function handleSwitchNetwork() {
    setSwitchErr(null); setSwitching(true);
    try { await c.wallet.switchNetwork(); }
    catch { setSwitchErr(`Couldn't switch automatically. Switch to ${MONAD_CHAIN_NAME} in your wallet.`); }
    finally { setSwitching(false); }
  }

  const amountErr = amountError(amount);
  const recipientErr = recipientError(recipient);
  const wallet = c.wallet;
  const identity = useIdentity(wallet.address);
  const available = token === "MON" ? c.balances.mon : c.balances.usdc;
  const insufficientBalance =
    wallet.address != null && !c.balances.loading && available != null &&
    isValidAmount(amount) && Number(amount) > Number(available);
  const canSubmit = isValidAmount(amount) && isValidRecipient(recipient) && !c.loading && !insufficientBalance && !wallet.isWrongNetwork;

  function submit() {
    if (!canSubmit) return;
    setShowChecks(false);
    setComposing(false);
    c.run(`Send ${amount} ${token} to ${recipient}`);
  }

  // Once a payment actually settles, the composer's job is done — leaving the
  // just-paid amount/recipient sitting there next to the receipt makes it
  // look like the same payment is still queued up to send again.
  useEffect(() => {
    if (c.res?.decision === "executed") {
      setAmount("");
      setRecipient("");
    }
  }, [c.res]);

  function copyHash(hash: string) {
    void copy(hash, "Transaction hash copied");
  }
  async function shareReceipt() {
    const res = c.res;
    if (!res) return;
    const lines = [
      phraseSummary(res.intent.summary, res.decision),
      res.transaction?.txHash ? `Tx: ${res.transaction.explorerUrl}` : null,
    ].filter(Boolean).join("\n");
    if (navigator.share) {
      try { await navigator.share({ title: "PayAI receipt", text: lines }); }
      catch { /* user cancelled */ }
    } else {
      // Same rule as everywhere else: confirm what happened, not what was
      // attempted. Swallowing the failure and claiming success sends the user
      // off to paste something that isn't there.
      await copy(lines, "Receipt copied");
    }
  }
  const StatusIcon = c.res ? STATUS_ICON[c.res.decision] ?? AlertTriangle : null;

  // Reached once the pipeline has a final answer — success or not. From here
  // the only way forward is an explicit "New payment"/"Try again", never an
  // automatic bounce back to the composer.
  const terminal = (c.res && !c.pendingConfirm) || (c.err && !c.pendingRecovery);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-foreground">Send Payment</h1>
      <p className="mb-6 text-sm text-muted-foreground">Pay any wallet address or .nads domain on Monad.</p>

      {composing ? (
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          {/* LEFT — composer */}
          <div>
            {/* Sender context — trust: who is paying, from where */}
            <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-panel/60 px-4 py-2.5 text-xs">
              <div className="flex items-center gap-2 text-muted-foreground">
                <WalletIcon size={13} className={wallet.address ? "text-primary-ink" : ""} />
                {wallet.address ? (
                  <span className="font-mono text-foreground">{identity.display}</span>
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
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                        token === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <TokenLogo token={t} size={14} /> {t}
                    </button>
                  ))}
                </div>
              </div>
              {amountErr && <p className="-mt-4 mb-4 text-xs text-danger">{amountErr}</p>}
              {!amountErr && insufficientBalance && (
                <p className="-mt-4 mb-4 text-xs text-danger">
                  Insufficient {token} balance. You have {Number(available).toFixed(token === "MON" ? 4 : 2)} {token}.
                </p>
              )}
              {!amountErr && wallet.address && !c.balances.loading && available != null && !insufficientBalance && (
                <div className="-mt-4 mb-4 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Balance: {Number(available).toFixed(token === "MON" ? 4 : 2)} {token}</span>
                  <button
                    type="button"
                    onClick={() => setAmount(maxSendable(available, token))}
                    className="rounded-full border border-border px-2 py-0.5 font-medium text-primary-ink transition hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Max
                  </button>
                </div>
              )}

              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">To</label>
              <Input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder=".nad domain or 0x address"
                className="w-full"
              />
              {recipientErr && <p className="mt-1.5 text-xs text-danger">{recipientErr}</p>}

              <Button onClick={submit} disabled={!canSubmit} className="mt-5 flex w-full items-center justify-center gap-2 py-3 text-sm">
                Send Payment <ArrowRight size={15} />
              </Button>
              {!wallet.address && <p className="mt-2 text-center text-xs text-warning">Connect your wallet from the top bar to sign on-chain payments.</p>}
            </Card>
          </div>

          {/* RIGHT — idle state: nothing in flight yet */}
          <div className="space-y-4">
            <Card className="flex min-h-[18rem] flex-col items-center justify-center p-6 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-input text-muted-foreground">
                <ReceiptText size={22} />
              </div>
              <p className="text-sm font-medium text-foreground">Your receipt appears here</p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                Enter an amount and recipient, then send. Your receipt and explorer link land here.
              </p>
            </Card>

            {c.history.length > 0 && (
              <Card title="Recent">
                <ul className="space-y-2 text-sm">
                  {c.history.map((h, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-none last:pb-0">
                      <span className="truncate text-foreground">{phraseSummary(h.summary, h.decision)}</span>
                      <Badge tone={DECISION[h.decision]?.tone ?? "neutral"}>{h.decision}</Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </div>
      ) : (
        /* Focused confirmation/result view — the composer is gone until this
           attempt reaches a terminal state and the user explicitly starts a
           new one, so it can never look like a second payment is queued. */
        <div className="mx-auto max-w-md space-y-4">
          {c.loading && (
            <Card>
              <p className="mb-4 text-sm font-medium text-foreground">Verifying your payment</p>
              <PipelineStepper steps={c.steps} />
            </Card>
          )}

          {/* A signed transaction broadcast but confirmation didn't finish — this is
              NEVER a failed payment, so it gets its own reassuring banner instead
              of the red error card. Recovery is automatic; Retry is just a nudge. */}
          {c.pendingRecovery && (
            <Card className="border-warning/30 bg-warning/5">
              <div className="flex items-start gap-3">
                <Loader2 size={16} className={`mt-0.5 shrink-0 text-warning ${c.recovering ? "animate-spin" : ""}`} />
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">Confirming your payment…</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your transaction was sent and is safe on-chain. We&apos;re confirming it now — do not send it again.
                  </p>
                  <a href={`${MONAD_EXPLORER}/tx/${c.pendingRecovery.txHash}`} target="_blank" rel="noreferrer" className="mt-1.5 inline-block font-mono text-xs text-primary-ink hover:underline">
                    {c.pendingRecovery.txHash.slice(0, 14)}…
                  </a>
                </div>
                <button onClick={c.retryPendingConfirm} disabled={c.recovering} className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition hover:bg-input disabled:opacity-50">
                  Retry
                </button>
              </div>
            </Card>
          )}

          {c.err && !c.pendingRecovery && <Card><p className="text-sm text-danger">{friendlyError(c.err)}</p></Card>}

          {/* AI CONFIRMATION — the pipeline approved this payment, but no wallet
              signature has been requested yet. Nothing signs until Confirm. */}
          {c.pendingConfirm && (
            <Card className="border-2 border-primary/40 bg-gradient-to-b from-primary/[0.05] to-transparent">
              <div className="mb-3 flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/12 text-warning"><Clock3 size={17} /></span>
                <div>
                  <p className="text-sm font-semibold text-foreground">Confirm this payment</p>
                  <p className="text-xs text-muted-foreground">Review before signing — nothing moves until you confirm.</p>
                </div>
              </div>
              <ConfirmDetails pending={c.pendingConfirm} kind={wallet.kind} />
              <div className="mt-3.5 flex gap-2">
                <button onClick={backToCompose} className="flex-1 rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-foreground transition hover:bg-input/40">
                  Edit
                </button>
                <button onClick={backToCompose} className="flex-1 rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-muted-foreground transition hover:border-danger/40 hover:text-danger">
                  Cancel
                </button>
                <button onClick={c.confirmSign} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                  {wallet.kind === "embedded" && <Fingerprint size={14} />} Confirm
                </button>
              </div>
            </Card>
          )}

          {/* The passkey prompt is a system dialog PayAI can't style, so the page
              says what it's waiting for — otherwise a dismissed prompt leaves a
              screen that looks like it froze. */}
          {c.walletBusy && !c.pendingConfirm && (
            <Card className="border-primary/30 bg-primary/[0.04]">
              <div className="flex items-start gap-3">
                <Fingerprint size={17} className="mt-0.5 shrink-0 animate-pulse text-primary-ink" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {wallet.kind === "embedded" ? "Approve with your passkey" : "Confirm in your wallet"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {wallet.kind === "embedded"
                      ? "Your device is asking you to verify. Nothing is signed or sent until you do."
                      : "Your wallet is asking you to confirm. Nothing is sent until you do."}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* Receipt / result */}
          <AnimatePresence>
            {c.res && !c.pendingConfirm && (
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
                    <p className="mt-1 flex items-center justify-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
                      <TokenLogo token={c.res.intent.token} size={22} /> {c.res.intent.amount} {c.res.intent.token}
                    </p>
                  )}
                  <p className="mt-1 text-sm text-muted-foreground">{phraseSummary(c.res.intent.summary, c.res.decision)}</p>
                  {NEXT_STEP[c.res.decision] && <p className="mt-2 text-xs text-muted-foreground">{NEXT_STEP[c.res.decision]}</p>}
                  {c.res.guardrail.violations.length > 0 && <p className="mt-2 text-xs text-danger">{c.res.guardrail.violations.join(" ")}</p>}

                  {/* Receipt details — who, when, on what network */}
                  {c.res.decision === "executed" && (
                    <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-4 text-left text-xs">
                      {(c.res.intent.domain || c.res.intent.recipient) && (
                        <div>
                          <p className="text-muted-foreground">To</p>
                          {/* The name and the address it resolved to — a receipt
                              for a .nad payment has to record which account was
                              actually paid, not just the name that was typed. */}
                          {c.res.intent.domain && <p className="mt-0.5 font-medium text-foreground">{c.res.intent.domain}</p>}
                          <p className={`mt-0.5 font-mono ${c.res.intent.domain ? "text-[11px] text-muted-foreground" : "text-foreground"}`} title={c.res.intent.recipient ?? undefined}>
                            {short(c.res.intent.recipient)}
                          </p>
                        </div>
                      )}
                      {c.res.transaction?.blockTimestamp != null && (
                        <div>
                          <p className="text-muted-foreground">When</p>
                          <p className="mt-0.5 text-foreground">{new Date(c.res.transaction.blockTimestamp).toLocaleString()}</p>
                        </div>
                      )}
                      <div>
                        <p className="text-muted-foreground">Network</p>
                        <p className="mt-0.5 text-foreground">{c.res.intent.network === "monad" ? MONAD_CHAIN_NAME : c.res.intent.network}</p>
                      </div>
                    </div>
                  )}

                  {/* Receipt — amount, platform fee, gas, total, status. Fee is
                      free during beta; the line stays visible so pricing is
                      never a surprise once it isn't. */}
                  {c.res.decision === "executed" && c.res.intent.amount != null && (() => {
                    const receipt = buildReceipt({
                      feature: "send_payment",
                      amount: c.res.intent.amount,
                      token: c.res.intent.token,
                      gasFee: c.res.transaction?.gasFee,
                      status: c.res.decision,
                      txHash: c.res.transaction?.txHash,
                      explorerUrl: c.res.transaction?.explorerUrl,
                    });
                    return (
                      <div className="mt-4 border-t border-border pt-4 text-left">
                        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Receipt</p>
                        <div className="space-y-1.5 rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent p-3 text-xs">
                          <div className="flex items-center justify-between"><span className="text-muted-foreground">Payment amount</span><span className="font-medium text-foreground">{receipt.paymentAmount} {receipt.token}</span></div>
                          <div className="flex items-center justify-between"><span className="text-muted-foreground">Platform fee</span><span className={`font-medium ${receipt.platformFee.isFree ? "text-primary-ink" : "text-foreground"}`}>{receipt.platformFee.label}</span></div>
                          {receipt.gasFee && <div className="flex items-center justify-between"><span className="text-muted-foreground">Gas fee</span><span className="font-medium text-foreground">{receipt.gasFee} MON</span></div>}
                          <div className="flex items-center justify-between border-t border-border pt-1.5"><span className="text-muted-foreground">Total cost</span><span className="font-semibold text-foreground">{receipt.totalCost}</span></div>
                        </div>
                      </div>
                    );
                  })()}

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
                            className="block flex-1 break-all font-mono text-xs text-primary-ink hover:underline"
                          >
                            {c.res.transaction.txHash}
                          </a>
                          <button
                            onClick={() => copyHash(c.res!.transaction!.txHash!)}
                            aria-label="Copy transaction hash"
                            className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground transition hover:border-primary/40 hover:text-primary-ink"
                          >
                            {copied === c.res!.transaction!.txHash ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                          </button>
                        </div>
                      </div>

                      <div className="mt-2 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Block</span>
                        <span className="font-mono text-foreground">{c.res.transaction.blockNumber != null ? c.res.transaction.blockNumber : "—"}</span>
                      </div>

                      <a href={c.res.transaction.explorerUrl} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-1 text-xs text-primary-ink hover:underline">
                        View on explorer <ExternalLink size={11} />
                      </a>

                      <button
                        onClick={shareReceipt}
                        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition hover:border-primary/40"
                      >
                        <Share2 size={13} /> Share receipt
                      </button>
                    </div>
                  )}
                </Card>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Terminal state reached — nothing moves forward on its own from
              here. Success clears the composer (see the effect above) so
              this reopens it blank; anything else leaves the same
              amount/recipient in place to edit and resend. */}
          {terminal && (
            <button
              onClick={backToCompose}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              {c.res?.decision === "executed" ? "Send another payment" : "Edit and try again"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
