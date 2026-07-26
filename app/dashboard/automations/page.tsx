"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import {
  AlertTriangle, ArrowRight, BarChart3, CalendarClock, CheckCircle2, Copy, ExternalLink,
  Pause, Play, Plus, ReceiptText, Repeat, ShieldCheck, Trash2, X, Eye, Pencil,
  Lock, Wallet, Zap, SkipForward, Search, Users,
} from "lucide-react";
import { encodeFunctionData, keccak256, parseUnits, stringToHex, type Hex } from "viem";
import { Badge, Button, Card, Input, Skeleton, SkeletonRows } from "@/components/ui";
import { TokenLogo } from "@/components/TokenLogo";
import { useToast } from "@/components/Toast";
import { useWallet, type WalletState } from "@/lib/wallet/useWallet";
import { BulkPaymentCreator } from "@/components/dashboard/BulkPaymentCreator";
import { useTokenBalance } from "@/lib/hooks/useTokenBalance";
import { TokenSelector, type TokenInfo } from "@/components/dashboard/TokenSelector";
import { useModalA11y } from "@/lib/hooks/useModalA11y";

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
import { AUTOMATION_VAULT_ABI } from "@/lib/monad/abi";
import { calculateFee } from "@/lib/payment/feeEngine";
import { TemplatePicker } from "@/components/dashboard/TemplatePicker";
import { TEMPLATE_CATEGORIES, findTemplate, canLaunchWorkflow, type AutomationTemplate, type TemplateCategory } from "@/lib/automation/templates";

type FundingMode = "wallet" | "reserved";
type OnchainConfig = {
  chainId: number; executor: string | null; vault: string | null; wmon: string | null;
  usdc: { address: string; decimals: number }; walletModeAvailable: boolean; reservedModeAvailable: boolean;
};

const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** bytes32 automation id — must match the server's requestId32 (keccak of the id string). */
function autoId32(id: string): Hex {
  return keccak256(stringToHex(id));
}

/**
 * Send a tx and wait for it to confirm through the wallet the user actually
 * connected with (wallet.sendTransaction/waitForReceipt), not the raw
 * `window.ethereum` global — with multiple wallet extensions installed,
 * `window.ethereum` can silently be a DIFFERENT extension than the one the
 * user picked, sending the tx to the wrong (or a disconnected) wallet. Wait
 * uses PayAI's own RPC via viem rather than the wallet's, so it doesn't
 * depend on that extension supporting eth_getTransactionReceipt correctly.
 */
async function confirmTx(wallet: WalletState, to: string, data: string, value?: bigint): Promise<string> {
  const hash = await wallet.sendTransaction({ to, data, value: value != null ? `0x${value.toString(16)}` : undefined });
  const receipt = (await wallet.waitForReceipt(hash)) as { status?: string } | null;
  if (receipt && receipt.status !== "success") throw new Error("The on-chain transaction failed. Nothing was created.");
  return hash;
}

type Cadence = "once" | "daily" | "weekly" | "monthly" | "custom";
type Status = "active" | "paused" | "completed" | "cancelled" | "failed" | "scheduled" | "executing";
type IntervalUnit = "days" | "weeks" | "months";
type BulkRecipientResult = { address: string; domain?: string | null; amount: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string; durationMs?: number };
type Run = { at: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string; gasFee?: number; durationMs?: number; recipientResults?: BulkRecipientResult[] };
type EndCondition = { type: "never" } | { type: "after_count"; totalRuns: number } | { type: "until_date"; untilMs: number };
type EndMode = "never" | "after_count" | "until_date";
type BulkRecipient = { input: string; address: string; domain?: string | null; amount: number; note?: string };
type Automation = {
  id: string; amount: number; token: string; tokenAddress?: string; tokenDecimals?: number; tokenLogo?: string | null;
  recipient: string; domain?: string | null;
  cadence: Cadence; intervalCount?: number; intervalUnit?: IntervalUnit; nextRun: number; status: Status;
  createdAt: number; modifiedAt?: number | null; runs: Run[]; purpose?: string; memo?: string; timezone?: string; runsCompleted: number; failureCount: number; lastError?: string | null; sender?: string | null;
  endCondition?: EndCondition; fundingMode?: "wallet" | "reserved";
  templateId?: string | null; templateCategory?: string | null;
  /** Bulk Payments only — presence marks this as a multi-recipient automation. */
  recipients?: BulkRecipient[];
  distributionMethod?: "equal" | "fixed" | "percentage" | "custom";
};

/** Real per-recipient totals across every run this automation has fired,
 *  computed only from recorded recipientResults — never fabricated. */
function bulkStats(a: Automation) {
  const allResults = a.runs.flatMap((r) => r.recipientResults ?? []);
  const successful = allResults.filter((r) => r.decision === "executed");
  const failed = allResults.filter((r) => r.decision !== "executed");
  const totalDistributed = successful.reduce((s, r) => s + r.amount, 0);
  const recipientCount = a.recipients?.length ?? 0;
  // "Remaining" only makes sense for a bounded (once / after_count / until_date)
  // schedule — an ongoing bulk payment has no fixed total to count down from.
  const remaining = a.cadence === "once" ? Math.max(0, recipientCount - successful.length) : null;
  return { recipientCount, successful: successful.length, failed: failed.length, totalDistributed, remaining };
}

const PURPOSES = ["Savings", "Salary", "Subscription", "Investment", "Rent", "Family", "Utilities", "Gift", "Business", "Other"];
const STATUS_TONE: Record<Status, "neutral" | "success" | "warning" | "danger" | "primary"> = {
  active: "success", scheduled: "primary", executing: "warning", paused: "neutral", completed: "success", cancelled: "neutral", failed: "danger",
};

/**
 * A finer-grained status LABEL layered on top of the real persisted `status`
 * field, purely for display — never changes any gating logic elsewhere
 * (button visibility, execution eligibility, etc. all still key off the real
 * `status`). "Retrying" and "Waiting" are both derived from fields that
 * already exist and are real (failureCount, nextRun) — never a fabricated
 * state with no backing.
 */
function displayStatus(a: Automation): { label: string; tone: "neutral" | "success" | "warning" | "danger" | "primary" } {
  if (a.status === "active" && a.failureCount > 0) return { label: "retrying", tone: "warning" };
  if ((a.status === "active" || a.status === "scheduled") && a.nextRun > Date.now()) return { label: "waiting", tone: "primary" };
  return { label: a.status, tone: STATUS_TONE[a.status] };
}
const short = (s?: string | null) => (s ? `${s.slice(0, 6)}...${s.slice(-4)}` : "-");
const money = (n: number, token = "") => `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}${token ? ` ${token}` : ""}`;

function cadenceLabel(a: Pick<Automation, "cadence" | "intervalCount" | "intervalUnit">) {
  if (a.cadence === "once") return "One time";
  if (a.cadence === "daily") return "Daily";
  if (a.cadence === "weekly") return "Weekly";
  if (a.cadence === "monthly") return "Monthly";
  return `Every ${a.intervalCount ?? 1} ${a.intervalUnit ?? "days"}`;
}

function annualVolume(a: Automation) {
  const amount = Number(a.amount) || 0;
  if (a.cadence === "once") return amount;
  if (a.cadence === "daily") return amount * 365;
  if (a.cadence === "weekly") return amount * 52;
  if (a.cadence === "monthly") return amount * 12;
  const count = Math.max(1, a.intervalCount ?? 1);
  if (a.intervalUnit === "weeks") return amount * (52 / count);
  if (a.intervalUnit === "months") return amount * (12 / count);
  return amount * (365 / count);
}

/** Advance a timestamp by one cadence step — mirrors the server's advanceRun. */
function stepOnce(from: number, cadence: Cadence, intervalCount: number, intervalUnit: IntervalUnit): number {
  const d = new Date(from);
  const n = Math.max(1, intervalCount);
  if (cadence === "daily") d.setUTCDate(d.getUTCDate() + 1);
  else if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cadence === "custom") {
    if (intervalUnit === "weeks") d.setUTCDate(d.getUTCDate() + n * 7);
    else if (intervalUnit === "months") d.setUTCMonth(d.getUTCMonth() + n);
    else d.setUTCDate(d.getUTCDate() + n);
  }
  return d.getTime();
}

/** How many payments this schedule will make. Returns null for open-ended
 *  ("no end date") automations, where the total is genuinely unbounded. */
function countOccurrences(opts: {
  startAt: number; cadence: Cadence; intervalCount: number; intervalUnit: IntervalUnit;
  endMode: EndMode; endCount: number; endUntilMs: number;
}): number | null {
  if (opts.cadence === "once") return 1;
  if (opts.endMode === "after_count") return Math.max(1, Math.floor(opts.endCount) || 1);
  if (opts.endMode === "until_date") {
    if (!Number.isFinite(opts.endUntilMs) || opts.endUntilMs < opts.startAt) return 0;
    let n = 0; let t = opts.startAt; const CAP = 1000;
    while (t <= opts.endUntilMs && n < CAP) { n++; t = stepOnce(t, opts.cadence, opts.intervalCount, opts.intervalUnit); }
    return n;
  }
  return null; // never — open-ended
}

/** Per-automation analytics, computed only from its own real recorded runs
 *  (on-chain txHash/gasFee when settled) — never a fabricated number. */
function automationMetrics(a: Automation) {
  const executed = a.runs.filter((r) => r.decision === "executed");
  const attempted = a.runs.filter((r) => r.decision === "executed" || r.decision === "error" || r.decision === "blocked" || r.decision === "needs_review");
  const totalGas = executed.reduce((sum, r) => sum + (r.gasFee ?? 0), 0);
  const lastExecution = executed[0]?.at ?? null;
  const target = a.endCondition?.type === "after_count" ? a.endCondition.totalRuns : null;
  return {
    totalExecutions: executed.length,
    successRate: attempted.length ? Math.round((executed.length / attempted.length) * 100) : 100,
    totalVolume: executed.length * a.amount,
    totalGas,
    avgGas: executed.length ? totalGas / executed.length : 0,
    lastExecution,
    completionPct: target ? Math.min(100, Math.round((a.runsCompleted / target) * 100)) : null,
  };
}

