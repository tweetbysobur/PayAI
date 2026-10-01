/**
 * Merchant-platform types. The platform layer sits on top of the agent +
 * payment layers and turns raw activity (on-chain payments + the agent
 * transaction log) into merchant-facing analytics, customers, links, invoices,
 * and AI-assistant answers.
 */

/** Which product surface produced a TxLogEntry — distinct from `action`
 *  (send_payment/swap/invoice_payment/…), since an automation and a bulk
 *  distribution both settle through the exact same "send_payment" pipeline
 *  as a manual send and are otherwise indistinguishable in the log.
 *  "trade" (Step 5) settles through the exact same /api/swap/confirm path
 *  as "swap" — same reasoning: an Ask PayAI trade (arbitrary-token, quoted
 *  via lib/monad/tradeQuote.ts) and PayAI's curated Smart Swap are
 *  otherwise indistinguishable in the log without this. */
export type PlatformFeature = "payment" | "swap" | "trade" | "automation" | "bulk";

/** The revenue/analytics chart's own category set — deliberately narrower
 *  than PlatformFeature. "trade" (Step 5's Ask PayAI arbitrary-token trades)
 *  folds into "swap" for revenue purposes — see lib/platform/analytics.ts's
 *  featureOf() — since this chart's 4-color categorical palette is validated
 *  for exactly these four buckets (see PlatformSections.tsx's FEATURE_COLOR
 *  doc); the raw "trade" vs "swap" distinction stays on TxLogEntry itself. */
export type RevenueFeature = Exclude<PlatformFeature, "trade">;

/** One recorded agent run (every outcome, not just settled). */
export interface TxLogEntry {
  id: string;
  at: number; // unix ms
  decision: "executed" | "needs_review" | "blocked" | "refused" | "error";
  action: string;
  /** Absent on entries recorded before this field existed — callers fall
   *  back to inferring "swap" vs "payment" from `action` for those. */
  feature?: PlatformFeature;
  amount: number | null;
  token: string;
  recipient: string | null;
  /** The original .nad/.nads domain, when the recipient was resolved from one. */
  domain?: string | null;
  /** The wallet that initiated this payment. Used to scope a connected user's
   *  dashboard to their OWN activity — one user never sees another's history,
   *  even though wallet-only users share the demo tenant's store. Null for the
   *  custodial/agent path (no end-user wallet) and read-only outcomes. */
  sender?: string | null;
  riskScore: number | null;
  compliance: string | null;
  txHash?: string;
  explorerUrl?: string;
  summary: string;
  /** Swap/trade only — what was actually received, alongside `amount`/`token`
   *  (what was spent). Absent for a payment (there's no "output side") and
   *  for swap/trade entries recorded before this field existed. */
  outputAmount?: number | null;
  outputToken?: string | null;
  /**
   * Swap/trade only — the received token's real CONTRACT ADDRESS, when the
   * trade identified it by address rather than by a curated symbol.
   *
   * `outputToken` above is only ever a display SYMBOL ("MONCAT"), which is
   * not resolvable back to a contract for an arbitrary token — a bare symbol
   * means nothing outside the curated registry. Execution already knows the
   * real address at settle time (executeTradeIntent's own
   * `request.outputToken`), so throwing it away here left the portfolio with
   * no record of what the wallet had just acquired, and therefore wholly
   * dependent on /api/portfolio/discover's wide `eth_getLogs` scan — the one
   * query shape production RPC most often rate-limits or refuses, whose
   * failure is indistinguishable from "this wallet holds nothing new".
   * Persisting it makes a freshly bought token discoverable from the user's
   * own settled history, with no chain scan involved at all.
   *
   * Display-only and additive: nothing reads this for execution, validation,
   * or amounts, and every entry recorded before it existed simply omits it.
   */
  outputTokenAddress?: string | null;
  /** Swap/trade only — which DEX actually served the trade ("Uniswap v3",
   *  "Kuru"). Absent for a payment. */
  provider?: string | null;
  /**
   * Split payments only — the whole on-chain settlement this recipient row
   * belongs to, identical on every row of the same settlement. The PayAI
   * platform fee is a property of the settlement, never a recipient row, so
   * summing recipient `amount`s never counts it. Amounts are exact base-unit
   * strings in `decimals`. Absent for everything else.
   */
  settlement?: {
    id: string | null;
    recipientCount: number;
    token: string;
    decimals: number;
    recipientTotal: string;
    platformFee: string;
    treasury: string | null;
    grossPaid: string;
  };
}

