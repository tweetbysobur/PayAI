import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "PayAI SDK · PayAI Docs",
  description: "The actions Ask PayAI can run on Monad — swap, wrap, split — how each one is checked before you sign, and what the SDK is not.",
};

const TOC = [
  { id: "what", title: "What it is" },
  { id: "actions", title: "Available actions" },
  { id: "flow", title: "How an action runs" },
  { id: "safety", title: "Safety rules" },
  { id: "contracts", title: "Contracts involved" },
  { id: "fees", title: "Fees" },
  { id: "limits", title: "Limits" },
  { id: "integrate", title: "Integrate your protocol" },
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
      lede="The layer that lets Ask PayAI run specific on-chain actions — swapping MON and USDC, wrapping MON and splitting a payment — with every transaction checked before your wallet sees it."
      toc={TOC}
    >
      <DocsSection id="what" index="01" title="What it is">
        <p>
          The PayAI SDK is the protocol-action layer inside PayAI. Each supported protocol
          declares a small set of actions. An action&apos;s own transaction can only go to the
          contract it was reviewed for, and any token approval it needs is checked separately.{" "}
          <Link href="/docs/ask">Ask PayAI</Link> uses it when you ask for one of the actions below.
        </p>
        <DocsCallout tone="note" title="Not a published package">
          The SDK runs inside PayAI. There is no package to install and no self-serve
          registration: a DeFi protocol joins through a partner integration that PayAI reviews
          and ships. See <a href="#integrate">Integrate your protocol</a>.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="actions" index="02" title="Available actions">
        <DocsTable
          headers={["Action", "What it does", "Try in Ask PayAI"]}
          rows={[
            [
              "Swap",
              "Swap MON ⇄ USDC through PayAI's trade executor, as a step of a plan.",
              <code key="sw">swap 10 MON to USDC and send it to 0x…</code>,
            ],
            ["Wrap MON", "Wrap native MON into WMON, 1:1.", <code key="w">wrap 1 MON</code>],
            ["Unwrap WMON", "Unwrap WMON back into native MON, 1:1.", <code key="u">unwrap 1 WMON</code>],
            [
              "Split payment",
              "Send MON or a token to 2–9 recipients in one transaction.",
              <code key="s">split 3 MON between 0x… and 0x…</code>,
            ],
          ]}
        />
        <p>
          <strong>Swap</strong> is the trade step inside a multi-step plan, so a swap can feed a
          send in the same request. It covers MON → USDC and USDC → MON, exact input, and only
          through PayAI&apos;s trade executor: a route the executor can&apos;t take is refused here,
          never silently sent elsewhere. Trading any other Monad token — by symbol or contract
          address, on Uniswap, Kuru or Nad.Fun — uses PayAI&apos;s trading engine directly; see{" "}
          <Link href="/docs/trading">Trading</Link>.
        </p>
        <p>
          These actions are offered on Monad mainnet. Split payment is only available where the
          Split Settlement contract is deployed, which is Monad mainnet. An action that
          isn&apos;t available on the network a deployment runs on is never offered there.
        </p>
        <p>
          In Ask PayAI, a split is one token — MON or USDC — and 2–9 recipients. A recipient
          can be a full 0x address, a .nad name, or a payee name your PayAI deployment has
          configured; anything else is refused and you&apos;re asked who you meant. There are
          three ways to write one:
        </p>
        <ul>
          <li>
            <strong>Even:</strong> <code>split 3 MON between 0x… and 0x…</code>. If the total
            doesn&apos;t divide exactly in the token&apos;s smallest unit, the last recipient
            receives the few extra units, so the amounts add up to exactly the total.
          </li>
          <li>
            <strong>Your own amounts:</strong> <code>split 100 USDC: 60 to 0x… and 40 to bob.nad</code>.
            If you state a total, the amounts must add up to it.
          </li>
          <li>
            <strong>The rest:</strong> <code>split 100 USDC: 20 to 0x… and the rest to bob.nad</code>.
            The total has to be in the same message.
          </li>
        </ul>
        <p>
          A split message that can&apos;t be read exactly — a recipient that can&apos;t be
          resolved, amounts that don&apos;t add up, the same wallet twice — gets a question
          back. It is never guessed, and never turned into a different payment.
        </p>
      </DocsSection>

      <DocsSection id="flow" index="03" title="How an action runs">
        <ol>
          <li>
            <strong>Recognised by fixed rules, not guessed.</strong> Protocol actions are matched
            by exact patterns in your message. The AI model is never allowed to choose a
            protocol, an action, a contract, or a split&apos;s recipients.
          </li>
          <li>
            <strong>Preview.</strong> You see what will happen — the amount, and the recipients
            for a split, including the address each .nad name resolved to — before anything is
            built. A split also shows its 0.25% platform fee and the total you pay, and is
            screened like a normal payment (sanctions and risk). Nothing is signed or sent.
          </li>
          <li>
            <strong>Build and check.</strong> When you confirm, PayAI builds the transaction and
            checks it: that it is exactly the action, version, inputs and fee terms you previewed,
            that it is on the right network, that the preview is less than 90 seconds old, the contract the
            transaction calls, and any token approval. One failed check stops the whole action.
            Each preview can be built once.
          </li>
          <li>
            <strong>You sign.</strong> Your own wallet signs and sends. For a token that needs an
            approval first, you sign that approval as a separate step.
          </li>
          <li>
            <strong>Confirmed on-chain.</strong> The result you see is read from the confirmed
            transaction on Monad, not from the preview. A split is added to your history, one
            entry per recipient, from what the contract actually paid.
          </li>
        </ol>
      </DocsSection>

      <DocsSection id="safety" index="04" title="Safety rules">
        <ul>
          <li>
            <strong>Allowlisted contracts only.</strong> The action itself may only call the
            contract listed for it below. A token approval goes to the token itself, and is
            checked so the allowance can only go to the listed contract. A transaction to
            anything else is refused before it reaches your wallet.
          </li>
          <li>
            <strong>Exact approvals.</strong> When a token approval is needed, it is for the
            exact amount of this action, to the one contract that will use it. Never unlimited.
          </li>
          <li>
            <strong>Right network.</strong> An action only runs on the network it was built for.
            A request made for one network is refused on another.
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
        <DocsCallout tone="note" title="What the checks do not cover">
          These checks cover where an action&apos;s transaction is sent and what a token approval
          can do. They do not check that the amount or recipient is what you meant — a mistyped
          address in a split is still paid. Read the transaction your wallet shows before you
          sign.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="contracts" index="05" title="Contracts involved">
        <DocsTable
          headers={["Action", "Contract", "Operated by"]}
          rows={[
            ["Swap", <Link key="te" href="/docs/contracts">PayAITradeExecutor (see Contracts)</Link>, "PayAI"],
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
          A split payment carries PayAI&apos;s standard 0.25% platform fee, added on top of the
          recipients&apos; total so each recipient receives exactly their amount. It is paid to
          PayAI&apos;s treasury as one extra leg of the same transaction, and shown before you
          sign. A swap pays the trade executor&apos;s fee (0.25%), also added on top, so the amount
          you set is swapped in full. Wrap and unwrap carry no platform fee. You pay Monad gas for each transaction
          you sign, including any approval. See <Link href="/docs/fees">Fees</Link>.
        </p>
      </DocsSection>

      <DocsSection id="limits" index="07" title="Limits">
        <ul>
          <li>A swap step is MON ⇄ USDC only, exact input, at the trading engine&apos;s 0.5% slippage. To set your own slippage or trade another token, trade on its own — see <Link href="/docs/trading">Trading</Link>.</li>
          <li>A split takes 2–9 recipients per transaction, each one only once. The contract&apos;s tenth slot carries the platform fee.</li>
          <li>From Ask PayAI, a split is in MON or USDC, and runs once — scheduled splits aren&apos;t supported.</li>
          <li>There is no public HTTP API or package for these actions.</li>
          <li>Other protocols are added only through a reviewed partner integration — see below. None is live yet.</li>
        </ul>
      </DocsSection>
      <DocsSection id="integrate" index="08" title="Integrate your protocol">
        <p>
          DeFi protocols on Monad can integrate with PayAI so their users can run them from a
          single sentence in Ask PayAI. Integration is a partnership: you describe your
          protocol&apos;s actions, PayAI reviews and implements the adapter, and nothing is
          offered to users until it has been tested and shipped. No DeFi protocol is live yet.
        </p>

        <h3>What your integration declares</h3>
        <DocsTable
          headers={["Part", "What it is"]}
          rows={[
            ["Protocol", "An id, a name, the chain (Monad mainnet, 143) and every contract address it may ever call."],
            ["Actions", "Each action — supply, withdraw, stake, and so on — with an id and an exact version. A version change is a new action, never a silent upgrade."],
            ["Inputs", "A typed schema for each action: amount, token, address, number, text or a list. Nothing untyped."],
            ["Quote", "What the user sees before anything is built: a one-line summary and the details that matter (rate, what they receive)."],
            ["Build", "The unsigned transactions for the action, plus any token approval it needs (token, spender, exact amount)."],
            ["Result", "How to read the outcome from the confirmed receipt's events, so the user sees what actually happened, not the quote."],
          ]}
        />

        <h3>What PayAI enforces</h3>
        <ul>
          <li><strong>Allowlisted contracts.</strong> A built transaction that calls anything outside the declared addresses is refused in full.</li>
          <li><strong>Exact approvals.</strong> An approval is for this action&apos;s exact amount, to a declared contract. Never unlimited.</li>
          <li><strong>Pinned chain and version.</strong> An action runs only on its chain, and only at the version the user previewed.</li>
          <li><strong>Fixed matching.</strong> Requests are matched to an action by fixed rules. The AI model never chooses a protocol, a contract or an amount.</li>
          <li><strong>The user signs.</strong> Every transaction is signed by the user&apos;s own wallet, after they review it.</li>
          <li><strong>Verified results.</strong> What the user is told comes from the confirmed transaction on Monad.</li>
        </ul>

        <h3>How to apply</h3>
        <ol>
          <li>Email <a href="mailto:support@usepayai.xyz?subject=Protocol%20integration">support@usepayai.xyz</a> with the subject <em>Protocol integration</em>.</li>
          <li>Include your contracts (verified on the Monad explorer), the actions you want users to run, and any audits.</li>
          <li>PayAI reviews the contracts and actions, builds the adapter and tests it against Monad.</li>
          <li>Once it ships, your actions appear in Ask PayAI with the exact wording users can say.</li>
        </ol>
      </DocsSection>
    </DocsChrome>
  );
}
