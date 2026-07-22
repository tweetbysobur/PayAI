"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  AlertTriangle, ArrowRight, BarChart3, CalendarClock, CheckCircle2, Copy, ExternalLink,
  Pause, Play, Plus, ReceiptText, Repeat, ShieldCheck, Trash2, X, Eye, Pencil,
  Lock, Wallet, Zap, SkipForward, Search,
} from "lucide-react";
import { encodeFunctionData, keccak256, parseUnits, stringToHex, type Hex } from "viem";
import { Badge, Button, Card, Input } from "@/components/ui";
import { TokenLogo } from "@/components/TokenLogo";
import { useToast } from "@/components/Toast";
import { useWallet } from "@/lib/wallet/useWallet";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { AUTOMATION_VAULT_ABI } from "@/lib/monad/abi";
import { calculateFee } from "@/lib/payment/feeEngine";
import { TemplatePicker } from "@/components/dashboard/TemplatePicker";
import { TEMPLATE_CATEGORIES, findTemplate, type AutomationTemplate, type TemplateCategory } from "@/lib/automation/templates";

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

/** Fire a wallet tx and resolve with its hash (no wait). Throws on user reject. */
async function sendWalletTx(from: string, to: string, data: string, value?: bigint): Promise<string> {
  const tx: Record<string, string> = { from, to, data };
  if (value != null) tx.value = `0x${value.toString(16)}`;
  const hash = (await window.ethereum?.request({ method: "eth_sendTransaction", params: [tx] })) as string | undefined;
  if (!hash) throw new Error("Transaction was cancelled in your wallet.");
  return hash;
}

