import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "Fees · PayAI Docs",
  description: "PayAI platform fees: 0.25% on send and automations, 0% on swaps, plus Monad gas.",
};

const TOC = [
  { id: "today", title: "What we charge today" },
  { id: "gas", title: "Gas" },
  { id: "where", title: "Where you see it" },
];

export default function FeesPage() {
  return (
    <DocsChrome
      kicker="Product"
      title="Fees."
      lede="The platform fee is taken on-chain from the gross amount. The recipient receives the remainder. Monad gas is separate and always paid by the signer."
      toc={TOC}
    >
      <DocsSection id="today" index="01" title="What we charge today">
        <DocsTable
          headers={["Feature", "Platform fee"]}
          rows={[
            ["Send payment", "0.25%"],
            ["Wallet Automation", "0.25%"],
            ["Reserved Funds", "0.25%"],
            ["Swaps", "None"],
          ]}
        />
        <p>
          0.25% is 25 basis points. The on-chain fee cannot exceed 1.00%. Live rates for this
          deployment: <a href="/api/fees"><code>GET /api/fees</code></a>.
        </p>
        <DocsCallout tone="note" title="Rates can change">
          The rate shown in the confirmation you signed is the rate that applies to that
          transaction. It will not be a silent extra deduction after the fact.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="gas" index="02" title="Network gas">
        <p>
          Every on-chain action — a payment, an approval, a vault deposit or refund, a swap —
          costs gas paid to Monad. That is not a PayAI fee. Failed or reverted transactions can
          still consume gas.
        </p>
      </DocsSection>

      <DocsSection id="where" index="03" title="Where you see it">
        <p>
          The confirmation screen itemizes the platform fee before you sign. Receipts show it
          after. If a screen still said “free during beta” while <code>/api/fees</code> did not,
          that was a bug — the live rate is the API, not the marketing copy. See{" "}
          <Link href="/terms">Terms</Link>.
        </p>
      </DocsSection>
    </DocsChrome>
  );
}