/**
 * A lifecycle notification for a Payment Automation — distinct from a payment
 * TxLogEntry (which is a settlement outcome feeding revenue analytics). This is
 * a generic, reusable event log: `kind` identifies which automation engine
 * produced it, so a future engine (payroll, subscriptions, treasury, savings,
 * installments…) reuses this same shape and the same notification feed
 * instead of inventing its own — the whole reason this is its own module
 * rather than folded into the tx log.
 */
export type AutomationEventType =
  | "created" | "updated" | "upcoming_execution" | "execution_started" | "executed" | "execution_failed"
  | "paused" | "resumed" | "cancelled" | "completed" | "skipped"
  | "low_balance" | "reserved_funds_low" | "refund_started" | "refunded";

export interface AutomationEvent {
  id: string;
  automationId: string;
  /** Which automation engine raised this — "recurring_payment" today; a future
   *  kind (e.g. "payroll_run") plugs into the same event log unchanged. */
  kind: string;
  merchantId: string;
  sender?: string | null;
  type: AutomationEventType;
  at: number;
  title: string;
  detail: string;
  amount?: number | null;
  token?: string | null;
  txHash?: string;
  explorerUrl?: string;
}

/** Payment Automation frequency. Custom stays intentionally small in v1. */
export type AutomationCadence = "once" | "daily" | "weekly" | "monthly" | "custom";
export type AutomationIntervalUnit = "days" | "weeks" | "months";
/** One clear status per automation. */
export type AutomationStatus = "active" | "paused" | "completed" | "cancelled" | "failed" | "scheduled" | "executing";

export type ScheduleCadence = AutomationCadence;
export type ScheduleStatus = AutomationStatus;

/** When a recurring automation stops on its own, without the user cancelling it.
 *  "never" (the old default behavior) is discouraged in the UI — real standing
 *  orders default to a bound. */
export type AutomationEndCondition =
  | { type: "never" }
  | { type: "after_count"; totalRuns: number }
  | { type: "until_date"; untilMs: number };
export type ScheduleEndCondition = AutomationEndCondition;

export interface AutomationExecution {
  at: number;
  txHash?: string;
  explorerUrl?: string;
  decision: string;
  detail?: string;
  gasFee?: number;
  /** Wall-clock time the compliance→risk→settlement pipeline actually took for this occurrence, in ms — measured around the real execute() call, never estimated. */
  durationMs?: number;
  /** Bulk Payments only: the real per-recipient outcome of this occurrence —
   *  one entry per recipient, each settled through the exact same execute()
   *  pipeline as a single-recipient automation, just called once per
   *  recipient instead of once total. `decision` on the parent run is the
   *  AGGREGATE outcome ("executed" only if every recipient succeeded,
   *  "partial" if some did and some didn't, "error" if none did) — the real
   *  detail always lives here, never summarized away. */
  recipientResults?: BulkRecipientResult[];
}

/** One recipient in a Bulk Payment — resolved and validated at creation time,
 *  the same way a single-recipient automation's recipient is. `input` keeps
 *  what the user actually typed/pasted/uploaded (an address, a .nad domain,
 *  or a known payee name) so the UI can show what they entered, not just the
 *  resolved 0x address. */
export interface BulkRecipient {
  input: string;
  address: string;
  domain?: string | null;
  amount: number;
  note?: string;
}

export type DistributionMethod = "equal" | "fixed" | "percentage" | "custom";

/** One refund event on a Reserved Funds automation (Mini Sprint Part 1's
 *  "AUTOMATIC REFUND HISTORY"). Immutable once recorded — nothing ever
 *  edits or removes an entry after the fact, only appends. */
