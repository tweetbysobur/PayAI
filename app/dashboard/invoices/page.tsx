"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Search } from "lucide-react";
import { motion } from "motion/react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { amountError, isValidAmount, addressError, isValidAddress } from "@/lib/validation";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";

interface PayLink { id: string; amount: number; token: string; description?: string; url: string; status: string; createdAt: number }
interface OnchainRequest { id: number; merchant: string; amount: number; paid: boolean; paymentId: number }
interface Onchain { configured: boolean; requests: OnchainRequest[] }

const short = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—");
const PAGE_SIZE = 10;

/** Off the sidebar (see Sidebar.tsx's `soon: true` on this entry), but the
 *  route itself still needs its own gate — a bookmarked or typed URL reaches
 *  the page directly, past any nav badge. The real workspace below is fully
 *  built and working (payment links, on-chain requests) and untouched; this
 *  only decides which one renders, same pattern as Ask PayAI's own
 *  COMING_SOON toggle in app/dashboard/ask/page.tsx. */
const COMING_SOON = true;

function InvoicesComingSoon() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center justify-center rounded-2xl border border-border bg-panel/40 px-4 py-16 text-center">
      <motion.div
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
        className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink"
      >
        <FileText size={26} />
      </motion.div>
      <motion.h1
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.35 }}
        className="mt-4 text-2xl font-semibold tracking-tight text-foreground"
      >
        Invoices — coming soon
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.35 }}
        className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground"
      >
        Shareable payment links and on-chain payment requests are being reworked. We&apos;ll have this back soon.
      </motion.p>
    </div>
  );
}

