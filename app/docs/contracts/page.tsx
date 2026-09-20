import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsShell } from "@/components/docs/DocsShell";
import { LiveContracts } from "@/components/docs/LiveContracts";

export const metadata: Metadata = {
  title: "Contracts · PayAI Docs",
  description: "Live PayAI contract addresses on Monad and what each contract is allowed to do.",
};

const TOC = [
  { id: "live", title: "Live addresses" },
  { id: "roles", title: "Roles" },
  { id: "source", title: "Source" },
];

export default function ContractsPage() {
  return (
    <DocsShell
      kicker="Developers"
      title="Contracts."
      lede="Settlement is the contracts on Monad, not this website. Addresses below are read from the running deployment. Verify them on the explorer before you approve anything large."
      toc={TOC}
    >
      <DocsSection id="live" index="01" title="Live addresses">
        <LiveContracts />
        <p>
          Machine-readable: <a href="/api/onchain"><code>GET /api/onchain</code></a> and{" "}
          <a href="/api/automation-config"><code>GET /api/automation-config</code></a>.
        </p>
      </DocsSection>

      <DocsSection id="roles" index="02" title="What each contract does">
        <p>
          <strong>PaymentExecutor</strong> settles a payment and writes the record (recipient,
          amount, request id). It enforces replay protection and the agent's per-transaction
          and daily caps.
        </p>
        <p>
          <strong>PayAIForwarder</strong> is the interactive-payment path: your wallet pays the
          forwarder, the forwarder pays the recipient. You sign; the agent is not in this path.
        </p>
        <p>
          <strong>AutomationVault</strong> holds a Reserved Funds deposit for one automation. It
          can pay the committed recipient or refund the depositor — nowhere else.
        </p>
        <p>
          <strong>PayAITradeExecutor</strong> executes interactive trades through allowlisted
          venues. The model does not pick an arbitrary target.
        </p>
        <p>
          <strong>MerchantRegistry</strong> is the payee directory the executor can check against.
        </p>
      </DocsSection>

      <DocsSection id="source" index="03" title="Source">
        <DocsCallout tone="note" title="Application source is private">
          The application repository is private. Deployed contracts are verified on the Monad
          explorer. We will not link a GitHub 404 and call the product public. Independent
          review of the protocol: <Link href="/security">Security</Link>.
        </DocsCallout>
      </DocsSection>
    </DocsShell>
  );
}
