import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsShell } from "@/components/docs/DocsShell";

export const metadata: Metadata = {
  title: "Privacy · PayAI",
  description:
    "What UsePayAI collects, what stays on-chain, how analytics and Ask PayAI work, and the custodial Telegram exception.",
};

const TOC = [
  { id: "who", title: "Who we are" },
  { id: "custody", title: "Custody" },
  { id: "onchain", title: "On-chain data" },
  { id: "offchain", title: "What we store" },
  { id: "analytics", title: "Analytics" },
  { id: "ai", title: "Ask PayAI" },
  { id: "contact", title: "Contact" },
];

export default function PrivacyPage() {
  return (
    <DocsShell
      kicker="Privacy"
      title="What we collect, and what we never see."
      lede="UsePayAI operates PayAI at usepayai.xyz. This policy covers the web app, the optional Telegram trading bot, and related services. It is written to match the product, not a template."
      toc={TOC}
    >
      <DocsSection id="who" index="01" title="Who we are">
        <p>
          UsePayAI operates the PayAI product at usepayai.xyz. We are not affiliated with PayAI
          Network, payai.network, or the $PAYAI token.
        </p>
        <p>
          Questions: <a href="mailto:privacy@usepayai.xyz">privacy@usepayai.xyz</a>.
        </p>
      </DocsSection>

      <DocsSection id="custody" index="02" title="Custody">
        <p>
          In the browser app, PayAI is an interface to smart contracts on Monad. We never take the
          seed phrase of an embedded (passkey) or external wallet. Every interactive payment is
          signed by your own wallet.
        </p>
        <p>
          Payment Automations are the first exception: a dedicated agent wallet, capped on-chain,
          settles runs you already authorized. Reserved Funds sit in AutomationVault on-chain, not
          on our servers.
        </p>
        <DocsCallout tone="warning" title="Telegram bot is custodial">
          If you use the PayAI Telegram trading bot, we generate a hot wallet for that Telegram
          user and store the private key encrypted at rest so the bot can sign trades and
          withdrawals from chat. That is custody. Do not deposit more than you are willing to
          trust to a bot. You can withdraw to your own address at any time.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="onchain" index="03" title="On-chain data is public">
        <p>
          Wallet addresses, transaction amounts, and payment status are public on-chain data,
          visible to anyone via the Monad block explorer, independent of this app. We cannot make
          a confirmed transaction private.
        </p>
      </DocsSection>

      <DocsSection id="offchain" index="04" title="What we store off-chain">
        <p>If you create an account or merchant workspace, we store what is needed to run the product:</p>
        <ul>
          <li>Session cookie</li>
          <li>Workspace name and merchant API key (shown once)</li>
          <li>Automations, activity, and support tickets</li>
          <li>For the Telegram bot, an encrypted wallet key</li>
        </ul>
        <p>
          We do not sell this data. Persistence uses a hosted Redis when configured. We do not
          run ads against your payment history.
        </p>
      </DocsSection>

      <DocsSection id="analytics" index="05" title="Analytics">
        <p>
          Marketing pages may load Google Analytics when a measurement ID is configured, so we can
          see whether the public site is used. Dashboard routes do not load that script.
        </p>
        <p>
          The dashboard still reads balances and history from Monad RPC and PayAI contracts —
          that is product data, not an ad pixel.
        </p>
      </DocsSection>

      <DocsSection id="ai" index="06" title="Ask PayAI">
        <p>
          If you type a natural-language instruction, the text may be sent to an LLM provider
          (Anthropic) to parse intent. Do not paste secrets, seed phrases, or private keys into
          Ask PayAI. See <Link href="/docs/ask">Ask PayAI</Link>.
        </p>
      </DocsSection>

      <DocsSection id="contact" index="07" title="Contact">
        <p>
          Privacy questions: <a href="mailto:privacy@usepayai.xyz">privacy@usepayai.xyz</a>. Also
          see <Link href="/terms">Terms</Link> and <Link href="/security">Security</Link>.
        </p>
      </DocsSection>
    </DocsShell>
  );
}
