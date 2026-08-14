"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ShieldCheck } from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { recipientError, isValidRecipient } from "@/lib/validation";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";

/**
 * Lives as a Transactions tab (see app/dashboard/transactions/page.tsx) —
 * this was previously its own page at /dashboard/compliance, which now
 * redirects here.
 */

interface Compliance { approved: number; rejected: number; review: number; blocked: number; approvalRate: number }
interface Analytics { compliance: Compliance }
interface CheckResult {
  recipient: string; domain: string | null; status: string; summary: string;
  checks: { id: string; label: string; passed: boolean }[];
  risk: { score: number; level: string };
}

export function ComplianceTabContent() {
  const wallet = useWallet();
  const [a, setA] = useState<Analytics | null>(null);
  const [addr, setAddr] = useState("");
  const [touched, setTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const addrErr = recipientError(addr);

  useEffect(() => {
    // Aggregate risk is scoped to the connected wallet's own payments.
    const headers = wallet.address ? { "x-wallet-address": wallet.address } : undefined;
    fetch("/api/analytics", { headers }).then((r) => r.json()).then(setA).catch(() => {});
  }, [wallet.address]);

  async function checkAddress() {
    setTouched(true);
    if (!isValidRecipient(addr)) return;
    setLoading(true); setErr(null); setResult(null);
    try {
      const r = await fetch("/api/compliance/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: addr.trim() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Compliance check failed.");
      setResult(j as CheckResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Compliance check failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">Rules-based screening on every payment: address denylist, risk scoring, and large-transfer checks. Third-party sanctions screening is on our roadmap.</p>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card title="Aggregate risk">
          {a ? (
            <div className="flex flex-col items-center">
              <div className="relative h-32 w-32" title={`${Math.round(a.compliance.approvalRate * 100)}% approval rate`}>
                <svg width="128" height="128" viewBox="0 0 128 128" className="-rotate-90">
                  <circle cx="64" cy="64" r="54" fill="none" stroke="var(--color-border)" strokeWidth="10" />
                  <motion.circle
                    cx="64" cy="64" r="54" fill="none" stroke="var(--color-success)" strokeWidth="10" strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 54}
                    initial={{ strokeDashoffset: 2 * Math.PI * 54 }}
                    animate={{ strokeDashoffset: 2 * Math.PI * 54 * (1 - a.compliance.approvalRate) }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <ShieldCheck className="mb-1 text-success" size={22} />
                  <span className="text-sm font-semibold text-foreground">{Math.round(a.compliance.approvalRate * 100)}%</span>
                </div>
              </div>
              <div className="mt-4 grid w-full grid-cols-2 gap-2 text-center text-xs">
                <div><p className="text-foreground">{a.compliance.approved}</p><p className="text-muted-foreground">Approved</p></div>
                <div><p className="text-foreground">{a.compliance.review}</p><p className="text-muted-foreground">Needs review</p></div>
                <div><p className="text-foreground">{a.compliance.blocked}</p><p className="text-muted-foreground">Blocked</p></div>
                <div><p className="text-foreground">{a.compliance.rejected}</p><p className="text-muted-foreground">Rejected</p></div>
              </div>
            </div>
          ) : <p className="text-sm text-muted-foreground">No payments yet. Risk scoring appears here once you send one.</p>}
        </Card>

        <Card title="Run a compliance check">
          <div className="flex flex-wrap gap-2">
            <Input value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && checkAddress()} placeholder="0x… or domain.nads" className="flex-1" />
            <Button onClick={checkAddress} disabled={loading || !addr}>{loading ? "Checking…" : "Check"}</Button>
          </div>
          {touched && addrErr && <p className="mt-2 text-xs text-danger">{addrErr}</p>}
          {err && <p className="mt-3 text-sm text-danger">{err}</p>}
          {result && (
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={result.status === "approved" ? "success" : result.status === "review" ? "warning" : "danger"}>{result.status}</Badge>
                <Badge tone={result.risk.level === "low" ? "success" : result.risk.level === "medium" ? "warning" : "danger"}>risk {result.risk.score}/100 · {result.risk.level}</Badge>
                {result.domain && <span className="font-mono text-xs text-primary-ink">{result.domain}</span>}
              </div>
              <p className="mt-2 text-sm text-foreground">{result.summary}</p>
              <ul className="mt-2 space-y-1 text-xs">
                {result.checks.map((chk) => (
                  <li key={chk.id} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{chk.label}</span>
                    <Badge tone={chk.passed ? "success" : "danger"}>{chk.passed ? "Passed" : "Failed"}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
