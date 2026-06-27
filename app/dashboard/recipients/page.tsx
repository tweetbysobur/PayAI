"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
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

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-2xl font-semibold text-foreground">Recipients</h1>
      <p className="mb-6 text-sm text-muted-foreground">Saved contacts and registered merchants on-chain.</p>

      <Card title="Add recipient" className="mb-4">
        <div className="flex flex-wrap gap-2">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Label (e.g. Alice)" className="w-40" />
          <Input value={newAddr} onChange={(e) => setNewAddr(e.target.value)} placeholder="0x… or alice.nads" className="w-56" />
          <Button onClick={addRecipient} disabled={!newAddr || !newName}>Save</Button>
        </div>
        {addrTouched && newAddrErr && <p className="mt-2 text-xs text-danger">{newAddrErr}</p>}
      </Card>

      <Card title="Saved recipients" className="mb-4">
        {savedLocal.length === 0 ? <p className="text-sm text-muted-foreground">No saved recipients yet.</p> : (
          <ul className="divide-y divide-border text-sm">
            {savedLocal.map((p, i) => (
              <li key={i} className="flex items-center justify-between py-2">
                <span className="text-foreground">{p.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{p.address}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Register merchant" className="mb-4">
        <div className="flex flex-wrap gap-2">
          <Input value={merchWallet} onChange={(e) => setMerchWallet(e.target.value)} placeholder="0x merchant wallet" className="w-56" />
          <Input value={merchName} onChange={(e) => setMerchName(e.target.value)} placeholder="name" className="w-32" />
          <Button onClick={registerMerchant} disabled={!merchWallet || !merchName || merchBusy}>{merchBusy ? "Registering…" : "Register"}</Button>
        </div>
        {merchTouched && merchWalletErr && <p className="mt-2 text-xs text-danger">{merchWalletErr}</p>}
        {merchMsg && <p className="mt-2 text-xs text-muted-foreground">{merchMsg}</p>}
      </Card>

      <Card title="Registered on-chain merchants">
        {!onchain?.configured ? (
          <p className="text-sm text-muted-foreground">On-chain registry not configured.</p>
        ) : onchain.merchants.length === 0 ? (
          <p className="text-sm text-muted-foreground">No merchants registered yet.</p>
        ) : (
          <>
            {onchain.merchants.length > PAGE_SIZE && (
              <div className="relative mb-3 max-w-xs">
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
              <p className="text-sm text-muted-foreground">No merchants match your search.</p>
            ) : (
              <>
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                    <tr><th className="py-1.5 pr-3">Wallet</th><th className="pr-3">Name</th><th className="pr-3">Status</th><th className="pr-3">Volume</th><th>Payments</th></tr>
                  </thead>
                  <tbody className="text-foreground">
                    {merchPageRows.map((m) => (
                      <tr key={m.wallet} className="border-t border-border">
                        <td className="py-1.5 pr-3 font-mono text-xs">{short(m.wallet)}</td>
                        <td className="pr-3">{m.name || "—"}</td>
                        <td className="pr-3"><Badge tone={m.active ? "success" : "neutral"}>{m.active ? "Active" : "Inactive"}</Badge></td>
                        <td className="pr-3">{m.volume}</td>
                        <td>{m.paymentCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {merchTotalPages > 1 && (
                  <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                    <span>Page {merchPage} of {merchTotalPages} ({filteredMerchants.length} results)</span>
                    <div className="flex gap-2">
                      <button onClick={() => setMerchPage((p) => Math.max(1, p - 1))} disabled={merchPage === 1} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40">Previous</button>
                      <button onClick={() => setMerchPage((p) => Math.min(merchTotalPages, p + 1))} disabled={merchPage === merchTotalPages} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40">Next</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
