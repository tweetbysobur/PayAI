import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsShell } from "@/components/docs/DocsShell";

export const metadata: Metadata = {
  title: "Ask PayAI · PayAI Docs",
  description: "Describe a payment in plain English. Review the preview. Sign with your wallet.",
};

const TOC = [
  { id: "how", title: "How it works" },
  { id: "preview", title: "Preview, then sign" },
  { id: "secrets", title: "Do not paste secrets" },
];

export default function AskPage() {
  return (
    <DocsShell
      kicker="Product"
      title="Ask PayAI."
      lede="Type what you want in plain English. PayAI parses it into a structured action, shows you a preview, and waits. Nothing moves until you confirm and sign."
      toc={TOC}
    >
      <DocsSection id="how" index="01" title="How it works">
        <p>
          Examples: <code>send 10 USDC to alice.nad</code>, <code>swap 50 MON to USDC</code>,{" "}
          <code>pay the team every Friday</code>. Parsing may call an LLM provider (Anthropic).
          Deterministic facts — what PayAI is, what MON is — are answered locally.
        </p>
        <p>
          Ask PayAI does not get a blanket approval to move funds. Each action still goes through
          the same payment, swap, or automation path as the rest of the dashboard.
        </p>
      </DocsSection>

      <DocsSection id="preview" index="02" title="Preview, then sign">
        <p>
          You should see the recipient, asset, amount, and fee before a signature prompt. If the
          preview looks wrong, cancel. Typed trades go through PayAITradeExecutor with allowlisted
          venues — the model does not get arbitrary target and calldata.
        </p>
      </DocsSection>

      <DocsSection id="secrets" index="03" title="Do not paste secrets">
        <DocsCallout tone="danger" title="Ask PayAI is not a keystore">
          Do not paste seed phrases, private keys, or API secrets into the composer. The text may
          be sent to an LLM provider to parse intent. Keys belong in your wallet, never in chat.
        </DocsCallout>
        <p>
          More on the signing model: <Link href="/security">Security</Link>.
        </p>
      </DocsSection>
    </DocsShell>
  );
}
