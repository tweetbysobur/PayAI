"use client";

/**
 * A plan inside Ask PayAI: the server-derived review of one request, with
 * Approve / Edit, then the run itself — quote review, wallet, outcome — all
 * in the conversation.
 *
 * Execution goes through ONE call — runPlanInApp (lib/plans-client/app.ts),
 * which drives the existing Plan Runner with its execution lock, transaction
 * journal and signing intent. This card never signs, sends, quotes, builds,
 * or records a transaction itself, and never retries on its own: what it
 * offers after a run comes from describeOutcome (lib/plans-client/view.ts),
 * which never offers Resume when a transaction may be in flight or
 * unrecorded.
 *
 * What it shows before quoting is the server's review; "you pay" is an
 * ESTIMATE from PayAI's published rate (GET /api/fees), labelled as one, and
 * only when that rate is positive — otherwise "Shown on the quote". The exact
 * amounts come from the quote, which the user reviews here before anything
 * is signed. Nothing is shown as sent until the runner says so.
 *
 * Layout: one action reads like a payment confirmation (amount, then who,
 * then what it costs); several read as a numbered list in run order, each
 * with its own state once the plan is under way. One Approve covers the
 * whole plan — exactly what the server will let the runner execute.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, Check, Circle, Loader2, X } from "lucide-react";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { MONAD_CHAIN_ID, MONAD_EXPLORER } from "@/lib/monad/public";
import { runPlanInApp } from "@/lib/plans-client/app";
import {
  abandonPlan, approvePlan, getPlanWithReview, replyError,
  type PlanReviewDTO, type ReviewAmountDTO, type ReviewOutputAmountDTO, type ReviewStepDTO,
} from "@/lib/plans-client/api";
import { canApprove, canCancel, canStartRun, describeOutcome, idleReason, phaseLabel, planStatus, stepStatus, type OutcomeView } from "@/lib/plans-client/view";
import type { PlanViewDTO, QuoteDecision, QuoteProjection, RunnerPhase, RunnerWallet } from "@/lib/plans-client/runner";
import { feeEstimate, sendFeeBps, takePrimed, timingFor, type PlanCardData } from "@/lib/ask/planCards";
import type { AskPlanRef } from "@/lib/ask/types";
import { feePercent } from "@/lib/rooms/escrowChain";

/** Decimals of the tokens a plan can move, for the "you pay" estimate only.
 *  An unknown symbol simply gets no estimate. */
const DECIMALS: Readonly<Record<string, number>> = { MON: 18, WMON: 18, USDC: 6 };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function amountText(a: ReviewAmountDTO | ReviewOutputAmountDTO): string {
  return a.kind === "exact" ? `${a.decimal} ${a.symbol}` : `the ${a.symbol} from the swap`;
}

/** One action, as a single line of words: "Send 0.2 MON" / "Swap 10 USDC". */
function actionLine(s: ReviewStepDTO): { verb: string; what: string; to: string | null; toTitle?: string } {
  if (s.action === "transfer") {
    const r = s.recipient;
    const named = r.display.toLowerCase() !== r.address.toLowerCase();
    return { verb: "Send", what: amountText(s.amount), to: named ? r.display : short(r.address), toTitle: r.address };
  }
  if (s.action === "swap") return { verb: "Swap", what: amountText(s.pay), to: s.receiveToken.symbol };
  if (s.action === "room_escrow") {
    const verb = { create: "Create room", contribute: "Contribute", claim: "Claim room", refund: "Refund from room", cancel: "Cancel room" }[s.op];
    return { verb, what: s.amount ? amountText(s.amount) : s.roomId ? `#${s.roomId}` : "", to: s.op === "contribute" ? "escrow" : null };
  }
  return { verb: "Action", what: "", to: null };
}

function Detail({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-foreground [font-variant-numeric:tabular-nums]">
        <span className="[overflow-wrap:anywhere]">{children}</span>
        {note && <span className="ml-1.5 text-[11px] text-muted-foreground">{note}</span>}
      </dd>
    </div>
  );
}

