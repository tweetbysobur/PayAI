"use client";

import { useEffect, useState } from "react";
import { MONAD_EXPLORER } from "@/lib/monad/public";
import { suiteFromOnchain, type OnchainContractFields, type SuiteEntry } from "@/lib/monad/contractSuite";

interface Tokens {
  usdc?: string | null;
  wmon?: string | null;
}

function explorerFor(address: string) {
  return `${MONAD_EXPLORER.replace(/\/$/, "")}/address/${address}`;
}

function AddressRow({ name, blurb, address, explorer }: { name: string; blurb: string; address: string; explorer: string }) {
  return (
    <tr>
      <td className="px-3 py-2.5 align-top">
        <p className="font-medium text-foreground">{name}</p>
        <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{blurb}</p>
      </td>
      <td className="px-3 py-2.5 align-top">
        <a
          href={explorer || explorerFor(address)}
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
}

function SuiteTable({ rows }: { rows: { name: string; blurb: string; address: string; explorer: string }[] }) {
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
          {rows.map((row) => (
            <AddressRow key={row.name} {...row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LiveContracts() {
  const [suite, setSuite] = useState<SuiteEntry[] | null>(null);
  const [tokens, setTokens] = useState<Tokens>({});
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/onchain").then((r) => r.json()),
      fetch("/api/automation-config").then((r) => r.json()),
    ])
      .then(([onchain, config]) => {
        if (cancelled) return;
        const fields: OnchainContractFields = {
          ...(onchain?.contracts ?? {}),
          vault: onchain?.contracts?.vault ?? config?.vault ?? null,
        };
        setSuite(suiteFromOnchain(fields, MONAD_EXPLORER));
        setTokens({
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
        Could not load live addresses. Check <a href="/api/onchain">/api/onchain</a>.
      </p>
    );
  }
  if (!suite) {
    return <p className="text-sm text-muted-foreground">Loading live contract addresses…</p>;
  }
  if (!suite.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Contract addresses are not configured on this deployment.
      </p>
    );
  }

  const tokenRows = [
    tokens.usdc ? { name: "USDC", blurb: "Stablecoin used across send, swap, and automations.", address: tokens.usdc, explorer: explorerFor(tokens.usdc) } : null,
    tokens.wmon ? { name: "WMON", blurb: "Wrapped MON. Needed for Wallet Automation of native MON.", address: tokens.wmon, explorer: explorerFor(tokens.wmon) } : null,
  ].filter((r): r is NonNullable<typeof r> => r !== null);

  return (
    <div className="space-y-6">
      <SuiteTable rows={suite} />
      {tokenRows.length > 0 ? (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Network tokens</p>
          <SuiteTable rows={tokenRows} />
        </div>
      ) : null}
    </div>
  );
}
