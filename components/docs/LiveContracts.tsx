"use client";

import { useEffect, useState } from "react";
import { MONAD_EXPLORER } from "@/lib/monad/public";

interface Live {
  executor?: string | null;
  executorExplorer?: string | null;
  forwarder?: string | null;
  forwarderExplorer?: string | null;
  tradeExecutor?: string | null;
  tradeExecutorExplorer?: string | null;
  vault?: string | null;
  usdc?: string | null;
  wmon?: string | null;
}

function explorerFor(address: string, explicit?: string | null) {
  return explicit || `${MONAD_EXPLORER.replace(/\/$/, "")}/address/${address}`;
}

const ROWS: { key: keyof Live; label: string; blurb: string }[] = [
  { key: "executor", label: "PaymentExecutor", blurb: "Settles payments, records them, enforces agent caps and request ids." },
  { key: "forwarder", label: "PayAIForwarder", blurb: "Interactive payments: payer → forwarder → recipient." },
  { key: "vault", label: "AutomationVault", blurb: "Reserved Funds. Pays the committed recipient or refunds you." },
  { key: "tradeExecutor", label: "PayAITradeExecutor", blurb: "Typed interactive trades through allowlisted venues." },
  { key: "usdc", label: "USDC", blurb: "Stablecoin used across send, swap, and automations." },
  { key: "wmon", label: "WMON", blurb: "Wrapped MON. Needed for Wallet Automation of native MON." },
];

export function LiveContracts() {
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/onchain").then((r) => r.json()),
      fetch("/api/automation-config").then((r) => r.json()),
    ])
      .then(([onchain, config]) => {
        if (cancelled) return;
        setLive({
          executor: onchain?.contracts?.paymentExecutor ?? config?.executor ?? null,
          executorExplorer: onchain?.contracts?.executorExplorer ?? null,
          forwarder: onchain?.contracts?.forwarder ?? null,
          forwarderExplorer: onchain?.contracts?.forwarderExplorer ?? null,
          tradeExecutor: onchain?.contracts?.tradeExecutor ?? null,
          tradeExecutorExplorer: onchain?.contracts?.tradeExecutorExplorer ?? null,
          vault: config?.vault ?? null,
          usdc: config?.usdc?.address ?? null,
          wmon: config?.wmon ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load live addresses. Check <a href="/api/onchain">/api/onchain</a> and{" "}
        <a href="/api/automation-config">/api/automation-config</a>.
      </p>
    );
  }
  if (!live) {
    return <p className="text-sm text-muted-foreground">Loading live contract addresses…</p>;
  }

  const shown = ROWS.filter((row) => live[row.key]);

  if (!shown.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Contract addresses are not configured on this deployment.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[32rem] text-left text-[13px]">
        <thead className="border-b border-border bg-panel/60 text-[11px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Contract</th>
            <th className="px-3 py-2 font-medium">Address</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/80">
          {shown.map((row) => {
            const address = String(live[row.key]);
            const href =
              row.key === "executor" ? explorerFor(address, live.executorExplorer)
              : row.key === "forwarder" ? explorerFor(address, live.forwarderExplorer)
              : row.key === "tradeExecutor" ? explorerFor(address, live.tradeExecutorExplorer)
              : explorerFor(address);
            return (
              <tr key={row.key}>
                <td className="px-3 py-2.5 align-top">
                  <p className="font-medium text-foreground">{row.label}</p>
                  <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{row.blurb}</p>
                </td>
                <td className="px-3 py-2.5 align-top">
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    title={address}
                    className="break-all font-mono text-[12px] text-primary-ink hover:underline"
                  >
                    {address}
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