/** What leaves the wallet, before the quote: an ESTIMATE only when the
 *  published rate is positive, labelled as one — never a guessed fee. */
function youPay(s: Extract<ReviewStepDTO, { action: "transfer" }>, bps: number | null): { text: string; estimate: boolean } {
  const sym = s.amount.symbol;
  const est = s.amount.kind === "exact" && bps !== null && bps > 0 && DECIMALS[sym] !== undefined
    ? feeEstimate(s.amount.decimal, DECIMALS[sym], bps)
    : null;
  return est ? { text: `≈ ${est.total} ${sym}`, estimate: true } : { text: "Shown on the quote", estimate: false };
}

/** A single transfer: the amount first, then who, then what it costs. */
function TransferSummary({ step, bps }: { step: Extract<ReviewStepDTO, { action: "transfer" }>; bps: number | null }) {
  const r = step.recipient;
  const named = r.display.toLowerCase() !== r.address.toLowerCase();
  const pay = youPay(step, bps);
  return (
    <>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Send</p>
      <p className="mt-1 text-[1.75rem] font-semibold leading-none tracking-tight text-foreground [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere]">
        {step.amount.kind === "exact" ? <>{step.amount.decimal} <span className="text-muted-foreground">{step.amount.symbol}</span></> : amountText(step.amount)}
      </p>
      <p className="mt-3 text-xs text-muted-foreground">to</p>
      <p className="mt-0.5 text-sm text-foreground">
        {named ? <span className="font-medium">{r.display}</span> : null}
        <span className={`block font-mono text-xs [overflow-wrap:anywhere] ${named ? "mt-0.5 text-muted-foreground" : "text-foreground"}`} title={r.address}>{r.address}</span>
      </p>
      <dl className="mt-3 divide-y divide-border/70 border-t border-border/70">
        <Detail label="Network">Monad</Detail>
        <Detail label="Recipient receives">{amountText(step.amount)}</Detail>
        <Detail label="You pay" note={pay.estimate ? "estimate" : undefined}>
          <span className={pay.estimate ? "" : "text-muted-foreground"}>{pay.text}</span>
        </Detail>
      </dl>
    </>
  );
}

/** A Room escrow action: what moves, where it's held, and the fee rule. The
 *  live quote (shown before signing) carries the contract's exact state. */
function RoomEscrowSummary({ step }: { step: Extract<ReviewStepDTO, { action: "room_escrow" }> }) {
  const feePct = feePercent(step.fee.maxBps);
  const title = { create: "Create escrow room", contribute: "Contribute to escrow", claim: "Claim room funds", refund: "Refund your contribution", cancel: "Cancel room" }[step.op];
  const c = step.create;
  return (
    <>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
      {step.amount && (
        <p className="mt-1 text-[1.75rem] font-semibold leading-none tracking-tight text-foreground [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere]">
          {step.amount.decimal} <span className="text-muted-foreground">{step.amount.symbol}</span>
        </p>
      )}
      <dl className="mt-3 divide-y divide-border/70 border-t border-border/70">
        <Detail label="Network">Monad</Detail>
        {step.roomId !== null && <Detail label="Room">{`#${step.roomId}`}</Detail>}
        {c && <Detail label="Type">{c.roomKind === "fixed" ? `${c.slots} × ${c.share ? amountText(c.share) : "—"}` : `Target${c.minContribution ? `, min ${amountText(c.minContribution)}` : ""}`}</Detail>}
        {c && <Detail label="Deadline">{new Date(c.deadline * 1000).toLocaleString()}</Detail>}
        {c && <Detail label="Beneficiary"><span className="font-mono text-xs" title={c.beneficiary.address}>{short(c.beneficiary.address)}</span></Detail>}
        {step.op === "contribute" && <Detail label="Held by">Room escrow contract</Detail>}
        <Detail label="PayAI fee">
          {step.op === "claim" ? `${feePct} of the proceeds (exact amount on the quote)` : step.op === "create" ? `${feePct} of the proceeds, only if the room completes` : step.op === "contribute" ? `None on your contribution · ${feePct} from successful proceeds` : "None"}
        </Detail>
      </dl>
    </>
  );
}