export interface RefundRecord {
  /** Why the refund happened, in the same plain-language form already used
   *  in the automation event log (e.g. "the automation was cancelled",
   *  "the automation stopped after a failed execution"). */
  reason: string;
  /** Amount actually returned, in the automation's display token/decimals — not base units. */
  amount: number;
  txHash: string;
  explorerUrl?: string;
  /** Unix ms the refund transaction was confirmed. */
  at: number;
  /** This automation's own id — redundant with the row it lives on, but kept
   *  so a refund record is self-describing if it's ever surfaced outside the
   *  automation's own page (e.g. a merchant-wide refund ledger). */
  automationId: string;
  /** The `at` timestamp of the run in `runs[]` whose failure triggered this
   *  refund, when there was one — null for a refund triggered by an explicit
   *  cancel/delete rather than an execution failure. */
  originalExecutionAt?: number | null;
}

export interface BulkRecipientResult {
  address: string;
  domain?: string | null;
  amount: number;
  txHash?: string;
  explorerUrl?: string;
  decision: "executed" | "error" | "blocked" | "needs_review";
  detail?: string;
  /** How long this recipient's own compliance→risk→settlement pass took, in ms. */
  durationMs?: number;
}

export interface PaymentAutomation {
  id: string;
  merchantId: string;
  /** The wallet that created this automation. Used to scope a connected user's
   *  own automations on the shared demo tenant — one wallet-only user must
   *  never see or cancel another's automation. Null on merchant-account
   *  tenants, which are already isolated by merchantId. */
  sender?: string | null;
  amount: number;
  /** Display symbol — kept for back-compat/display; tokenAddress below is the source of truth execution actually settles against. */
  token: string;
  /** The token's real contract address (NATIVE_TOKEN_ADDRESS for MON), resolved once at creation via lib/monad/tokenRegistry.ts and never re-guessed at execution time. Absent on automations created before token selection existed — those fall back to the legacy MON/USDC symbol path. */
  tokenAddress?: string;
  /** The token's on-chain decimals, captured at creation alongside tokenAddress. */
  tokenDecimals?: number;
  /** Curated logo URI for display, if the token was verified at creation; null/absent falls back to the generic token badge. */
  tokenLogo?: string | null;
  /**
   * The PaymentExecutor / AutomationVault contract address that was actually
   * live when this automation was created, stamped once and never changed.
   * This is what lets a contract redeploy (a fix, a new feature) ship
   * without breaking every existing automation: execution reads THESE
   * addresses instead of always calling the current global config, so an
   * existing Wallet Automation keeps using the exact executor its ERC-20
   * approval was granted to, and an existing Reserved Funds automation keeps
   * releasing/refunding from the exact vault holding its deposit — forever,
   * with no forced re-approval or fund migration. Absent on automations
   * created before this existed; execution falls back to the current global
   * config for those, which is correct since they were created against
   * whatever was live at the time this field was introduced.
   */
  executorAddress?: string | null;
  /** Same per-automation pinning as executorAddress, for AutomationVault (Reserved Funds only). */
  vaultAddress?: string | null;
  /** Resolved 0x address the payment settles to. */
  recipient: string;
  /** Original .nad/.nads domain, when the recipient was resolved from one. */
  domain?: string | null;
  cadence: AutomationCadence;
  intervalCount?: number;
  intervalUnit?: AutomationIntervalUnit;
  timezone?: string;
  purpose: string;
  /** Unix ms of the next (or only) automation execution. */
  nextRun: number;
  status: AutomationStatus;
  createdAt: number;
  /** The `nextRun` value an "upcoming execution" reminder has already been sent
   *  for — prevents re-notifying on every cron tick within the lookahead
   *  window. Cleared implicitly whenever nextRun advances past it. */
  remindedForRun?: number | null;
  /** The `nextRun` value a "low balance" (Wallet Automation) warning has already been sent for — same anti-spam pattern as remindedForRun. */
  lowBalanceWarnedForRun?: number | null;
  /** The `nextRun` value a "reserved funds running low" (Reserved Funds) warning has already been sent for. */
  reservedLowWarnedForRun?: number | null;
  /** Every fired run, newest first — real on-chain receipts, never fabricated. */
  runs: AutomationExecution[];
  /** Optional human label/memo. */
  memo?: string;
  /** Defaults to `{ type: "never" }` for automations created before this existed. */
  endCondition?: AutomationEndCondition;
  /** Successful (executed) runs only — checked against after_count. */
  runsCompleted: number;
  /** Consecutive execution errors since the last success (or since creation).
   *  Reset to 0 on every successful run. A hard compliance block does NOT
   *  count here — that goes straight to "failed" since retrying won't help. */
  failureCount: number;
  /** The reason the automation stopped or is at risk of stopping, for display. */
  lastError?: string | null;
  /** The wallet signature captured at CREATION — an immutable record of the
   *  terms the owner originally authorized. Deliberately never overwritten by
   *  edits: it stays verifiable against `signatureMessage` forever. If a
   *  material term (amount/cadence/timing) is later changed, `modifiedAt` is
   *  stamped so the audit trail reflects that current terms may differ from
   *  this original authorization rather than silently contradicting it. */
  signature?: string | null;
  signatureMessage?: string | null;
  /** Unix ms of the last material edit (amount/cadence/timing/end-condition),
   *  null if never edited since creation. Every edit is itself gated by a
   *  fresh action-scoped wallet signature (see verifyMutation), so this marks
   *  a re-authorized change, not an unauthorized one. */
  modifiedAt?: number | null;
  /**
   * How this automation is funded at execution:
   *   - "wallet"   → Wallet Automation (non-custodial): pull the user's
   *                  pre-approved ERC-20 at execution. Default for USDC.
   *   - "reserved" → Reserved Funds: pay out from the user's AutomationVault
   *                  reservation.
   * Absent on legacy records = the old agent-funded path.
   */
  fundingMode?: "wallet" | "reserved";
  /** Reserved Funds: the tx hash that funded the vault reservation (audit trail). */
  reserveTxHash?: string | null;
  /** Reserved Funds: the tx that returned the unspent reservation to the depositor, set when an automation is cancelled or terminally fails. Presence means the money is already back in their wallet. Kept alongside refundHistory[0].txHash for back-compat with anything still reading this field directly. */
  reserveRefundTxHash?: string | null;
  /**
   * Reserved Funds refund outcome — the explicit signal displayStatus() and
   * the dashboard need to tell "nothing was ever owed back" apart from "money
   * is owed back and the refund hasn't landed yet." Without this, the mere
   * absence of reserveRefundTxHash is ambiguous: it's equally true for an
   * automation that spent its ENTIRE reservation through legitimate runs
   * (nothing left, "none" — correct, no action needed) and for one where the
   * refund attempt failed on an RPC hiccup (money still owed, "pending" —
   * needs the "Recover reserved funds" tool or a retry).
   *   - undefined → pre-Mini-Sprint row, or a non-reserved automation. Never
   *     shown as "refunding" in the UI (see displayStatus in
   *     app/dashboard/automations/page.tsx) — same reasoning as every other
   *     optional field introduced after existing data: absence must never be
   *     read as "stuck," only as "this concept didn't exist yet when it was
   *     created."
   *   - "none"     → checked on-chain at terminal time, reservedBalance was
   *                   already 0. Nothing owed.
   *   - "refunded" → refund succeeded. reserveRefundTxHash / refundHistory
   *                   has the tx.
   *   - "pending"  → the automation is terminal, something WAS reserved, and
   *                   the refund attempt hasn't succeeded yet (chain hiccup,
   *                   or genuinely still in flight). Retryable via the
   *                   dashboard's recovery tool.
   */
  reserveRefundStatus?: "none" | "refunded" | "pending";
  /**
   * Full refund history for this automation (Reserved Funds only). In
   * practice at most one entry today — a reservation is refunded once, at
   * the one terminal moment nothing will draw on it again — but this is an
   * array, not a single record, so a future scenario with more than one
   * refund event (e.g. a partial refund followed by a final sweep) doesn't
   * require another migration.
   */
  refundHistory?: RefundRecord[];
  /** The Automation Template this was created from (see lib/automation/templates.ts),
   *  or null/absent for a from-scratch ("Custom") automation. Purely a label on
   *  top of the same engine — a template never changes execution behavior,
   *  only the defaults the creation wizard was pre-filled with. */
  templateId?: string | null;
  /** Template category (Personal/Business/Launchpad/NFT/DAO/Creator), stored
   *  alongside templateId so the dashboard can filter without re-deriving it
   *  from a template catalog that may change over time. */
  templateCategory?: string | null;
  /**
   * Bulk Payments. When present, this automation pays MULTIPLE recipients
   * per occurrence instead of one — `recipient`/`amount` above still hold a
   * representative value (the first recipient / the total budget) for any
   * code that isn't bulk-aware, but the REAL per-recipient breakdown lives
   * here. Every recipient still settles through the exact same execute()
   * pipeline as a single-recipient automation; this only changes how many
   * times that pipeline runs per occurrence, not what it does.
   *
   * Reserved Funds is NOT supported for bulk: AutomationVault.reserve()/
   * release() lock a reservation to exactly one recipient on-chain, decided
   * at reserve time — there is no contract-level way to pay out to N
   * different recipients from one reservation without changing the
   * contract itself, which is out of scope here. Bulk automations are
   * Wallet Automation only.
   */
  recipients?: BulkRecipient[];
  distributionMethod?: DistributionMethod;
}

