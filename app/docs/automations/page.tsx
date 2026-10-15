import type { Metadata } from "next";
import Link from "next/link";
import { DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "Automations · PayAI Docs",
  description: "Wallet Automation vs Reserved Funds: how recurring PayAI payments are funded and bounded.",
};

const TOC = [
  { id: "why", title: "Why two modes" },
  { id: "wallet", title: "Wallet Automation" },
  { id: "reserved", title: "Reserved Funds" },
  { id: "runs", title: "Runs" },
  { id: "limits", title: "On-chain limits" },
];

export default function AutomationsPage() {
  return (
    <DocsChrome
      title="Automations"
      lede="Recurring payments cannot wait for you to click Approve every Friday. PayAI uses a dedicated agent wallet for those runs, bounded on-chain. You choose how each automation is funded."
      toc={TOC}
    >
      <DocsSection id="why" title="Why two modes">
        <DocsTable
          headers={["", "Wallet Automation", "Reserved Funds"]}
          rows={[
            ["Where funds sit", "Your wallet, until each run", "AutomationVault, from deposit"],
            ["Guarantee", "Run fails if balance/allowance is short", "Run can pay as long as the reservation covers it"],
            ["Who can receive", "The recipients you set", "Only the committed recipient, or a refund to you"],
            ["How to stop", "Cancel, and revoke the token approval", "Cancel — unspent reservation refunds"],
          ]}
        />
        <p>
          Neither mode puts your balance on a PayAI server. The agent can only spend within the
          caps PaymentExecutor enforces. See <Link href="/security">Security</Link>.
        </p>
      </DocsSection>

      <DocsSection id="wallet" title="Wallet Automation">
        <p>
          You approve PaymentExecutor to pull an ERC-20 from your wallet, up to a limit. Each
          scheduled run pulls exactly what is due. Native MON uses WMON — you wrap, then approve.
        </p>
        <p>
          If another active automation shares that token approval, cancelling one will not
          silently revoke it. You can revoke from the app, your wallet, or the explorer.
        </p>
      </DocsSection>

      <DocsSection id="reserved" title="Reserved Funds">
        <p>
          You deposit the budget into AutomationVault for that automation. The vault can only pay
          the recipient you committed to, or refund you. A later balance change in your wallet
          cannot starve the run.
        </p>
      </DocsSection>

      <DocsSection id="runs" title="Runs">
        <p>
          Execute Now runs the next payment immediately. Skip advances past the next occurrence
          without sending. Cancel stops future runs. Those actions still require a signed
          confirmation somewhere in that automation history — PayAI does not invent a
          payment you never authorized.
        </p>
      </DocsSection>

      <DocsSection id="limits" title="On-chain limits">
        <p>
          PaymentExecutor enforces a per-transaction cap and a rolling daily cap, separately for
          stablecoins and native MON. Every payment carries a unique request id. These limits
          hold even if the application layer were compromised.
        </p>
      </DocsSection>
    </DocsChrome>
  );
}
