import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "Payments · PayAI Docs",
  description: "Send MON or any Monad token from PayAI, including to .nad names.",
};

const TOC = [
  { id: "what", title: "What a payment is" },
  { id: "tokens", title: "Tokens" },
  { id: "names", title: ".nad names" },
  { id: "bulk", title: "Bulk" },
  { id: "record", title: "On-chain record" },
];

export default function PaymentsPage() {
  return (
    <DocsChrome
      kicker="Product"
      title="Payments."
      lede="A PayAI payment is a Monad transaction your wallet signs. The interface checks the recipient, amount, and fee, then your wallet decides."
      toc={TOC}
    >
      <DocsSection id="what" index="01" title="What a payment is">
        <p>
          Interactive payments route payer → PayAIForwarder → recipient. You sign. PayAI does not
          hold the funds in between. A platform fee is taken on-chain from the gross amount when
          the feature charges one — see <Link href="/docs/fees">Fees</Link>.
        </p>
        <DocsCallout tone="danger" title="Final">
          Once the transaction confirms, it cannot be reversed. Wrong address is a lost payment.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="tokens" index="02" title="Tokens">
        <p>
          MON (native) and a curated set of verified mainnet tokens — including USDC — work out of
          the box. Any other Monad ERC-20 works if you paste its contract address. PayAI reads
          decimals and symbol on-chain; it does not guess them.
        </p>
      </DocsSection>

      <DocsSection id="names" index="03" title=".nad names">
        <p>
          You can send to a Nad Name Service name instead of a 42-character address. The name is
          resolved on-chain before you sign. Confirm the resolved address in the preview — a name
          can be updated by its owner later, but the payment goes to whatever it resolved to at
          send time.
        </p>
      </DocsSection>

      <DocsSection id="bulk" index="04" title="Bulk">
        <p>
          Bulk payments are an automation: many recipients, one approval. Paste addresses, upload
          a CSV, or add them one by one. Excel files are not accepted — export as CSV first.
        </p>
        <DocsTable
          headers={["Column", "Required"]}
          rows={[
            ["address (or wallet / recipient)", "Yes"],
            ["amount", "If you are not splitting equally / by %"],
            ["percentage", "If splitting by share"],
            ["note", "No"],
          ]}
        />
      </DocsSection>

      <DocsSection id="record" index="05" title="On-chain record">
        <p>
          PaymentExecutor writes recipient, amount, and a request id so the same payment cannot
          settle twice. You can look up the hash on the Monad explorer from Activity. Live
          contract addresses: <Link href="/docs/contracts">Contracts</Link>.
        </p>
      </DocsSection>
    </DocsChrome>
  );
}
