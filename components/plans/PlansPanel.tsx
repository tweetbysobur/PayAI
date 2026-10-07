"use client";

/**
 * The Plans screen: create a plan from a request, read its server-derived
 * review, approve it, and run it.
 *
 * Execution goes through ONE call — runPlanInApp (lib/plans-client/app.ts),
 * which drives the existing Plan Runner with its execution lock, transaction
 * journal and signing intent. This component never signs, sends, quotes,
 * builds, or records a transaction itself, and never retries on its own:
 * what it offers after a run comes from describeOutcome (view.ts), which
 * never offers Resume when a transaction may be in flight or unrecorded.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { MONAD_CHAIN_ID, MONAD_EXPLORER } from "@/lib/monad/public";
import { runPlanInApp } from "@/lib/plans-client/app";
import { abandonPlan, approvePlan, createPlanFromText, getPlanWithReview, listPlans, replyError, type PlanReviewDTO, type PlanSummaryDTO, type ReviewAmountDTO, type ReviewOutputAmountDTO, type ReviewStepDTO } from "@/lib/plans-client/api";
import { canApprove, canCancel, canStartRun, describeOutcome, idleReason, phaseLabel, planStatus, stepStatus, summaryStatus, type OutcomeView } from "@/lib/plans-client/view";
import type { PlanViewDTO, QuoteDecision, QuoteProjection, RunnerPhase, RunnerWallet } from "@/lib/plans-client/runner";

type PlanSummary = PlanSummaryDTO;

interface Opened {
  plan: PlanViewDTO;
  review: PlanReviewDTO;
}

function plansFrom(r: { status: number; body: unknown }): PlanSummary[] {
  const list = (r.body as { plans?: unknown } | null)?.plans;
  return r.status === 200 && Array.isArray(list) ? (list as PlanSummary[]) : [];
}

function amountText(a: ReviewAmountDTO | ReviewOutputAmountDTO): string {
  return a.kind === "exact" ? `${a.decimal} ${a.symbol}` : `the ${a.symbol} from step ${a.fromStep}`;
}

function stepText(s: ReviewStepDTO): string {
  if (s.action === "transfer") {
    // The resolved address only when it adds something (a name or a payee).
    const to = s.recipient.display.toLowerCase() === s.recipient.address.toLowerCase() ? s.recipient.address : `${s.recipient.display} (${s.recipient.address})`;
    return `Send ${amountText(s.amount)} to ${to}`;
  }
  if (s.action === "swap") return `Swap ${amountText(s.pay)} for ${s.receiveToken.symbol} (max slippage ${(s.slippageBps / 100).toFixed(2)}%)`;
  return "A step PayAI can't describe in full — this plan can't be approved.";
}

export function PlansPanel() {
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

  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"create" | "approve" | "open" | "cancel" | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const runningRef = useRef(false); // a second click before React re-renders
  const [phase, setPhase] = useState<RunnerPhase | null>(null);
  const [quote, setQuote] = useState<{ q: QuoteProjection; answer: (d: QuoteDecision) => void } | null>(null);
  const [last, setLast] = useState<OutcomeView | null>(null);

  const refreshList = useCallback(async () => {
    setPlans(plansFrom(await listPlans()));
  }, []);

  const open = useCallback(async (planId: string) => {
    setBusy("open");
    setError(null);
    const r = await getPlanWithReview(planId);
    setBusy(null);
    const b = r.body as { ok?: boolean; plan?: PlanViewDTO; review?: PlanReviewDTO } | null;
    if (r.status === 200 && b?.ok && b.plan && b.review) setOpened({ plan: b.plan, review: b.review });
    else setError(replyError(r).message);
  }, []);

  useEffect(() => {
    if (!wallet.address) return;
    let live = true;
    void listPlans().then((r) => {
      if (live) setPlans(plansFrom(r));
    });
    return () => {
      live = false;
    };
  }, [wallet.address]);

  // A quote review still open when the screen goes away is a decline: the
  // runner must never wait on a dialog nobody can answer.
  const quoteRef = useRef(quote);
  useEffect(() => {
    quoteRef.current = quote;
  }, [quote]);
  useEffect(() => () => quoteRef.current?.answer("decline"), []);

  async function create() {
    if (!text.trim()) return;
    setBusy("create");
    setError(null);
    const r = await createPlanFromText(text.trim());
    setBusy(null);
    const b = r.body as { ok?: boolean; plan?: PlanViewDTO; review?: PlanReviewDTO } | null;
    if (r.status === 200 && b?.ok && b.plan && b.review) {
      setOpened({ plan: b.plan, review: b.review });
      setLast(null);
      setText("");
      void refreshList();
    } else {
      setError(replyError(r).message);
    }
  }

  async function approve() {
    if (!opened) return;
    setBusy("approve");
    setError(null);
    const r = await approvePlan(opened.plan.planId);
    setBusy(null);
    await open(opened.plan.planId); // the plan as the server now has it
    if (r.status !== 200) setError(replyError(r).message); // after open(), which clears errors
    void refreshList();
  }

  async function cancel() {
    if (!opened) return;
    setBusy("cancel");
    setError(null);
    const r = await abandonPlan(opened.plan.planId);
    setBusy(null);
    setConfirmCancel(false);
    setLast(null);
    await open(opened.plan.planId); // the plan as the server now has it
    if (r.status !== 200) setError(replyError(r).message); // after open(), which clears errors
    void refreshList();
  }

  async function run() {
    if (!opened || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setLast(null);
    setError(null);
    setPhase(null);
    setConfirmCancel(false);
    const planId = opened.plan.planId;
    try {
      const result = await runPlanInApp({
        planId,
        wallet: runnerWallet,
        chainId: MONAD_CHAIN_ID,
        onEvent: (e) => setPhase(e.phase),
        confirmQuote: (q) => new Promise<QuoteDecision>((resolve) => {
          setQuote({ q, answer: (d) => { setQuote(null); resolve(d); } });
        }),
      });
      setLast(describeOutcome(result));
    } finally {
      runningRef.current = false;
      setRunning(false);
      setPhase(null);
      setQuote(null);
      await open(planId);
      void refreshList();
    }
  }

  if (!wallet.address) {
    return (
      <Card title="Plans">
        <p className="text-sm text-muted-foreground">Connect or unlock your wallet to see and run your plans.</p>
      </Card>
    );
  }

  const plan = opened?.plan ?? null;
  const showRun = !!plan && canStartRun(plan, running, last);
  const showCancel = !!plan && canCancel(plan, running);
  const status = plan ? planStatus(plan) : null;
  const idle = plan && opened ? idleReason(plan, opened.review) : null;

  return (
    <div className="space-y-6">
      <Card title="New plan">
        <div className="flex flex-col gap-3 sm:flex-row [&>input]:flex-1">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. send 5 USDC to alice.nad"
            aria-label="Describe a plan"
            disabled={busy === "create" || running}
          />
          <Button onClick={create} disabled={!text.trim() || busy === "create" || running}>
            {busy === "create" ? "Planning…" : "Plan it"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Creates a plan you can review. Nothing is approved or signed yet.</p>
      </Card>

      {error && (
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {plan && opened && (
        <Card title="Review" right={status && <Badge tone={status.tone}>{status.label}</Badge>}>
          <p className="text-sm text-muted-foreground">“{opened.review.request}”</p>
          <ol className="mt-4 space-y-2">
            {opened.review.steps.map((s) => (
              <li key={s.nodeId} className="flex gap-3 text-sm">
                <span className="text-muted-foreground">{s.order}.</span>
                <span className="text-foreground">{stepText(s)}</span>
                {(() => {
                  const node = plan.nodes.find((n) => n.nodeId === s.nodeId);
                  if (!node) return null;
                  return (
                    <span className="ml-auto shrink-0 text-right text-xs text-muted-foreground">
                      {stepStatus(node, plan)}
                      {node.txHash && (
                        <a className="ml-2 font-mono text-primary-ink hover:underline" href={`${MONAD_EXPLORER}/tx/${node.txHash}`} target="_blank" rel="noreferrer">
                          {node.txHash.slice(0, 10)}…
                        </a>
                      )}
                    </span>
                  );
                })()}
              </li>
            ))}
          </ol>
          {!plan.expired && !plan.abandoned && plan.state !== "completed" && (
            <p className="mt-4 text-xs text-muted-foreground">
              {`Expires ${new Date(plan.expiresAt).toLocaleString()}.`}
              {!plan.approved && plan.approvable ? ` Approve by ${new Date(plan.approveBy).toLocaleTimeString()}.` : ""}
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-3">
            {canApprove(plan, opened.review) && (
              <Button onClick={approve} disabled={busy === "approve" || running}>{busy === "approve" ? "Approving…" : "Approve plan"}</Button>
            )}
            {showRun && (
              <Button onClick={run} disabled={running}>{last?.canResume ? last.resumeLabel : "Run plan"}</Button>
            )}
            {showCancel && !confirmCancel && (
              <Button variant="secondary" onClick={() => setConfirmCancel(true)} disabled={busy === "cancel"}>Cancel plan</Button>
            )}
          </div>
          {showCancel && confirmCancel && (
            <div className="mt-3 rounded-lg border border-border bg-input p-3 text-sm">
              <p className="text-foreground">{"Cancel this plan? It can't be run or approved again. Nothing has been sent."}</p>
              <div className="mt-3 flex gap-3">
                <Button variant="secondary" onClick={cancel} disabled={busy === "cancel"}>{busy === "cancel" ? "Cancelling…" : "Yes, cancel plan"}</Button>
                <Button variant="ghost" onClick={() => setConfirmCancel(false)} disabled={busy === "cancel"}>Keep it</Button>
              </div>
            </div>
          )}
          {idle && <p className="mt-3 text-xs text-muted-foreground">{idle}</p>}
          {!opened.review.reviewable && (
            <p className="mt-3 text-xs text-warning">{"PayAI can't show every step of this plan in full, so it can't be approved."}</p>
          )}

          {running && (
            <p className="mt-4 text-sm text-foreground" aria-live="polite">{phase ? phaseLabel(phase) : "Starting…"}</p>
          )}

          {quote && (
            <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
              <p className="text-sm font-medium text-foreground">{quote.q.summary}</p>
              <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-xs">
                {Object.entries(quote.q.details).map(([k, v]) => (
                  <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="text-foreground">{v}</dd></div>
                ))}
              </dl>
              {quote.q.warnings?.map((w) => <p key={w} className="mt-2 text-xs text-warning">{w}</p>)}
              <p className="mt-2 text-xs text-muted-foreground">Valid until {new Date(quote.q.freshUntil).toLocaleTimeString()}.</p>
              <div className="mt-3 flex gap-3">
                <Button onClick={() => quote.answer("continue")}>Continue to wallet</Button>
                <Button variant="secondary" onClick={() => quote.answer("decline")}>Decline</Button>
              </div>
            </div>
          )}

          {last && last.planId === plan.planId && (
            <div
              role="status"
              className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
                last.tone === "success" ? "border-success/30 bg-success/10"
                  : last.tone === "warning" ? "border-warning/30 bg-warning/10"
                  : last.tone === "danger" ? "border-danger/30 bg-danger/10"
                  : "border-border bg-input"}`}
            >
              <p className="font-medium text-foreground">{last.title}</p>
              <p className="mt-1 text-muted-foreground">{last.message}</p>
              {last.advice && <p className="mt-1 text-foreground">{last.advice}</p>}
              {last.txHash && (
                <a className="mt-2 inline-block font-mono text-xs text-primary-ink hover:underline" href={`${MONAD_EXPLORER}/tx/${last.txHash}`} target="_blank" rel="noreferrer">
                  View transaction {last.txHash.slice(0, 10)}…
                </a>
              )}
              {last.showNewPlan && (
                <p className="mt-2 text-xs text-muted-foreground">Describe a new plan above to start again.</p>
              )}
            </div>
          )}
        </Card>
      )}

      <Card title="Your plans">
        {plans === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <ul className="divide-y divide-border">
            {plans.map((p) => (
              <li key={p.planId}>
                <button
                  className="flex w-full items-center justify-between py-3 text-left text-sm hover:bg-input/50 disabled:opacity-50"
                  onClick={() => { setLast(null); setConfirmCancel(false); void open(p.planId); }}
                  disabled={running || busy === "open"}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{p.request || "Plan"}</span>
                    <span className="block text-xs text-muted-foreground">
                      {p.steps} step{p.steps === 1 ? "" : "s"} · {new Date(p.createdAt).toLocaleString()} · <span className="font-mono">{p.planId.slice(0, 13)}…</span>
                    </span>
                  </span>
                  {(() => { const st = summaryStatus(p); return <span className="ml-3 shrink-0"><Badge tone={st.tone}>{st.label}</Badge></span>; })()}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