/** A single swap: what goes in, what comes out, the slippage it accepts. */
function SwapSummary({ step }: { step: Extract<ReviewStepDTO, { action: "swap" }> }) {
  return (
    <>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Swap</p>
      <p className="mt-1 text-[1.75rem] font-semibold leading-none tracking-tight text-foreground [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere]">
        {step.pay.kind === "exact" ? <>{step.pay.decimal} <span className="text-muted-foreground">{step.pay.symbol}</span></> : amountText(step.pay)}
      </p>
      <p className="mt-3 text-xs text-muted-foreground">for</p>
      <p className="mt-0.5 text-sm font-medium text-foreground">{step.receiveToken.symbol}</p>
      <dl className="mt-3 divide-y divide-border/70 border-t border-border/70">
        <Detail label="Network">Monad</Detail>
        <Detail label="Max slippage">{`${(step.slippageBps / 100).toFixed(2)}%`}</Detail>
        <Detail label="You receive">Shown on the quote</Detail>
      </dl>
    </>
  );
}

type StepMark = "done" | "failed" | "active" | "pending" | "cancelled";

function stepMark(node: PlanViewDTO["nodes"][number] | undefined, plan: PlanViewDTO, activeNode: string | null, running: boolean): StepMark {
  if (!node) return "pending";
  if (node.state === "confirmed") return "done";
  if (node.state === "reverted" || node.state === "unverified") return "failed";
  if (running && activeNode === node.nodeId) return "active";
  if (node.state === "submitted" || (node.signing !== null && node.txHash === null)) return "active";
  if (node.state === "skipped" && plan.abandoned) return "cancelled";
  return "pending";
}

function Mark({ m }: { m: StepMark }) {
  if (m === "done") return <Check size={13} className="text-success" aria-hidden />;
  if (m === "failed") return <X size={13} className="text-danger" aria-hidden />;
  if (m === "active") return <Loader2 size={13} className="animate-spin text-primary-ink" aria-hidden />;
  return <Circle size={11} className="text-muted-foreground/60" aria-hidden />;
}

/** Several actions, one plan: numbered, in the order they will run, each with
 *  its own state once the plan is under way. Long plans (dozens or hundreds
 *  of actions) get a progress summary and a scrolling list that keeps the
 *  action under way in view — never a card the length of the plan. */
