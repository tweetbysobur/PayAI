"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import {
  LifeBuoy, AlertTriangle, RotateCcw, Receipt, Wallet as WalletIcon,
  Bug, Sparkles, HelpCircle, Mail, CheckCircle2, Clock,
} from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";
import { useWallet } from "@/lib/wallet/useWallet";

const SUPPORT_EMAIL = "support@usepayai.xyz";

type Category =
  | "failed_automation" | "missing_refund" | "payment_issue"
  | "wallet_issue" | "bug_report" | "feature_request" | "general_question";

const CATEGORIES: { id: Category; label: string; icon: typeof AlertTriangle; hint: string }[] = [
  { id: "failed_automation", label: "Report Failed Automation", icon: AlertTriangle, hint: "An automation didn't run or produced an error." },
  { id: "missing_refund", label: "Report Missing Refund", icon: RotateCcw, hint: "A cancelled or stopped automation's deposit hasn't come back." },
  { id: "payment_issue", label: "Report Payment Issue", icon: Receipt, hint: "A send, swap, or invoice didn't behave as expected." },
  { id: "wallet_issue", label: "Report Wallet Issue", icon: WalletIcon, hint: "Connection, balance, or approval problems." },
  { id: "bug_report", label: "Bug Report", icon: Bug, hint: "Something in the app is broken." },
  { id: "feature_request", label: "Feature Request", icon: Sparkles, hint: "Something you wish PayAI could do." },
  { id: "general_question", label: "General Question", icon: HelpCircle, hint: "Anything else." },
];

interface Ticket {
  id: string; category: Category; description: string; status: "open" | "resolved";
  automationId?: string | null; txHash?: string | null; createdAt: number;
}

/**
 * The Support Center. Every submission is durably recorded with a reference
 * id and, where the reporter has one, the automation id / transaction hash
 * that pins down exactly what they're describing.
 *
 * Deliberately does NOT promise a response time or claim a ticket is
 * emailed/triaged in real time — PayAI has no support-routing infrastructure
 * behind this yet (see lib/platform/support.ts). Overstating that would be
 * exactly the kind of claim this product's trust work has been about
 * removing, not adding. What IS true, and is what's shown: the ticket is
 * saved, it has an id you can reference, and support@usepayai.xyz reaches
 * the team directly.
 */
function SupportPageInner() {
  const wallet = useWallet();
  const params = useSearchParams();
  const prefillAutomationId = params.get("automationId");
  const prefillCategory = params.get("category") as Category | null;

  const [category, setCategory] = useState<Category | null>(
    prefillCategory && CATEGORIES.some((c) => c.id === prefillCategory) ? prefillCategory : null,
  );
  const [description, setDescription] = useState("");
  const [automationId, setAutomationId] = useState(prefillAutomationId ?? "");
  const [txHash, setTxHash] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(false);

  const loadTickets = useCallback(() => {
    if (!wallet.address) { setTickets([]); return; }
    setLoadingTickets(true);
    fetch(`/api/support?wallet=${wallet.address}`)
      .then((r) => r.json())
      .then((j) => setTickets(j.tickets ?? []))
      .finally(() => setLoadingTickets(false));
  }, [wallet.address]);
  useEffect(() => { loadTickets(); }, [loadTickets]);

  async function submit() {
    if (!category || !description.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/support", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          walletAddress: wallet.address, category, description: description.trim(),
          automationId: automationId.trim() || null, txHash: txHash.trim() || null,
        }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || "Could not submit your report.");
      setSubmitted({ id: j.ticket.id });
      setCategory(null); setDescription(""); setAutomationId(""); setTxHash("");
      loadTickets();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit your report.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold text-foreground"><LifeBuoy size={24} className="text-primary-ink" /> Support Center</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Report a problem with an automation, a refund, a payment, or your wallet. Every report is saved with a
          reference id, and the automation or transaction it's about if you have one.
        </p>
      </div>

      {submitted ? (
        <Card className="text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary-ink"><CheckCircle2 size={20} /></div>
          <p className="text-sm font-medium text-foreground">Report submitted</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Reference <span className="font-mono text-foreground">{submitted.id}</span>. Include it if you email{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary-ink hover:underline">{SUPPORT_EMAIL}</a> about this.
          </p>
          <Button variant="secondary" className="mt-4" onClick={() => setSubmitted(null)}>Submit another report</Button>
        </Card>
      ) : (
        <Card title="Report an issue">
          <div className="grid gap-2 sm:grid-cols-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className={`flex items-start gap-3 rounded-lg border p-3.5 text-left transition-all duration-150 ${
                  category === c.id ? "border-primary/50 bg-primary/[0.06]" : "border-border hover:-translate-y-0.5 hover:border-primary/30 hover:bg-input/40"
                }`}
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${category === c.id ? "bg-primary/15 text-primary-ink" : "bg-input text-muted-foreground"}`}><c.icon size={15} /></span>
                <span>
                  <span className="block text-sm font-medium text-foreground">{c.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{c.hint}</span>
                </span>
              </button>
            ))}
          </div>

          {category && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="mt-5 space-y-4 border-t border-border pt-5">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">What happened?</label>
                <textarea
                  value={description} onChange={(e) => setDescription(e.target.value)}
                  rows={5} maxLength={4000} placeholder="Describe the issue in as much detail as you can."
                  className="w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Automation ID (optional)</label>
                  <input value={automationId} onChange={(e) => setAutomationId(e.target.value)} placeholder="sch_..." className="w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Transaction hash (optional)</label>
                  <input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="0x..." className="w-full rounded-lg border border-border bg-input px-3 py-2.5 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring" />
                </div>
              </div>
              {!wallet.address && (
                <p className="text-xs text-muted-foreground">Connect your wallet so this report is linked to your automations and can be looked up later.</p>
              )}
              {error && <p className="text-sm text-danger">{error}</p>}
              <Button onClick={submit} disabled={submitting || !description.trim()}>{submitting ? "Submitting…" : "Submit report"}</Button>
            </motion.div>
          )}
        </Card>
      )}

      <Card title="Contact" right={<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Clock size={12} /> Best-effort, not yet a staffed queue</span>}>
        <p className="flex items-center gap-2 text-sm text-foreground">
          <Mail size={15} className="text-primary-ink" />
          <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:underline">{SUPPORT_EMAIL}</a>
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          A report through this form is saved with a reference id you can bring to that address. PayAI doesn't yet
          have a dedicated response-time commitment to promise you here, so we won't pretend to.
        </p>
      </Card>

      {wallet.address && (
        <Card title="Your reports" right={tickets.length > 0 ? <span className="text-xs text-muted-foreground">{tickets.length}</span> : undefined}>
          {loadingTickets ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : tickets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reports submitted yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {tickets.map((t) => {
                const meta = CATEGORIES.find((c) => c.id === t.category);
                return (
                  <div key={t.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-input text-muted-foreground">
                      {meta ? <meta.icon size={14} /> : <HelpCircle size={14} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-foreground">{meta?.label ?? t.category}</p>
                        <Badge tone={t.status === "resolved" ? "success" : "neutral"}>{t.status}</Badge>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{t.description}</p>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground/70">{t.id} · {new Date(t.createdAt).toLocaleString()}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

export default function SupportPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-4xl"><p className="text-sm text-muted-foreground">Loading…</p></div>}>
      <SupportPageInner />
    </Suspense>
  );
}