function InvoicesWorkspace() {
  const wallet = useWallet();
  const [links, setLinks] = useState<PayLink[]>([]);
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [onchain, setOnchain] = useState<Onchain | null>(null);
  const [invMerchant, setInvMerchant] = useState("");
  const [invAmount, setInvAmount] = useState("");
  const [invMsg, setInvMsg] = useState<string | null>(null);
  const [invBusy, setInvBusy] = useState(false);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const [linkTouched, setLinkTouched] = useState(false);
  const [invTouched, setInvTouched] = useState(false);
  const linkAmountErr = amountError(amount);
  const invMerchantErr = addressError(invMerchant);
  const invAmountErr = amountError(invAmount);
  const [reqQuery, setReqQuery] = useState("");
  const [reqPage, setReqPage] = useState(1);

  function loadOnchain() {
    fetch("/api/onchain").then((r) => r.json()).then(setOnchain).catch(() => {});
  }

  useEffect(() => {
    loadOnchain();
  }, []);

  const filteredRequests = useMemo(() => {
    const q = reqQuery.trim().toLowerCase();
    const list = onchain?.requests ?? [];
    if (!q) return list;
    return list.filter((rq) => rq.merchant.toLowerCase().includes(q) || String(rq.id).includes(q));
  }, [onchain, reqQuery]);
  const reqTotalPages = Math.max(1, Math.ceil(filteredRequests.length / PAGE_SIZE));
  const reqPageRows = filteredRequests.slice((reqPage - 1) * PAGE_SIZE, reqPage * PAGE_SIZE);

  async function onchainAction(payload: Record<string, unknown>, okMsg: string) {
    setInvMsg(null); setInvBusy(true);
    try {
      const r = await fetch("/api/onchain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Action failed");
      setInvMsg(`${okMsg}${j.txHash ? ` ✓ ${j.txHash.slice(0, 12)}…` : " ✓"}`);
      loadOnchain();
    } catch (e) {
      setInvMsg(e instanceof Error ? e.message : "Action failed");
    } finally {
      setInvBusy(false);
    }
  }

  const JSON_HEADERS = { "content-type": "application/json" };

  // Scoped to the connected wallet on the shared demo tenant — otherwise every
  // wallet-only user's links (memo, amount, URL) would be visible to every
  // other wallet-only user.
  const refresh = useCallback(() => {
    const qs = wallet.address ? `?wallet=${wallet.address}` : "";
    fetch(`/api/links${qs}`).then((r) => r.json()).then((j) => setLinks(j.links ?? [])).catch(() => {});
  }, [wallet.address]);

  useEffect(() => { refresh(); }, [refresh]);

  async function createLink() {
    setLinkTouched(true);
    setLinkMsg(null);
    if (!isValidAmount(amount)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/links", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ amount: Number(amount), token: "USDC", description: desc, walletAddress: wallet.address }) });
      const j = await r.json();
      if (j.ok) { setAmount(""); setDesc(""); setLinkTouched(false); refresh(); }
      else setLinkMsg(j.error || "Could not create the payment link.");
    } catch {
      setLinkMsg("Couldn't reach the server. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-semibold text-foreground">Invoices</h1>
      <p className="mb-6 text-sm text-muted-foreground">Create shareable payment links and on-chain payment requests.</p>

      <Card title="Create payment link" className="mb-4">
        <div className="flex flex-wrap gap-2">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (USDC)" className="w-40" />
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" className="w-56" />
          <Button onClick={createLink} disabled={!amount || busy}>{busy ? "Creating…" : "Create link"}</Button>
        </div>
        {linkTouched && linkAmountErr && <p className="mt-2 text-xs text-danger">{linkAmountErr}</p>}
        {linkMsg && <p className="mt-2 text-xs text-danger">{linkMsg}</p>}
      </Card>

      <Card title="Your links" className="mb-4">
        {links.length === 0 ? <p className="text-sm text-muted-foreground">No links created yet.</p> : (
          <ul className="divide-y divide-border text-sm">
            {links.map((l) => (
              <li key={l.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-foreground">{l.amount} {l.token} {l.description ? `· ${l.description}` : ""}</p>
                  <a href={l.url} target="_blank" rel="noreferrer" className="text-xs text-primary-ink hover:underline">{l.url}</a>
                </div>
                <Badge tone={l.status === "paid" ? "success" : "neutral"}>{l.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {onchain?.configured && (
        <Card title="On-chain payment requests">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
            <Input value={invMerchant} onChange={(e) => setInvMerchant(e.target.value)} placeholder="0x merchant wallet" className="flex-1 text-xs" />
            <Input value={invAmount} onChange={(e) => setInvAmount(e.target.value)} placeholder="amount (USDC)" inputMode="decimal" className="w-32 text-xs" />
            <Button
              disabled={invBusy || !invMerchant || !invAmount}
              onClick={() => {
                setInvTouched(true);
                if (!isValidAddress(invMerchant) || !isValidAmount(invAmount)) return;
                onchainAction({ action: "create_request", merchant: invMerchant, amount: Number(invAmount) }, "Invoice created");
              }}
              className="text-xs"
            >
              Create invoice
            </Button>
          </div>
          {invTouched && (invMerchantErr || invAmountErr) && <p className="mb-2 text-xs text-danger">{invMerchantErr || invAmountErr}</p>}
          {invMsg && <p className="mb-2 text-xs text-muted-foreground">{invMsg}</p>}
          {onchain.requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payment requests yet.</p>
          ) : (
            <>
              {onchain.requests.length > PAGE_SIZE && (
                <div className="relative mb-3 max-w-xs">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={reqQuery}
                    onChange={(e) => { setReqQuery(e.target.value); setReqPage(1); }}
                    placeholder="Search merchant or #"
                    className="w-full pl-9"
                  />
                </div>
              )}
              {filteredRequests.length === 0 ? (
                <p className="text-sm text-muted-foreground">No requests match your search.</p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                        <tr><th className="py-1 pr-3">#</th><th className="pr-3">Merchant</th><th className="pr-3">Amount</th><th className="pr-3">Status</th><th></th></tr>
                      </thead>
                      <tbody className="text-foreground">
                        {reqPageRows.map((rq) => (
                          <tr key={rq.id} className="border-t border-border">
                            <td className="py-1.5 pr-3 text-muted-foreground">{rq.id}</td>
                            <td className="pr-3 font-mono text-xs">{short(rq.merchant)}</td>
                            <td className="pr-3">{rq.amount} USDC</td>
                            <td className="pr-3"><Badge tone={rq.paid ? "success" : "warning"}>{rq.paid ? `paid #${rq.paymentId}` : "open"}</Badge></td>
                            <td className="text-right">
                              {!rq.paid && (
                                <Button variant="secondary" disabled={invBusy} onClick={() => onchainAction({ action: "pay_request", requestId: rq.id }, `Paid invoice #${rq.id}`)} className="px-2 py-1 text-xs">
                                  Pay
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {reqTotalPages > 1 && (
                    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                      <span>Page {reqPage} of {reqTotalPages} ({filteredRequests.length} results)</span>
                      <div className="flex gap-2">
                        <button onClick={() => setReqPage((p) => Math.max(1, p - 1))} disabled={reqPage === 1} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40">Previous</button>
                        <button onClick={() => setReqPage((p) => Math.min(reqTotalPages, p + 1))} disabled={reqPage === reqTotalPages} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40">Next</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}

export default function Invoices() {
  return COMING_SOON ? <InvoicesComingSoon /> : <InvoicesWorkspace />;
}
