import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "PayAI SDK · PayAI Docs",
  description: "The protocol actions Ask PayAI can run on Monad, how each one is checked before you sign, and what the SDK is not.",
};

const TOC = [
  { id: "what", title: "What it is" },
  { id: "actions", title: "Available actions" },
  { id: "flow", title: "How an action runs" },
  { id: "safety", title: "Safety rules" },
  { id: "contracts", title: "Contracts involved" },
  { id: "fees", title: "Fees" },
  { id: "limits", title: "Limits" },
];

const explorer = (address: string, key: string) => (
  <a key={key} href={`https://monadexplorer.com/address/${address}`} target="_blank" rel="noreferrer" className="font-mono text-[12px]">
    {address}
  </a>
);

export default function SdkPage() {
  return (
    <DocsChrome
      kicker="Developers"
      title="PayAI SDK."
      lede="The layer that lets Ask PayAI run specific on-chain protocol actions — wrapping MON and splitting a payment — with every transaction checked before your wallet sees it."
      toc={TOC}
    >
      <DocsSection id="what" index="01" title="What it is">
        <p>
          The PayAI SDK is the protocol-action layer inside PayAI. Each supported protocol
          declares a small set of actions, and each action can only build transactions to the
          contracts it was reviewed for. <Link href="/docs/ask">Ask PayAI</Link> uses it when you
          ask for one of the actions below.
        </p>
        <DocsCallout tone="note" title="Not a published package">
          The SDK runs inside PayAI. There is no package to install and no way for another
          project to register a protocol with it yet. This page describes what it does for you
          as a PayAI user, and what it checks — not a library you can build against.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="actions" index="02" title="Available actions">
        <DocsTable
          headers={["Action", "What it does", "Try in Ask PayAI"]}
          rows={[
            ["Wrap MON", "Wrap native MON into WMON, 1:1.", <code key="w">wrap 1 MON</code>],
            ["Unwrap WMON", "Unwrap WMON back into native MON, 1:1.", <code key="u">unwrap 1 WMON</code>],
            [
              "Split payment",
              "Send MON or USDC to 2–3 addresses in one transaction.",
              <code key="s">split 3 MON between 0x… and 0x…</code>,
            ],
          ]}
        />
        <p>
          These actions run on Monad mainnet. An action that isn&apos;t available on the
          network a deployment runs on is never offered there.
        </p>
        <p>
          A split divides the total evenly between the addresses you write out. If it
          doesn&apos;t divide exactly in the token&apos;s smallest unit, the last address receives
          the few extra units, so the recipients always add up to exactly the total.
        </p>
      </DocsSection>

      <DocsSection id="flow" index="03" title="How an action runs">
        <ol>
          <li>
            <strong>Recognised by fixed rules, not guessed.</strong> Protocol actions are matched
            by exact patterns in your message. The AI model is never allowed to choose a
            protocol, an action, or a contract.
          </li>
          <li>
            <strong>Preview.</strong> You see what will happen — amounts and recipients —
            before anything is built. Nothing is signed or sent.
          </li>
          <li>
            <strong>Build and check.</strong> When you confirm, PayAI builds the transaction and
            checks it: the exact action version you previewed, every input, and every contract
            it touches. One failed check stops the whole action.
          </li>
          <li>
            <strong>You sign.</strong> Your own wallet signs and sends. For a token that needs an
            approval first, you sign that approval as a separate step.
          </li>
          <li>
            <strong>Confirmed on-chain.</strong> The result you see is read from the confirmed
            transaction on Monad, not from the preview.
          </li>
        </ol>
      </DocsSection>

      <DocsSection id="safety" index="04" title="Safety rules">
        <ul>
          <li>
            <strong>Allowlisted contracts only.</strong> Each action may only send transactions
            to the contracts listed below. A transaction to anything else is refused before it
            reaches your wallet.
          </li>
          <li>
            <strong>Exact approvals.</strong> When a token approval is needed, it is for the
            exact amount of this action, to the one contract that will use it. Never unlimited.
          </li>
          <li>
            <strong>No silent upgrades.</strong> The action version you previewed is the one
            that runs. If it changed in between, the action is refused, not swapped.
          </li>
          <li>
            <strong>Your wallet signs.</strong> These actions are signed by your own wallet.
            PayAI does not hold the key for them. See <Link href="/security">Security</Link> for
            the paths that are custodial.
          </li>
        </ul>
      </DocsSection>

      <DocsSection id="contracts" index="05" title="Contracts involved">
        <DocsTable
          headers={["Action", "Contract", "Operated by"]}
          rows={[
            ["Wrap / unwrap", explorer("0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", "wmon"), "WMON (wrapped MON) token"],
            ["Split payment", explorer("0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F", "split"), "PayAI (SplitSettlement)"],
          ]}
        />
        <p>
          The full list of PayAI&apos;s own contracts is on <Link href="/docs/contracts">Contracts</Link>.
        </p>
      </DocsSection>

      <DocsSection id="fees" index="06" title="Fees">
        <p>
          PayAI adds no platform fee to SDK actions. You pay Monad gas for each transaction you
          sign, including any approval. See <Link href="/docs/fees">Fees</Link>.
        </p>
      </DocsSection>

      <DocsSection id="limits" index="07" title="Limits">
        <ul>
          <li>Split payments take 2–3 recipients, each written as a full 0x address.</li>
          <li>From Ask PayAI, splits accept MON or USDC.</li>
          <li>There is no public HTTP API or package for these actions.</li>
          <li>Other projects can&apos;t add their own protocols yet.</li>
        </ul>
      </DocsSection>
    </DocsChrome>
  );
}
