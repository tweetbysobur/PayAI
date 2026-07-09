"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  AlertTriangle, ArrowRight, BarChart3, CalendarClock, CheckCircle2, Copy, ExternalLink,
  MoreHorizontal, Pause, Play, Plus, ReceiptText, Repeat, ShieldCheck, Trash2, X, Eye, Pencil,
} from "lucide-react";
import { encodeFunctionData, keccak256, parseUnits, stringToHex, type Hex } from "viem";
import { Badge, Button, Card, Input } from "@/components/ui";
import { TokenLogo } from "@/components/TokenLogo";
import { useToast } from "@/components/Toast";
import { useWallet } from "@/lib/wallet/useWallet";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { AUTOMATION_VAULT_ABI } from "@/lib/monad/abi";

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
  endCondition?: EndCondition;
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
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [duplicateSeed, setDuplicateSeed] = useState<AutomationSeed | null>(null);
  const [viewing, setViewing] = useState<Automation | null>(null);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  async function action(id: string, actionName: "pause" | "resume" | "cancel" | "delete") {
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
      toast(actionName === "resume" ? "Automation resumed" : `Automation ${actionName}d`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Automation action failed");
    } finally {
      setBusy(null);
    }
  }

  const active = automations.filter((a) => a.status === "active" || a.status === "scheduled" || a.status === "executing");
  const upcoming = active.slice().sort((a, b) => a.nextRun - b.nextRun).slice(0, 5);
  const runs = automations.flatMap((a) => a.runs.map((run) => ({ ...run, automation: a }))).sort((a, b) => b.at - a.at);
  const totalVolume = automations.reduce((sum, a) => sum + a.runs.filter((r) => r.decision === "executed").length * a.amount, 0);
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
          <Button onClick={() => { setDuplicateSeed(null); setCreatorOpen(true); }} className="inline-flex items-center gap-2">
            <Plus size={16} /> Create Automation
          </Button>
        )}
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric title="Active Automations" value={active.length.toString()} icon={Repeat} />
        <Metric title="Success Rate" value={`${successRate}%`} icon={ShieldCheck} />
        <Metric title="Total Volume" value={money(totalVolume)} icon={BarChart3} />
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
                      onDuplicate={() => { setDuplicateSeed(a); setCreatorOpen(true); }}
                    />
                  ))}
                </div>
              )}
            </Card>
            <Card title="Upcoming Executions">
              <Timeline items={upcoming.map((a) => ({ id: a.id, title: `${a.purpose ?? "Automation"} - ${money(a.amount, a.token)}`, detail: `${new Date(a.nextRun).toLocaleString()} - ${a.timezone ?? "Africa/Lagos"}`, status: a.status, href: null }))} empty="No upcoming executions." />
            </Card>
          </section>

          <section className="grid gap-4 xl:grid-cols-3">
            <Card title="Recent Activity">
              <Timeline items={runs.slice(0, 5).map((r) => ({ id: `${r.automation.id}-${r.at}`, title: `${r.automation.purpose ?? "Automation"} ${r.decision === "executed" ? "executed" : r.decision}`, detail: new Date(r.at).toLocaleString(), status: r.decision === "executed" ? "completed" : "failed", href: r.explorerUrl ?? null }))} empty="No automation activity yet." />
            </Card>
            <Card title="Execution History" className="xl:col-span-2">
              <div className="space-y-3">
                {automations.length === 0 ? <EmptyState title="No automations yet" detail="Your execution timelines will appear here after you create one." /> : automations.map((a) => <ExecutionHistory key={a.id} automation={a} />)}
              </div>
            </Card>
          </section>

          <Card title="Analytics">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <AnalyticsTile label="Total Executions" value={totalRuns.toString()} />
              <AnalyticsTile label="Total Gas Spent" value={`${totalGas.toFixed(4)} MON`} />
              <AnalyticsTile label="Average Gas" value={`${(totalRuns ? totalGas / totalRuns : 0).toFixed(4)} MON`} />
              <AnalyticsTile label="Completion" value={`${automations.length ? Math.round((automations.filter((a) => a.status === "completed").length / automations.length) * 100) : 0}%`} />
            </div>
          </Card>
        </>
      )}

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

