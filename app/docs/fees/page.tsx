import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "Fees · PayAI Docs",
  description: "PayAI platform fees: 0.25% on send, automations and split payments, 0% on swaps, plus Monad gas.",
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
      lede="The platform fee is collected on-chain. For a send or automation it comes out of the gross amount; for a split it is added on top, so every recipient receives exactly what you set. Monad gas is separate and always paid by the signer."
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
            ["Split payment", "0.25%, added on top"],
            ["Wrap / unwrap MON", "None"],
          ]}
        />
        <p>
          <strong>Split payments</strong> work differently from a send: each recipient receives
          exactly the amount you set, and the 0.25% fee is added on top of the recipients&apos;
          total — <code>fee = floor(total × 25 / 10,000)</code>, rounded down — and paid to
          PayAI&apos;s treasury in the same transaction. The fee rate and treasury are read from
          PayAI&apos;s on-chain fee configuration. The confirmation shows the platform fee and
          the total you pay before you sign. Splitting 100 USDC costs 100.25 USDC.
        </p>
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
