import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "Ask PayAI · PayAI Docs",
  description:
    "Describe what you want done on Monad in plain English — one action or many in one request. PayAI plans it, you review it, one approval runs it.",
};

const TOC = [
  { id: "what", title: "What you can ask" },
  { id: "many", title: "Many actions, one request" },
  { id: "approval", title: "One approval" },
  { id: "run", title: "How a plan runs" },
  { id: "images", title: "Images and QR codes" },
  { id: "sdk", title: "Protocol actions" },
  { id: "understanding", title: "How Ask understands you" },
  { id: "limits", title: "Limits" },
  { id: "secrets", title: "Do not paste secrets" },
];

/*
 * Every statement here is read from the code:
 *   lib/ask/planFastPath.ts      which requests become a plan, "each" and recipient-first rewrites
 *   lib/plan-adapter/grammar.ts  the plan grammar, connectors, "send it", limits (MAX_ACTIONS 500)
 *   lib/plans-client/*           the runner: order, confirm-before-next, stop on failure, resume
 *   lib/plans-client/approval.ts one approval per plan; which quotes still stop for review
 *   lib/wallet-service/registry.ts the plan's approval session (count- and time-bounded)
 *   lib/ask/intent/classify.ts   the deterministic engine first, the model only for open wording
 */
export default function AskPage() {
  return (
    <DocsChrome
      title="Ask PayAI"
      lede="Say what you want done on Monad — one action or a whole list of them. PayAI turns it into a plan, shows you every step, and runs it on one approval. Nothing moves until you approve and your wallet signs."
      toc={TOC}
    >
      <DocsSection id="what" title="What you can ask">
        <DocsTable
          headers={["You say", "What happens"]}
          rows={[
            [<code key="a">send 10 USDC to alice.nad</code>, "A payment in MON or USDC to a 0x address, a .nad name or a saved payee."],
            [<code key="b">swap 50 MON to USDC</code>, "A swap between MON and USDC, quoted live."],
            [<code key="c">buy $20 of 0x… with USDC</code>, <>A trade in any Monad token by symbol or contract address — see <Link href="/docs/trading">Trading</Link>.</>],
            [<code key="d">send 5 USDC each to alice.nad and bob.nad</code>, "Several payments as one plan."],
            [<code key="e">swap 10 MON to USDC and send it to bob.nad</code>, "Chained actions: the second uses exactly what the first produced."],
            [<code key="f">pay alice.nad 50 USDC every Friday</code>, <>A scheduled or recurring payment — see <Link href="/docs/automations">Automations</Link>.</>],
            [<code key="g">wrap 1 MON</code>, <>A protocol action — see <a href="#sdk">Protocol actions</a>.</>],
            ["An image or QR code", <>A payment read from a picture — see <a href="#images">Images and QR codes</a>.</>],
            [<code key="h">what&apos;s my USDC balance?</code>, "Balances, history and token information, answered from your own wallet. Nothing is prepared."],
          ]}
        />
        <p>
          A request that is missing something — an amount, a token, who it&apos;s for — gets one
          short question back. PayAI never guesses an amount or a recipient.
        </p>
      </DocsSection>

      <DocsSection id="many" title="Many actions, one request">
        <p>
          You don&apos;t have to send one message per payment. Write everything you want done in
          one request and PayAI builds a single plan with every action in the order you wrote it.
        </p>
        <h3>Ways to write it</h3>
        <DocsTable
          headers={["Pattern", "Example"]}
          rows={[
            ["Join actions with and, then or commas", <code key="j">send 1 MON to alice.nad, then swap 5 USDC to MON</code>],
            ["Several payments, one verb", <code key="k">send 1 MON to alice.nad, 2 MON to bob.nad and 3 MON to carol.nad</code>],
            ["The same amount to everyone", <code key="l">send 20 USDC each to alice.nad, bob.nad and carol.nad</code>],
            ["Recipient first", <code key="m">pay alice.nad 1 MON and bob.nad 2 MON</code>],
            ["Use a swap's output", <code key="n">swap 10 MON to USDC and send it to bob.nad</code>],
            ["Mix them", <code key="o">send 5 USDC to alice.nad, swap 2 MON to USDC and send it to bob.nad</code>],
          ]}
        />
        <p>
          <strong>&ldquo;Send it&rdquo; means exactly what the swap returned</strong> — not an
          estimate and not your whole balance. The amount is read from the confirmed swap
          before the payment is built. &ldquo;Each&rdquo; is written out per recipient, so
          &ldquo;20 USDC each to three people&rdquo; is three payments of 20 USDC, shown that
          way in the review.
        </p>
        <p>
          <strong>How many?</strong> A plan can hold up to 500 actions. Long requests — a
          payroll list pasted in one message, for example — are planned the same way; the review
          shows a progress count and a scrolling list instead of a card the length of the plan.
        </p>
        <h3>The review</h3>
        <p>
          Before anything runs you see every action, numbered in the order it will run: what
          moves, how much, and to whom — with the full address each .nad name or payee resolved
          to, pinned for this plan. One action reads like a payment confirmation; several read
          as a numbered list. Cancel or edit at this point and nothing has been sent.
        </p>
      </DocsSection>

      <DocsSection id="approval" title="One approval">
        <p>
          <strong>One approval covers the whole plan.</strong> With a PayAI Wallet, tapping
          Approve opens one passkey prompt, and every action in the plan runs on it. You are not
          asked again for each step.
        </p>
        <ul>
          <li>The approval signs only that plan&apos;s transactions — never anything else in PayAI, which still asks for your passkey every time.</li>
          <li>It is capped to the plan&apos;s own number of transactions (each action plus any token approval it needs) and expires after 10 minutes.</li>
          <li>It is wiped the moment the plan finishes, fails or is cancelled.</li>
          <li>Cancelling the passkey prompt approves nothing and sends nothing.</li>
        </ul>
        <p>
          Quotes don&apos;t stop you either: a clean, low-risk quote goes straight on. A quote
          that carries a warning — high price impact, an amount that changed — still stops and is
          shown to you to accept or decline before anything is signed. Swaps stay protected by
          the slippage limit shown in the review, which the transaction enforces on-chain.
        </p>
        <DocsCallout tone="note" title="Connected wallets">
          A wallet like MetaMask confirms every transaction in its own pop-up — PayAI can&apos;t
          skip that. You still approve the plan once in PayAI; your wallet then asks for each
          transaction in order.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="run" title="How a plan runs">
        <ol>
          <li><strong>In order.</strong> Actions run in the order you wrote them. Each one is quoted, built, signed and confirmed on Monad before the next one starts.</li>
          <li><strong>Checked before signing.</strong> Every transaction is built by PayAI for the plan you approved and checked against it — the contract it calls, the amounts, the recipient, the network. A transaction that doesn&apos;t match is refused before your wallet sees it.</li>
          <li><strong>Confirmed, not assumed.</strong> A step counts as done only when its transaction is confirmed on-chain. The receipt shows the real amounts, fees and transaction hash.</li>
          <li><strong>A failure stops the rest.</strong> If a step fails, the steps after it don&apos;t start. Steps that already completed stay completed — nothing is reversed or repeated.</li>
          <li><strong>Pick up where it stopped.</strong> When it is safe, the plan offers Continue, which picks up at the step that didn&apos;t finish. It is never offered while a transaction may still be in flight, so nothing is sent twice.</li>
        </ol>
      </DocsSection>

      <DocsSection id="images" title="Images and QR codes">
        <p>
          Attach a picture instead of typing: a wallet&apos;s QR code, a payment request QR, or
          (where enabled) an invoice or a screenshot of payment instructions. PayAI reads the
          payment out of it, turns it into an ordinary request and shows it to you — the image
          is never an approval, and nothing runs until you review and approve the plan.
        </p>
        <p>
          Full details — what can be read, how a caption combines with the image, and the
          safety rules — are on <Link href="/docs/visual-intent">Visual intent</Link>.
        </p>
      </DocsSection>

      <DocsSection id="sdk" title="Protocol actions">
        <p>
          Some on-chain actions run through the PayAI SDK, a layer that only lets each action
          call the contract it was reviewed for:
        </p>
        <DocsTable
          headers={["Action", "Say"]}
          rows={[
            ["Wrap MON into WMON (1:1)", <code key="w">wrap 1 MON</code>],
            ["Unwrap WMON into MON (1:1)", <code key="u">unwrap 1 WMON</code>],
            ["Split one payment between 2–9 people in one transaction", <code key="s">split 30 USDC between alice.nad, bob.nad and carol.nad</code>],
            ["Swap as a step of a plan", <code key="sw">swap 10 MON to USDC and send it to bob.nad</code>],
          ]}
        />
        <p>
          These are matched by fixed rules — the language model never chooses a protocol, a
          contract or an amount. How each one is checked, its fees and limits:{" "}
          <Link href="/docs/sdk">PayAI SDK</Link>.
        </p>
      </DocsSection>

      <DocsSection id="understanding" title="How Ask understands you">
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
          to a language model from Anthropic to work out the action, amount, token and recipient.
          Reading an invoice image works the same way. The model only fills in those fields: it
          can&apos;t approve, sign or pick a contract, and everything it returns goes through the
          same checks and your review. If the model is unavailable, the engine answers on its own
          or asks you to rephrase.
        </p>
      </DocsSection>

      <DocsSection id="limits" title="Limits">
        <ul>
          <li>Payments in a plan are MON or USDC. Swaps in a plan are MON ⇄ USDC. Other tokens are traded on their own — see <Link href="/docs/trading">Trading</Link>.</li>
          <li>&ldquo;Send it&rdquo; works after a swap to USDC. MON received from a swap can&apos;t be passed to the next step yet.</li>
          <li>Amounts must be exact. &ldquo;Half of it&rdquo;, &ldquo;the rest&rdquo; or &ldquo;all&rdquo; between steps aren&apos;t supported yet.</li>
          <li>A scheduled or recurring payment goes in its own message; it can&apos;t be combined with other actions yet.</li>
          <li>Up to 500 actions per plan.</li>
          <li>Staking, bridging and other DeFi protocols aren&apos;t available yet — PayAI says so rather than guessing.</li>
        </ul>
      </DocsSection>

      <DocsSection id="secrets" title="Do not paste secrets">
        <DocsCallout tone="danger" title="Ask PayAI is not a keystore">
          Do not paste seed phrases, private keys, or API secrets into the composer. The text may
          be sent to a language model provider (Anthropic) to work out what you meant. Keys belong
          in your wallet, never in chat.
        </DocsCallout>
        <p>
          More on the signing model: <Link href="/security">Security</Link>.
        </p>
      </DocsSection>
    </DocsChrome>
  );
}
