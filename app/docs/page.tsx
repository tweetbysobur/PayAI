import type { Metadata } from "next";
import Link from "next/link";
import { DocsSection, DocsShell } from "@/components/docs/DocsShell";

export const metadata: Metadata = {
  title: "Docs · PayAI",
  description: "How PayAI works on Monad: payments, automations, fees, contracts, and the Telegram bot.",
};

const LINKS = [
  { href: "/docs/getting-started", title: "Getting started", body: "Connect a wallet and send the first payment." },
  { href: "/docs/payments", title: "Payments", body: "Send MON or any Monad token, including to a .nad name." },
  { href: "/docs/automations", title: "Automations", body: "Wallet Automation vs Reserved Funds, bulk, skip, execute now." },
  { href: "/docs/fees", title: "Fees", body: "0.25% on send and automations. Swaps are currently free." },
  { href: "/docs/ask", title: "Ask PayAI", body: "Describe a payment in English, review it, then sign." },
  { href: "/docs/contracts", title: "Contracts", body: "Live addresses and what each contract is allowed to do." },
  { href: "/docs/api", title: "HTTP API", body: "Public endpoints, merchant keys, and what is not a public SDK." },
  { href: "/docs/telegram", title: "Telegram bot", body: "A custodial hot wallet for trading from chat. Optional." },
  { href: "/security", title: "Security", body: "Keys, custody exceptions, Ultrafuzz, how to report a bug." },
];

export default function DocsIndexPage() {
  return (
    <DocsShell
      kicker="Documentation"
      title="PayAI, in writing."
      lede="PayAI turns natural-language intent into on-chain execution on Monad. These pages describe what the product actually does today — including the limits."
    >
      <DocsSection id="start" title="Start here">
        <p>
          New to the app? <Link href="/docs/getting-started">Getting started</Link> is the shortest
          path to a real payment. If you need to trust it with money first, read{" "}
          <Link href="/security">Security</Link> and <Link href="/docs/fees">Fees</Link>.
        </p>
        <p>
          UsePayAI operates PayAI at usepayai.xyz. We are not affiliated with PayAI Network,
          payai.network, or the $PAYAI token.
        </p>
      </DocsSection>

      <DocsSection id="contents" title="Contents">
        <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="block bg-background px-4 py-4 transition-colors hover:bg-panel"
            >
              <p className="text-sm font-semibold text-foreground">{l.title}</p>
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{l.body}</p>
            </Link>
          ))}
        </div>
      </DocsSection>
    </DocsShell>
  );
}
