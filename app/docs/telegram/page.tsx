import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsShell, DocsTable } from "@/components/docs/DocsShell";

export const metadata: Metadata = {
  title: "Telegram bot · PayAI Docs",
  description: "The PayAI Telegram trading bot is custodial. Commands, withdrawal, and what it is not.",
};

const TOC = [
  { id: "custody", title: "Custody" },
  { id: "commands", title: "Commands" },
  { id: "not", title: "What it is not" },
];

export default function TelegramPage() {
  return (
    <DocsShell
      kicker="Developers"
      title="Telegram trading bot."
      lede="An optional bot that can trade on Monad from chat. It is a different trust model from the web app. Read this before you send it funds."
      toc={TOC}
    >
      <DocsSection id="custody" index="01" title="This path is custodial">
        <DocsCallout tone="danger" title="PayAI holds this key">
          On <code>/start</code> the bot creates a hot wallet for your Telegram user and stores
          the private key encrypted at rest so <code>/buy</code>, <code>/sell</code>, and{" "}
          <code>/withdraw</code> can sign from chat. That is custody. Do not deposit more than
          you are willing to trust to a bot.
        </DocsCallout>
        <p>
          The same disclosure is sent every time you run <code>/start</code>, including when you
          already have a wallet. Withdraw to an address you control with <code>/withdraw</code>.
          The web app's passkey and external wallets are a different, non-custodial model —
          see <Link href="/security">Security</Link>.
        </p>
        <p>
          The webhook fails closed without a configured secret. If the bot is not set up on a
          given deployment, these commands simply do not exist there.
        </p>
      </DocsSection>

      <DocsSection id="commands" index="02" title="Commands">
        <DocsTable
          headers={["Command", "What it does"]}
          rows={[
            ["/start", "Create or show your hot wallet, with the custody notice"],
            ["/help", "Command list"],
            ["/balance", "MON and USDC balances"],
            ["/price <token>", "Look up a token"],
            ["/buy <token> <MON amount>", "Spend MON to buy a token"],
            ["/sell <token> <amount>", "Sell a token for MON"],
            ["/withdraw <amount> <MON|token> <to>", "Send funds out of the bot wallet"],
          ]}
        />
        <p>
          You need MON in the bot wallet for gas, even on a trade that does not spend MON as the
          input asset.
        </p>
      </DocsSection>

      <DocsSection id="not" index="03" title="What it is not">
        <ul>
          <li>Not the PayAI Wallet you get from a passkey in the browser.</li>
          <li>Not Wallet Automation or Reserved Funds — those are the scheduled-payments path.</li>
          <li>Not a place to paste a seed phrase. It already has a key; it does not need yours.</li>
        </ul>
      </DocsSection>
    </DocsShell>
  );
}