/** Poll the wallet's RPC for a receipt so we only proceed once the tx is mined. */
async function waitForReceipt(hash: string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = (await window.ethereum?.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string } | null;
    if (r) {
      if (r.status === "0x0") throw new Error("The on-chain transaction failed. Nothing was created.");
      return;
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
  throw new Error("Timed out waiting for the transaction to confirm. Check your wallet and try again.");
}

type Cadence = "once" | "daily" | "weekly" | "monthly" | "custom";
type Status = "active" | "paused" | "completed" | "cancelled" | "failed" | "scheduled" | "executing";
type IntervalUnit = "days" | "weeks" | "months";
type Run = { at: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string; gasFee?: number };
type EndCondition = { type: "never" } | { type: "after_count"; totalRuns: number } | { type: "until_date"; untilMs: number };
type EndMode = "never" | "after_count" | "until_date";
type Automation = {
  id: string; amount: number; token: "MON" | "USDC" | string; recipient: string; domain?: string | null;
  cadence: Cadence; intervalCount?: number; intervalUnit?: IntervalUnit; nextRun: number; status: Status;
  createdAt: number; modifiedAt?: number | null; runs: Run[]; purpose?: string; memo?: string; timezone?: string; runsCompleted: number; failureCount: number; lastError?: string | null; sender?: string | null;
  endCondition?: EndCondition; fundingMode?: "wallet" | "reserved";
  templateId?: string | null; templateCategory?: string | null;
};

const PURPOSES = ["Savings", "Salary", "Subscription", "Investment", "Rent", "Family", "Utilities", "Gift", "Business", "Other"];
const STATUS_TONE: Record<Status, "neutral" | "success" | "warning" | "danger" | "primary"> = {
  active: "success", scheduled: "primary", executing: "warning", paused: "neutral", completed: "success", cancelled: "neutral", failed: "danger",
};
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
async function signMutation(walletAddress: string, automationId: string, actionName: string): Promise<{ signature: string; timestamp: number } | null> {
  const timestamp = Date.now();
  const message = mutationMessage({ walletAddress, automationId, action: actionName, timestamp });
  const signature = await window.ethereum?.request({ method: "personal_sign", params: [message, walletAddress] }) as string | undefined;
  return signature ? { signature, timestamp } : null;
}

export default function AutomationsPage() {
  const wallet = useWallet();
  const { toast } = useToast();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [duplicateSeed, setDuplicateSeed] = useState<AutomationSeed | null>(null);
  const [viewing, setViewing] = useState<Automation | null>(null);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<TemplateCategory | "all">("all");
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [tokenFilter, setTokenFilter] = useState<string | "all">("all");
  const [modeFilter, setModeFilter] = useState<FundingMode | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");

  /** Template → wizard seed. Only sets fields the template actually
   *  specifies; recipient/amount/exact time are always left for the user to
   *  fill in, even from a template — templates set smart defaults, not
   *  locked-in values. */
  function handleTemplateSelect(template: AutomationTemplate | null) {
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

  const visibleAutomations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return automations.filter((a) => {
      if (categoryFilter !== "all" && a.templateCategory !== categoryFilter) return false;
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      if (tokenFilter !== "all" && a.token !== tokenFilter) return false;
      if (modeFilter !== "all" && (a.fundingMode ?? "wallet") !== modeFilter) return false;
      if (q) {
        const haystack = [a.purpose, a.memo, a.domain, a.recipient, findTemplate(a.templateId ?? "")?.name]
          .filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [automations, categoryFilter, statusFilter, tokenFilter, modeFilter, searchQuery]);

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
      const proof = await signMutation(wallet.address, id, actionName);
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
          <Button onClick={() => setPickerOpen(true)} className="inline-flex items-center gap-2">
            <Plus size={16} /> Create Automation
          </Button>
        )}
      </div>

      {automations.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1 sm:flex-none">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search automations…"
              className="w-full rounded-lg border border-border bg-input py-1.5 pl-8 pr-3 text-xs text-foreground outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-ring sm:w-56"
            />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as Status | "all")} className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs text-foreground outline-none">
            <option value="all">All statuses</option>
            {(["active", "scheduled", "executing", "paused", "completed", "cancelled", "failed"] as Status[]).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={tokenFilter} onChange={(e) => setTokenFilter(e.target.value)} className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs text-foreground outline-none">
            <option value="all">All tokens</option>
            <option value="MON">MON</option>
            <option value="USDC">USDC</option>
          </select>
          <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value as FundingMode | "all")} className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs text-foreground outline-none">
            <option value="all">All execution modes</option>
            <option value="wallet">Wallet Automation</option>
            <option value="reserved">Reserved Funds</option>
          </select>
        </div>
      )}

      {automations.some((a) => a.templateCategory) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Filter by template:</span>
          <button
            onClick={() => setCategoryFilter("all")}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${categoryFilter === "all" ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"}`}
          >
            All
          </button>
          {TEMPLATE_CATEGORIES.filter((c) => c.id !== "custom" && automations.some((a) => a.templateCategory === c.id)).map((c) => (
            <button
              key={c.id}
              onClick={() => setCategoryFilter(c.id)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${categoryFilter === c.id ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"}`}
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

      {!wallet.address ? (
        <Card className="text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary"><ShieldCheck size={20} /></div>
          <p className="text-sm font-medium text-foreground">Connect your wallet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">Automations are scoped to your wallet. Connect to create and manage yours.</p>
        </Card>
      ) : loading ? (
        <Card><p className="text-sm text-muted-foreground">Loading automations...</p></Card>
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

      <TemplatePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={handleTemplateSelect} />
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
        <Icon size={16} className="text-primary" />
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

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="rounded-lg border border-dashed border-border p-6 text-center"><p className="text-sm font-medium text-foreground">{title}</p><p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{detail}</p></div>;
}

function Timeline({ items, empty }: { items: { id: string; title: string; detail: string; status: string; href: string | null }[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return <div className="space-y-3">{items.map((item) => <div key={item.id} className="flex gap-3"><span className="mt-1 h-2.5 w-2.5 rounded-full bg-primary" /><div className="min-w-0 flex-1 border-b border-border pb-3 last:border-b-0"><div className="flex items-center justify-between gap-2"><p className="truncate text-sm font-medium text-foreground">{item.title}</p>{item.href && <a href={item.href} target="_blank" rel="noreferrer" className="text-primary"><ExternalLink size={13} /></a>}</div><p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p></div></div>)}</div>;
}

function AutomationCard({ automation, busy, onAction, onView, onEdit, onDuplicate }: {
  automation: Automation; busy: boolean;
  onAction: (id: string, action: "pause" | "resume" | "cancel" | "delete" | "skip_next" | "execute_now") => void;
  onView: () => void; onEdit: () => void; onDuplicate: () => void;
}) {
  const m = automationMetrics(automation);
  const template = automation.templateId ? findTemplate(automation.templateId) : undefined;
  return (
    <motion.div className="group rounded-xl border border-border bg-gradient-to-br from-primary/[0.07] via-panel/40 to-transparent p-5 transition-all duration-200 hover:border-primary/35 hover:from-primary/[0.11]" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold tracking-tight text-foreground">{automation.purpose ?? automation.memo ?? "Automation"}</p>
          {template && (
            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground/70">
              <template.icon size={11} /> Created from {template.name}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground"><TokenLogo token={automation.token} size={14} /> {money(automation.amount, automation.token)}</span>
            <span className="text-muted-foreground/50">·</span>
            <span>{cadenceLabel(automation)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge tone={STATUS_TONE[automation.status]}>{automation.status}</Badge>
          {automation.fundingMode && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {automation.fundingMode === "reserved" ? <><Lock size={9} /> Reserved</> : <><Wallet size={9} /> Non-custodial</>}
            </span>
          )}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <Info label="Recipient" value={automation.domain ?? short(automation.recipient)} mono />
        <Info label="Next Execution" value={new Date(automation.nextRun).toLocaleDateString()} />
        <Info label="Time" value={new Date(automation.nextRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
        <Info label="Success Rate" value={`${m.successRate}%`} />
      </div>
      <div className="mt-5 flex items-center gap-2 border-t border-border/60 pt-4">
        <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={onView} disabled={busy}><Eye size={13} /> View</Button>
        <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={onEdit} disabled={busy}><Pencil size={13} /> Edit</Button>
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
          <IconAction label="Duplicate" onClick={onDuplicate} disabled={busy}><Copy size={14} /></IconAction>
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
          <p className={`mt-0.5 truncate ${r.mono ? "font-mono text-xs" : "text-sm"} ${r.accent ? "font-semibold text-primary" : "font-medium text-foreground"}`}>{r.value}</p>
        </div>
      ))}
    </div>
  );
}

function AnalyticsTile({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-border bg-gradient-to-b from-primary/[0.06] to-transparent p-4 transition-colors hover:border-primary/25"><p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">{value}</p></div>;
}

/** One unified, chronological activity feed — every run across every
 *  automation (sent / blocked / failed) with its date-time and, when it
 *  settled on-chain, a linked transaction hash. */
function ActivityFeed({ runs }: { runs: { automation: Automation; at: number; decision: string; explorerUrl?: string; txHash?: string }[] }) {
  const meta = (d: string) =>
    d === "executed" ? { Icon: CheckCircle2, tone: "bg-primary/12 text-primary", label: "Sent" }
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
                <span className={`shrink-0 text-xs font-medium ${r.decision === "executed" ? "text-primary" : r.decision === "error" || r.decision === "failed" ? "text-danger" : "text-muted-foreground"}`}>{label}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><CalendarClock size={11} /> {fmt(r.at)}</span>
                {r.txHash && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    {r.explorerUrl
                      ? <a href={r.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-primary transition-colors hover:text-secondary hover:underline">{r.txHash.slice(0, 8)}…{r.txHash.slice(-6)} <ExternalLink size={10} /></a>
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
  if (!automation) return null;
  const a = automation;
  const m = automationMetrics(a);
  const template = a.templateId ? findTemplate(a.templateId) : undefined;
  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm" onClick={onClose}>
        <motion.div initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div><p className="text-sm font-semibold text-foreground">{a.purpose ?? a.memo ?? "Automation"}</p><p className="text-xs text-muted-foreground">{money(a.amount, a.token)} · {cadenceLabel(a)}</p></div>
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-input hover:text-foreground"><X size={16} /></button>
          </div>
          <div className="space-y-5 p-5">
            <ReviewGrid rows={[
              { label: "Status", value: a.status, accent: true },
              { label: "Recipient", value: a.domain ?? short(a.recipient), accent: true },
              { label: "Created", value: new Date(a.createdAt).toLocaleString() },
              { label: "Last Execution", value: m.lastExecution ? new Date(m.lastExecution).toLocaleString() : "Never" },
              { label: "Next Execution", value: a.status === "active" || a.status === "scheduled" ? new Date(a.nextRun).toLocaleString() : "—" },
              { label: "Network", value: "Monad Mainnet" },
              { label: "Template", value: template ? template.name : "Custom (built from scratch)" },
            ]} />
            <div className="grid gap-3 sm:grid-cols-3">
              <AnalyticsTile label="Success Rate" value={`${m.successRate}%`} />
              <AnalyticsTile label="Total Executions" value={m.totalExecutions.toString()} />
              <AnalyticsTile label="Total Volume" value={money(m.totalVolume, a.token)} />
              <AnalyticsTile label="Total Gas Spent" value={`${m.totalGas.toFixed(4)} MON`} />
              <AnalyticsTile label="Average Gas" value={`${m.avgGas.toFixed(4)} MON`} />
              <AnalyticsTile label="Completion" value={m.completionPct != null ? `${m.completionPct}%` : "Open-ended"} />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Execution history</p>
              {a.runs.length ? <ActivityFeed runs={a.runs.map((run) => ({ ...run, automation: a }))} /> : <p className="text-sm text-muted-foreground">No executions yet.</p>}
            </div>
            {a.lastError && (a.status === "paused" || a.status === "failed") && (
              <div className="rounded-lg border border-warning/25 bg-warning/10 p-3 text-xs text-warning">{a.lastError}</div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
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
      const proof = await signMutation(wallet.address, automation!.id, "edit");
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

  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm" onClick={onClose}>
        <motion.div initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }} className="w-full max-w-md rounded-lg border border-border bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
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
    </AnimatePresence>
  );
}

/** Everything the creator wizard actually pre-fills from — a real Duplicate
 *  passes the full Automation; an AI-parsed draft passes only the subset it
 *  resolved (recipient/amount/asset/cadence/time), never a purpose or id. */
type AutomationSeed = Partial<Pick<Automation, "domain" | "recipient" | "token" | "amount" | "cadence" | "intervalCount" | "intervalUnit" | "nextRun" | "purpose" | "memo">> & {
  /** Only set when seeded from an Automation Template — carried through to
   *  creation so the created automation records which template it came from.
   *  A real Duplicate or an AI-parsed draft never sets these. */
  fundingMode?: FundingMode;
  endMode?: EndMode;
  templateId?: string;
  templateCategory?: TemplateCategory;
};

/** Shared premium style for selectable chips (asset, cadence, end-mode,
 *  purpose) — consistent selected/hover states across the whole flow. */
function choiceClass(selected: boolean, extra = "") {
  return `rounded-lg border text-sm font-medium transition-all duration-150 ${
    selected
      ? "border-primary/60 bg-primary/10 text-primary shadow-sm shadow-primary/10"
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
      <ul className="mt-4 space-y-1.5">{pros.map((p) => <li key={p} className="flex items-center gap-2 text-xs text-foreground"><CheckCircle2 size={13} className="shrink-0 text-primary" /> {p}</li>)}</ul>
      <p className="mt-4 text-[11px] leading-snug text-muted-foreground">{note}</p>
    </button>
  );
}

function AutomationCreator({ open, seed, onClose, onCreated }: { open: boolean; seed?: AutomationSeed | null; onClose: () => void; onCreated: () => void }) {
  const wallet = useWallet();
  const balances = useWalletBalances(wallet.address);
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [recipientInput, setRecipientInput] = useState("");
  const [resolved, setResolved] = useState<{ recipient: string; domain: string | null } | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [asset, setAsset] = useState<"MON" | "USDC">("MON");
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
  const balance = asset === "MON" ? balances.mon : balances.usdc;
  const balanceNum = balance == null ? null : Number(balance);
  const invalidAmount = !Number.isFinite(amountNum) || amountNum <= 0 || (balanceNum != null && amountNum > balanceNum);
  const finalPurpose = purpose === "Other" ? customPurpose.trim() : purpose;
  const estimateGas = asset === "MON" ? "0.002 MON" : "0.004 MON";
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
      if (seed.token) setAsset(seed.token === "USDC" ? "USDC" : "MON");
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
      setRecipientInput(""); setResolved(null); setAmount(""); setPurpose("Savings"); setCustomPurpose("");
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

  // Wallet Automation needs an ERC-20 allowance: USDC works directly; MON only
  // works if WMON is configured. When unavailable for the chosen token, the
  // choice collapses to Reserved Funds so we never offer an impossible path.
  const walletAvailableForToken = asset === "USDC" ? !!config?.walletModeAvailable : !!config?.wmon;
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
    : annualVolume({ amount: perPayment, token: asset, cadence, intervalCount: Number(intervalCount), intervalUnit } as Automation);
  const reservedBudgetAmount = totalScheduled != null ? totalScheduled : perPayment;
  // What the Review screen shows depends on the chosen mode.
  const budgetAmount = fundingMode === "wallet" ? walletBudgetAmount : reservedBudgetAmount;

  const endCondition: EndCondition = cadence === "once" || endMode === "never"
    ? { type: "never" }
    : endMode === "after_count"
      ? { type: "after_count", totalRuns: Math.max(1, Math.floor(Number(endCount) || 1)) }
      : { type: "until_date", untilMs: endUntilMs };

  async function create() {
    if (!wallet.address || !resolved || invalidAmount || !finalPurpose || !config) return;
    const isNative = asset === "MON";
    const decimals = isNative ? 18 : config.usdc.decimals;
    const perRun = parseUnits(String(amountNum), decimals);
    const budget = parseUnits(String(walletBudgetAmount), decimals);
    const reservedBudget = parseUnits(String(reservedBudgetAmount), decimals);
    setSaving(true);
    try {
      if (wallet.isWrongNetwork) await wallet.switchNetwork();
      const message = signatureMessage({ walletAddress: wallet.address, recipient: resolved.recipient, amount: amountNum, token: asset, cadence, startAt, timezone, purpose: finalPurpose });
      setSavingStep("Confirm the automation in your wallet");
      const signature = await window.ethereum?.request({ method: "personal_sign", params: [message, wallet.address] }) as string | undefined;
      if (!signature) throw new Error("Wallet confirmation was cancelled.");

      const body: Record<string, unknown> = {
        walletAddress: wallet.address, recipient: recipientInput, amount: amountNum, token: asset, cadence,
        intervalCount: Number(intervalCount), intervalUnit, startAt, timezone, purpose: finalPurpose,
        signature, signatureMessage: message, fundingMode, endCondition,
        ...(templateMeta ? { templateId: templateMeta.id, templateCategory: templateMeta.category } : {}),
      };

      if (fundingMode === "wallet") {
        // Non-custodial: approve the executor to pull up to the budget. (MON→WMON path lands with a WMON address.)
        if (!config.executor) throw new Error("Wallet Automation isn't available right now.");
        const token = isNative ? config.wmon : config.usdc.address;
        if (!token) throw new Error("This token can't use Wallet Automation yet. Choose Reserved Funds.");
        setSavingStep("Approve PayAI to send from your wallet");
        const data = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [config.executor as Hex, budget] });
        const hash = await sendWalletTx(wallet.address, token, data);
        setSavingStep("Waiting for approval to confirm on Monad");
        await waitForReceipt(hash);
      } else {
        // Reserved Funds: deposit the budget into the vault, keyed to a client id.
        if (!config.vault) throw new Error("Reserved Funds isn't available right now.");
        const id = `sch_${crypto.randomUUID()}`;
        body.id = id;
        if (!isNative) {
          // ERC-20 must approve the vault before it can pull the reserve.
          setSavingStep("Approve the reserved amount");
          const approveData = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [config.vault as Hex, reservedBudget] });
          const aHash = await sendWalletTx(wallet.address, config.usdc.address, approveData);
          await waitForReceipt(aHash);
        }
        setSavingStep("Reserve funds for this automation");
        const reserveData = encodeFunctionData({
          abi: AUTOMATION_VAULT_ABI, functionName: "reserve",
          args: [autoId32(id), (isNative ? "0x0000000000000000000000000000000000000000" : config.usdc.address) as Hex, resolved.recipient as Hex, reservedBudget],
        });
        const rHash = await sendWalletTx(wallet.address, config.vault, reserveData, isNative ? reservedBudget : undefined);
        setSavingStep("Waiting for the reservation to confirm on Monad");
        await waitForReceipt(rHash);
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

  const canNext = step === 1 ? !!resolved : step === 2 ? !invalidAmount : step === 3 ? cadence !== "custom" || Number(intervalCount) > 0 : step === 4 ? Number.isFinite(startAt) && startAt > Date.now() - 60_000 : step === 5 ? !!finalPurpose : true;

  return (
    <AnimatePresence>
      {open && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm" onClick={onClose}>
        <motion.div initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }} className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-border bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border px-6 py-4"><div><p className="text-sm font-semibold tracking-tight text-foreground">Create Payment Automation</p><p className="mt-0.5 text-xs text-muted-foreground">Step {step} of 6</p></div><button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-input hover:text-foreground"><X size={16} /></button></div>
          <div className="grid gap-6 p-6 lg:grid-cols-[190px_1fr]">
            <div className="space-y-1">{["Recipient", "Payment", "Automation", "Execution Time", "Purpose", "Review"].map((label, i) => <button key={label} onClick={() => setStep(i + 1)} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${step === i + 1 ? "bg-primary/12 font-medium text-primary" : i + 1 < step ? "text-foreground hover:bg-input/50" : "text-muted-foreground hover:bg-input/40"}`}>{i + 1 < step ? <CheckCircle2 size={15} className="shrink-0 text-primary" /> : <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] ${step === i + 1 ? "border-primary text-primary" : "border-current"}`}>{i + 1}</span>} {label}</button>)}</div>
            <div className="min-h-[420px]">
              {step === 1 && <Step title="Recipient" detail="Enter a wallet address or .nads domain. PayAI verifies it before you continue."><Input value={recipientInput} onChange={(e) => setRecipientInput(e.target.value)} placeholder=".nad domain or 0x wallet address" className="w-full" />{resolved && <Verified label={resolved.domain ?? "Wallet address"} value={resolved.recipient} />}{recipientError && <p className="mt-2 text-sm text-danger">{recipientError}</p>}</Step>}
              {step === 2 && <Step title="Payment" detail="Choose asset and amount. Balance and gas are shown before review."><div className="flex gap-2">{(["MON", "USDC"] as const).map((t) => <button key={t} onClick={() => setAsset(t)} className={choiceClass(asset === t, "flex items-center gap-2 px-4 py-2.5")}><TokenLogo token={t} size={16} /> {t}</button>)}</div><Input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" inputMode="decimal" className="mt-4 w-full" /><div className="mt-3 grid gap-2 sm:grid-cols-2"><Info label="Wallet Balance" value={balances.loading ? "Loading..." : balance ? money(Number(balance), asset) : "-"} /><Info label="Estimated Gas" value={estimateGas} /></div>{invalidAmount && amount && <p className="mt-2 text-sm text-danger">Enter a valid amount within your wallet balance.</p>}</Step>}
              {step === 3 && <Step title="Automation" detail="Choose the cadence. Custom stays simple in v1: every X days, weeks, or months."><div className="grid gap-2 sm:grid-cols-3">{(["once", "daily", "weekly", "monthly", "custom"] as Cadence[]).map((c) => <button key={c} onClick={() => setCadence(c)} className={choiceClass(cadence === c, "px-3 py-3 text-left capitalize")}>{c === "once" ? "One Time" : c}</button>)}</div>{cadence === "custom" && <div className="mt-4 flex items-center gap-2"><span className="text-sm text-muted-foreground">Every</span><Input value={intervalCount} onChange={(e) => setIntervalCount(e.target.value.replace(/[^0-9]/g, ""))} className="w-20" /><select value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)} className="rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground"><option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option></select></div>}</Step>}
              {step === 4 && <Step title="Execution Time" detail="Set the first execution date and time, then choose when it ends.">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">First execution date</label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Time</label><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Timezone</label><Input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div>
                </div>
                <div className="mt-3 rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent p-3 text-sm"><span className="text-muted-foreground">First run: </span><span className="font-medium text-primary">{new Date(startAt).toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
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
                    ? <p className="text-foreground">{occurrences} payment{occurrences === 1 ? "" : "s"} × {money(perPayment, asset)} = <strong className="text-primary">{money(totalScheduled ?? 0, asset)}</strong> total{fundingMode === "reserved" ? " reserved up front" : " authorized"}.</p>
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
                      note={asset === "MON" && !walletAvailableForToken ? "Not available for MON yet — use Reserved Funds for MON." : "Payment depends on your available balance at run time."}
                    />
                    <ModeCard
                      selected={fundingMode === "reserved"} disabled={!reservedAvailable}
                      onSelect={() => setFundingMode("reserved")} badge="Guaranteed Execution" title="Reserved Funds"
                      description="Set aside funds now, dedicated to this automation, so scheduled payments always go through."
                      pros={["Higher reliability", "Funds already reserved", "Best for important payments"]}
                      note="Reserved funds stay dedicated until spent or released back to you."
                    />
                  </div>
                  <details className="mt-3 text-sm text-muted-foreground"><summary className="cursor-pointer text-primary">Learn more about the two options</summary>
                    <p className="mt-2"><strong className="text-foreground">Wallet Automation</strong> keeps your money in your own wallet and only moves it at the moment each payment is due — you stay fully in control. <strong className="text-foreground">Reserved Funds</strong> moves the money into a dedicated reserve up front, so the payment can never miss for lack of balance. You can get reserved money back anytime you cancel.</p>
                  </details>
                </div>
                <ReviewGrid rows={[
                  { label: "Funding Method", value: fundingMode === "wallet" ? "Wallet Automation" : "Reserved Funds", accent: true },
                  { label: fundingMode === "wallet" ? "You authorize up to" : "You reserve", value: money(budgetAmount, asset), accent: true },
                  { label: "Recipient", value: recipientInput, accent: true },
                  { label: "Resolved Address", value: resolved?.recipient ?? "-", mono: true },
                  { label: "Asset", value: asset, accent: true },
                  { label: "Amount per payment", value: money(amountNum || 0, asset), accent: true },
                  { label: "Total payments", value: occurrences != null ? `${occurrences}` : "Ongoing", accent: true },
                  { label: fundingMode === "reserved" ? "Total reserved now" : "Total authorized", value: occurrences != null ? money(totalScheduled ?? 0, asset) : "Up to ~1 year", accent: true },
                  { label: "Automation Type", value: cadence === "custom" ? `Every ${intervalCount} ${intervalUnit}` : cadenceLabel({ cadence }), accent: true },
                  { label: "Ends", value: cadence === "once" ? "Single payment" : endMode === "never" ? "No end date" : endMode === "after_count" ? `After ${Math.max(1, Math.floor(Number(endCount) || 1))} payments` : `On ${new Date(endUntilMs).toLocaleDateString()}`, accent: true },
                  { label: "Execution Time", value: new Date(startAt).toLocaleString() },
                  { label: "Purpose", value: finalPurpose || "-", accent: true },
                  { label: "Platform Fee", value: platformFee.label },
                  { label: "Estimated Gas", value: estimateGas },
                  { label: "Network", value: "Monad Mainnet" },
                  { label: "Wallet", value: short(wallet.address), mono: true },
                ]} />
                {savingStep && <p className="mt-4 flex items-center gap-2 text-sm text-primary"><span className="h-2 w-2 animate-pulse rounded-full bg-primary" /> {savingStep}…</p>}
              </Step>}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-border px-5 py-4"><Button variant="secondary" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1}>Back</Button>{step < 6 ? <Button onClick={() => setStep((s) => Math.min(6, s + 1))} disabled={!canNext}>Continue <ArrowRight size={14} /></Button> : <Button onClick={create} disabled={!canNext || saving}>{saving ? "Confirming..." : "Sign & Create Automation"}</Button>}</div>
        </motion.div>
      </motion.div>}
    </AnimatePresence>
  );
}

function Step({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return <div><h2 className="text-xl font-semibold text-foreground">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{detail}</p><div className="mt-5">{children}</div></div>;
}

function Verified({ label, value }: { label: string; value: string }) {
  return <div className="mt-3 rounded-lg border border-success/25 bg-success/10 p-3"><div className="flex items-center gap-2 text-sm font-medium text-success"><CheckCircle2 size={15} /> Recipient verified</div><p className="mt-1 text-xs text-muted-foreground">{label}</p><p className="mt-0.5 break-all font-mono text-xs text-foreground">{value}</p></div>;
}
