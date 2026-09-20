import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "Terms · PayAI",
  description:
    "Terms of use for PayAI at usepayai.xyz: custody, fees, irreversible settlement, and limitation of liability.",
};

const TOC = [
  { id: "who", title: "Who this is" },
  { id: "as-is", title: "As-is" },
  { id: "final", title: "On-chain is final" },
  { id: "custody", title: "Custody" },
  { id: "fees", title: "Fees" },
  { id: "advice", title: "No advice" },
  { id: "compliance", title: "Your compliance" },
  { id: "liability", title: "Limitation of liability" },
];

export default function TermsPage() {
  return (
    <DocsChrome
      kicker="Terms"
      title="Terms of use."
      lede="These terms cover the PayAI product at usepayai.xyz, operated by UsePayAI. By using the app you agree to them. They are written to match how the product actually works."
      toc={TOC}
    >
      <DocsSection id="who" index="01" title="Who this is">
        <p>
          UsePayAI operates PayAI at usepayai.xyz. PayAI is not affiliated with PayAI Network,
          payai.network, or the $PAYAI token.
        </p>
      </DocsSection>

      <DocsSection id="as-is" index="02" title="Provided as-is, your responsibility">
        <p>
          PayAI is provided as-is, without warranty of any kind. You are solely responsible for
          the wallet you connect and every transaction it signs. Smart-contract execution is
          final. PayAI cannot reverse, cancel, or recover a transaction once it is broadcast to
          Monad.
        </p>
      </DocsSection>

      <DocsSection id="final" index="03" title="On-chain execution is final">
        <p>
          Settlement is governed by the contracts deployed on Monad (PaymentExecutor,
          PayAIForwarder, AutomationVault, MerchantRegistry, PayAITradeExecutor, and their current
          versions), not by this interface. Always verify the recipient, asset, amount, and fee in
          your wallet before approving.
        </p>
      </DocsSection>

      <DocsSection id="custody" index="04" title="Custody">
        <p>
          Interactive payments and trades in the web app are non-custodial: your wallet signs.
          Payment Automations use a capped on-chain agent and, for Reserved Funds, an isolated
          vault — still contract-bounded, not a PayAI hot wallet holding your balance.
        </p>
        <DocsCallout tone="warning" title="Telegram trading bot">
          The Telegram trading bot is custodial: UsePayAI generates and holds an encrypted key for
          that chat so it can sign. Use of the bot is optional and at your own risk. See{" "}
          <Link href="/docs/telegram">Telegram bot</Link>.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="fees" index="05" title="Fees">
        <p>
          PayAI currently charges a <strong>0.25% platform fee</strong> (25 basis points) on
          send-payment, Wallet Automation, and Reserved Funds executions, taken on-chain from the
          gross amount, with the remainder delivered to the recipient. Swaps currently have no
          platform fee. Monad network gas is always paid by the signer.
        </p>
        <p>
          The on-chain fee cannot exceed 1.00%. Live rates are at{" "}
          <a href="/api/fees">/api/fees</a> and shown in the confirmation screen before you sign.
          Rates can change; the rate in the confirmation you signed is the rate that applies to
          that transaction. See <Link href="/docs/fees">Fees</Link>.
        </p>
      </DocsSection>

      <DocsSection id="advice" index="06" title="No advice, no guaranteed uptime">
        <p>
          PayAI does not provide investment, legal, or tax advice, and does not guarantee uptime
          of third-party RPC providers, wallets, LLM providers, Telegram, or the Monad network
          itself.
        </p>
      </DocsSection>

      <DocsSection id="compliance" index="07" title="Your compliance">
        <p>
          You are responsible for complying with the laws that apply to you when sending,
          receiving, automating, or trading on-chain. Recipients are screened against the OFAC SDN
          digital-currency address list. That is not a licensed KYC/AML programme and does not
          make a payment legal in your jurisdiction.
        </p>
      </DocsSection>

      <DocsSection id="liability" index="08" title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, UsePayAI is not liable for lost funds, failed
          or delayed transactions, smart-contract bugs, key compromise (including of a Telegram
          bot wallet or the automation agent), RPC faults, or any indirect, incidental, or
          consequential damages. On-chain transfers are irreversible.
        </p>
        <p>
          Questions: <a href="mailto:support@usepayai.xyz">support@usepayai.xyz</a>. See also{" "}
          <Link href="/privacy">Privacy</Link> and <Link href="/security">Security</Link>.
        </p>
      </DocsSection>
    </DocsChrome>
  );
}
