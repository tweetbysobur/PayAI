"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import {
  AlertTriangle, CalendarClock, CheckCircle2, ExternalLink,
  Plus, ShieldCheck, X, Search, Users, Vault, LifeBuoy,
} from "lucide-react";
import { encodeFunctionData, type Hex } from "viem";
import { Badge, Button, Input, SkeletonRows } from "@/components/ui";
import { TokenLogo } from "@/components/TokenLogo";
import { PageHeader, SectionHeader, EmptyState as PEmptyState } from "@/components/dashboard/primitives";
import { AskEntry } from "@/components/dashboard/AskEntry";
import { useToast } from "@/components/Toast";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import type { WalletState } from "@/lib/wallet/useWallet";
import { BulkPaymentCreator } from "@/components/dashboard/BulkPaymentCreator";
import { useTokenBalance } from "@/lib/hooks/useTokenBalance";
import { useModalA11y } from "@/lib/hooks/useModalA11y";

import { AUTOMATION_VAULT_ABI } from "@/lib/monad/abi";
import { MONAD_EXPLORER } from "@/lib/monad/public";
import { ReservationRecovery } from "@/components/dashboard/ReservationRecovery";
import { TemplatePicker } from "@/components/dashboard/TemplatePicker";
import { TEMPLATE_CATEGORIES, findTemplate, canLaunchWorkflow, type AutomationTemplate, type TemplateCategory } from "@/lib/automation/templates";
import { AutomationCreator } from "@/components/dashboard/AutomationCreator";
import { AutomationCard, bulkStats, displayStatus } from "@/components/dashboard/AutomationCard";
// Automation types, helpers, and the creation wizard were extracted verbatim
// into automationShared / AutomationCreator so Ask PayAI can mount the same
// creator. This page imports them back and uses them exactly as before —
// nothing about the behaviour here changed with the move.
import {
  NATIVE_TOKEN_ADDRESS, ERC20_APPROVE_ABI,
  autoId32, confirmTx, readPendingReservations, forgetPendingReservation,
  short, money, cadenceLabel,
  ReviewGrid,
  type FundingMode, type OnchainConfig, type Status, type Automation, type AutomationSeed,
} from "@/components/dashboard/automationShared";

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
    // Null until something has actually been attempted — an automation that
    // has never run has no success rate, and "100%" would claim a history
    // that doesn't exist.
    successRate: attempted.length ? Math.round((executed.length / attempted.length) * 100) : null,
    totalVolume: executed.length * a.amount,
    totalGas,
    avgGas: executed.length ? totalGas / executed.length : 0,
    lastExecution,
    completionPct: target ? Math.min(100, Math.round((a.runsCompleted / target) * 100)) : null,
  };
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
  /** Needed at page level (not just in the creator) so a Reserved Funds
   *  automation can offer a refund — the vault address lives here. */
  const [vaultConfig, setVaultConfig] = useState<OnchainConfig | null>(null);
  /** Live reserved balance per automation id, read straight from the vault.
   *  Only a non-zero on-chain balance ever shows a refund button, so we never
   *  offer to refund funds that aren't actually there. */
  const [reserved, setReserved] = useState<Record<string, string>>({});
  /** Reservations with funds but NO automation record — a create that failed
   *  after the reserve tx, or a deleted automation. Rendered from the id
   *  alone, since there is no row to read a name or token off. */
  const [orphanIds, setOrphanIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/automation-config").then((r) => r.json())
      .then((c: OnchainConfig) => { if (!cancelled) setVaultConfig(c); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /**
   * Read each Reserved Funds automation's ACTUAL remaining vault balance.
   *
   * This is deliberately read from the chain rather than inferred from the
   * automation record: a reservation can hold funds long after the automation
   * itself is cancelled, completed, or failed — which is exactly how money
   * gets stranded. The record says "cancelled"; the vault still holds MON.
   * Only the chain knows the truth, so only the chain decides whether a
   * refund is offered.
   */
  const loadReserved = useCallback(async () => {
    const vault = vaultConfig?.vault;
    if (!vault) return;
    // Saved automations PLUS ids written down before a reserve tx whose
    // automation may never have been created. The second set is the whole
    // point: those have no record, so nothing else would ever surface them.
    const ids = new Set(automations.filter((a) => a.fundingMode === "reserved").map((a) => a.id));
    const pending = readPendingReservations()
      .filter((p) => !wallet.address || p.wallet === wallet.address.toLowerCase());
    for (const p of pending) ids.add(p.id);
    if (ids.size === 0) { setReserved({}); setOrphanIds([]); return; }

    try {
      const { getBrowserPublicClient } = await import("@/lib/monad/browserClient");
      const client = await getBrowserPublicClient();
      const byId = new Map(automations.map((a) => [a.id, a]));
      const entries = await Promise.all([...ids].map(async (id) => {
        const a = byId.get(id);
        try {
          const bal = (await client.readContract({
            address: vault as Hex, abi: AUTOMATION_VAULT_ABI,
            functionName: "reservedBalance", args: [autoId32(id)],
          })) as bigint;
          if (bal === 0n) {
            // Fully released or refunded — drop the pending note so it stops
            // being re-checked forever.
            if (!a) forgetPendingReservation(id);
            return [id, ""] as const;
          }
          const decimals = a?.tokenAddress && a.tokenAddress !== NATIVE_TOKEN_ADDRESS ? (a.tokenDecimals ?? 18) : 18;
          return [id, (Number(bal) / 10 ** decimals).toString()] as const;
        } catch {
          // A read failure must NOT be reported as "no funds" — that is how
          // money becomes invisible. Leave it out of this pass and retry.
          return [id, ""] as const;
        }
      }));
      const found = Object.fromEntries(entries.filter(([, v]) => v));
      setReserved(found);
      setOrphanIds(Object.keys(found).filter((id) => !byId.has(id)));
    } catch {
      /* RPC hiccup — no refund buttons this pass rather than a wrong claim. */
    }
  }, [automations, vaultConfig?.vault, wallet.address]);

  useEffect(() => { loadReserved(); }, [loadReserved]);

  /**
   * Refund a reservation back to the wallet that funded it.
   *
   * Sent from the USER's wallet, not the agent: AutomationVault.refund()
   * authorizes `msg.sender == r.depositor`, so the owner can always recover
   * their own funds without depending on PayAI's agent being available or
   * willing. That property is the whole point of Reserved Funds being
   * non-custodial, and it's why this button can exist at all.
   */
  async function refundReservationById(id: string) {
    const vault = vaultConfig?.vault;
    if (!vault || !wallet.address) return;
    setBusy(id);
    try {
      if (wallet.isWrongNetwork) await wallet.switchNetwork();
      const data = encodeFunctionData({ abi: AUTOMATION_VAULT_ABI, functionName: "refund", args: [autoId32(id)] });
      const txHash = await confirmTx(wallet, vault, data);
      // Only forget the pending note AFTER the refund confirms — dropping it
      // on a failed attempt would discard the handle to live funds.
      forgetPendingReservation(id);
      toast("Reserved funds refunded to your wallet");
      // Tell the server this happened — self-service recovery bypasses the
      // agent entirely (the whole point: it must work even if the agent is
      // down), so without this report the automation's own row would never
      // learn its reservation came back, and would show "refunding" (money
      // still owed) forever even after the user already has it. Best-effort:
      // if this fails, the funds are still safely in the user's wallet
      // either way — only the dashboard's own status display would lag.
      const proof = await signMutation(wallet, id, "report_self_refund");
      if (proof) {
        await fetch(`/api/automations?id=${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ walletAddress: wallet.address, action: "report_self_refund", refundTxHash: txHash, ...proof }),
        }).catch(() => {});
      }
      await loadReserved();
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Refund failed");
    } finally {
      setBusy(null);
    }
  }

  const refundReservation = (a: Automation) => refundReservationById(a.id);

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

  /**
   * After a Wallet Automation is cancelled or deleted, offer to revoke the
   * ERC-20 allowance it was created with.
   *
   * This exists because cancelling used to leave that allowance live forever:
   * creation approves the automation's WHOLE budget (its full scheduled total,
   * or roughly a year of volume when open-ended), so a cancelled monthly
   * automation could leave many months of spending authority granted to the
   * executor indefinitely. The vault refund is the same story for Reserved
   * Funds, but that one the agent can settle itself; an allowance can only be
   * revoked by the token owner, so it must be a tx the user signs.
   *
   * Critically, allowance is per (owner, token, spender) — NOT per automation.
   * Several automations paying in the same token share ONE allowance, so
   * revoking after cancelling one of them would break the others. We therefore
   * only offer it when no other live wallet-funded automation uses that token.
   */
  async function offerAllowanceRevoke(ended: Automation | undefined) {
    if (!ended || !wallet.address) return;
    if ((ended.fundingMode ?? "wallet") !== "wallet") return; // reserved → refunded server-side

    // Native MON has no allowance to revoke.
    const tokenAddr = ended.tokenAddress;
    if (!tokenAddr || /^0x0+$/.test(tokenAddr)) return;

    // Would revoking strand another automation? Compare by token address, and
    // exclude the one that just ended.
    const stillUsingToken = automations.some(
      (a) =>
        a.id !== ended.id &&
        (a.fundingMode ?? "wallet") === "wallet" &&
        (a.tokenAddress ?? "").toLowerCase() === tokenAddr.toLowerCase() &&
        (a.status === "active" || a.status === "scheduled" || a.status === "executing" || a.status === "paused"),
    );
    if (stillUsingToken) {
      toast(`Approval left in place — another active automation still pays in ${ended.token}.`);
      return;
    }

    try {
      // Use the exact executor THIS automation's approval was granted to —
      // never just the current global config, which may point at a newer
      // PaymentExecutor deployment by the time this automation ends. Checking
      // allowance against the wrong (new) address would read 0 and silently
      // skip revoking a real stale approval still standing on the old one.
      let executor = ended.executorAddress;
      if (!executor) {
        const cfg: OnchainConfig = await fetch("/api/automation-config").then((r) => r.json());
        executor = cfg.executor ?? null;
      }
      if (!executor) return;

      // Nothing granted (already revoked, or fully spent) — say nothing.
      const client = await (await import("@/lib/monad/browserClient")).getBrowserPublicClient();
      const allowance = (await client.readContract({
        address: tokenAddr as Hex,
        abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "allowance",
        args: [wallet.address as Hex, executor as Hex],
      })) as bigint;
      if (allowance === 0n) return;

      const human = Number(allowance) / 10 ** (ended.tokenDecimals ?? 18);
      const ok = window.confirm(
        `This automation left PayAI approved to spend up to ${human.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${ended.token} from your wallet.\n\n` +
        `Revoke that approval now? You'll sign one transaction. Nothing can be pulled from your wallet afterwards.`,
      );
      if (!ok) return;

      const data = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [executor as Hex, 0n] });
      await confirmTx(wallet, tokenAddr, data);
      toast(`Approval revoked — PayAI can no longer spend your ${ended.token}.`);
    } catch (e) {
      // Never let this fail the cancel itself; the allowance stays revocable.
      toast(e instanceof Error ? e.message : "Could not revoke the approval — you can retry from the automation.");
    }
  }

  async function action(id: string, actionName: "pause" | "resume" | "cancel" | "delete" | "skip_next" | "execute_now") {
    if (!wallet.address) return;
    const ended = automations.find((a) => a.id === id);
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
        toast(j.outcome === "executed" ? "Payment sent" : j.outcome === "error" ? "Execution failed — check activity for details" : "Payment not sent — stopped by the compliance or risk check. Nothing moved.");
      } else {
        toast(ACTION_LABEL[actionName] ?? "Done");
      }
      // Reserved Funds is refunded server-side by the agent (the vault pays the
      // depositor, so the agent is allowed to trigger it). Wallet Automation's
      // leftover is an ERC-20 ALLOWANCE, which only the token owner can revoke
      // — so it has to be offered here, as a tx the user signs.
      if (actionName === "cancel" || actionName === "delete") {
        await offerAllowanceRevoke(ended);
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
  const others = visibleAutomations.filter((a) => !(a.status === "active" || a.status === "scheduled" || a.status === "executing"));

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div>
        <PageHeader
          title="Automations"
          description="Manage what PayAI has scheduled: what runs, when, who it affects, and what happened."
          actions={wallet.address ? (
            <>
              <Button variant="secondary" onClick={() => setBulkOpen(true)} className="inline-flex items-center gap-2 text-sm">
                <Users size={15} /> Bulk payment
              </Button>
              <Button variant="secondary" onClick={() => setPickerOpen(true)} className="inline-flex items-center gap-2 text-sm">
                <Plus size={15} /> From a template
              </Button>
            </>
          ) : undefined}
        />
        {/* Intent first: describe it, Ask PayAI plans it and opens the same
            automation creator this page uses — no second automation system. */}
        <div className="max-w-3xl">
          <AskEntry id="automate-intent" label="Automate with intent" placeholder="Describe an automation, e.g. send 20 USDC to bob.nad every Friday" />
        </div>
      </div>

      {automations.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1 sm:flex-none">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search recipient, template, wallet, or tx hash…"
              className="w-full rounded-lg border border-border bg-input py-1.5 pl-8 pr-3 text-base text-foreground outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-ring sm:w-64 sm:text-xs"
            />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as Status | "all")} className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-base text-foreground outline-none sm:text-xs">
            <option value="all">All statuses</option>
            {(["active", "scheduled", "executing", "paused", "completed", "cancelled", "failed"] as Status[]).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={tokenFilter} onChange={(e) => setTokenFilter(e.target.value)} className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-base text-foreground outline-none sm:text-xs">
            <option value="all">All tokens</option>
            {availableTokens.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value as FundingMode | "all")} className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-base text-foreground outline-none sm:text-xs">
            <option value="all">All execution modes</option>
            <option value="wallet">Wallet Automation</option>
            <option value="reserved">Reserved Funds</option>
          </select>
          <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value as typeof dateFilter)} className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-base text-foreground outline-none sm:text-xs">
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

      {/* Recoverable reserved funds. Surfaced at the very top, above the
          metrics, because money sitting in the vault after an automation
          stopped is the single most urgent thing on this page — and until
          now there was no way to get it back at all. Driven entirely by the
          live on-chain balance, so it appears only when funds are genuinely
          there and disappears the moment they're returned. */}
      {Object.keys(reserved).length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
          className="rounded-xl surface-purple p-5"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-input text-muted-foreground">
              <Vault size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">You have reserved funds you can withdraw</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                These are held in the AutomationVault for automations that are no longer going to spend them.
                Refunds go straight back to your own wallet — the vault only ever lets the original depositor withdraw.
              </p>
              <div className="mt-3 space-y-2">
                {/* Reservations with funds but no automation record. These are
                    the dangerous ones — nothing else in the UI knows they
                    exist — so they're listed first. */}
                {orphanIds.map((id) => (
                  <div key={id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-exec-scheduled/30 bg-background/40 px-3.5 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      Reservation with no automation
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground">{autoId32(id).slice(0, 10)}…</span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-foreground">{money(Number(reserved[id]))}</span>
                    <Button
                      variant="secondary" className="!px-3 !py-1.5 text-xs"
                      disabled={busy === id}
                      onClick={() => refundReservationById(id)}
                    >
                      {busy === id ? "Refunding…" : "Refund to my wallet"}
                    </Button>
                  </div>
                ))}
                {automations.filter((a) => reserved[a.id]).map((a) => (
                  <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border/70 bg-background/40 px-3.5 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {a.purpose ?? a.memo ?? "Automation"}
                      <span className="ml-2 text-muted-foreground">· {a.status}</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold tabular-nums text-foreground">
                      <TokenLogo token={a.token} logoURI={a.tokenLogo} size={14} />
                      {money(Number(reserved[a.id]), a.token)}
                    </span>
                    <Button
                      variant="secondary"
                      className="!px-3 !py-1.5 text-xs"
                      disabled={busy === a.id}
                      onClick={() => refundReservation(a)}
                    >
                      {busy === a.id ? "Refunding…" : "Refund to my wallet"}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* Always available when a wallet is connected — NOT gated on the
          reserved map above. A reservation whose automation was never saved
          (creation failed after reserve()) or was deleted has no record to
          key a banner off, which is exactly the case that strands money. */}
      {wallet.address && vaultConfig?.vault && (
        <ReservationRecovery vault={vaultConfig.vault} explorerBase={MONAD_EXPLORER} />
      )}

      {!wallet.address ? (
        <div className="rounded-xl surface-purple px-4">
          <PEmptyState title="Connect your wallet" hint="Automations belong to your wallet. Connect it to see and manage yours." action={{ label: "Connect", href: "/auth" }} />
        </div>
      ) : loading ? (
        <div className="rounded-xl surface-purple px-4 py-4"><SkeletonRows rows={4} /></div>
      ) : (
        <>
          {/* What is scheduled to happen. */}
          <section aria-labelledby="coming-up">
            <SectionHeader id="coming-up" title="Coming up" />
            <div className="rounded-xl surface-purple px-4">
              {upcoming.length === 0 ? (
                <PEmptyState compact title="No upcoming actions." hint="Scheduled and recurring runs show up here." />
              ) : (
                <ul className="divide-y divide-border">
                  {upcoming.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
                      <p className="min-w-0 truncate text-sm text-foreground">{a.purpose ?? a.memo ?? "Automation"} <span className="text-muted-foreground">· {money(a.amount, a.token)}</span></p>
                      <p className="shrink-0 text-xs tabular-nums text-muted-foreground">{new Date(a.nextRun).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* Everything PayAI runs on a schedule for this wallet. */}
          <section aria-labelledby="running">
            <SectionHeader id="running" title="Running" right={<span className="text-xs text-muted-foreground">{active.length}</span>} />
            {active.length === 0 ? (
              <div className="rounded-xl surface-purple px-4">
                <PEmptyState title="No automations yet." hint="Describe one above and PayAI will set it up for your approval." />
              </div>
            ) : (
              <ul className="space-y-2">
                {active.map((a) => (
                  <li key={a.id}>
                    <AutomationCard
                      automation={a} busy={busy === a.id} onAction={action}
                      onView={() => setViewing(a)}
                      onEdit={() => setEditing(a)}
                      onDuplicate={() => {
                        setDuplicateSeed({
                          ...a,
                          templateId: a.templateId ?? undefined,
                          templateCategory: (a.templateCategory as TemplateCategory | null) ?? undefined,
                        });
                        setCreatorOpen(true);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Paused, failed and finished automations — previously not listed
              anywhere on the page, so a paused one could only be found by
              filtering. Same card, same actions. */}
          {others.length > 0 && (
            <section aria-labelledby="stopped">
              <SectionHeader id="stopped" title="Paused and finished" right={<span className="text-xs text-muted-foreground">{others.length}</span>} />
              <ul className="space-y-2">
                {others.map((a) => (
                  <li key={a.id}>
                    <AutomationCard
                      automation={a} busy={busy === a.id} onAction={action}
                      onView={() => setViewing(a)}
                      onEdit={() => setEditing(a)}
                      onDuplicate={() => {
                        setDuplicateSeed({
                          ...a,
                          templateId: a.templateId ?? undefined,
                          templateCategory: (a.templateCategory as TemplateCategory | null) ?? undefined,
                        });
                        setCreatorOpen(true);
                      }}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* What happened. */}
          <section aria-labelledby="automation-activity">
            <SectionHeader id="automation-activity" title="What happened" right={runs.length > 0 ? <span className="text-xs text-muted-foreground">{runs.length} run{runs.length === 1 ? "" : "s"}</span> : undefined} />
            <div className="rounded-xl surface-purple px-4 py-1">
              {runs.length === 0
                ? <PEmptyState compact title="No activity yet." hint="Every run — sent, blocked or failed — appears here with its onchain receipt." />
                : <div className="py-3"><ActivityFeed runs={runs} /></div>}
            </div>
          </section>
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



function AnalyticsTile({ label, value }: { label: string; value: ReactNode }) {
  return <div className="rounded-xl surface-purple p-4"><p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">{value}</p></div>;
}

/** One unified, chronological activity feed — every run across every
 *  automation (sent / blocked / failed) with its date-time and, when it
 *  settled on-chain, a linked transaction hash. */
function ActivityFeed({ runs }: { runs: { automation: Automation; at: number; decision: string; explorerUrl?: string; txHash?: string }[] }) {
  const meta = (d: string) =>
    d === "executed" ? { Icon: CheckCircle2, tone: "bg-primary/12 text-primary-ink", label: "Sent" }
    : d === "blocked" ? { Icon: ShieldCheck, tone: "bg-warning/12 text-warning", label: "Blocked" }
    : d === "needs_review" ? { Icon: ShieldCheck, tone: "bg-warning/12 text-warning", label: "Stopped by risk check" }
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
            <div className="flex items-center gap-1.5">
              <a
                href={`/dashboard/help?tab=support&automationId=${encodeURIComponent(a.id)}&category=${
                  a.fundingMode === "reserved" && a.reserveRefundStatus === "pending" && (a.status === "cancelled" || a.status === "failed")
                    ? "missing_refund" : "failed_automation"
                }`}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
              >
                <LifeBuoy size={13} /> Report issue
              </a>
              <button onClick={onClose} aria-label="Close automation details" className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X size={16} /></button>
            </div>
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
              // Only shown for Reserved Funds — Wallet Automation has no
              // deposit to refund, so there's nothing honest to report here.
              ...(a.fundingMode === "reserved"
                ? [{
                    label: "Refund Status",
                    value: a.reserveRefundStatus === "refunded" ? "Refunded"
                      : a.reserveRefundStatus === "pending" ? "Refund pending"
                      : a.reserveRefundStatus === "none" ? "Nothing owed"
                      : "—",
                    accent: a.reserveRefundStatus === "refunded",
                  }]
                : []),
            ]} />
            {a.fundingMode === "reserved" && !!a.refundHistory?.length && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Refund History</p>
                <div className="space-y-2">
                  {a.refundHistory.map((r, i) => (
                    <div key={i} className="rounded-lg border border-border bg-input/40 p-3 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-foreground">{money(r.amount, a.token)} refunded</span>
                        <span className="text-muted-foreground">{new Date(r.at).toLocaleString()}</span>
                      </div>
                      <p className="mt-1 text-muted-foreground">Because {r.reason}.</p>
                      {r.explorerUrl && (
                        <a href={r.explorerUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-primary hover:underline">
                          View transaction ↗
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Timeline</p>
              <AutomationTimeline a={a} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <AnalyticsTile label="Success Rate" value={m.successRate == null ? "Not run yet" : `${m.successRate}%`} />
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
/** A Bulk Payment template's pre-fill — purpose and a distribution-method
 *  hint only; recipients, token, and schedule are always left for the user. */
type BulkAutomationSeed = {
  purpose?: string;
  distributionMethod?: "equal" | "fixed" | "percentage" | "custom";
  templateId?: string;
  templateCategory?: TemplateCategory;
};