function Metric({ title, value, icon: Icon }: { title: string; value: string; icon: typeof Repeat }) {
  return <Card className="!p-4"><div className="flex items-center justify-between"><p className="text-xs text-muted-foreground">{title}</p><Icon size={16} className="text-primary" /></div><p className="mt-2 text-2xl font-semibold text-foreground">{value}</p></Card>;
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
  onAction: (id: string, action: "pause" | "resume" | "cancel" | "delete") => void;
  onView: () => void; onEdit: () => void; onDuplicate: () => void;
}) {
  const m = automationMetrics(automation);
  return (
    <motion.div className="rounded-lg border border-border bg-background/35 p-4" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-foreground">{automation.purpose ?? automation.memo ?? "Automation"}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1"><TokenLogo token={automation.token} size={14} /> {money(automation.amount, automation.token)}</span>
            <span>{cadenceLabel(automation)}</span>
          </div>
        </div>
        <Badge tone={STATUS_TONE[automation.status]}>{automation.status}</Badge>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <Info label="Recipient" value={automation.domain ?? short(automation.recipient)} mono />
        <Info label="Next Execution" value={new Date(automation.nextRun).toLocaleDateString()} />
        <Info label="Time" value={new Date(automation.nextRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
        <Info label="Success Rate" value={`${m.successRate}%`} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={onView} disabled={busy}><Eye size={13} /> View</Button>
        <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={onEdit} disabled={busy}><Pencil size={13} /> Edit</Button>
        {automation.status === "paused" || automation.status === "failed" ? (
          <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={() => onAction(automation.id, "resume")} disabled={busy}><Play size={13} /> Resume</Button>
        ) : (
          <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={() => onAction(automation.id, "pause")} disabled={busy}><Pause size={13} /> Pause</Button>
        )}
        <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={onDuplicate} disabled={busy}><Copy size={13} /> Duplicate</Button>
        <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={() => onAction(automation.id, "cancel")} disabled={busy}><X size={13} /> Cancel</Button>
        <Button variant="ghost" className="!px-2.5 !py-1.5 text-xs text-danger" onClick={() => onAction(automation.id, "delete")} disabled={busy}><Trash2 size={13} /> Delete</Button>
      </div>
    </motion.div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div><p className="text-muted-foreground">{label}</p><p className={`mt-0.5 truncate text-foreground ${mono ? "font-mono" : ""}`}>{value}</p></div>;
}

function AnalyticsTile({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-background/35 p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-semibold text-foreground">{value}</p></div>;
}

function ExecutionHistory({ automation }: { automation: Automation }) {
  const [open, setOpen] = useState(false);
  const synthetic = automation.runs.length ? automation.runs : [{ at: automation.nextRun, decision: "scheduled" }];
  return (
    <div className="rounded-lg border border-border p-4">
      <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen((v) => !v)}>
        <div><p className="text-sm font-medium text-foreground">{automation.purpose ?? "Automation"}</p><p className="mt-0.5 text-xs text-muted-foreground">{money(automation.amount, automation.token)} - {cadenceLabel(automation)}</p></div>
        <MoreHorizontal size={16} className="text-muted-foreground" />
      </button>
      {open && <div className="mt-4 space-y-3">{synthetic.slice(0, 6).map((run, idx) => <div key={`${run.at}-${idx}`} className="flex gap-3 text-sm"><span className={`mt-1 h-2.5 w-2.5 rounded-full ${run.decision === "executed" ? "bg-success" : run.decision === "scheduled" ? "bg-primary" : "bg-danger"}`} /><div><p className="font-medium text-foreground">{new Date(run.at).toLocaleDateString()} - {run.decision === "executed" ? "Executed Successfully" : run.decision === "scheduled" ? "Scheduled" : "Execution Failed"}</p><p className="text-xs text-muted-foreground">{new Date(run.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{run.gasFee ? ` - Gas ${run.gasFee} MON` : ""}</p>{run.explorerUrl && <a href={run.explorerUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary">Explorer Link <ExternalLink size={11} /></a>}</div></div>)}</div>}
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
  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm" onClick={onClose}>
        <motion.div initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div><p className="text-sm font-semibold text-foreground">{a.purpose ?? a.memo ?? "Automation"}</p><p className="text-xs text-muted-foreground">{money(a.amount, a.token)} · {cadenceLabel(a)}</p></div>
            <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-input"><X size={17} /></button>
          </div>
          <div className="space-y-5 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Info label="Status" value={a.status} />
              <Info label="Recipient" value={a.domain ?? short(a.recipient)} mono />
              <Info label="Created" value={new Date(a.createdAt).toLocaleString()} />
              <Info label="Last Execution" value={m.lastExecution ? new Date(m.lastExecution).toLocaleString() : "Never"} />
              <Info label="Next Execution" value={a.status === "active" || a.status === "scheduled" ? new Date(a.nextRun).toLocaleString() : "—"} />
              <Info label="Network" value="Monad Mainnet" />
            </div>
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
              <ExecutionHistory automation={a} />
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
            <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-input"><X size={17} /></button>
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
type AutomationSeed = Partial<Pick<Automation, "domain" | "recipient" | "token" | "amount" | "cadence" | "intervalCount" | "intervalUnit" | "nextRun" | "purpose" | "memo">>;

function ModeCard({ selected, disabled, onSelect, badge, title, description, pros, note }: {
  selected: boolean; disabled?: boolean; onSelect: () => void; badge: string; title: string; description: string; pros: string[]; note: string;
}) {
  return (
    <button type="button" onClick={onSelect} disabled={disabled}
      className={`flex flex-col rounded-lg border p-4 text-left transition ${disabled ? "cursor-not-allowed border-border opacity-45" : selected ? "border-primary bg-primary/10" : "border-border hover:border-primary/40"}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <Badge tone={badge === "Recommended" ? "primary" : "success"}>{badge}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      <ul className="mt-3 space-y-1">{pros.map((p) => <li key={p} className="flex items-center gap-1.5 text-xs text-foreground"><CheckCircle2 size={12} className="text-success" /> {p}</li>)}</ul>
      <p className="mt-3 text-[11px] leading-snug text-muted-foreground">{note}</p>
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
  const startAt = useMemo(() => new Date(`${date}T${time}:00`).getTime(), [date, time]);
  const amountNum = Number(amount);
  const balance = asset === "MON" ? balances.mon : balances.usdc;
  const balanceNum = balance == null ? null : Number(balance);
  const invalidAmount = !Number.isFinite(amountNum) || amountNum <= 0 || (balanceNum != null && amountNum > balanceNum);
  const finalPurpose = purpose === "Other" ? customPurpose.trim() : purpose;
  const estimateGas = asset === "MON" ? "0.002 MON" : "0.004 MON";

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
    } else {
      setRecipientInput(""); setResolved(null); setAmount(""); setPurpose("Savings"); setCustomPurpose("");
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
        <motion.div initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }} className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-border bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="text-sm font-semibold text-foreground">Create Payment Automation</p><p className="text-xs text-muted-foreground">Step {step} of 6</p></div><button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-input"><X size={17} /></button></div>
          <div className="grid gap-5 p-5 lg:grid-cols-[180px_1fr]">
            <div className="space-y-2">{["Recipient", "Payment", "Automation", "Execution Time", "Purpose", "Review"].map((label, i) => <button key={label} onClick={() => setStep(i + 1)} className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${step === i + 1 ? "bg-primary/15 text-primary" : i + 1 < step ? "text-foreground" : "text-muted-foreground"}`}>{i + 1 < step ? <CheckCircle2 size={14} /> : <span className="h-3.5 w-3.5 rounded-full border border-current" />} {label}</button>)}</div>
            <div className="min-h-[420px]">
              {step === 1 && <Step title="Recipient" detail="Enter a wallet address or .nads domain. PayAI verifies it before you continue."><Input value={recipientInput} onChange={(e) => setRecipientInput(e.target.value)} placeholder=".nad domain or 0x wallet address" className="w-full" />{resolved && <Verified label={resolved.domain ?? "Wallet address"} value={resolved.recipient} />}{recipientError && <p className="mt-2 text-sm text-danger">{recipientError}</p>}</Step>}
              {step === 2 && <Step title="Payment" detail="Choose asset and amount. Balance and gas are shown before review."><div className="flex gap-2">{(["MON", "USDC"] as const).map((t) => <button key={t} onClick={() => setAsset(t)} className={`flex items-center gap-2 rounded-md border px-4 py-2 text-sm ${asset === t ? "border-primary bg-primary/10 text-primary" : "border-border text-foreground"}`}><TokenLogo token={t} size={16} /> {t}</button>)}</div><Input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" inputMode="decimal" className="mt-4 w-full" /><div className="mt-3 grid gap-2 sm:grid-cols-2"><Info label="Wallet Balance" value={balances.loading ? "Loading..." : balance ? money(Number(balance), asset) : "-"} /><Info label="Estimated Gas" value={estimateGas} /></div>{invalidAmount && amount && <p className="mt-2 text-sm text-danger">Enter a valid amount within your wallet balance.</p>}</Step>}
              {step === 3 && <Step title="Automation" detail="Choose the cadence. Custom stays simple in v1: every X days, weeks, or months."><div className="grid gap-2 sm:grid-cols-3">{(["once", "daily", "weekly", "monthly", "custom"] as Cadence[]).map((c) => <button key={c} onClick={() => setCadence(c)} className={`rounded-md border px-3 py-3 text-left text-sm capitalize ${cadence === c ? "border-primary bg-primary/10 text-primary" : "border-border text-foreground"}`}>{c === "once" ? "One Time" : c}</button>)}</div>{cadence === "custom" && <div className="mt-4 flex items-center gap-2"><span className="text-sm text-muted-foreground">Every</span><Input value={intervalCount} onChange={(e) => setIntervalCount(e.target.value.replace(/[^0-9]/g, ""))} className="w-20" /><select value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)} className="rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground"><option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option></select></div>}</Step>}
              {step === 4 && <Step title="Execution Time" detail="Set the first execution date and time, then choose when it ends.">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">First execution date</label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Time</label><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Timezone</label><Input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div>
                </div>
                <div className="mt-3 rounded-lg border border-border bg-background/35 p-3 text-sm"><span className="text-muted-foreground">First run: </span><span className="text-foreground">{new Date(startAt).toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
                {cadence !== "once" && <div className="mt-4">
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">When should it end?</label>
                  <div className="flex flex-wrap gap-2">
                    {([["never", "No end date"], ["after_count", "After N payments"], ["until_date", "On a date"]] as [EndMode, string][]).map(([m, label]) =>
                      <button key={m} onClick={() => setEndMode(m)} className={`rounded-md border px-3 py-2 text-sm ${endMode === m ? "border-primary bg-primary/10 text-primary" : "border-border text-foreground"}`}>{label}</button>)}
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
              {step === 5 && <Step title="Purpose" detail="Purpose powers history, analytics, receipts, and future AI insights."><div className="grid gap-2 sm:grid-cols-3">{PURPOSES.map((p) => <button key={p} onClick={() => setPurpose(p)} className={`rounded-md border px-3 py-2 text-sm ${purpose === p ? "border-primary bg-primary/10 text-primary" : "border-border text-foreground"}`}>{p}</button>)}</div>{purpose === "Other" && <Input value={customPurpose} onChange={(e) => setCustomPurpose(e.target.value)} placeholder="Custom purpose" className="mt-4 w-full" />}</Step>}
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
                <div className="grid gap-3 sm:grid-cols-2"><Info label="Funding Method" value={fundingMode === "wallet" ? "Wallet Automation" : "Reserved Funds"} /><Info label={fundingMode === "wallet" ? "You authorize up to" : "You reserve"} value={money(budgetAmount, asset)} /><Info label="Recipient" value={recipientInput} /><Info label="Resolved Address" value={resolved?.recipient ?? "-"} mono /><Info label="Asset" value={asset} /><Info label="Amount per payment" value={money(amountNum || 0, asset)} /><Info label="Total payments" value={occurrences != null ? `${occurrences}` : "Ongoing"} /><Info label={fundingMode === "reserved" ? "Total reserved now" : "Total authorized"} value={occurrences != null ? money(totalScheduled ?? 0, asset) : "Up to ~1 year"} /><Info label="Automation Type" value={cadence === "custom" ? `Every ${intervalCount} ${intervalUnit}` : cadenceLabel({ cadence })} /><Info label="Ends" value={cadence === "once" ? "Single payment" : endMode === "never" ? "No end date" : endMode === "after_count" ? `After ${Math.max(1, Math.floor(Number(endCount) || 1))} payments` : `On ${new Date(endUntilMs).toLocaleDateString()}`} /><Info label="Execution Time" value={new Date(startAt).toLocaleString()} /><Info label="Purpose" value={finalPurpose || "-"} /><Info label="Estimated Gas" value={estimateGas} /><Info label="Network" value="Monad Mainnet" /><Info label="Wallet" value={short(wallet.address)} mono /></div>
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
