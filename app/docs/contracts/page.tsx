import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsShell, DocsTable } from "@/components/docs/DocsShell";
import { LiveContracts } from "@/components/docs/LiveContracts";

export const metadata: Metadata = {
  title: "Contracts · PayAI Docs",
  description: "Live PayAI contract addresses on Monad and what each contract is allowed to do.",
};

const TOC = [
  { id: "live", title: "In production" },
  { id: "roles", title: "Roles" },
  { id: "unused", title: "Deployed, not in the app" },
  { id: "source", title: "Source" },
];

export default function ContractsPage() {
  return (
    <DocsShell
      kicker="Developers"
      title="Contracts."
      lede="Settlement is the contracts on Monad, not this website. The table is read from the running deployment. PayAIForwarder and PayAITradeExecutor are what your wallet actually pays and trades through. PaymentExecutor is the automation path."
      toc={TOC}
    >
      <DocsSection id="live" index="01" title="In production now">
        <p>
          Interactive payments go through <strong>PayAIForwarder</strong>. Interactive trades go
          through <strong>PayAITradeExecutor</strong>. PaymentExecutor, AutomationVault, and
          MerchantRegistry settle automations and the on-chain record. Addresses below are live
          on this deployment, not a screenshot.
        </p>
        <LiveContracts />
        <p>
          Machine-readable: <a href="/api/onchain"><code>GET /api/onchain</code></a> and{" "}
          <a href="/api/automation-config"><code>GET /api/automation-config</code></a>.
        </p>
      </DocsSection>

      <DocsSection id="roles" index="02" title="What each live contract does">
        <p>
          <strong>PayAIForwarder</strong> is the interactive-payment path: your wallet pays the
          forwarder, the forwarder pays the recipient. You sign. The automation agent is not in
          this path.
        </p>
        <p>
          <strong>PayAITradeExecutor</strong> executes interactive trades through allowlisted
          venues. The model does not pick an arbitrary target.
        </p>
        <p>
          <strong>PaymentExecutor</strong> settles automated payments and writes the record
          (recipient, amount, request id). It enforces replay protection and the agent
          per-transaction and daily caps. It is not the contract your wallet sends an
          interactive payment to.
        </p>
        <p>
          <strong>AutomationVault</strong> holds a Reserved Funds deposit for one automation. It
          can pay the committed recipient or refund the depositor — nowhere else.
        </p>
        <p>
          <strong>MerchantRegistry</strong> is the payee directory the executor can check against.
        </p>
      </DocsSection>

      <DocsSection id="unused" index="03" title="Deployed, not in the app">
        <p>
          These exist on Monad. They are not what the live product routes through today. Listed
          so an explorer search for “PayAI” is not a mystery.
        </p>
        <DocsTable
          headers={["Contract", "Address", "Status"]}
          rows={[
            [
              "PayAITradeExecutorV2",
              <a key="tev2" href="https://monadexplorer.com/address/0x920409bed646fFA094b9851867435a74B55Ca40d" target="_blank" rel="noreferrer" className="font-mono text-[12px]">0x920409bed646fFA094b9851867435a74B55Ca40d</a>,
              "Deployed and verified. Flag off — Uniswap/Kuru still use V1; Nad.Fun is still direct.",
            ],
            [
              "SplitSettlement",
              <a key="split" href="https://monadexplorer.com/address/0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F" target="_blank" rel="noreferrer" className="font-mono text-[12px]">0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F</a>,
              "Deployed. SDK action exists. Not a dashboard flow yet.",
            ],
            [
              "PayAIForwarder V1",
              <a key="fwd1" href="https://monadexplorer.com/address/0x4ce7B3036595eDA699Aebeb47b34fd4bc4F80709" target="_blank" rel="noreferrer" className="font-mono text-[12px]">0x4ce7B3036595eDA699Aebeb47b34fd4bc4F80709</a>,
              "Superseded by Forwarder V2. Do not send to this.",
            ],
            [
              "PaymentExecutor V1",
              <a key="ex1" href="https://monadexplorer.com/address/0xf723BE809A99A1c29e0205a542aa2aEF80B508AF" target="_blank" rel="noreferrer" className="font-mono text-[12px]">0xf723BE809A99A1c29e0205a542aa2aEF80B508AF</a>,
              "Superseded by Executor V2. Existing automations pinned to it still settle here.",
            ],
            [
              "AutomationVault V1",
              <a key="va1" href="https://monadexplorer.com/address/0x87D42314d1BAf2386fB9ff3dF398b543bc64cA47" target="_blank" rel="noreferrer" className="font-mono text-[12px]">0x87D42314d1BAf2386fB9ff3dF398b543bc64cA47</a>,
              "Superseded by Vault V2. Same pin rule as Executor V1.",
            ],
          ]}
        />
        <DocsCallout tone="warning" title="Do not pay the retired addresses">
          New interactive payments must hit PayAIForwarder V2 (
          <code>0x8b2c7E8F…464D</code>). New automations use PaymentExecutor V2 and
          AutomationVault V2. The V1 contracts still exist so old pinned automations do not
          break.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="source" index="04" title="Source">
        <DocsCallout tone="note" title="Application source is private">
          The application repository is private. Deployed contracts are verified on the Monad
          explorer. We will not link a GitHub 404 and call the product public. Independent
          review of the protocol: <Link href="/security">Security</Link>.
        </DocsCallout>
      </DocsSection>
    </DocsShell>
  );
}
