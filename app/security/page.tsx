import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";
import { LiveContracts } from "@/components/docs/LiveContracts";

export const metadata: Metadata = {
  title: "Security · PayAI",
  description:
    "How PayAI handles keys, custody, on-chain limits, independent review, and the two exceptions to the non-custodial model.",
};

const TOC = [
  { id: "model", title: "The model" },
  { id: "exceptions", title: "Two exceptions" },
  { id: "safeguards", title: "Safeguards" },
  { id: "review", title: "Independent review" },
  { id: "contracts", title: "Live contracts" },
  { id: "browser", title: "Browser security" },
  { id: "never", title: "What PayAI never does" },
  { id: "report", title: "Report a vulnerability" },
];

export default function SecurityPage() {
  return (
    <DocsChrome
      title="How PayAI keeps funds and keys honest"
      lede="PayAI, operated by UsePayAI at usepayai.xyz, is non-custodial for interactive payments and trades: you hold the keys, you approve the transaction, and settlement is a real Monad transaction anyone can look up. This page is the model — including the two places it is not that simple."
      toc={TOC}
    >
      <DocsSection id="model" title="The model">
        <p>
          You connect a wallet you control. For interactive payments and trades, PayAI proposes a
          transaction; your wallet signs it; Monad settles it. PayAI never asks for a seed phrase.
          An embedded PayAI Wallet is derived on-device from your passkey. An external wallet
          (MetaMask and the rest) signs the same way it always has.
        </p>
        <p>
          <strong>Rooms</strong> are shared costs split into equal shares. Each share is a direct
          transfer from the person paying to the room&apos;s recipient — PayAI never holds the
          money, and there is no escrow.
        </p>
        <p>
          Every settled payment has a transaction hash. There is no simulated “success” on mainnet.
          If it did not land on Monad, it did not happen.
        </p>
      </DocsSection>

      <DocsSection id="exceptions" title="Two exceptions">
        <p>
          Two paths cannot wait for you to click Approve. We do not pretend they are the same as
          the rest of the app.
        </p>
        <p>
          <strong>Payment Automations.</strong> Because you are not there to sign each run, they
          settle through a dedicated agent wallet bounded by per-transaction and daily limits
          enforced on-chain in PaymentExecutor — not just in application code. Wallet Automation
          pulls from an ERC-20 allowance you approved. Reserved Funds sit in AutomationVault, which
          can only pay the committed recipient or refund you. See{" "}
          <Link href="/docs/automations">Automations</Link>.
        </p>
        <p>
          <strong>Telegram trading bot.</strong> If you use the bot, PayAI generates a hot wallet
          for that chat and stores the key encrypted at rest so trades can sign from Telegram.
          That path is custodial. Do not send it more than you are willing to trust to a bot.
          Withdraw anytime with <code>/withdraw</code>.
        </p>
        <DocsCallout tone="warning" title="Different product, different trust">
          The browser app and the Telegram bot are not the same custody model. Interactive PayAI
          never holds the key to your passkey or extension wallet. The bot does hold a key, by
          design, so it can sign in chat.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="safeguards" title="Safeguards">
        <ul>
          <li><strong>Your signature</strong> — interactive payments cannot move without it.</li>
          <li><strong>Plan review</strong> — Ask PayAI shows the whole plan, every action, amount and recipient in order, before anything is prepared for signing. A multi-step plan quotes each step only after the one before it has confirmed, and a step that may already have been sent is never sent again automatically.</li>
          <li><strong>Wallet-bound approvals</strong> — PayAI prepares and confirms a payment only for a wallet the browser has proven it controls, not for an address someone merely types in.</li>
          <li><strong>Replay protection</strong> — each payment carries a request id the contract marks as used, so a retry cannot settle twice.</li>
          <li><strong>On-chain spend caps</strong> — per-transaction and daily limits for the agent path are enforced by PaymentExecutor.</li>
          <li><strong>Sanctions screening</strong> — recipients are checked against the OFAC SDN digital-currency address list. This is address screening, not a licensed KYC/AML programme.</li>
          <li><strong>Typed trades</strong> — interactive swaps go through PayAITradeExecutor with allowlisted venues, not arbitrary calldata from the model.</li>
        </ul>
      </DocsSection>

      <DocsSection id="review" title="Independent review">
        <p>
          In August 2026 the PayAI contracts completed the DeltaV × Ultrafuzz protocol security
          program. That review found no critical vulnerability that could drain user funds.
          Medium and low findings — fee-on-transfer accounting, a sender-surcharge vault gap,
          native request lifecycle, and registrar privilege — were patched and redeployed.
        </p>
        <p>
          Ultrafuzz is an independent protocol review, not a full commercial audit of the
          application. A formal third-party audit remains on the roadmap.
        </p>
      </DocsSection>

      <DocsSection id="contracts" title="Live contracts">
        <p>
          Deployed PayAI contracts are verified on the Monad explorer, so you can check every live
          contract and every transaction yourself. Addresses are read live from this deployment,
          not copied from a screenshot.
        </p>
        <LiveContracts />
        <p>
          Full context: <Link href="/docs/contracts">Contracts</Link>.
        </p>
      </DocsSection>

      <DocsSection id="browser" title="Browser security">
        <p>
          Every response sets <code>frame-ancestors none</code>, HSTS, and a Content-Security-Policy
          that pins <code>connect-src</code> to this origin and the Monad RPCs so injected script
          cannot exfiltrate a key over <code>fetch</code>. Two honest limits: Next.js still
          requires <code>script-src unsafe-inline</code> (no nonce middleware yet), and
          token logos load from arbitrary HTTPS URLs. The embedded wallet keeps a live key in the
          page — XSS containment matters more here than on a brochure site.
        </p>
      </DocsSection>

      <DocsSection id="never" title="What PayAI never does">
        <ul>
          <li>Ask for your seed phrase</li>
          <li>Move interactive funds without your signature</li>
          <li>Let the automation agent exceed the on-chain caps you authorized</li>
          <li>Sell your payment history</li>
        </ul>
      </DocsSection>

      <DocsSection id="report" title="Report a vulnerability">
        <p>
          If you find a security issue, email{" "}
          <a href="mailto:security@usepayai.xyz">security@usepayai.xyz</a> with details and steps
          to reproduce. Do not open a public issue for anything exploitable. We aim to acknowledge
          within 48 hours.
        </p>
        <p>
          Product questions go to{" "}
          <Link href="/dashboard/help?tab=support">in-app support</Link> or{" "}
          <a href="mailto:support@usepayai.xyz">support@usepayai.xyz</a>.
        </p>
      </DocsSection>
    </DocsChrome>
  );
}
