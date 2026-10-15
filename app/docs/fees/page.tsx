import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "Fees · PayAI Docs",
  description: "PayAI platform fees: 0.25% of the gross amount handled by the contract on sends, automations, split payments and swaps routed through PayAI's trade executor, plus Monad gas.",
};

const TOC = [
  { id: "today", title: "What we charge today" },
  { id: "gas", title: "Gas" },
  { id: "where", title: "Where you see it" },
];

export default function FeesPage() {
  return (
    <DocsChrome
      title="Fees"
      lede="PayAI's fee is 0.25% of the gross amount handled by the contract, rounded down, and is added on top of the amount you set. Monad gas is separate and always paid by the signer."
      toc={TOC}
    >
      <DocsSection id="today" title="What we charge today">
        <DocsTable
          headers={["Feature", "Platform fee"]}
          rows={[
            ["Send payment", "0.25% of the gross, added on top"],
            ["Wallet Automation (new)", "0.25% of the gross per payment, added on top"],
            ["Reserved Funds (new)", "0.25% of the gross per payment, added on top"],
            ["Automations created before fees moved on top", "0.25% per payment, deducted from the payment"],
            ["Swaps and trades through PayAI's trade executor", "0.25% of the gross, added on top"],
            ["Swaps and trades routed directly to a DEX", "None"],
            ["Split payment", "0.25% of the recipients' total, added on top"],
            ["Wrap / unwrap MON", "None"],
          ]}
        />
        <p>
          PayAI&apos;s fee is 0.25% of the gross amount handled by the contract, rounded down. For
          sends, swaps through PayAI&apos;s trade executor, and new automations, the fee is added on
          top so the recipient receives the amount you requested. Because the fee is calculated on
          the gross amount, the effective fee relative to the requested amount can be slightly
          higher than 0.25%. Your confirmation screen shows the exact fee and total before you sign.
        </p>
        <p>
          <strong>Example.</strong> Sending 1 USDC costs 1.002506 USDC before network gas. The
          recipient receives 1 USDC. PayAI hands the contract the smallest gross amount for which{" "}
          <code>gross − floor(gross × 25 / 10,000)</code> is exactly what you set — here 1.002506
          USDC, whose fee is 0.002506 USDC. An automation&apos;s approval or reservation is sized
          for each payment plus its fee. If your balance covers the amount but not the fee, PayAI
          says so before you sign.
        </p>
        <p>
          <strong>Existing automations.</strong> Automations created before this change retain
          their original fee behaviour: the fee is deducted from each payment, so the recipient
          receives the payment amount minus the fee.
        </p>
        <p>
          <strong>Split payments</strong>: the PayAI fee is 0.25% of the recipients&apos; total,
          rounded down, and is added on top — <code>fee = floor(total × 25 / 10,000)</code>. Each
          recipient receives exactly the amount you set, and the fee is paid to PayAI&apos;s
          treasury in the same transaction. The fee rate and treasury are read from
          PayAI&apos;s on-chain fee configuration. The confirmation shows the platform fee and
          the total you pay before you sign. Splitting 100 USDC costs 100.25 USDC.
        </p>
        <p>
          <strong>Swaps and trades</strong> that route through PayAI&apos;s trade executor pay its
          on-chain fee — 0.25% of the gross today, read live from the contract&apos;s{" "}
          <code>feeBps()</code> at quote time — added on top: the amount you set is swapped in full
          and the fee is paid from your balance in addition. The quote you review shows it as a{" "}
          <em>PayAI fee</em> line with the total from your balance. A route the executor
          can&apos;t take (for example a direct Nad.Fun or multi-hop route) goes straight to the
          DEX and carries no PayAI fee; its quote shows no PayAI fee line. DEX pool fees and
          price impact are separate and belong to the pool.
        </p>
        <p>
          0.25% is 25 basis points. The on-chain fee cannot exceed 1.00%. The authoritative rate
          is each contract&apos;s own <code>feeBps()</code>, which PayAI reads when it prepares your
          confirmation. <a href="/api/fees"><code>GET /api/fees</code></a> publishes PayAI&apos;s{" "}
          <em>configured estimates</em> used for previews — it is not read from the contracts and
          is not authoritative.
        </p>
        <DocsCallout tone="note" title="Rates can change">
          Each contract applies its current on-chain rate when your transaction executes. The
          amount you send or approve is fixed by what you sign and is never exceeded. If a rate
          changed between your confirmation and execution, the split between what the recipient
          receives and the fee could differ from the confirmation. Automations use the rate at the
          time each payment runs: the recipient still receives the payment amount, the fee follows
          the current rate, and a run that its remaining approval or reservation can&apos;t cover
          does not go through.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="gas" title="Network gas">
        <p>
          Every on-chain action — a payment, an approval, a vault deposit or refund, a swap —
          costs gas paid to Monad. That is not a PayAI fee. Failed or reverted transactions can
          still consume gas.
        </p>
      </DocsSection>

      <DocsSection id="where" title="Where you see it">
        <p>
          The confirmation screen itemizes the platform fee before you sign. Receipts show it
          after. If any screen disagrees with the contract&apos;s on-chain rate, the contract is
          what charges — please report it. See{" "}
          <Link href="/terms">Terms</Link>.
        </p>
      </DocsSection>
    </DocsChrome>
  );
}
