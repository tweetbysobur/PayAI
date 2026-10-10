"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui";
import { PageHeader, SectionHeader, StatusIndicator, EmptyState as PEmptyState } from "@/components/dashboard/primitives";
import { recipientError, isValidRecipient, addressError, isValidAddress } from "@/lib/validation";

interface OnchainMerchant { wallet: string; name: string; active: boolean; volume: number; paymentCount: number }
interface Onchain { configured: boolean; merchants: OnchainMerchant[] }

const short = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—");
const PAGE_SIZE = 10;

export default function Recipients() {
  const [onchain, setOnchain] = useState<Onchain | null>(null);
  const [newAddr, setNewAddr] = useState("");
  const [newName, setNewName] = useState("");
  const [savedLocal, setSavedLocal] = useState<{ name: string; address: string }[]>([]);
  const [merchWallet, setMerchWallet] = useState("");
  const [merchName, setMerchName] = useState("");
  const [merchMsg, setMerchMsg] = useState<string | null>(null);
  const [merchBusy, setMerchBusy] = useState(false);
  const [addrTouched, setAddrTouched] = useState(false);
  const [merchTouched, setMerchTouched] = useState(false);
  const newAddrErr = recipientError(newAddr);
  const merchWalletErr = addressError(merchWallet);
  const [merchQuery, setMerchQuery] = useState("");
  const [merchPage, setMerchPage] = useState(1);

  function loadOnchain() {
    fetch("/api/onchain").then((r) => r.json()).then(setOnchain).catch(() => {});
  }

  useEffect(() => {
    loadOnchain();
    try { const saved = localStorage.getItem("veripay_recipients"); if (saved) setSavedLocal(JSON.parse(saved)); } catch {}
  }, []);

  function addRecipient() {
    setAddrTouched(true);
    if (!newName.trim() || !isValidRecipient(newAddr)) return;
    const next = [...savedLocal, { name: newName.trim(), address: newAddr.trim() }];
    setSavedLocal(next);
    localStorage.setItem("veripay_recipients", JSON.stringify(next));
    setNewAddr(""); setNewName(""); setAddrTouched(false);
  }

  const filteredMerchants = useMemo(() => {
    const q = merchQuery.trim().toLowerCase();
    const list = onchain?.merchants ?? [];
    if (!q) return list;
    return list.filter((m) => m.wallet.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [onchain, merchQuery]);
  const merchTotalPages = Math.max(1, Math.ceil(filteredMerchants.length / PAGE_SIZE));
  const merchPageRows = filteredMerchants.slice((merchPage - 1) * PAGE_SIZE, merchPage * PAGE_SIZE);

  async function registerMerchant() {
    setMerchTouched(true);
    if (!merchName.trim() || !isValidAddress(merchWallet)) return;
    setMerchMsg(null); setMerchBusy(true);
    try {
      const r = await fetch("/api/onchain", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: merchWallet, name: merchName }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Registration failed");
      setMerchMsg(`Registered ✓ ${merchName}`);
      setMerchWallet(""); setMerchName("");
      loadOnchain();
    } catch (e) {
      setMerchMsg(e instanceof Error ? e.message : "Registration failed");
    } finally {
      setMerchBusy(false);
    }
  }

  const field = "h-10 rounded-md border border-border bg-background px-3 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring sm:text-sm";

  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <PageHeader
        title="Recipients"
        description="Addresses you've saved, so the people you pay often are easy to find. Saved in this browser."
      />

      <section aria-labelledby="saved-title">
        <SectionHeader id="saved-title" title="Saved" right={savedLocal.length > 0 ? <span className="text-xs text-muted-foreground">{savedLocal.length}</span> : undefined} />
        <div className="rounded-lg border border-border bg-panel">
          <form
            onSubmit={(e) => { e.preventDefault(); addRecipient(); }}
            className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row"
          >
            <label className="sr-only" htmlFor="recipient-name">Name</label>
            <input id="recipient-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name" className={`${field} w-full sm:w-44`} />
            <label className="sr-only" htmlFor="recipient-address">Address or .nad name</label>
            <input id="recipient-address" value={newAddr} onChange={(e) => setNewAddr(e.target.value)} placeholder="0x address or .nad name" className={`${field} w-full min-w-0 sm:flex-1`} />
            <button type="submit" disabled={!newAddr || !newName} className="h-10 shrink-0 rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-input disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Save</button>
          </form>
          {addrTouched && newAddrErr && <p className="px-4 pt-2 text-xs text-danger">{newAddrErr}</p>}
          <div className="px-4">
            {savedLocal.length === 0 ? (
              <PEmptyState compact title="No recipients yet." hint="Save an address with a name you'll recognise." />
            ) : (
              <ul className="divide-y divide-border">
                {savedLocal.map((p, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-3">
                    <span className="text-sm text-foreground">{p.name}</span>
                    <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{p.address}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="merchants-title">
        <SectionHeader id="merchants-title" title="Registered merchants" />
        <p className="-mt-1 mb-3 text-sm text-muted-foreground">Wallets registered in PayAI&apos;s onchain merchant registry on Monad.</p>
        <div className="rounded-lg border border-border bg-panel">
          <form
            onSubmit={(e) => { e.preventDefault(); registerMerchant(); }}
            className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row"
          >
            <label className="sr-only" htmlFor="merchant-name">Merchant name</label>
            <input id="merchant-name" value={merchName} onChange={(e) => setMerchName(e.target.value)} placeholder="Name" className={`${field} w-full sm:w-44`} />
            <label className="sr-only" htmlFor="merchant-wallet">Merchant wallet</label>
            <input id="merchant-wallet" value={merchWallet} onChange={(e) => setMerchWallet(e.target.value)} placeholder="0x merchant wallet" className={`${field} w-full min-w-0 sm:flex-1`} />
            <button type="submit" disabled={!merchWallet || !merchName || merchBusy} className="h-10 shrink-0 rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-input disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{merchBusy ? "Registering…" : "Register"}</button>
          </form>
          {merchTouched && merchWalletErr && <p className="px-4 pt-2 text-xs text-danger">{merchWalletErr}</p>}
          {merchMsg && <p className="px-4 pt-2 text-xs text-muted-foreground">{merchMsg}</p>}
          <div className="px-4">
            {!onchain?.configured ? (
              <PEmptyState compact title="The onchain registry isn't configured here." />
            ) : onchain.merchants.length === 0 ? (
              <PEmptyState compact title="No merchants registered yet." />
            ) : (
              <>
                {onchain.merchants.length > PAGE_SIZE && (
                  <div className="relative mt-3 max-w-xs">
                    <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={merchQuery}
                      onChange={(e) => { setMerchQuery(e.target.value); setMerchPage(1); }}
                      placeholder="Search wallet or name"
                      className="w-full pl-9"
                    />
                  </div>
                )}
                {filteredMerchants.length === 0 ? (
                  <PEmptyState compact title="No merchants match your search." />
                ) : (
                  <>
                    <ul className="divide-y divide-border">
                      {merchPageRows.map((m) => (
                        <li key={m.wallet} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
                          <div className="min-w-0">
                            <p className="text-sm text-foreground">{m.name || "—"}</p>
                            <p className="font-mono text-xs text-muted-foreground">{short(m.wallet)}</p>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span className="tabular-nums">{m.paymentCount} payment{m.paymentCount === 1 ? "" : "s"}</span>
                            <StatusIndicator tone={m.active ? "success" : "neutral"} label={m.active ? "Active" : "Inactive"} />
                          </div>
                        </li>
                      ))}
                    </ul>
                    {merchTotalPages > 1 && (
                      <div className="flex items-center justify-between border-t border-border py-3 text-xs text-muted-foreground">
                        <span>Page {merchPage} of {merchTotalPages} ({filteredMerchants.length} results)</span>
                        <div className="flex gap-2">
                          <button onClick={() => setMerchPage((p) => Math.max(1, p - 1))} disabled={merchPage === 1} className="h-8 rounded-md border border-border px-3 disabled:opacity-40">Previous</button>
                          <button onClick={() => setMerchPage((p) => Math.min(merchTotalPages, p + 1))} disabled={merchPage === merchTotalPages} className="h-8 rounded-md border border-border px-3 disabled:opacity-40">Next</button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