function signatureMessage(input: { walletAddress: string; recipient: string; amount: number; token: string; cadence: string; startAt: number; timezone: string; purpose: string }) {
  return [
    "PayAI Payment Automation",
    `Wallet: ${input.walletAddress}`,
    `Recipient: ${input.recipient}`,
    `Amount: ${input.amount} ${input.token}`,
    `Automation: ${input.cadence}`,
    `First execution: ${new Date(input.startAt).toISOString()}`,
    `Timezone: ${input.timezone}`,
    `Purpose: ${input.purpose}`,
    "Network: Monad Mainnet",
  ].join("\n");
}

/** Mirrors the server's mutationMessage() in app/api/automations/route.ts —
 *  must stay byte-for-byte identical or verifyMessage() rejects every action. */
function mutationMessage(input: { walletAddress: string; automationId: string; action: string; timestamp: number }) {
  return [
    "PayAI Automation Update",
    `Wallet: ${input.walletAddress}`,
    `Automation: ${input.automationId}`,
    `Action: ${input.action}`,
    `Timestamp: ${input.timestamp}`,
  ].join("\n");
}

/** Every mutation to an existing automation — edit, pause, resume, cancel,
 *  delete — needs proof of wallet ownership, the same as creation. Returns
 *  null if the user has no wallet connected or cancels the wallet prompt. */
async function signMutation(wallet: WalletState, automationId: string, actionName: string): Promise<{ signature: string; timestamp: number } | null> {
  if (!wallet.address) return null;
  const timestamp = Date.now();
  const message = mutationMessage({ walletAddress: wallet.address, automationId, action: actionName, timestamp });
  try {
    const signature = await wallet.signMessage(message);
    return { signature, timestamp };
  } catch {
    return null;
  }
}

