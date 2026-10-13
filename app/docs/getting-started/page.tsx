import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "Getting started · PayAI Docs",
  description: "Connect a wallet on Monad and send your first PayAI payment.",
};

const TOC = [
  { id: "connect", title: "Connect" },
  { id: "network", title: "Network" },
  { id: "first", title: "First payment" },
  { id: "next", title: "What next" },
];

export default function GettingStartedPage() {
  return (
    <DocsChrome
      kicker="Product"
      title="Getting started."
      lede="PayAI runs on Monad mainnet. You need a wallet that can sign on Monad, a little MON for gas, and a recipient — an 0x address or a .nad name."
      toc={TOC}
    >
      <DocsSection id="connect" index="01" title="Connect a wallet">
        <p>
          Open <Link href="/auth">Launch PayAI</Link>. You can create a PayAI Wallet with a
          passkey (the key is derived on your device), or connect an external wallet you already
          use.
        </p>
        <p>
          There is no KYC step to send a payment. Terms and Privacy have to be accepted on first
          launch.
        </p>
      </DocsSection>

      <DocsSection id="network" index="02" title="You are on Monad">
        <p>
          Chain ID <code>143</code>. Every payment, swap, and automation settles as a real Monad
          transaction. If your external wallet is on another network, switch it — PayAI will not
          silently send on Ethereum or anywhere else.
        </p>
      </DocsSection>

      <DocsSection id="first" index="03" title="Send the first payment">
        <p>
          From the dashboard, open Payments — or type it in{" "}
          <Link href="/docs/ask">Ask PayAI</Link>, for example{" "}
          <code>send 10 USDC to alice.nad</code>. You will see the recipient, asset, amount, and
          fee before anything is signed. Confirm in your wallet. Then check the transaction hash
          on the explorer.
        </p>
        <DocsCallout tone="note" title="Irreversible">
          A confirmed on-chain payment cannot be undone by PayAI or anyone else. Check the
          address or .nad name before you approve.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="next" index="04" title="What next">
        <ul>
          <li><Link href="/docs/payments">Payments</Link> — tokens, .nad names, bulk.</li>
          <li><Link href="/docs/automations">Automations</Link> — payroll, rent, recurring.</li>
          <li><Link href="/docs/fees">Fees</Link> — what 0.25% actually means.</li>
          <li><Link href="/security">Security</Link> — keys and automations.</li>
        </ul>
      </DocsSection>
    </DocsChrome>
  );
}
