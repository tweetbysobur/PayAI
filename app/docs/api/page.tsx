import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "HTTP API · PayAI Docs",
  description: "Public PayAI HTTP endpoints, merchant keys, and what is not a public developer platform.",
};

const TOC = [
  { id: "honest", title: "What this is" },
  { id: "public", title: "Public endpoints" },
  { id: "merchant", title: "Merchant key" },
  { id: "not", title: "What is not public" },
];

export default function ApiPage() {
  return (
    <DocsChrome
      kicker="Developers"
      title="HTTP API."
      lede="PayAI is a product with HTTP endpoints, not a published SDK. Some routes are public on purpose. Most dashboard writes use your session. This page lists the ones you can actually call without pretending the rest is a stable public API."
      toc={TOC}
    >
      <DocsSection id="honest" index="01" title="What this is">
        <p>
          The dashboard talks to <code>/api/*</code> with a session cookie. That is first-party,
          not a partner integration. If you are building against PayAI from another service, start
          with the public GET routes and the merchant key — and expect the surface to evolve.
        </p>
      </DocsSection>

      <DocsSection id="public" index="02" title="Public GET endpoints">
        <DocsTable
          headers={["Method", "Path", "What it returns"]}
          rows={[
            ["GET", "/api/fees", "Current platform fee rates per feature"],
            ["GET", "/api/onchain", "Live contract addresses"],
            ["GET", "/api/automation-config", "Executor, vault, WMON, USDC addresses"],
            ["GET", "/api/health", "Liveness — connected or not. No model, no balances"],
            ["GET", "/api/tokens", "Verified token list, or resolve an address"],
          ]}
        />
        <p>
          <code>/api/tokens?address=0x…</code> reads arbitrary contracts and is rate-limited.
          <code>/api/health</code> does not expose the agent wallet address or its balance.
        </p>
      </DocsSection>

      <DocsSection id="merchant" index="03" title="Merchant key">
        <p>
          <code>POST /api/merchants</code> creates a workspace and returns an API key once. Send
          it as <code>x-merchant-key</code> on later merchant-scoped calls (for example payment
          links). The key is not recoverable from the API after that response.
        </p>
        <DocsCallout tone="warning" title="Shown once">
          Store the merchant key yourself. PayAI will not email it again.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="not" index="04" title="What is not a public API">
        <p>
          Automations, Ask PayAI, swaps, and anything that can move funds are session-authenticated
          dashboard routes, or gated on an internal signer key that is not issued to third
          parties. Treat them as the app backend.
        </p>
        <p>
          Contracts you can verify: <Link href="/docs/contracts">Contracts</Link>.
        </p>
      </DocsSection>
    </DocsChrome>
  );
}
