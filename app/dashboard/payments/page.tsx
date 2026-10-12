"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowRight, CheckCircle2, AlertTriangle, Clock3, XCircle,
  ChevronDown, ShieldCheck, ExternalLink, Wallet as WalletIcon, Loader2,
  Copy, Check, Share2, Fingerprint,
} from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { TokenLogo } from "@/components/TokenLogo";
import { PipelineStepper } from "@/components/PipelineStepper";
import { ConfirmDetails } from "@/components/dashboard/ConfirmDetails";
import { AmountHero, RecipientBlock, ReceiptRow, ReceiptRows, ReceiptTotal, REVIEW_PRIMARY, REVIEW_SECONDARY } from "@/components/receipt/ReceiptKit";
import { PageHeader } from "@/components/dashboard/primitives";
import { AskEntry } from "@/components/dashboard/AskEntry";
import { useAgentConsole, DECISION, friendlyError, phraseSummary } from "@/lib/hooks/useAgentConsole";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { useCopy } from "@/lib/hooks/useCopy";
import { amountError, recipientError, isValidAmount, isValidRecipient } from "@/lib/validation";
import { MONAD_CHAIN_NAME, MONAD_EXPLORER } from "@/lib/monad/public";

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
      <PageHeader title="Send" description="Tell PayAI who should receive what, and when. You review the plan before anything is sent." />

      {/* Intent first: the request goes to Ask PayAI, which plans it and asks
          for approval. The direct form below is the existing, working
          single-transfer path, kept as the alternative — not the default. */}
      {composing && (
        <section className="mb-10 max-w-3xl">
          <AskEntry
            id="send-intent"
            label="Send with intent"
            placeholder="For example: send 50 USDC to alice.nad on Friday"
          />
        </section>
      )}

      {composing && (
        <div className="mb-4 border-t border-border pt-8">
          <h2 className="text-sm font-semibold text-foreground">Or send directly</h2>
          <p className="mt-1 text-sm text-muted-foreground">One transfer to an address or .nad name, signed in your wallet.</p>
        </div>
      )}

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
              <Badge tone={!wallet.address ? "neutral" : wallet.isWrongNetwork ? "danger" : "success"}>{wallet.isWrongNetwork ? "Wrong network" : "Monad"}</Badge>
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
            <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center">
              <p className="text-sm text-foreground">The receipt appears here</p>
              <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
                After you sign, you&apos;ll see the confirmation and the explorer link.
              </p>
            </div>

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
            <Card>
              <div className="flex items-start gap-3">
                <Loader2 size={16} className={`mt-0.5 shrink-0 text-muted-foreground ${c.recovering ? "animate-spin" : ""}`} />
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
            <Card className="border-primary/40">
              <div className="mb-4">
                <p className="text-base font-semibold tracking-tight text-foreground">Review payment</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Check the details. Nothing moves until you confirm.</p>
              </div>
              <ConfirmDetails pending={c.pendingConfirm} kind={wallet.kind} />
              {/* Primary action first and full width on a phone; Edit and
                  Cancel share the row under it. */}
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_1.4fr]">
                <button onClick={c.confirmSign} className={`${REVIEW_PRIMARY} col-span-2 sm:order-3 sm:col-span-1`}>
                  {wallet.kind === "embedded" && <Fingerprint size={15} aria-hidden />} Confirm and send
                </button>
                <button onClick={backToCompose} className={`${REVIEW_SECONDARY} sm:order-1`}>
                  Edit
                </button>
                <button onClick={backToCompose} className={`${REVIEW_SECONDARY} text-muted-foreground hover:border-danger/40 hover:text-danger sm:order-2`}>
                  Cancel
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

          {/* Receipt / result — a plain div, not another <Card>: Card is
              already a motion.div that animates its own mount, and this is
              the single densest card on the page (icon, amount, receipt
              breakdown, compliance list, on-chain proof). Wrapping it in a
              second enter animation on top of Card's own used to double the
              framer-motion work for exactly this card, which is what made it
              the most noticeably janky screen on slower mobile devices. This
              still gets its own enter/exit fade via AnimatePresence below —
              just once, not twice. */}
          <AnimatePresence>
            {c.res && !c.pendingConfirm && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: "easeOut" }}>
                <div className="rounded-xl border border-border bg-panel p-5 sm:p-6">
                  {/* Status — icon, what happened, and the next step if any. */}
                  <div className="flex items-center gap-3">
                    <motion.div
                      initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.1, duration: 0.35, ease: "easeOut" }}
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${STATUS_COLOR[c.res.decision] ?? "bg-input text-muted-foreground"}`}
                    >
                      {StatusIcon && <StatusIcon size={20} />}
                    </motion.div>
                    <div className="min-w-0">
                      <p className="text-base font-semibold tracking-tight text-foreground">{DECISION[c.res.decision].label}</p>
                      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{phraseSummary(c.res.intent.summary, c.res.decision)}</p>
                    </div>
                  </div>
                  {NEXT_STEP[c.res.decision] && <p className="mt-3 text-xs text-muted-foreground">{NEXT_STEP[c.res.decision]}</p>}
                  {c.res.guardrail.violations.length > 0 && <p className="mt-3 text-xs text-danger">{c.res.guardrail.violations.join(" ")}</p>}

                  {c.res.intent.amount != null && (
                    <div className="mt-5">
                      <AmountHero eyebrow={c.res.decision === "executed" ? "Amount sent" : "Amount"} amount={c.res.intent.amount} token={c.res.intent.token} />
                    </div>
                  )}

                  {/* Receipt — who, when, network, then the money: amount, PayAI
                      fee, gas and total. The money rows are computed SERVER-SIDE
                      (see AgentResult.receipt's doc comment) and rendered as
                      returned — never recomputed here, since the live fee config
                      only exists in the server's environment. */}
                  {c.res.decision === "executed" && (
                    <ReceiptRows className="mt-4 border-t border-border/70">
                      {(c.res.intent.domain || c.res.intent.recipient) && (
                        // The name and the address it resolved to — a receipt
                        // for a .nad payment has to record which account was
                        // actually paid, not just the name that was typed.
                        <RecipientBlock domain={c.res.intent.domain} address={c.res.intent.recipient} />
                      )}
                      {c.res.transaction?.blockTimestamp != null && (
                        <ReceiptRow label="Date">{new Date(c.res.transaction.blockTimestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</ReceiptRow>
                      )}
                      <ReceiptRow label="Network">{c.res.intent.network === "monad" ? MONAD_CHAIN_NAME : c.res.intent.network}</ReceiptRow>
                      {c.res.receipt && (
                        <>
                          <ReceiptRow label="Payment amount" value={`${c.res.receipt.paymentAmount} ${c.res.receipt.token}`} round="nearest" />
                          <ReceiptRow label="PayAI fee">
                            <span className={c.res.receipt.platformFee.isFree ? "text-primary-ink" : ""}>{c.res.receipt.platformFee.label}</span>
                          </ReceiptRow>
                          {c.res.receipt.recipientReceives && <ReceiptRow label="Recipient received" value={c.res.receipt.recipientReceives} />}
                          {c.res.receipt.gasFee && <ReceiptRow label="Network fee" value={`${c.res.receipt.gasFee} MON`} />}
                        </>
                      )}
                    </ReceiptRows>
                  )}
                  {c.res.decision === "executed" && c.res.receipt && (
                    <dl className="mt-1">
                      <ReceiptTotal label="Total cost" value={c.res.receipt.totalCost} />
                    </dl>
                  )}

                  {/* Compliance visibility — expandable */}
                  {c.res.compliance && (
                    <div className="mt-4 border-t border-border/70 pt-3">
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

                  {/* On-chain proof — the transaction, the block, and the explorer. */}
                  {c.res.transaction?.txHash && (
                    <div className="mt-4 border-t border-border/70 pt-1">
                      <ReceiptRows>
                        <ReceiptRow label="Transaction">
                          <span className="inline-flex items-center gap-1.5">
                            <a href={c.res.transaction.explorerUrl} target="_blank" rel="noreferrer" title={c.res.transaction.txHash} className="font-mono text-[12px] text-primary-ink hover:underline">
                              {`${c.res.transaction.txHash.slice(0, 10)}…${c.res.transaction.txHash.slice(-8)}`}
                            </a>
                            <button
                              onClick={() => copyHash(c.res!.transaction!.txHash!)}
                              aria-label="Copy transaction hash"
                              className="rounded-md p-1 text-muted-foreground transition hover:bg-input hover:text-foreground"
                            >
                              {copied === c.res!.transaction!.txHash ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                            </button>
                          </span>
                        </ReceiptRow>
                        <ReceiptRow label="Block" mono>{c.res.transaction.blockNumber != null ? String(c.res.transaction.blockNumber) : "—"}</ReceiptRow>
                      </ReceiptRows>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <a href={c.res.transaction.explorerUrl} target="_blank" rel="noreferrer" className={`${REVIEW_SECONDARY} gap-1.5 text-[13px]`}>
                          Explorer <ExternalLink size={13} aria-hidden />
                        </a>
                        <button onClick={shareReceipt} className={`${REVIEW_SECONDARY} gap-1.5 text-[13px]`}>
                          <Share2 size={13} aria-hidden /> Share receipt
                        </button>
                      </div>
                    </div>
                  )}
                </div>
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