export type ScheduledPayment = PaymentAutomation;

export type LinkStatus = "active" | "paid" | "expired";

export interface PaymentLink {
  id: string;
  merchantId: string;
  /** The wallet that created this link. Scopes listing to the caller's own
   *  links on the shared demo tenant, same reasoning as ScheduledPayment.sender. */
  sender?: string | null;
  url: string;
  amount: number;
  token: string;
  /** Merchant payout wallet snapshotted at link creation, if one was on file. */
  recipient?: string;
  memo?: string;
  status: LinkStatus;
  createdAt: number;
  expiresAt: number | null;
  paidAt?: number;
  txHash?: string;
}

export interface RevenueOverview {
  /** All figures below are denominated in `currency` and count only payments
   *  settled in it. Amounts in different assets are never added together —
   *  see `byToken` for the full picture. */
  total: number;
  today: number;
  thisWeek: number;
  thisMonth: number;
  /** The asset the headline figures are in: whichever one this merchant has
   *  settled the most payments in. */
  currency: string;
  /** Settled amount per token, so activity outside the headline currency is
   *  reported rather than dropped — or, worse, blended into it. */
  byToken: Record<string, number>;
  settledCount: number;
  failedCount: number;
  successRate: number; // 0..1
}

export interface TrendPoint {
  date: string; // YYYY-MM-DD
  revenue: number;
  count: number;
}

