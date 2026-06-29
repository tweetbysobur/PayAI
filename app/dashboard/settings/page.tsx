"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Input } from "@/components/ui";

export default function Settings() {
  const [merchant, setMerchant] = useState<{ id: string; name: string; apiKey: string; wallet?: string } | null>(null);
  const [bizName, setBizName] = useState("");
  const [signinKey, setSigninKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [signupBusy, setSignupBusy] = useState(false);

  useEffect(() => {
    try { const saved = localStorage.getItem("veripay_merchant"); if (saved) setMerchant(JSON.parse(saved)); } catch {}
  }, []);

  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (merchant?.apiKey) h["x-merchant-key"] = merchant.apiKey;
    return h;
  }, [merchant]);

  async function signup() {
    setMsg(null);
    if (!bizName.trim()) return;
    setSignupBusy(true);
    try {
      const r = await fetch("/api/merchants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: bizName }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Signup failed");
      const m = { id: j.id, name: j.name, apiKey: j.apiKey };
      localStorage.setItem("veripay_merchant", JSON.stringify(m));
      setMerchant(m); setBizName("");
      setMsg(`Account created. Save your API key: ${j.apiKey}`);
    } catch (e) { setMsg(e instanceof Error ? e.message : "Signup failed"); }
    finally { setSignupBusy(false); }
  }
  function signin() {
    if (!signinKey.trim()) return;
    const m = { id: "", name: "My workspace", apiKey: signinKey.trim() };
    localStorage.setItem("veripay_merchant", JSON.stringify(m));
    setMerchant(m); setSigninKey(""); setMsg(null);
  }
  function signout() {
    localStorage.removeItem("veripay_merchant");
    setMerchant(null); setMsg(null);
  }

  async function connectPayoutWallet() {
    if (!merchant) return;
    setMsg(null);
    const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!eth) { setMsg("No wallet found. Install MetaMask or another Monad-compatible wallet."); return; }
    setWalletBusy(true);
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const wallet = accounts[0];
      const r = await fetch("/api/merchants", { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ wallet }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Could not save wallet");
      const updated = { ...merchant, wallet: j.wallet };
      localStorage.setItem("veripay_merchant", JSON.stringify(updated));
      setMerchant(updated);
      setMsg(`Payout wallet connected: ${wallet.slice(0, 6)}…${wallet.slice(-4)}`);
    } catch (e) { setMsg(e instanceof Error ? e.message : "Could not connect wallet"); }
    finally { setWalletBusy(false); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-semibold text-foreground">Settings</h1>
      <p className="mb-6 text-sm text-muted-foreground">Workspace, API keys, and payout wallet.</p>

      <Card title="Workspace" className="mb-4">
        {merchant ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-foreground">{merchant.name}</p>
              {merchant.id && <p className="font-mono text-xs text-muted-foreground">{merchant.id}</p>}
              {merchant.wallet && <Badge tone="success">payout: {merchant.wallet.slice(0, 6)}…{merchant.wallet.slice(-4)}</Badge>}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={connectPayoutWallet} disabled={walletBusy} className="text-xs">
                {walletBusy ? "Connecting…" : merchant.wallet ? "Change payout wallet" : "Connect payout wallet"}
              </Button>
              <Button variant="ghost" onClick={signout} className="text-xs hover:text-danger">Sign out</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">You&apos;re not signed in to a workspace yet. Create an account to keep your payment links and merchants private.</p>
            <div className="flex flex-wrap gap-2">
              <Input value={bizName} onChange={(e) => setBizName(e.target.value)} placeholder="Business name" className="w-44 text-xs" />
              <Button onClick={signup} disabled={!bizName || signupBusy} className="text-xs">{signupBusy ? "Creating…" : "Create account"}</Button>
              <Input value={signinKey} onChange={(e) => setSigninKey(e.target.value)} placeholder="…or paste API key" className="w-44 text-xs" />
              <Button variant="secondary" onClick={signin} disabled={!signinKey} className="text-xs">Sign in</Button>
            </div>
          </div>
        )}
        {msg && <p className="mt-3 break-all rounded-md bg-input p-2 text-xs text-warning">{msg}</p>}
      </Card>
    </div>
  );
}
