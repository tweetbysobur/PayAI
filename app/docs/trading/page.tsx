import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "Trading · PayAI Docs",
  description: "Swap, buy and sell any Monad token from a sentence in Ask PayAI: how a trade is quoted, checked and signed, the venues, slippage, fees and limits.",
};

const TOC = [
  { id: "what", title: "What you can trade" },
  { id: "ask", title: "How to ask" },
  { id: "flow", title: "How a trade runs" },
  { id: "venues", title: "Venues" },
  { id: "protection", title: "Price protection" },
  { id: "fees", title: "Fees" },
  { id: "limits", title: "Limits" },
];

/*
 * Every statement here is read from the trading engine:
 *   lib/monad/tradeQuote.ts   previewTrade / prepareTradeExecution / isMaterialChange
 *   lib/monad/swap.ts         DEFAULT_SLIPPAGE 0.5%, MAX_SLIPPAGE 50%, MAX_PRICE_IMPACT 15%
 *   lib/monad/tradeExecutor.ts executor fee (feeBps), direct-router fallback
 *   lib/monad/nadfun.ts / kuruSwap.ts   venues
 */
export default function TradingPage() {
  return (
    <DocsChrome
      kicker="Product"
      title="Trading."
      lede="Swap, buy or sell any Monad token by saying what you want. PayAI quotes it live, shows you exactly what you'll receive, and your wallet signs. Nothing trades until you confirm."
      toc={TOC}
    >
      <DocsSection id="what" index="01" title="What you can trade">
        <p>
          MON, USDC and the other tokens in PayAI&apos;s verified list can be named by symbol.
          Any other token on Monad is traded by its <strong>contract address (CA)</strong>: paste
          the address and PayAI reads the token&apos;s name, symbol and decimals from the contract
          itself. A symbol is only ever matched against the verified list, so a look-alike token
          can&apos;t be picked up by name.
        </p>
        <DocsCallout tone="note" title="Unverified tokens">
          A token traded by address is not checked for being legitimate — only that it exists and
          has a route. Check the contract before you trade it.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="ask" index="02" title="How to ask">
        <DocsTable
          headers={["You say", "What happens"]}
          rows={[
            [<code key="a">swap 100 USDC to MON</code>, "Spend exactly 100 USDC."],
            [<code key="b">buy $20 of MON with USDC</code>, "Spend $20 worth of USDC, priced live."],
            [<code key="c">sell half my MON for USDC</code>, "Spend 50% of your MON balance, keeping enough MON for gas."],
            [<code key="d">sell all my MON for USDC</code>, "Spend your whole balance, minus the gas reserve."],
            [<code key="e">0x… then &ldquo;buy $20 of it&rdquo;</code>, "Paste a token's address, then trade it."],
          ]}
        />
        <p>
          You can also chain a trade with a send — <code>swap 10 MON to USDC and send it to alice.nad</code> —
          and both steps are planned together and run in order. See <Link href="/docs/ask">Ask PayAI</Link>.
        </p>
      </DocsSection>

      <DocsSection id="flow" index="03" title="How a trade runs">
        <ol>
          <li>
            <strong>Quote.</strong> PayAI finds a route and shows the amount you spend, the amount
            you receive, the venue, the price impact and your slippage limit. Nothing is built yet.
          </li>
          <li>
            <strong>Confirm.</strong> When you confirm, PayAI quotes again from scratch. If the
            venue changed, or the amount you&apos;d receive moved by more than your slippage limit,
            you&apos;re shown the new quote to confirm instead — a different trade is never
            executed silently.
          </li>
          <li>
            <strong>Sign.</strong> Your own wallet signs. A token that needs an approval first is
            approved for the exact amount of this trade only, never unlimited.
          </li>
          <li>
            <strong>Confirmed on-chain.</strong> What you received is read from the confirmed
            transaction and recorded in your history.
          </li>
        </ol>
      </DocsSection>

      <DocsSection id="venues" index="04" title="Venues">
        <DocsTable
          headers={["Venue", "Used for"]}
          rows={[
            ["Uniswap v3", "Verified pairs, and any token traded by address that has a Uniswap pool."],
            ["Kuru", "Verified pairs where Kuru has a market."],
            ["Nad.Fun", "Tokens on the Nad.Fun bonding curve, traded against MON. Trading such a token against USDC is done in two steps through MON."],
          ]}
        />
        <p>
          For verified pairs PayAI picks the better quote. Trades go through PayAI&apos;s trade
          executor (PayAITradeExecutor) where the venue is allowlisted there; otherwise they go
          straight to the venue. Nad.Fun trades always go straight to Nad.Fun. Addresses are on{" "}
          <Link href="/docs/contracts">Contracts</Link>.
        </p>
      </DocsSection>

      <DocsSection id="protection" index="05" title="Price protection">
        <ul>
          <li><strong>Slippage:</strong> 0.5% by default. You can name your own — <code>use 1% slippage</code> — up to 50%.</li>
          <li><strong>Minimum received:</strong> the transaction carries a minimum output; if the price moves past your slippage limit before it lands, it reverts instead of filling worse.</li>
          <li><strong>Price impact:</strong> a trade whose price impact is above 15% is flagged on the quote before you confirm.</li>
          <li><strong>Balance:</strong> an amount your wallet can&apos;t cover is refused at the quote, and MON trades keep a small reserve for gas.</li>
        </ul>
      </DocsSection>

      <DocsSection id="fees" index="06" title="Fees">
        <p>
          A trade that goes through PayAI&apos;s trade executor pays PayAI&apos;s 0.25% fee, added
          on top so the amount you set is traded in full. A trade that goes straight to a venue
          pays no PayAI fee. Either way you pay Monad gas, and the venue&apos;s own pool fee is
          already in the quote. See <Link href="/docs/fees">Fees</Link>.
        </p>
      </DocsSection>

      <DocsSection id="limits" index="07" title="Limits">
        <ul>
          <li>Trades are exact-input: you say what to spend. &ldquo;Receive exactly 100 tokens&rdquo; isn&apos;t supported yet.</li>
          <li>A token with no route on Uniswap, Kuru or Nad.Fun can&apos;t be traded.</li>
          <li>MON received from a swap can&apos;t be passed on to the next step of a plan yet; USDC can.</li>
          <li>Trades can&apos;t be scheduled or automated.</li>
        </ul>
      </DocsSection>
    </DocsChrome>
  );
}
