import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "Fees · PayAI Docs",
  description: "PayAI platform fees: 0.25% on send, automations, split payments and swaps routed through PayAI's trade executor, plus Monad gas.",
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
      lede="The platform fee is collected on-chain and added on top: every recipient receives exactly the amount you set, and the fee comes from your balance in addition. Monad gas is separate and always paid by the signer."
      toc={TOC}
    >
      <DocsSection id="today" index="01" title="What we charge today">
        <DocsTable
          headers={["Feature", "Platform fee"]}
          rows={[
            ["Send payment", "0.25%, added on top"],
            ["Wallet Automation", "0.25% per payment, added on top"],
            ["Reserved Funds", "0.25% per payment, added on top"],
            ["Swaps and trades through PayAI's trade executor", "0.25%, added on top"],
            ["Swaps and trades routed directly to a DEX", "None"],
            ["Split payment", "0.25%, added on top"],
            ["Wrap / unwrap MON", "None"],
          ]}
        />
        <p>
          <strong>On top, everywhere.</strong> Sending 100 USDC delivers exactly 100 USDC and
          costs about 100.25 USDC: PayAI hands its contract the smallest amount whose fee —{" "}
          <code>floor(amount × 25 / 10,000)</code>, rounded down — leaves exactly what you set
          for the recipient. An automation&apos;s approval or reservation is sized for each
          payment plus its fee. If your balance covers the amount but not the fee, PayAI says so
          before you sign. Automations created before this change keep the fee taken from the
          amount they were funded for.
        </p>
        <p>
          <strong>Split payments</strong>: each recipient receives exactly the amount you set,
          and the 0.25% fee is added on top of the recipients&apos;
          total — <code>fee = floor(total × 25 / 10,000)</code>, rounded down — and paid to
          PayAI&apos;s treasury in the same transaction. The fee rate and treasury are read from
          PayAI&apos;s on-chain fee configuration. The confirmation shows the platform fee and
          the total you pay before you sign. Splitting 100 USDC costs 100.25 USDC.
        </p>
        <p>
          <strong>Swaps and trades</strong> that route through PayAI&apos;s trade executor pay its
          on-chain fee — 0.25% today, read live from the contract&apos;s <code>feeBps()</code> at
          quote time — added on top: the amount you set is swapped in full and the fee is paid
          from your balance in addition. The quote you review shows it as a{" "}
          <em>PayAI fee</em> line with the total from your balance. A route the executor
          can&apos;t take (for example a direct Nad.Fun or multi-hop route) goes straight to the
          DEX and carries no PayAI fee; its quote shows no PayAI fee line. DEX pool fees and
          price impact are separate and belong to the pool.
        </p>
        <p>
          0.25% is 25 basis points. The on-chain fee cannot exceed 1.00%. Live rates for
          payments and automations: <a href="/api/fees"><code>GET /api/fees</code></a>. The swap
          and trade rate is the executor contract&apos;s own, shown in each quote.
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