export default function AutomationsPage() {
  const wallet = useWallet();
  const { toast } = useToast();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [duplicateSeed, setDuplicateSeed] = useState<AutomationSeed | null>(null);
  const [bulkSeed, setBulkSeed] = useState<BulkAutomationSeed | null>(null);
  const [viewing, setViewing] = useState<Automation | null>(null);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<TemplateCategory | "all">("all");
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [tokenFilter, setTokenFilter] = useState<string | "all">("all");
  const [modeFilter, setModeFilter] = useState<FundingMode | "all">("all");
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "week" | "month">("all");
  const [searchQuery, setSearchQuery] = useState("");

  /** Template → wizard seed. Only sets fields the template actually
   *  specifies; recipient/amount/exact time are always left for the user to
   *  fill in, even from a template — templates set smart defaults, not
   *  locked-in values. */
  function handleTemplateSelect(template: AutomationTemplate | null) {
    // Defense in depth: the picker already disables and guards Coming Soon
    // workflows, but the wizard must refuse one regardless of how it was
    // reached — an unimplemented workflow can never begin creating a
    // real, money-moving automation.
    if (template && !canLaunchWorkflow(template)) return;
    setPickerOpen(false);
    if (!template) {
      setDuplicateSeed(null);
    } else {
      setDuplicateSeed({
        token: template.defaults.token,
        cadence: template.defaults.cadence,
        intervalCount: template.defaults.intervalCount,
        intervalUnit: template.defaults.intervalUnit,
        purpose: template.defaults.purpose,
        fundingMode: template.defaults.fundingMode,
        endMode: template.defaults.endMode,
        templateId: template.id,
        templateCategory: template.category,
      });
    }
    setCreatorOpen(true);
  }

  /** A Bulk Payment template hands off to the Bulk Payment wizard instead
   *  of the single-recipient one — same pre-fill contract, different
   *  existing wizard. */
  function handleBulkTemplateSelect(template: AutomationTemplate) {
    if (!canLaunchWorkflow(template)) return; // same guard as the single-recipient path
    setPickerOpen(false);
    setBulkSeed({
      purpose: template.defaults.purpose,
      distributionMethod: template.defaults.distributionMethod,
      templateId: template.id,
      templateCategory: template.category,
    });
    setBulkOpen(true);
  }

  // Every distinct token actually seen across this wallet's automations —
  // never a hardcoded MON/USDC pair, since any Monad token can be used now.
  const availableTokens = useMemo(() => Array.from(new Set(automations.map((a) => a.token))).sort(), [automations]);

  const visibleAutomations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const now = Date.now();
    const dateFrom = dateFilter === "today" ? now - 24 * 60 * 60 * 1000
      : dateFilter === "week" ? now - 7 * 24 * 60 * 60 * 1000
      : dateFilter === "month" ? now - 30 * 24 * 60 * 60 * 1000
      : null;
    return automations.filter((a) => {
      if (categoryFilter !== "all" && a.templateCategory !== categoryFilter) return false;
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      if (tokenFilter !== "all" && a.token !== tokenFilter) return false;
      if (modeFilter !== "all" && (a.fundingMode ?? "wallet") !== modeFilter) return false;
      if (dateFrom != null && a.createdAt < dateFrom) return false;
      if (q) {
        const haystack = [
          a.purpose, a.memo, a.domain, a.recipient, a.sender, findTemplate(a.templateId ?? "")?.name,
          ...a.runs.map((r) => r.txHash),
        ].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [automations, categoryFilter, statusFilter, tokenFilter, modeFilter, dateFilter, searchQuery]);

  const load = useCallback(() => {
    const qs = wallet.address ? `?wallet=${wallet.address}` : "";
    fetch(`/api/automations${qs}`)
      .then((r) => r.json())
      .then((j) => setAutomations(j.automations ?? []))
      .finally(() => setLoading(false));
  }, [wallet.address]);

  useEffect(() => { load(); }, [load]);

  // Ask PayAI can parse and resolve a Payment Automation draft, but it can
  // never create one itself — it hands the resolved fields here as a prefill
  // (lib/hooks/useAgentConsole.ts) and the user still has to review and sign
  // through this same wizard, exactly like a manual creation.
  useEffect(() => {
    const raw = sessionStorage.getItem("payai_automation_prefill");
    if (!raw) return;
    sessionStorage.removeItem("payai_automation_prefill");
    try {
      setDuplicateSeed(JSON.parse(raw) as AutomationSeed);
      setCreatorOpen(true);
    } catch {
      /* malformed draft — ignore, user can still create manually */
    }
  }, []);

  const ACTION_LABEL: Record<string, string> = {
    pause: "Automation paused", resume: "Automation resumed", cancel: "Automation cancelled",
    delete: "Automation deleted", skip_next: "Next execution skipped", execute_now: "Execution triggered",
  };

  async function action(id: string, actionName: "pause" | "resume" | "cancel" | "delete" | "skip_next" | "execute_now") {
    if (!wallet.address) return;
    setBusy(id);
    try {
      const proof = await signMutation(wallet, id, actionName);
      if (!proof) throw new Error("Confirmation was cancelled in your wallet.");
      const r = actionName === "delete"
        ? await fetch(`/api/automations?id=${id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ walletAddress: wallet.address, ...proof }) })
        : await fetch(`/api/automations?id=${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ walletAddress: wallet.address, action: actionName, ...proof }) });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || "Action failed.");
      if (actionName === "execute_now") {
        toast(j.outcome === "executed" ? "Payment sent" : j.outcome === "error" ? "Execution failed — check activity for details" : "Payment could not be sent — needs review");
      } else {
        toast(ACTION_LABEL[actionName] ?? "Done");
      }
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Automation action failed");
    } finally {
      setBusy(null);
    }
  }

  const active = visibleAutomations.filter((a) => a.status === "active" || a.status === "scheduled" || a.status === "executing");
  const upcoming = active.slice().sort((a, b) => a.nextRun - b.nextRun).slice(0, 5);
  const runs = visibleAutomations.flatMap((a) => a.runs.map((run) => ({ ...run, automation: a }))).sort((a, b) => b.at - a.at);
  // Never blend MON and USDC into one number — same convention as
  // components/TokenLogo.tsx's VolumeInline (which this now reuses). A
  // single summed "totalVolume" across tokens was previously meaningless
  // (1 MON + 1 USDC read as "2") and, on mobile, the resulting long/odd
  // number was the actual cause of the perceived "lag" — the tile reflowed
  // once the real (much longer) formatted string rendered post-hydration.
  const volumeByToken = visibleAutomations.reduce<Record<string, number>>((acc, a) => {
    const executed = a.runs.filter((r) => r.decision === "executed").length;
    if (executed > 0) acc[a.token] = (acc[a.token] ?? 0) + executed * a.amount;
    return acc;
  }, {});
  const totalRuns = runs.length;
  const successRuns = runs.filter((r) => r.decision === "executed").length;
  const successRate = totalRuns ? Math.round((successRuns / totalRuns) * 100) : 0;
  const totalGas = runs.reduce((sum, r) => sum + (r.gasFee ?? 0), 0);

  // Automation Health — every figure derived from the same already-loaded
  // automations/runs, nothing separately fetched or fabricated.
  const executingNow = visibleAutomations.filter((a) => a.status === "executing").length;
  const todayEnd = useMemo(() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }, []);
  const upcomingToday = active.filter((a) => a.nextRun >= Date.now() && a.nextRun <= todayEnd).length;
  const startOfToday = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }, []);
  const failedToday = runs.filter((r) => r.at >= startOfToday && r.decision !== "executed" && r.decision !== "partial").length;
  const soonest = active.slice().sort((a, b) => a.nextRun - b.nextRun)[0] ?? null;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Payment Automations</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Create reliable MON and USDC automations with wallet confirmation, verified recipients, and execution history on Monad Mainnet.
          </p>
        </div>
        {wallet.address && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setBulkOpen(true)} className="inline-flex items-center gap-2">
              <Users size={16} /> Bulk Payment
            </Button>
            <Button onClick={() => setPickerOpen(true)} className="inline-flex items-center gap-2">
              <Plus size={16} /> Create Automation
            </Button>
          </div>
        )}
      </div>

      {automations.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1 sm:flex-none">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search recipient, template, wallet, or tx hash…"
              className="w-full rounded-lg border border-border bg-input py-1.5 pl-8 pr-3 text-xs text-foreground outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-ring sm:w-64"
            />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as Status | "all")} className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs text-foreground outline-none">
            <option value="all">All statuses</option>
            {(["active", "scheduled", "executing", "paused", "completed", "cancelled", "failed"] as Status[]).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={tokenFilter} onChange={(e) => setTokenFilter(e.target.value)} className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs text-foreground outline-none">
            <option value="all">All tokens</option>
            {availableTokens.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value as FundingMode | "all")} className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs text-foreground outline-none">
            <option value="all">All execution modes</option>
            <option value="wallet">Wallet Automation</option>
            <option value="reserved">Reserved Funds</option>
          </select>
          <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value as typeof dateFilter)} className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs text-foreground outline-none">
            <option value="all">Any date created</option>
            <option value="today">Last 24 hours</option>
            <option value="week">Last 7 days</option>
            <option value="month">Last 30 days</option>
          </select>
        </div>
      )}

      {automations.some((a) => a.templateCategory) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Filter by template:</span>
          <button
            onClick={() => setCategoryFilter("all")}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${categoryFilter === "all" ? "border-primary/50 bg-primary/10 text-primary-ink" : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"}`}
          >
            All
          </button>
          {TEMPLATE_CATEGORIES.filter((c) => c.id !== "custom" && automations.some((a) => a.templateCategory === c.id)).map((c) => (
            <button
              key={c.id}
              onClick={() => setCategoryFilter(c.id)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${categoryFilter === c.id ? "border-primary/50 bg-primary/10 text-primary-ink" : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"}`}
            >
              {c.emoji} {c.label}
            </button>
          ))}
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric title="Active Automations" value={active.length.toString()} icon={Repeat} />
        <Metric title="Success Rate" value={`${successRate}%`} icon={ShieldCheck} />
        <Metric title="Total Volume" icon={BarChart3} value={<VolumeMetricValue byToken={volumeByToken} />} />
        <Metric title="Gas Spent" value={`${totalGas.toFixed(4)} MON`} icon={ReceiptText} />
      </section>

      {automations.length > 0 && (
        <Card title="Automation Health">
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-7">
            <AnalyticsTile label="Total Active" value={active.length.toString()} />
            <AnalyticsTile label="Executing Right Now" value={executingNow.toString()} />
            <AnalyticsTile label="Upcoming Today" value={upcomingToday.toString()} />
            <AnalyticsTile label="Success Rate" value={`${successRate}%`} />
            <AnalyticsTile label="Failed Today" value={failedToday.toString()} />
            <AnalyticsTile label="Total Automated Volume" value={<VolumeMetricValue byToken={volumeByToken} />} />
            <AnalyticsTile
              label="Estimated Next Payment"
              value={soonest ? `${money(soonest.amount, soonest.token)} · ${new Date(soonest.nextRun).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "None scheduled"}
            />
          </div>
          {runs.length > 0 && <ExecutionTrendChart runs={runs} />}
        </Card>
      )}

      {!wallet.address ? (
        <Card className="text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary-ink"><ShieldCheck size={20} /></div>
          <p className="text-sm font-medium text-foreground">Connect your wallet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">Automations are scoped to your wallet. Connect to create and manage yours.</p>
        </Card>
      ) : loading ? (
        <section className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
          <Card title="Active Automations">
            <div className="grid gap-3 lg:grid-cols-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-border p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton className="h-4 w-2/3" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                    <Skeleton className="h-5 w-16 shrink-0 rounded-md" />
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    {Array.from({ length: 4 }).map((__, j) => (
                      <div key={j} className="space-y-1.5"><Skeleton className="h-2.5 w-16" /><Skeleton className="h-3 w-20" /></div>
                    ))}
                  </div>
                  <div className="mt-5 border-t border-border/60 pt-4"><Skeleton className="h-7 w-full rounded-lg" /></div>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Upcoming Executions"><SkeletonRows rows={4} /></Card>
        </section>
      ) : (
        <>
          <section className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
            <Card title="Active Automations" right={<span className="text-xs text-muted-foreground">{active.length} live</span>}>
              {active.length === 0 ? <EmptyState title="No active automations" detail="Create an automation when you want PayAI to execute a payment on a future cadence." /> : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {active.map((a) => (
                    <AutomationCard
                      key={a.id} automation={a} busy={busy === a.id} onAction={action}
                      onView={() => setViewing(a)}
                      onEdit={() => setEditing(a)}
                      onDuplicate={() => {
                        // Preserve which template this came from (if any) —
                        // spreading `a` directly doesn't typecheck since its
                        // templateId/templateCategory can be `null` (as
                        // stored) where the seed type wants `undefined`.
                        setDuplicateSeed({
                          ...a,
                          templateId: a.templateId ?? undefined,
                          templateCategory: (a.templateCategory as TemplateCategory | null) ?? undefined,
                        });
                        setCreatorOpen(true);
                      }}
                    />
                  ))}
                </div>
              )}
            </Card>
            <Card title="Upcoming Executions">
              <Timeline items={upcoming.map((a) => ({ id: a.id, title: `${a.purpose ?? "Automation"} - ${money(a.amount, a.token)}`, detail: `${new Date(a.nextRun).toLocaleString()} - ${a.timezone ?? "Africa/Lagos"}`, status: a.status, href: null }))} empty="No upcoming executions." />
            </Card>
          </section>

          <Card title="Activity" right={runs.length > 0 ? <span className="text-xs text-muted-foreground">{runs.length} event{runs.length === 1 ? "" : "s"}</span> : undefined}>
            {runs.length === 0
              ? <EmptyState title="No activity yet" detail="Every execution — sent, blocked, or failed — appears here with its on-chain receipt once your automations start running." />
              : <ActivityFeed runs={runs} />}
          </Card>

          <Card title="Analytics">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <AnalyticsTile label="Total Executions" value={totalRuns.toString()} />
              <AnalyticsTile label="Total Gas Spent" value={`${totalGas.toFixed(4)} MON`} />
              <AnalyticsTile label="Average Gas" value={`${(totalRuns ? totalGas / totalRuns : 0).toFixed(4)} MON`} />
              <AnalyticsTile label="Completion" value={`${visibleAutomations.length ? Math.round((visibleAutomations.filter((a) => a.status === "completed").length / visibleAutomations.length) * 100) : 0}%`} />
            </div>
          </Card>
        </>
      )}

      <TemplatePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={handleTemplateSelect} onSelectBulk={handleBulkTemplateSelect} />
      <BulkPaymentCreator open={bulkOpen} seed={bulkSeed} onClose={() => { setBulkOpen(false); setBulkSeed(null); }} onCreated={() => { setBulkOpen(false); setBulkSeed(null); load(); }} />
      <AutomationCreator
        open={creatorOpen}
        seed={duplicateSeed}
        onClose={() => { setCreatorOpen(false); setDuplicateSeed(null); }}
        onCreated={() => { setCreatorOpen(false); setDuplicateSeed(null); load(); }}
      />
      <AutomationDetail automation={viewing} onClose={() => setViewing(null)} />
      <AutomationEdit
        automation={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }}
      />
    </div>
  );
}

function Metric({ title, value, icon: Icon }: { title: string; value: ReactNode; icon: typeof Repeat }) {
  return (
    <Card className="!p-4 bg-gradient-to-b from-primary/[0.06] to-transparent">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
        <Icon size={16} className="text-primary-ink" />
      </div>
      {/* A plain div, not <p> — some values (VolumeMetricValue) render block
          children, and nesting a block element inside <p> is invalid HTML
          that browsers silently "fix" by closing the tag early, which was
          a real source of the mobile reflow/glitch this replaces. */}
      <div className="mt-2 min-w-0 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
    </Card>
  );
}

/** Real per-token totals only — never blended into one meaningless number
 *  across MON and USDC (same convention as components/TokenLogo.tsx's
 *  VolumeInline). Stacked one token per row so mobile never has to squeeze
 *  two currencies onto one line. */
function VolumeMetricValue({ byToken }: { byToken: Record<string, number> }) {
  const parts = Object.entries(byToken).filter(([, v]) => v > 0);
  if (!parts.length) return <span className="text-2xl font-semibold tracking-tight text-foreground">—</span>;
  return (
    <div className="space-y-1">
      {parts.map(([token, v]) => (
        <div key={token} className="flex items-center gap-1.5">
          <TokenLogo token={token} size={15} className="shrink-0" />
          <span className="truncate text-xl font-semibold tabular-nums tracking-tight text-foreground">
            {v.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{token}</span>
        </div>
      ))}
    </div>
  );
}

/** Daily executions (last 14 days), stacked executed/failed — real counts
 *  from the same `runs` already loaded for the page, nothing separately
 *  fetched. One axis (count); success rate is direct-labeled per bar via
 *  hover rather than a second y-scale, so this never becomes a dual-axis
 *  chart. Executed/failed reuse the same primary/danger tokens the rest of
 *  the dashboard already uses for those two states (Badge/STATUS_TONE), so
 *  color still follows a fixed, existing meaning rather than a new scale. */
function ExecutionTrendChart({ runs }: { runs: { at: number; decision: string }[] }) {
  const DAYS = 14;
  const days = useMemo(() => {
    const buckets: { key: string; label: string; executed: number; failed: number; other: number }[] = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      buckets.push({ key: d.toDateString(), label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), executed: 0, failed: 0, other: 0 });
    }
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    for (const r of runs) {
      const b = byKey.get(new Date(r.at).toDateString());
      if (!b) continue; // outside the 14-day window
      if (r.decision === "executed" || r.decision === "partial") b.executed += 1;
      else if (r.decision === "error" || r.decision === "failed") b.failed += 1;
      else b.other += 1;
    }
    return buckets;
  }, [runs]);

  const max = Math.max(1, ...days.map((d) => d.executed + d.failed + d.other));
  const H = 96;

  return (
    <div className="mt-5 border-t border-border/60 pt-4">
      <div className="mb-2.5 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Executions — last {DAYS} days</p>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" /> Executed</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-danger" /> Failed</span>
        </div>
      </div>
      <div className="flex items-end gap-[3px]" style={{ height: H }}>
        {days.map((d) => {
          const total = d.executed + d.failed + d.other;
          const executedH = (d.executed / max) * H;
          const failedH = (d.failed / max) * H;
          const otherH = (d.other / max) * H;
          const rate = total ? Math.round((d.executed / total) * 100) : null;
          return (
            <div key={d.key} className="group relative flex-1" style={{ height: H }}>
              <div className="absolute bottom-0 flex w-full flex-col-reverse overflow-hidden rounded-t-sm">
                {failedH > 0 && <div className="w-full bg-danger" style={{ height: failedH }} />}
                {otherH > 0 && <div className="w-full bg-muted-foreground/40" style={{ height: otherH }} />}
                {executedH > 0 && <div className="w-full bg-primary" style={{ height: executedH }} />}
                {total === 0 && <div className="w-full bg-border/50" style={{ height: 2 }} />}
              </div>
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-panel px-2 py-1 text-[11px] shadow-lg group-hover:block">
                <p className="font-medium text-foreground">{d.label}</p>
                <p className="text-muted-foreground">{total} execution{total === 1 ? "" : "s"}{rate != null ? ` · ${rate}% success` : ""}</p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
        <span>{days[0].label}</span>
        <span>{days[days.length - 1].label}</span>
      </div>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="rounded-lg border border-dashed border-border p-6 text-center"><p className="text-sm font-medium text-foreground">{title}</p><p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{detail}</p></div>;
}

/**
 * Created → Activated → Waiting → Executing → Confirmed → Next Scheduled Run.
 * Every timestamp shown is a real field already on the automation (createdAt,
 * the latest run's `at`, nextRun) — "Waiting"/"Executing" have no timestamp
 * of their own since they're phases, not events, so they're marked as the
 * CURRENT step (pulsing dot) rather than given a fabricated time.
 */
function AutomationTimeline({ a }: { a: Automation }) {
  const lastRun = a.runs[0]; // newest first (schedules.ts prepends each new run)
  const isLive = a.status === "active" || a.status === "scheduled";
  const steps = [
    { key: "created", label: "Created", at: a.createdAt as number | null, current: false },
    { key: "activated", label: "Activated", at: a.createdAt as number | null, current: false },
    { key: "waiting", label: "Waiting", at: null as number | null, current: isLive && a.nextRun > Date.now() },
    { key: "executing", label: "Executing", at: lastRun?.at ?? null, current: a.status === "executing" },
    { key: "confirmed", label: "Confirmed", at: lastRun?.decision === "executed" ? lastRun.at : null, current: false },
    { key: "next", label: "Next Scheduled Run", at: isLive ? a.nextRun : null, current: false },
  ];
  return (
    <div className="flex flex-col">
      {steps.map((s, i) => {
        const reached = s.at != null || s.current;
        return (
          <div key={s.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className={`relative mt-0.5 flex h-2.5 w-2.5 shrink-0 rounded-full ${reached ? "bg-primary" : "bg-border"}`}>
                {s.current && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />}
              </span>
              {i < steps.length - 1 && <span className="w-px flex-1 bg-border" />}
            </div>
            <div className="min-w-0 pb-4">
              <p className={`text-sm font-medium ${reached ? "text-foreground" : "text-muted-foreground"}`}>{s.label}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {s.at != null ? new Date(s.at).toLocaleString() : s.current ? "In progress" : "—"}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Timeline({ items, empty }: { items: { id: string; title: string; detail: string; status: string; href: string | null }[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return <div className="space-y-3">{items.map((item) => <div key={item.id} className="flex gap-3"><span className="mt-1 h-2.5 w-2.5 rounded-full bg-primary" /><div className="min-w-0 flex-1 border-b border-border pb-3 last:border-b-0"><div className="flex items-center justify-between gap-2"><p className="truncate text-sm font-medium text-foreground">{item.title}</p>{item.href && <a href={item.href} target="_blank" rel="noreferrer" className="text-primary-ink"><ExternalLink size={13} /></a>}</div><p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p></div></div>)}</div>;
}

function AutomationCard({ automation, busy, onAction, onView, onEdit, onDuplicate }: {
  automation: Automation; busy: boolean;
  onAction: (id: string, action: "pause" | "resume" | "cancel" | "delete" | "skip_next" | "execute_now") => void;
  onView: () => void; onEdit: () => void; onDuplicate: () => void;
}) {
  const m = automationMetrics(automation);
  const template = automation.templateId ? findTemplate(automation.templateId) : undefined;
  const isBulk = !!automation.recipients?.length;
  const bulk = isBulk ? bulkStats(automation) : null;
  return (
    <motion.div className="group rounded-xl border border-border bg-gradient-to-br from-primary/[0.07] via-panel/40 to-transparent p-5 transition-all duration-200 hover:border-primary/35 hover:from-primary/[0.11]" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold tracking-tight text-foreground">
            {isBulk && <Users size={13} className="mr-1 inline text-primary-ink" />}
            {automation.purpose ?? automation.memo ?? "Automation"}
          </p>
          {template && (
            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground/70">
              <template.icon size={11} /> Created from {template.name}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground"><TokenLogo token={automation.token} size={14} /> {money(automation.amount, automation.token)}{isBulk && ` total`}</span>
            <span className="text-muted-foreground/50">·</span>
            <span>{cadenceLabel(automation)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge tone={displayStatus(automation).tone}>{displayStatus(automation).label}</Badge>
          {automation.fundingMode && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {automation.fundingMode === "reserved" ? <><Lock size={9} /> Reserved</> : <><Wallet size={9} /> Non-custodial</>}
            </span>
          )}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        {isBulk && bulk ? (
          <>
            <Info label="Recipients" value={String(bulk.recipientCount)} />
            <Info label="Successful / Failed" value={`${bulk.successful} / ${bulk.failed}`} />
            <Info label="Total Distributed" value={money(bulk.totalDistributed, automation.token)} />
            <Info label="Remaining" value={bulk.remaining != null ? String(bulk.remaining) : "Ongoing"} />
          </>
        ) : (
          <Info label="Recipient" value={automation.domain ?? short(automation.recipient)} mono />
        )}
        <Info label="Next Execution" value={new Date(automation.nextRun).toLocaleDateString()} />
        <Info label="Time" value={new Date(automation.nextRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
        <Info label="Success Rate" value={`${m.successRate}%`} />
      </div>
      <div className="mt-5 flex items-center gap-2 border-t border-border/60 pt-4">
        <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={onView} disabled={busy}><Eye size={13} /> View</Button>
        {!isBulk && <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={onEdit} disabled={busy}><Pencil size={13} /> Edit</Button>}
        <div className="ml-auto flex items-center gap-0.5">
          {automation.status === "paused" || automation.status === "failed" ? (
            <IconAction label="Resume" onClick={() => onAction(automation.id, "resume")} disabled={busy}><Play size={14} /></IconAction>
          ) : (
            <IconAction label="Pause" onClick={() => onAction(automation.id, "pause")} disabled={busy}><Pause size={14} /></IconAction>
          )}
          {(automation.status === "active" || automation.status === "scheduled") && (
            <>
              <IconAction label="Execute Now" onClick={() => onAction(automation.id, "execute_now")} disabled={busy}><Zap size={14} /></IconAction>
              <IconAction label="Skip Next" onClick={() => onAction(automation.id, "skip_next")} disabled={busy}><SkipForward size={14} /></IconAction>
            </>
          )}
          <IconAction label={isBulk ? "Duplicate (not supported for bulk payments yet)" : "Duplicate"} onClick={onDuplicate} disabled={busy || isBulk}><Copy size={14} /></IconAction>
          <IconAction label="Cancel" onClick={() => onAction(automation.id, "cancel")} disabled={busy}><X size={14} /></IconAction>
          <IconAction label="Delete" danger onClick={() => onAction(automation.id, "delete")} disabled={busy}><Trash2 size={14} /></IconAction>
        </div>
      </div>
    </motion.div>
  );
}

function IconAction({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className={`rounded-lg p-2 transition-colors disabled:opacity-40 ${danger ? "text-muted-foreground hover:bg-danger/10 hover:text-danger" : "text-muted-foreground hover:bg-input hover:text-foreground"}`}>
      {children}
    </button>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div><p className="text-muted-foreground">{label}</p><p className={`mt-0.5 truncate text-foreground ${mono ? "font-mono" : ""}`}>{value}</p></div>;
}

/** Sleek review summary — each field a subtle panel card; key money values
 *  accented in purple so the numbers pop against white text. */
function ReviewGrid({ rows }: { rows: { label: string; value: string; mono?: boolean; accent?: boolean }[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {rows.map((r) => (
        <div key={r.label} className="rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-3.5 py-2.5 transition-colors hover:border-primary/25">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{r.label}</p>
          <p className={`mt-0.5 truncate ${r.mono ? "font-mono text-xs" : "text-sm"} ${r.accent ? "font-semibold text-primary-ink" : "font-medium text-foreground"}`}>{r.value}</p>
        </div>
      ))}
    </div>
  );
}

function AnalyticsTile({ label, value }: { label: string; value: ReactNode }) {
  return <div className="rounded-xl border border-border bg-gradient-to-b from-primary/[0.06] to-transparent p-4 transition-colors hover:border-primary/25"><p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">{value}</p></div>;
}

/** One unified, chronological activity feed — every run across every
 *  automation (sent / blocked / failed) with its date-time and, when it
 *  settled on-chain, a linked transaction hash. */
function ActivityFeed({ runs }: { runs: { automation: Automation; at: number; decision: string; explorerUrl?: string; txHash?: string }[] }) {
  const meta = (d: string) =>
    d === "executed" ? { Icon: CheckCircle2, tone: "bg-primary/12 text-primary-ink", label: "Sent" }
    : d === "blocked" ? { Icon: ShieldCheck, tone: "bg-warning/12 text-warning", label: "Blocked" }
    : d === "needs_review" ? { Icon: ShieldCheck, tone: "bg-warning/12 text-warning", label: "Needs review" }
    : d === "error" || d === "failed" ? { Icon: AlertTriangle, tone: "bg-danger/12 text-danger", label: "Failed" }
    : { Icon: CalendarClock, tone: "bg-input text-muted-foreground", label: "Scheduled" };
  const fmt = (ts: number) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="divide-y divide-border">
      {runs.slice(0, 12).map((r) => {
        const { Icon, tone, label } = meta(r.decision);
        return (
          <div key={`${r.automation.id}-${r.at}`} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
            <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone}`}><Icon size={16} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium text-foreground">
                  {r.automation.purpose ?? r.automation.memo ?? "Automation"} <span className="font-normal text-muted-foreground">· {money(r.automation.amount, r.automation.token)}</span>
                </p>
                <span className={`shrink-0 text-xs font-medium ${r.decision === "executed" ? "text-primary-ink" : r.decision === "error" || r.decision === "failed" ? "text-danger" : "text-muted-foreground"}`}>{label}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><CalendarClock size={11} /> {fmt(r.at)}</span>
                {r.txHash && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    {r.explorerUrl
                      ? <a href={r.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-primary-ink transition-colors hover:text-secondary hover:underline">{r.txHash.slice(0, 8)}…{r.txHash.slice(-6)} <ExternalLink size={10} /></a>
                      : <span className="font-mono">{r.txHash.slice(0, 8)}…{r.txHash.slice(-6)}</span>}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Full detail view for a single automation — real per-automation analytics
 *  (created date, last/next execution, success rate, volume, gas, completion)
 *  plus its own execution timeline, none of it fabricated. */
function AutomationDetail({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  // Hooks must run unconditionally (before the early return below), so the
  // live-balance check is guarded by optional chaining on its arguments
  // instead of skipping the hook call itself.
  const wallet = useWallet();
  const { balance: liveBalance } = useTokenBalance(automation?.tokenAddress ?? null, automation?.tokenDecimals ?? null, wallet.address);
  useModalA11y(!!automation, onClose);
  if (!automation) return null;
  const a = automation;
  const m = automationMetrics(a);
  const template = a.templateId ? findTemplate(a.templateId) : undefined;
  const isBulk = !!a.recipients?.length;
  const bulk = isBulk ? bulkStats(a) : null;
  const allRecipientResults = isBulk ? a.runs.flatMap((r) => (r.recipientResults ?? []).map((rr) => ({ ...rr, runAt: r.at }))) : [];
  // This component returns null when closed, so React unmounts the whole
  // subtree — the previous AnimatePresence/`exit` pair could never run and was
  // dead code. Enter-only animation, consistent with the other modals.
  return (
    <>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: "easeOut" }} className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm" onClick={onClose}>
        <motion.div role="dialog" aria-modal="true" aria-label={`Automation details: ${a.purpose ?? a.memo ?? "Automation"}`} initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.2, ease: "easeOut" }} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div><p className="text-sm font-semibold text-foreground">{a.purpose ?? a.memo ?? "Automation"}</p><p className="text-xs text-muted-foreground">{money(a.amount, a.token)} · {cadenceLabel(a)}</p></div>
            <button onClick={onClose} aria-label="Close automation details" className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X size={16} /></button>
          </div>
          <div className="space-y-5 p-5">
            <ReviewGrid rows={[
              { label: "Status", value: displayStatus(a).label, accent: true },
              { label: "Recipient", value: isBulk ? `${bulk?.recipientCount ?? 0} recipients` : (a.domain ?? short(a.recipient)), accent: true },
              { label: "Created", value: new Date(a.createdAt).toLocaleString() },
              { label: "Last Execution", value: m.lastExecution ? new Date(m.lastExecution).toLocaleString() : "Never" },
              { label: "Next Execution", value: a.status === "active" || a.status === "scheduled" ? new Date(a.nextRun).toLocaleString() : "—" },
              { label: "Network", value: "Monad Mainnet" },
              { label: "Template", value: template ? template.name : "Custom (built from scratch)" },
              { label: "Execution Mode", value: a.fundingMode === "reserved" ? "Reserved Funds" : "Wallet Automation" },
              { label: "Timezone", value: a.timezone ?? "—" },
              ...(isBulk ? [{ label: "Distribution Method", value: a.distributionMethod ?? "custom" }] : []),
            ]} />
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Timeline</p>
              <AutomationTimeline a={a} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <AnalyticsTile label="Success Rate" value={`${m.successRate}%`} />
              <AnalyticsTile label="Total Executions" value={m.totalExecutions.toString()} />
              <AnalyticsTile label="Total Volume" value={money(m.totalVolume, a.token)} />
              <AnalyticsTile label="Total Gas Spent" value={`${m.totalGas.toFixed(4)} MON`} />
              <AnalyticsTile label="Average Gas" value={`${m.avgGas.toFixed(4)} MON`} />
              <AnalyticsTile label="Completion" value={m.completionPct != null ? `${m.completionPct}%` : "Open-ended"} />
            </div>
            {isBulk && bulk && (
              <div className="grid gap-3 sm:grid-cols-4">
                <AnalyticsTile label="Recipients" value={String(bulk.recipientCount)} />
                <AnalyticsTile label="Successful" value={String(bulk.successful)} />
                <AnalyticsTile label="Failed" value={String(bulk.failed)} />
                <AnalyticsTile label="Total Distributed" value={money(bulk.totalDistributed, a.token)} />
              </div>
            )}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Execution history</p>
              {a.runs.length ? <ActivityFeed runs={a.runs.map((run) => ({ ...run, automation: a }))} /> : <p className="text-sm text-muted-foreground">No executions yet.</p>}
            </div>
            {!isBulk && a.runs.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-input/40 text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Time</th>
                      <th className="px-3 py-2 font-medium">Recipient</th>
                      <th className="px-3 py-2 font-medium">Amount</th>
                      <th className="px-3 py-2 font-medium">Tx Hash</th>
                      <th className="px-3 py-2 font-medium">Gas Used</th>
                      <th className="px-3 py-2 font-medium">Duration</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Failure Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.runs.map((run, i) => (
                      <tr key={i} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2 text-muted-foreground">{new Date(run.at).toLocaleDateString()}</td>
                        <td className="px-3 py-2 text-muted-foreground">{new Date(run.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                        <td className="px-3 py-2 font-mono">{a.domain ?? short(a.recipient)}</td>
                        <td className="px-3 py-2">{money(a.amount, a.token)}</td>
                        <td className="px-3 py-2">
                          {run.explorerUrl && run.txHash ? (
                            <a href={run.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-primary-ink hover:underline">{short(run.txHash)}</a>
                          ) : run.txHash ? <span className="font-mono">{short(run.txHash)}</span> : "—"}
                        </td>
                        <td className="px-3 py-2">{run.gasFee != null ? `${run.gasFee.toFixed(4)} MON` : "—"}</td>
                        <td className="px-3 py-2">{run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                        <td className="px-3 py-2"><Badge tone={run.decision === "executed" ? "success" : run.decision === "needs_review" ? "warning" : "danger"}>{run.decision}</Badge></td>
                        <td className="px-3 py-2 text-muted-foreground">{run.decision !== "executed" ? (run.detail ?? "—") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {isBulk && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Execution logs (per recipient)</p>
                {allRecipientResults.length ? (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border bg-input/40 text-left text-muted-foreground">
                          <th className="px-3 py-2 font-medium">Recipient</th>
                          <th className="px-3 py-2 font-medium">Amount</th>
                          <th className="px-3 py-2 font-medium">Tx Hash</th>
                          <th className="px-3 py-2 font-medium">Duration</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Failure Reason</th>
                          <th className="px-3 py-2 font-medium">Timestamp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allRecipientResults.map((rr, i) => (
                          <tr key={i} className="border-b border-border/60 last:border-0">
                            <td className="px-3 py-2 font-mono">{rr.domain ?? short(rr.address)}</td>
                            <td className="px-3 py-2">{money(rr.amount, a.token)}</td>
                            <td className="px-3 py-2">
                              {rr.explorerUrl && rr.txHash ? (
                                <a href={rr.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-primary-ink hover:underline">{short(rr.txHash)}</a>
                              ) : rr.txHash ? <span className="font-mono">{short(rr.txHash)}</span> : "—"}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{rr.durationMs != null ? `${(rr.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                            <td className="px-3 py-2"><Badge tone={rr.decision === "executed" ? "success" : rr.decision === "needs_review" ? "warning" : "danger"}>{rr.decision}</Badge></td>
                            <td className="px-3 py-2 text-muted-foreground">{rr.decision !== "executed" ? (rr.detail ?? "—") : "—"}</td>
                            <td className="px-3 py-2 text-muted-foreground">{new Date(rr.runAt).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="text-sm text-muted-foreground">No executions yet.</p>}
              </div>
            )}
            {a.lastError && (a.status === "paused" || a.status === "failed") && (
              <div className="rounded-lg border border-warning/25 bg-warning/10 p-3 text-xs text-warning">{a.lastError}</div>
            )}
            {/* Low Balance: only checkable for Wallet Automation (a live ERC-20/native
               balance read against the next payment amount) — Reserved Funds' vault
               balance isn't loaded on this page yet, so that check is deferred rather
               than faked. Only shown to the automation's own owner. */}
            {(a.fundingMode ?? "wallet") === "wallet" && (a.status === "active" || a.status === "scheduled")
              && wallet.address && a.sender && wallet.address.toLowerCase() === a.sender.toLowerCase()
              && liveBalance != null && Number(liveBalance) < a.amount && (
              <div className="flex items-center gap-2 rounded-lg border border-danger/25 bg-danger/10 p-3 text-xs text-danger">
                <AlertTriangle size={14} className="shrink-0" />
                Low balance: your wallet has {Number(liveBalance).toLocaleString(undefined, { maximumFractionDigits: 4 })} {a.token}, less than the {money(a.amount, a.token)} due next.
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </>
  );
}

/** Edit an automation's terms — amount, cadence timing, and purpose. Doesn't
 *  require a fresh wallet signature (the server-side PATCH only mutates
 *  editable, non-security-relevant fields; the recipient/asset/signature that
 *  actually move funds can't be changed here — that requires a new automation). */
function AutomationEdit({ automation, onClose, onSaved }: { automation: Automation | null; onClose: () => void; onSaved: () => void }) {
  const wallet = useWallet();
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [saving, setSaving] = useState(false);
  useModalA11y(!!automation, onClose);

  useEffect(() => {
    if (!automation) return;
    setAmount(String(automation.amount));
    setPurpose(automation.purpose ?? automation.memo ?? "");
    const d = new Date(automation.nextRun);
    setDate(d.toISOString().slice(0, 10));
    setTime(d.toTimeString().slice(0, 5));
  }, [automation]);

  if (!automation) return null;
  const amountNum = Number(amount);
  const invalidAmount = !Number.isFinite(amountNum) || amountNum <= 0;
  const nextRun = new Date(`${date}T${time}:00`).getTime();
  const invalidTime = !Number.isFinite(nextRun) || nextRun < Date.now() - 60_000;

  async function save() {
    if (invalidAmount || invalidTime || !purpose.trim() || !wallet.address) return;
    setSaving(true);
    try {
      const proof = await signMutation(wallet, automation!.id, "edit");
      if (!proof) throw new Error("Confirmation was cancelled in your wallet.");
      const r = await fetch(`/api/automations?id=${automation!.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet.address, amount: amountNum, nextRun, purpose: purpose.trim(), ...proof }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || "Could not save changes.");
      toast("Automation updated");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }

  // Same as AutomationDetail: returns null when closed, so exit could never run.
  return (
    <>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: "easeOut" }} className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm" onClick={onClose}>
        <motion.div role="dialog" aria-modal="true" aria-label="Edit automation" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.2, ease: "easeOut" }} className="w-full max-w-md rounded-lg border border-border bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <p className="text-sm font-semibold text-foreground">Edit automation</p>
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-input hover:text-foreground"><X size={16} /></button>
          </div>
          <div className="space-y-4 p-5">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Amount ({automation.token})</label>
              <Input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" className="w-full" />
              {invalidAmount && amount && <p className="mt-1 text-xs text-danger">Enter an amount greater than 0.</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Next execution date</label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
              <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Time</label><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
            </div>
            {invalidTime && <p className="text-xs text-danger">Choose a future time.</p>}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Purpose</label>
              <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} className="w-full" />
            </div>
            <p className="text-xs text-muted-foreground">Recipient, asset, and cadence can&apos;t be changed here — create a new automation for those.</p>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={saving || invalidAmount || invalidTime || !purpose.trim()}>{saving ? "Saving…" : "Save changes"}</Button>
          </div>
        </motion.div>
      </motion.div>
    </>
  );
}

/** Everything the creator wizard actually pre-fills from — a real Duplicate
 *  passes the full Automation; an AI-parsed draft passes only the subset it
 *  resolved (recipient/amount/asset/cadence/time), never a purpose or id. */
type AutomationSeed = Partial<Pick<Automation, "domain" | "recipient" | "token" | "tokenAddress" | "tokenDecimals" | "tokenLogo" | "amount" | "cadence" | "intervalCount" | "intervalUnit" | "nextRun" | "purpose" | "memo">> & {
  /** Only set when seeded from an Automation Template — carried through to
   *  creation so the created automation records which template it came from.
   *  A real Duplicate or an AI-parsed draft never sets these. */
  fundingMode?: FundingMode;
  endMode?: EndMode;
  templateId?: string;
  templateCategory?: TemplateCategory;
};

/** A Bulk Payment template's pre-fill — purpose and a distribution-method
 *  hint only; recipients, token, and schedule are always left for the user. */
type BulkAutomationSeed = {
  purpose?: string;
  distributionMethod?: "equal" | "fixed" | "percentage" | "custom";
  templateId?: string;
  templateCategory?: TemplateCategory;
};

/** Shared premium style for selectable chips (asset, cadence, end-mode,
 *  purpose) — consistent selected/hover states across the whole flow. */
function choiceClass(selected: boolean, extra = "") {
  return `rounded-lg border text-sm font-medium transition-all duration-150 ${
    selected
      ? "border-primary/60 bg-primary/10 text-primary-ink shadow-sm shadow-primary/10"
      : "border-border text-foreground hover:border-primary/40 hover:bg-input/50"
  } ${extra}`;
}

function ModeCard({ selected, disabled, onSelect, badge, title, description, pros, note }: {
  selected: boolean; disabled?: boolean; onSelect: () => void; badge: string; title: string; description: string; pros: string[]; note: string;
}) {
  return (
    <button type="button" onClick={onSelect} disabled={disabled}
      className={`group relative flex flex-col rounded-xl border p-5 text-left transition-all duration-200 ${
        disabled ? "cursor-not-allowed border-border opacity-45"
        : selected ? "border-primary/60 bg-primary/[0.06] shadow-lg shadow-primary/10"
        : "border-border hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input/40"}`}>
      <span aria-hidden className={`absolute right-4 top-4 h-3.5 w-3.5 rounded-full border-2 transition-colors ${selected ? "border-primary bg-primary" : "border-muted-foreground/40 group-hover:border-primary/50"}`} />
      <span className="pr-6 text-base font-semibold tracking-tight text-foreground">{title}</span>
      <span className="mt-2"><Badge tone={badge === "Recommended" ? "primary" : "success"}>{badge}</Badge></span>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{description}</p>
      <ul className="mt-4 space-y-1.5">{pros.map((p) => <li key={p} className="flex items-center gap-2 text-xs text-foreground"><CheckCircle2 size={13} className="shrink-0 text-primary-ink" /> {p}</li>)}</ul>
      <p className="mt-4 text-[11px] leading-snug text-muted-foreground">{note}</p>
    </button>
  );
}

function AutomationCreator({ open, seed, onClose, onCreated }: { open: boolean; seed?: AutomationSeed | null; onClose: () => void; onCreated: () => void }) {
  const wallet = useWallet();
  const { toast } = useToast();
  useModalA11y(open, onClose);
  const [step, setStep] = useState(1);
  const [recipientInput, setRecipientInput] = useState("");
  const [resolved, setResolved] = useState<{ recipient: string; domain: string | null } | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const { balance, loading: balanceLoading } = useTokenBalance(tokenInfo?.address ?? null, tokenInfo?.decimals ?? null, wallet.address);
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [intervalCount, setIntervalCount] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("weeks");
  const [date, setDate] = useState(() => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [time, setTime] = useState("10:00");
  const [endMode, setEndMode] = useState<EndMode>("never");
  const [endCount, setEndCount] = useState("12");
  const [endDate, setEndDate] = useState(() => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos");
  const [purpose, setPurpose] = useState("Savings");
  const [customPurpose, setCustomPurpose] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingStep, setSavingStep] = useState<string | null>(null);
  const [fundingMode, setFundingMode] = useState<FundingMode>("wallet");
  const [config, setConfig] = useState<OnchainConfig | null>(null);
  /** Set only when this creation started from an Automation Template — carried
   *  through to the create() call so the record stores what it came from.
   *  Never set for a duplicate or an AI-parsed draft. */
  const [templateMeta, setTemplateMeta] = useState<{ id: string; category: TemplateCategory } | null>(null);
  const startAt = useMemo(() => new Date(`${date}T${time}:00`).getTime(), [date, time]);
  const amountNum = Number(amount);
  const balanceNum = balance == null ? null : Number(balance);
  const invalidAmount = !Number.isFinite(amountNum) || amountNum <= 0 || (balanceNum != null && amountNum > balanceNum);
  const finalPurpose = purpose === "Other" ? customPurpose.trim() : purpose;
  const estimateGas = tokenInfo?.address === NATIVE_TOKEN_ADDRESS ? "0.002 MON" : "0.004 MON";
  const platformFee = calculateFee(fundingMode === "reserved" ? "reserved_funds" : "wallet_automation", amountNum || 0);

  useEffect(() => {
    if (!open) return;
    setStep(1); setRecipientError(null);
    if (seed) {
      // Pre-fill from either a duplicated automation or an AI-parsed draft —
      // either way, the recipient still goes through the same live
      // re-verification as a fresh entry; nothing here is trusted blindly,
      // and nothing is created until the user reviews and signs below.
      if (seed.domain || seed.recipient) setRecipientInput(seed.domain ?? seed.recipient ?? "");
      setResolved(null);
      if (seed.tokenAddress) {
        // A real Duplicate carries the exact token forward, address and all.
        setTokenInfo({
          address: seed.tokenAddress, symbol: seed.token ?? "", name: seed.token ?? "",
          decimals: seed.tokenDecimals ?? 18, logoURI: seed.tokenLogo ?? null, verified: false,
        });
      } else if (seed.token) {
        // A Template only hints at a symbol — resolve it against the verified
        // list so the wizard opens with a real, selectable token pre-filled.
        fetch(`/api/tokens?q=${encodeURIComponent(seed.token)}`)
          .then((r) => r.json())
          .then((j) => { if (j.success && j.tokens[0]) setTokenInfo(j.tokens[0]); })
          .catch(() => {});
      } else {
        setTokenInfo(null);
      }
      if (seed.amount != null) setAmount(String(seed.amount));
      if (seed.cadence) setCadence(seed.cadence);
      if (seed.intervalCount != null) setIntervalCount(String(seed.intervalCount));
      if (seed.intervalUnit) setIntervalUnit(seed.intervalUnit);
      if (seed.nextRun) {
        const d = new Date(seed.nextRun);
        setDate(d.toISOString().slice(0, 10));
        setTime(d.toTimeString().slice(0, 5));
      }
      const seedPurpose = seed.purpose ?? seed.memo;
      setPurpose(seedPurpose && PURPOSES.includes(seedPurpose) ? seedPurpose : "Other");
      setCustomPurpose(seedPurpose && PURPOSES.includes(seedPurpose) ? "" : (seedPurpose ?? ""));
      if (seed.fundingMode) setFundingMode(seed.fundingMode);
      if (seed.endMode) setEndMode(seed.endMode);
      setTemplateMeta(seed.templateId && seed.templateCategory ? { id: seed.templateId, category: seed.templateCategory } : null);
    } else {
      setRecipientInput(""); setResolved(null); setTokenInfo(null); setAmount(""); setPurpose("Savings"); setCustomPurpose("");
      setFundingMode("wallet"); setEndMode("never"); setTemplateMeta(null);
    }
  }, [open, seed]);

  useEffect(() => {
    if (!recipientInput.trim()) { setResolved(null); setRecipientError(null); return; }
    const handle = setTimeout(() => {
      fetch(`/api/automations?resolve=${encodeURIComponent(recipientInput.trim())}`)
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (!ok || !j.success) { setResolved(null); setRecipientError(j.error ?? "Recipient could not be verified."); return; }
          setResolved({ recipient: j.recipient, domain: j.domain }); setRecipientError(null);
        })
        .catch(() => { setResolved(null); setRecipientError("Recipient verification failed."); });
    }, 350);
    return () => clearTimeout(handle);
  }, [recipientInput]);

  // Load the public on-chain addresses the browser needs to build approve/reserve txs.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/automation-config").then((r) => r.json()).then((c: OnchainConfig) => { if (!cancelled) setConfig(c); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  // Wallet Automation needs an ERC-20 allowance: any non-native token works
  // directly; native MON only works if WMON is configured. When unavailable
  // for the chosen token, the choice collapses to Reserved Funds so we never
  // offer an impossible path.
  const isNativeToken = tokenInfo?.address === NATIVE_TOKEN_ADDRESS;
  const walletAvailableForToken = tokenInfo ? (isNativeToken ? !!config?.wmon : !!config?.walletModeAvailable) : false;
  const reservedAvailable = !!config?.reservedModeAvailable;
  useEffect(() => {
    if (fundingMode === "wallet" && !walletAvailableForToken && reservedAvailable) setFundingMode("reserved");
  }, [fundingMode, walletAvailableForToken, reservedAvailable]);

  // End condition — the user controls how long this runs, so the total that
  // gets authorized/reserved is always a number they chose, never a surprise.
  const endUntilMs = useMemo(() => new Date(`${endDate}T23:59:59`).getTime(), [endDate]);
  const occurrences = useMemo(() => countOccurrences({
    startAt, cadence, intervalCount: Number(intervalCount) || 1, intervalUnit,
    endMode, endCount: Number(endCount) || 1, endUntilMs,
  }), [startAt, cadence, intervalCount, intervalUnit, endMode, endCount, endUntilMs]);

  const perPayment = amountNum || 0;
  // Total the schedule will move over its whole (bounded) life. null = open-ended.
  const totalScheduled = occurrences != null ? perPayment * occurrences : null;

  // Wallet Automation only grants an ALLOWANCE (no funds move until each run):
  // a bounded schedule approves its exact total; an open-ended one approves ~a
  // year and re-approves later. Reserved Funds MOVES real money up front, so a
  // bounded schedule reserves its exact total (true guaranteed execution) while
  // an open-ended one reserves only the next payment (can't lock infinity).
  const walletBudgetAmount = totalScheduled != null
    ? totalScheduled
    : annualVolume({ amount: perPayment, token: tokenInfo?.symbol ?? "", cadence, intervalCount: Number(intervalCount), intervalUnit } as Automation);
  const reservedBudgetAmount = totalScheduled != null ? totalScheduled : perPayment;
  // What the Review screen shows depends on the chosen mode.
  const budgetAmount = fundingMode === "wallet" ? walletBudgetAmount : reservedBudgetAmount;

  const endCondition: EndCondition = cadence === "once" || endMode === "never"
    ? { type: "never" }
    : endMode === "after_count"
      ? { type: "after_count", totalRuns: Math.max(1, Math.floor(Number(endCount) || 1)) }
      : { type: "until_date", untilMs: endUntilMs };

  async function create() {
    if (!wallet.address || !resolved || invalidAmount || !finalPurpose || !config || !tokenInfo) return;
    const isNative = tokenInfo.address === NATIVE_TOKEN_ADDRESS;
    const decimals = tokenInfo.decimals;
    const perRun = parseUnits(String(amountNum), decimals);
    const budget = parseUnits(String(walletBudgetAmount), decimals);
    const reservedBudget = parseUnits(String(reservedBudgetAmount), decimals);
    setSaving(true);
    try {
      if (wallet.isWrongNetwork) await wallet.switchNetwork();
      const message = signatureMessage({ walletAddress: wallet.address, recipient: resolved.recipient, amount: amountNum, token: tokenInfo.symbol, cadence, startAt, timezone, purpose: finalPurpose });
      setSavingStep("Confirm the automation in your wallet");
      const signature = await wallet.signMessage(message);

      const body: Record<string, unknown> = {
        walletAddress: wallet.address, recipient: recipientInput, amount: amountNum, token: tokenInfo.symbol, tokenAddress: tokenInfo.address, cadence,
        intervalCount: Number(intervalCount), intervalUnit, startAt, timezone, purpose: finalPurpose,
        signature, signatureMessage: message, fundingMode, endCondition,
        ...(templateMeta ? { templateId: templateMeta.id, templateCategory: templateMeta.category } : {}),
      };

      if (fundingMode === "wallet") {
        // Non-custodial: approve the executor to pull up to the budget. Native
        // MON has no ERC-20 allowance, so it lands with the WMON address instead.
        if (!config.executor) throw new Error("Wallet Automation isn't available right now.");
        const token = isNative ? config.wmon : tokenInfo.address;
        if (!token) throw new Error("This token can't use Wallet Automation yet. Choose Reserved Funds.");
        setSavingStep("Approve PayAI to send from your wallet");
        const data = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [config.executor as Hex, budget] });
        setSavingStep("Waiting for approval to confirm on Monad");
        await confirmTx(wallet, token, data);
      } else {
        // Reserved Funds: deposit the budget into the vault, keyed to a client id.
        if (!config.vault) throw new Error("Reserved Funds isn't available right now.");
        const id = `sch_${crypto.randomUUID()}`;
        body.id = id;
        if (!isNative) {
          // ERC-20 must approve the vault before it can pull the reserve.
          setSavingStep("Approve the reserved amount");
          const approveData = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [config.vault as Hex, reservedBudget] });
          await confirmTx(wallet, tokenInfo.address, approveData);
        }
        setSavingStep("Reserve funds for this automation");
        const reserveData = encodeFunctionData({
          abi: AUTOMATION_VAULT_ABI, functionName: "reserve",
          args: [autoId32(id), (isNative ? "0x0000000000000000000000000000000000000000" : tokenInfo.address) as Hex, resolved.recipient as Hex, reservedBudget],
        });
        setSavingStep("Waiting for the reservation to confirm on Monad");
        const rHash = await confirmTx(wallet, config.vault, reserveData, isNative ? reservedBudget : undefined);
        body.reserveTxHash = rHash;
      }

      setSavingStep("Activating your automation");
      const r = await fetch("/api/automations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || "Could not create automation.");
      toast("Automation created");
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Automation creation failed");
    } finally {
      setSaving(false);
      setSavingStep(null);
    }
  }

  const canNext = step === 1 ? !!resolved : step === 2 ? !!tokenInfo && !invalidAmount : step === 3 ? cadence !== "custom" || Number(intervalCount) > 0 : step === 4 ? Number.isFinite(startAt) && startAt > Date.now() - 60_000 : step === 5 ? !!finalPurpose : true;

  // No AnimatePresence — see the note in components/dashboard/TemplatePicker.tsx.
  return (
    <>
      {open && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: "easeOut" }} className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm" onClick={onClose}>
        <motion.div role="dialog" aria-modal="true" aria-label="Create Payment Automation" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.2, ease: "easeOut" }} className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-border bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border px-6 py-4"><div><p className="text-sm font-semibold tracking-tight text-foreground">Create Payment Automation</p><p className="mt-0.5 text-xs text-muted-foreground">Step {step} of 6</p></div><button onClick={onClose} aria-label="Close automation creator" className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X size={16} /></button></div>
          <div className="grid gap-6 p-6 lg:grid-cols-[190px_1fr]">
            <div className="space-y-1">{["Recipient", "Payment", "Automation", "Execution Time", "Purpose", "Review"].map((label, i) => <button key={label} onClick={() => setStep(i + 1)} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${step === i + 1 ? "bg-primary/12 font-medium text-primary-ink" : i + 1 < step ? "text-foreground hover:bg-input/50" : "text-muted-foreground hover:bg-input/40"}`}>{i + 1 < step ? <CheckCircle2 size={15} className="shrink-0 text-primary-ink" /> : <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] ${step === i + 1 ? "border-primary text-primary-ink" : "border-current"}`}>{i + 1}</span>} {label}</button>)}</div>
            <div className="min-h-[420px]">
              {step === 1 && <Step title="Recipient" detail="Enter a wallet address or .nads domain. PayAI verifies it before you continue."><Input value={recipientInput} onChange={(e) => setRecipientInput(e.target.value)} placeholder=".nad domain or 0x wallet address" className="w-full" />{resolved && <Verified label={resolved.domain ?? "Wallet address"} value={resolved.recipient} />}{recipientError && <p className="mt-2 text-sm text-danger">{recipientError}</p>}</Step>}
              {step === 2 && <Step title="Payment" detail="Choose a token and amount. Balance and gas are shown before review."><div className="max-w-xs"><TokenSelector value={tokenInfo} onChange={setTokenInfo} walletAddress={wallet.address} /></div><Input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" inputMode="decimal" className="mt-4 w-full" /><div className="mt-3 grid gap-2 sm:grid-cols-2"><Info label="Wallet Balance" value={balanceLoading ? "Loading..." : balance ? money(Number(balance), tokenInfo?.symbol ?? "") : "-"} /><Info label="Estimated Gas" value={estimateGas} /></div>{invalidAmount && amount && <p className="mt-2 text-sm text-danger">Enter a valid amount within your wallet balance.</p>}</Step>}
              {step === 3 && <Step title="Automation" detail="Choose the cadence. Custom stays simple in v1: every X days, weeks, or months."><div className="grid gap-2 sm:grid-cols-3">{(["once", "daily", "weekly", "monthly", "custom"] as Cadence[]).map((c) => <button key={c} onClick={() => setCadence(c)} className={choiceClass(cadence === c, "px-3 py-3 text-left capitalize")}>{c === "once" ? "One Time" : c}</button>)}</div>{cadence === "custom" && <div className="mt-4 flex items-center gap-2"><span className="text-sm text-muted-foreground">Every</span><Input value={intervalCount} onChange={(e) => setIntervalCount(e.target.value.replace(/[^0-9]/g, ""))} className="w-20" /><select value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)} className="rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground"><option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option></select></div>}</Step>}
              {step === 4 && <Step title="Execution Time" detail="Set the first execution date and time, then choose when it ends.">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">First execution date</label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Time</label><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Timezone</label><Input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div>
                </div>
                <div className="mt-3 rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent p-3 text-sm"><span className="text-muted-foreground">First run: </span><span className="font-medium text-primary-ink">{new Date(startAt).toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
                {cadence !== "once" && <div className="mt-4">
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">When should it end?</label>
                  <div className="flex flex-wrap gap-2">
                    {([["never", "No end date"], ["after_count", "After N payments"], ["until_date", "On a date"]] as [EndMode, string][]).map(([m, label]) =>
                      <button key={m} onClick={() => setEndMode(m)} className={choiceClass(endMode === m, "px-3 py-2")}>{label}</button>)}
                  </div>
                  {endMode === "after_count" && <div className="mt-3 flex items-center gap-2"><span className="text-sm text-muted-foreground">Stop after</span><Input value={endCount} onChange={(e) => setEndCount(e.target.value.replace(/[^0-9]/g, ""))} className="w-24" /><span className="text-sm text-muted-foreground">payments</span></div>}
                  {endMode === "until_date" && <div className="mt-3"><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Runs until (inclusive)</label><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>}
                </div>}
                <div className="mt-4 rounded-lg border border-primary/25 bg-primary/5 p-4 text-sm">
                  {occurrences != null
                    ? <p className="text-foreground">{occurrences} payment{occurrences === 1 ? "" : "s"} × {money(perPayment, tokenInfo?.symbol ?? "")} = <strong className="text-primary-ink">{money(totalScheduled ?? 0, tokenInfo?.symbol ?? "")}</strong> total{fundingMode === "reserved" ? " reserved up front" : " authorized"}.</p>
                    : <p className="text-muted-foreground">Ongoing — no fixed total. {fundingMode === "reserved" ? "Reserved Funds sets aside only the next payment; add an end date or count to reserve the full run up front." : "You authorize about a year at a time and re-approve later — funds only move at each run."}</p>}
                </div>
              </Step>}
              {step === 5 && <Step title="Purpose" detail="Purpose powers history, analytics, receipts, and future AI insights."><div className="grid gap-2 sm:grid-cols-3">{PURPOSES.map((p) => <button key={p} onClick={() => setPurpose(p)} className={choiceClass(purpose === p, "px-3 py-2")}>{p}</button>)}</div>{purpose === "Other" && <Input value={customPurpose} onChange={(e) => setCustomPurpose(e.target.value)} placeholder="Custom purpose" className="mt-4 w-full" />}</Step>}
              {step === 6 && <Step title="Review" detail="Choose how this automation is funded, verify the details, then sign once to activate.">
                <div className="mb-5">
                  <p className="mb-2 text-sm font-medium text-foreground">How should this automation be funded?</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ModeCard
                      selected={fundingMode === "wallet"} disabled={!walletAvailableForToken}
                      onSelect={() => setFundingMode("wallet")} badge="Recommended" title="Wallet Automation"
                      description="Funds stay in your wallet until each payment runs. PayAI never holds your money."
                      pros={["Funds stay in your wallet", "Non-custodial", "More flexible"]}
                      note={isNativeToken && !walletAvailableForToken ? "Not available for MON yet — use Reserved Funds for MON." : "Payment depends on your available balance at run time."}
                    />
                    <ModeCard
                      selected={fundingMode === "reserved"} disabled={!reservedAvailable}
                      onSelect={() => setFundingMode("reserved")} badge="Guaranteed Execution" title="Reserved Funds"
                      description="Set aside funds now, dedicated to this automation, so scheduled payments always go through."
                      pros={["Higher reliability", "Funds already reserved", "Best for important payments"]}
                      note="Reserved funds stay dedicated until spent or released back to you."
                    />
                  </div>
                  <details className="mt-3 text-sm text-muted-foreground"><summary className="cursor-pointer text-primary-ink">Learn more about the two options</summary>
                    <p className="mt-2"><strong className="text-foreground">Wallet Automation</strong> keeps your money in your own wallet and only moves it at the moment each payment is due — you stay fully in control. <strong className="text-foreground">Reserved Funds</strong> moves the money into a dedicated reserve up front, so the payment can never miss for lack of balance. You can get reserved money back anytime you cancel.</p>
                  </details>
                </div>
                <ReviewGrid rows={[
                  { label: "Funding Method", value: fundingMode === "wallet" ? "Wallet Automation" : "Reserved Funds", accent: true },
                  { label: fundingMode === "wallet" ? "You authorize up to" : "You reserve", value: money(budgetAmount, tokenInfo?.symbol ?? ""), accent: true },
                  { label: "Recipient", value: recipientInput, accent: true },
                  { label: "Resolved Address", value: resolved?.recipient ?? "-", mono: true },
                  { label: "Asset", value: tokenInfo?.symbol ?? "-", accent: true },
                  { label: "Amount per payment", value: money(amountNum || 0, tokenInfo?.symbol ?? ""), accent: true },
                  { label: "Total payments", value: occurrences != null ? `${occurrences}` : "Ongoing", accent: true },
                  { label: fundingMode === "reserved" ? "Total reserved now" : "Total authorized", value: occurrences != null ? money(totalScheduled ?? 0, tokenInfo?.symbol ?? "") : "Up to ~1 year", accent: true },
                  { label: "Automation Type", value: cadence === "custom" ? `Every ${intervalCount} ${intervalUnit}` : cadenceLabel({ cadence }), accent: true },
                  { label: "Ends", value: cadence === "once" ? "Single payment" : endMode === "never" ? "No end date" : endMode === "after_count" ? `After ${Math.max(1, Math.floor(Number(endCount) || 1))} payments` : `On ${new Date(endUntilMs).toLocaleDateString()}`, accent: true },
                  { label: "Execution Time", value: new Date(startAt).toLocaleString() },
                  { label: "Purpose", value: finalPurpose || "-", accent: true },
                  { label: "Platform Fee", value: platformFee.label },
                  { label: "Estimated Gas", value: estimateGas },
                  { label: "Network", value: "Monad Mainnet" },
                  { label: "Wallet", value: short(wallet.address), mono: true },
                ]} />
                {savingStep && <p className="mt-4 flex items-center gap-2 text-sm text-primary-ink"><span className="h-2 w-2 animate-pulse rounded-full bg-primary" /> {savingStep}…</p>}
              </Step>}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-border px-5 py-4"><Button variant="secondary" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1}>Back</Button>{step < 6 ? <Button onClick={() => setStep((s) => Math.min(6, s + 1))} disabled={!canNext}>Continue <ArrowRight size={14} /></Button> : <Button onClick={create} disabled={!canNext || saving}>{saving ? "Confirming..." : "Sign & Create Automation"}</Button>}</div>
        </motion.div>
      </motion.div>}
    </>
  );
}

function Step({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return <div><h2 className="text-xl font-semibold text-foreground">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{detail}</p><div className="mt-5">{children}</div></div>;
}

function Verified({ label, value }: { label: string; value: string }) {
  return <div className="mt-3 rounded-lg border border-success/25 bg-success/10 p-3"><div className="flex items-center gap-2 text-sm font-medium text-success"><CheckCircle2 size={15} /> Recipient verified</div><p className="mt-1 text-xs text-muted-foreground">{label}</p><p className="mt-0.5 break-all font-mono text-xs text-foreground">{value}</p></div>;
}