export interface Customer {
  address: string;
  name?: string;
  totalPaid: number;
  paymentCount: number;
  avgRisk: number;
  lastActivity: number;
  riskLevel: "low" | "medium" | "high";
}

export interface ComplianceMetrics {
  approved: number;
  rejected: number;
  review: number;
  blocked: number;
  approvalRate: number; // 0..1
}

export interface Insight {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  suggestion?: string;
}

export interface AnalyticsSnapshot {
  revenue: RevenueOverview;
  trend: TrendPoint[];
  volume: { count: number; total: number };
  topCustomers: Customer[];
  compliance: ComplianceMetrics;
  insights: Insight[];
}

export interface AssistantAnswer {
  intent: string;
  answer: string;
  data?: unknown;
  action?: { type: string; result: unknown };
}

/* ── Support Center ──────────────────────────────────────────────────────── */

export type SupportCategory =
  | "failed_automation" | "missing_refund" | "payment_issue"
  | "wallet_issue" | "bug_report" | "feature_request" | "general_question";

export type SupportTicketStatus = "open" | "resolved";

export interface SupportTicket {
  id: string;
  merchantId: string;
  sender?: string | null;
  category: SupportCategory;
  description: string;
  /** Optional cross-references the reporter supplies or that get auto-filled
   *  from context (e.g. opened from an Automation Details page). Never
   *  required — a general question has neither. */
  automationId?: string | null;
  txHash?: string | null;
  status: SupportTicketStatus;
  createdAt: number;
}