export function StepList({ review, plan, activeNode, running }: { review: PlanReviewDTO; plan: PlanViewDTO; activeNode: string | null; running: boolean }) {
  const n = review.steps.length;
  const width = Math.max(2, String(n).length);
  const num = (i: number) => String(i).padStart(width, "0");
  const started = plan.approved || plan.abandoned;
  const byId = new Map(plan.nodes.map((x) => [x.nodeId, x]));
  const marks = review.steps.map((s) => (started ? stepMark(byId.get(s.nodeId), plan, activeNode, running) : null));
  const done = marks.filter((m) => m === "done").length;
  const failed = marks.filter((m) => m === "failed").length;
  const long = n > 6;

  // Keep the action under way (or the first unfinished one) in view, inside
  // the list only — never scrolling the page under the user.
  const listRef = useRef<HTMLOListElement>(null);
  const focusIndex = marks.findIndex((m) => m === "active" || m === "failed");
  const firstOpen = focusIndex >= 0 ? focusIndex : marks.findIndex((m) => m === "pending");
  useEffect(() => {
    const list = listRef.current;
    if (!long || !list || firstOpen < 0) return;
    const row = list.children[firstOpen] as HTMLElement | undefined;
    if (!row) return;
    if (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, row.offsetTop - list.clientHeight / 3);
    }
  }, [long, firstOpen]);

  return (
    <>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{`${n} actions · in this order`}</p>
      {started && (
        <div className="mt-2">
          <p className="text-xs text-muted-foreground [font-variant-numeric:tabular-nums]" aria-live="polite">
            <span className="text-foreground">{`${done} of ${n} done`}</span>
            {failed > 0 && <span className="text-danger">{` · ${failed} failed`}</span>}
            {n - done - failed > 0 && <span>{` · ${n - done - failed} not finished`}</span>}
          </p>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border" aria-hidden>
            <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${(done / n) * 100}%` }} />
          </div>
        </div>
      )}
      <ol
        ref={listRef}
        aria-label={`${n} actions, in the order they run`}
        tabIndex={long ? 0 : undefined}
        className={`mt-2 divide-y divide-border/70 border-y border-border/70 ${long ? "max-h-[min(22rem,55vh)] overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" : ""}`}
      >
        {review.steps.map((s, i) => {
          const node = byId.get(s.nodeId);
          const line = actionLine(s);
          const m = marks[i];
          return (
            <li key={s.nodeId} className="flex items-start gap-3 py-2">
              <span className="shrink-0 pt-px font-mono text-xs text-muted-foreground" style={{ width: `${width + 0.5}ch` }}>{num(s.order)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-foreground [overflow-wrap:anywhere]">
                  {s.action === "unsupported" ? <span className="text-warning">{"PayAI can't show this action in full."}</span> : <>{line.verb} <span className="font-medium [font-variant-numeric:tabular-nums]">{line.what}</span></>}
                </span>
                {line.to && <span className="mt-0.5 block text-xs text-muted-foreground [overflow-wrap:anywhere]" title={line.toTitle}>{`→ ${line.to}`}</span>}
                {node?.txHash && (
                  <a className="mt-1 inline-block rounded font-mono text-[11px] text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`${MONAD_EXPLORER}/tx/${node.txHash}`} target="_blank" rel="noreferrer">
                    {`${node.txHash.slice(0, 10)}…`}<span className="sr-only"> (view transaction)</span>
                  </a>
                )}
              </span>
              {m && node && (
                <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
                  <Mark m={m} />
                  {/* Skipped because an earlier action failed: it never started. */}
                  <span>{node.state === "skipped" && !plan.abandoned ? "Not started" : stepStatus(node, plan)}</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** The exact quote, before the wallet. Known keys get product labels; the
 *  fee is not repeated here (it is published in the docs and FAQ), but what
 *  leaves the wallet is. Anything unrecognised is still shown, never hidden. */
const QUOTE_LABELS: Readonly<Record<string, string>> = {
  "recipient receives": "Recipient receives",
  "total from your balance": "You pay",
  "you swap": "You swap",
  "you receive (est.)": "You receive",
  "minimum received": "At least",
  "price impact": "Price impact",
  slippage: "Slippage",
  route: "Route",
};
const QUOTE_OMIT = new Set(["recipient", "token", "PayAI fee", "platform fee"]);

function QuoteReview({ q, label, onContinue, onDecline }: { q: QuoteProjection; label: string; onContinue: () => void; onDecline: () => void }) {
  const rows = Object.entries(q.details).filter(([k]) => !QUOTE_OMIT.has(k));
  rows.sort(([a], [b]) => (QUOTE_LABELS[a] ? 0 : 1) - (QUOTE_LABELS[b] ? 0 : 1));
  return (
    <section aria-label="Exact quote" className="rounded-lg border border-border bg-input/40 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <dl className="mt-1 divide-y divide-border/70">
        {rows.map(([k, v]) => <Detail key={k} label={QUOTE_LABELS[k] ?? k}>{v}</Detail>)}
      </dl>
      {q.warnings?.map((w) => <p key={w} className="mt-1 text-xs text-warning">{w}</p>)}
      <p className="mt-1.5 text-[11px] text-muted-foreground">{`Valid until ${new Date(q.freshUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}. Your wallet asks for the signature next.`}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <button autoFocus onClick={onContinue} className={PRIMARY}>Continue to wallet</button>
        <button onClick={onDecline} className={SECONDARY}>Decline</button>
      </div>
    </section>
  );
}

/** The idle reason in Ask's words (view.ts's are written for a form "above"). */
function idleText(plan: PlanViewDTO, fallback: string): string {
  if (plan.abandoned) return "Cancelled. Nothing was sent.";
  if (plan.expired) return "This plan expired. Ask again for a new one.";
  if (!plan.approved && !plan.approvable) return "The window to approve this passed. Ask again for a fresh one.";
  return fallback;
}

const PRIMARY = "inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-40 sm:flex-1";
const SECONDARY = "inline-flex h-11 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
const QUIET = "inline-flex h-11 items-center justify-center rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";

export function PlanCard({ planRef, onEdit }: {
  planRef: AskPlanRef;
  /** Puts the request back in the composer (Edit). */
  onEdit?: (text: string) => void;
}) {
  const planId = planRef.planId;
  const wallet = useWalletService();
  // The runner reads the wallet afresh at every check, so it gets a getter
  // over the latest render's state — never a stale snapshot.
  const walletRef = useRef(wallet);
  useEffect(() => {
    walletRef.current = wallet;
  });
  const runnerWallet = useCallback((): RunnerWallet | null => {
    const w = walletRef.current;
    if (!w.address) return null;
    return { address: w.address, chainId: w.chainId, isWrongNetwork: w.isWrongNetwork, sendTransaction: w.sendTransaction, waitForReceipt: w.waitForReceipt };
  }, []);

  // The creating turn hands over the server's create response, so the first
  // render needs no request; a restored conversation reads the server.
  const [data, setData] = useState<PlanCardData | null>(() => takePrimed(planId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bps, setBps] = useState<number | null>(null);
  const [busy, setBusy] = useState<"approve" | "cancel" | "edit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false); // a second click before React re-renders
  const [phase, setPhase] = useState<RunnerPhase | null>(null);
  const [activeNode, setActiveNode] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ q: QuoteProjection; answer: (d: QuoteDecision) => void } | null>(null);
  const [last, setLast] = useState<OutcomeView | null>(null);

  const reload = useCallback(async (): Promise<boolean> => {
    const r = await getPlanWithReview(planId);
    const b = r.body as { ok?: boolean } & Partial<PlanCardData> | null;
    if (r.status === 200 && b?.ok && b.plan && b.review) {
      setData({ plan: b.plan, review: b.review });
      setLoadError(null);
      return true;
    }
    setLoadError(r.status === 404 ? "This plan is no longer available." : replyError(r).message);
    return false;
  }, [planId]);

  useEffect(() => {
    // Restored conversations: read the plan as the server has it now.
    if (!data) queueMicrotask(() => void reload());
    let live = true;
    void sendFeeBps().then((v) => { if (live) setBps(v); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per card
  }, []);

  // "response_rendered": the first frame this card is on screen.
  useEffect(() => {
    const t = timingFor(planId);
    if (!t || !data) return;
    const raf = requestAnimationFrame(() => t.mark("response_rendered"));
    return () => cancelAnimationFrame(raf);
  }, [planId, data]);

  // A quote review still open when the card goes away is a decline: the
  // runner must never wait on a dialog nobody can answer.
  const quoteRef = useRef(quote);
  useEffect(() => {
    quoteRef.current = quote;
  }, [quote]);
  useEffect(() => () => quoteRef.current?.answer("decline"), []);

  async function run() {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setLast(null);
    setError(null);
    setPhase(null);
    setConfirmCancel(false);
    try {
      const result = await runPlanInApp({
        planId,
        wallet: runnerWallet,
        chainId: MONAD_CHAIN_ID,
        onEvent: (e) => {
          setPhase(e.phase);
          setActiveNode(e.nodeId);
          if (e.phase === "waiting_for_quote_review") timingFor(planId)?.mark("quote_ready");
        },
        confirmQuote: (q) => new Promise<QuoteDecision>((resolve) => {
          setQuote({ q, answer: (d) => { setQuote(null); resolve(d); } });
        }),
      });
      setLast(describeOutcome(result));
    } finally {
      runningRef.current = false;
      setRunning(false);
      setPhase(null);
      setActiveNode(null);
      setQuote(null);
      await reload();
    }
  }

  /** Approve, then go straight on to the run: the quote review inside the
   *  run is still the last stop before the wallet. */
  async function approveAndRun() {
    if (busy || runningRef.current) return;
    setBusy("approve");
    setError(null);
    const r = await approvePlan(planId);
    setBusy(null);
    if (r.status !== 200) {
      await reload();
      setError(replyError(r).message);
      return;
    }
    await run();
  }

  async function cancel() {
    setBusy("cancel");
    setError(null);
    const r = await abandonPlan(planId);
    setBusy(null);
    setConfirmCancel(false);
    setLast(null);
    await reload();
    if (r.status !== 200) setError(replyError(r).message);
  }

  /** Edit: this plan is cancelled (it was never approved, so nothing of it
   *  can have been sent) and the request goes back into the composer. */
  async function edit() {
    if (!data || !onEdit) return;
    setBusy("edit");
    setError(null);
    const r = await abandonPlan(planId);
    setBusy(null);
    await reload();
    if (r.status !== 200) { setError(replyError(r).message); return; }
    onEdit(data.review.request);
  }

  const shell = "w-full max-w-md rounded-xl border border-border bg-panel";

  if (!data) {
    return (
      <div className={`${shell} px-4 py-3.5`} role="status" aria-live="polite">
        {loadError
          ? <p className="text-sm text-muted-foreground">{loadError}</p>
          : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={13} className="animate-spin" aria-hidden />Loading the review</p>}
      </div>
    );
  }

  const { plan, review } = data;
  const status = planStatus(plan);
  const approvable = canApprove(plan, review);
  const showRun = canStartRun(plan, running, last);
  const showCancel = canCancel(plan, running);
  const showEdit = !!onEdit && approvable && showCancel;
  const idle = idleReason(plan, review);
  const multi = review.steps.length > 1;
  const only = review.steps[0];
  const activeOrder = activeNode ? review.steps.find((x) => x.nodeId === activeNode)?.order ?? null : null;
  const quoteLabel = multi && quote ? `Exact quote · action ${review.steps.find((x) => x.nodeId === quote.q.nodeId)?.order ?? 1} of ${review.steps.length}` : "Exact quote";
  const statusDot =
    status.tone === "success" ? "bg-success"
      : status.tone === "warning" ? (plan.state === "partial" ? "bg-danger" : "bg-primary")
      : status.tone === "danger" ? "bg-danger"
      : status.tone === "primary" ? "bg-primary"
      : "bg-muted-foreground/50";
  const outcomeIcon = last
    ? last.tone === "success" ? <Check size={15} className="mt-0.5 shrink-0 text-success" aria-hidden />
      : last.tone === "danger" ? <X size={15} className="mt-0.5 shrink-0 text-danger" aria-hidden />
      : last.tone === "warning" ? <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden />
      : <Circle size={13} className="mt-1 shrink-0 text-muted-foreground" aria-hidden />
    : null;

  return (
    <motion.article
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className={shell}
      aria-label={multi ? `Plan with ${review.steps.length} actions` : only?.action === "swap" ? "Swap review" : only?.action === "room_escrow" ? "Room review" : "Transfer review"}
    >
      <div className="px-4 pb-3 pt-3.5">
        <p className="mb-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={`h-1.5 w-1.5 rounded-full ${statusDot}`} aria-hidden />
          <span>{status.label}</span>
        </p>
        {multi ? <StepList review={review} plan={plan} activeNode={activeNode} running={running} />
          : only?.action === "transfer" ? <TransferSummary step={only} bps={bps} />
          : only?.action === "swap" ? <SwapSummary step={only} />
          : only?.action === "room_escrow" ? <RoomEscrowSummary step={only} />
          : <p className="text-sm text-warning">{"PayAI can't show this action in full, so it can't be approved."}</p>}
        {!multi && plan.nodes[0]?.txHash && (
          <a className="mt-2 inline-block rounded font-mono text-xs text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`${MONAD_EXPLORER}/tx/${plan.nodes[0].txHash}`} target="_blank" rel="noreferrer">
            {`View transaction ${plan.nodes[0].txHash.slice(0, 10)}…`}
          </a>
        )}
      </div>

      {(running || quote || last || error || idle || confirmCancel) && (
        <div className="space-y-3 border-t border-border/70 px-4 py-3">
          {running && !quote && (
            <p className="flex items-center gap-2 text-sm text-foreground" role="status" aria-live="polite">
              <Loader2 size={13} className="animate-spin text-primary-ink" aria-hidden />
              <span>{phase ? phaseLabel(phase) : "Starting…"}</span>
              {multi && activeOrder !== null && <span className="ml-auto font-mono text-[11px] text-muted-foreground">{`${activeOrder} / ${review.steps.length}`}</span>}
            </p>
          )}

          {quote && (
            <QuoteReview q={quote.q} label={quoteLabel} onContinue={() => quote.answer("continue")} onDecline={() => quote.answer("decline")} />
          )}

          {last && (
            <div role="status" className="flex items-start gap-2.5">
              {outcomeIcon}
              <div className="min-w-0 text-sm">
                <p className="font-medium text-foreground">{last.completed ? (multi ? "All actions completed" : "Completed") : last.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{last.message}</p>
                {last.advice && <p className="mt-1 text-xs text-foreground">{last.advice}</p>}
                {last.txHash && (
                  <a className="mt-1.5 inline-block rounded font-mono text-xs text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`${MONAD_EXPLORER}/tx/${last.txHash}`} target="_blank" rel="noreferrer">
                    {`View transaction ${last.txHash.slice(0, 10)}…`}
                  </a>
                )}
                {last.showNewPlan && <p className="mt-1 text-xs text-muted-foreground">Ask again to start over.</p>}
              </div>
            </div>
          )}

          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          {idle && !last && <p className="text-xs text-muted-foreground">{idleText(plan, idle)}</p>}

          {confirmCancel && showCancel && (
            <div role="alertdialog" aria-label="Cancel this plan?" className="rounded-lg border border-border bg-input/40 p-3 text-sm">
              <p className="text-foreground">{multi ? "Cancel all actions? Nothing has been sent." : "Cancel this? Nothing has been sent."}</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button autoFocus onClick={cancel} disabled={busy === "cancel"} className={SECONDARY}>{busy === "cancel" ? "Cancelling…" : "Yes, cancel"}</button>
                <button onClick={() => setConfirmCancel(false)} disabled={busy === "cancel"} className={QUIET}>Keep it</button>
              </div>
            </div>
          )}
        </div>
      )}

      {!running && (approvable || showRun || (showCancel && !confirmCancel)) && (
        <div className="border-t border-border/70 px-4 py-3">
          {approvable ? (
            <button onClick={approveAndRun} disabled={busy !== null} className={PRIMARY}>
              {busy === "approve" && <Loader2 size={14} className="animate-spin" aria-hidden />}
              {multi ? `Approve ${review.steps.length} actions` : "Approve"}
            </button>
          ) : showRun ? (
            <button onClick={run} disabled={busy !== null} className={PRIMARY}>
              {last?.canResume ? last.resumeLabel : "Continue"}
            </button>
          ) : null}
          {(showEdit || (showCancel && !confirmCancel)) && (
            <div className="mt-1 flex items-center justify-center gap-1">
              {showEdit && <button onClick={edit} disabled={busy !== null} className={QUIET}>Edit</button>}
              {showCancel && !confirmCancel && <button onClick={() => setConfirmCancel(true)} disabled={busy !== null} className={QUIET}>Cancel</button>}
            </div>
          )}
          {approvable && (
            <p className="mt-1 text-center text-[11px] text-muted-foreground">
              {multi ? "One approval covers every action above. You review each exact quote, then sign in your wallet." : "Next: the exact quote, then your wallet."}
            </p>
          )}
        </div>
      )}
    </motion.article>
  );
}
