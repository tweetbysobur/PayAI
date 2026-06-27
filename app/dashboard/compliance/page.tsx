"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ShieldCheck } from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { useAgentConsole, friendlyError } from "@/lib/hooks/useAgentConsole";
import { recipientError, isValidRecipient } from "@/lib/validation";

interface Compliance { approved: number; rejected: number; review: number; blocked: number; approvalRate: number }
interface Analytics { compliance: Compliance }

export default function Compliance() {
  const [a, setA] = useState<Analytics | null>(null);
  const [addr, setAddr] = useState("");
  const [touched, setTouched] = useState(false);
  const c = useAgentConsole();
  const addrErr = recipientError(addr);

  useEffect(() => {
    fetch("/api/analytics").then((r) => r.json()).then(setA).catch(() => {});
  }, []);

  function checkAddress() {
    setTouched(true);
    if (!isValidRecipient(addr)) return;
    c.run(`Check compliance for ${addr.trim()}`);
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-2xl font-semibold text-foreground">Compliance Center</h1>
      <p className="mb-6 text-sm text-muted-foreground">Risk scoring and compliance checks across all payments.</p>

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
          ) : <p className="text-sm text-muted-foreground">No payments processed yet — risk scoring will appear here.</p>}
        </Card>

        <Card title="Run a compliance check">
          <div className="flex flex-wrap gap-2">
            <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x… or domain.nads" className="flex-1" />
            <Button onClick={checkAddress} disabled={c.loading || !addr}>Check</Button>
          </div>
          {touched && addrErr && <p className="mt-2 text-xs text-danger">{addrErr}</p>}
          {c.err && <p className="mt-3 text-sm text-danger">{friendlyError(c.err)}</p>}
          {c.res?.compliance && (
            <div className="mt-3">
              <Badge tone={c.res.compliance.status === "approved" ? "success" : "warning"}>{c.res.compliance.status}</Badge>
              <p className="mt-2 text-sm text-foreground">{c.res.compliance.summary}</p>
              <ul className="mt-2 space-y-1 text-xs">
                {c.res.compliance.checks.map((chk) => (
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
