import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

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
    <DocsChrome
      kicker="Product"
      title="Ask PayAI."
      lede="Type what you want in plain English. PayAI parses it into a structured action, shows you a preview, and waits. Nothing moves until you confirm and sign."
      toc={TOC}
    >
      <DocsSection id="how" index="01" title="How it works">
        <p>
          Examples: <code>send 10 USDC to alice.nad</code>, <code>swap 50 MON to USDC</code>,{" "}
          <code>pay the team every Friday</code>.
        </p>
        <p>
          <strong>PayAI&apos;s own engine reads every request first.</strong> Clearly written
          sends, swaps and multi-action plans — including &ldquo;each&rdquo; and
          &ldquo;then&rdquo; — are turned into a plan by PayAI&apos;s deterministic grammar, and
          balances, history, token lookups and facts about PayAI are answered the same way. None of
          that leaves PayAI.
        </p>
        <p>
          <strong>Open-ended wording uses a language model.</strong> When a request isn&apos;t in a
          form the engine can read on its own — &ldquo;twenty bucks of USDC&rdquo;, &ldquo;sell
          about a third of my MON&rdquo;, most buy/sell and scheduling requests — the text is sent
          to Anthropic&apos;s Claude model to work out the action, amount, token and recipient.
          Reading an invoice image works the same way. The model only fills in those fields: it
          can&apos;t approve, sign or pick a contract, and everything it returns goes through the
          same checks and your review. If the model is unavailable, the engine answers on its own
          or asks you to rephrase.
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
          be sent to a language model provider (Anthropic) to work out what you meant. Keys belong in your wallet, never in chat.
        </DocsCallout>
        <p>
          More on the signing model: <Link href="/security">Security</Link>.
        </p>
      </DocsSection>
    </DocsChrome>
  );
}
