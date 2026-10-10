import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rooms fee policy — what is true today, and why fee-free shares aren't
 * implemented (docs/hackathon/payai-rooms-cleanverse.md §16.2, point 2).
 *
 * The intended policy is fee-free room contributions. The audit found the
 * existing fee architecture can't exempt them safely: a share is a
 * payai/transfer@1.0.0 plan whose only target is PayAIForwarderV2, and the
 * forwarder takes its global feeBps from every payment with no exemption.
 * So shares keep that fee, added on top and disclosed before signing — and
 * nothing anywhere claims rooms are fee-free.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const forwarder = read("../contracts/contracts/PayAIForwarderV2.sol");
const service = read("../lib/rooms/service.ts");
const spec = read("../docs/hackathon/payai-rooms-cleanverse.md");
const pages = [read("../app/dashboard/rooms/page.tsx"), read("../app/dashboard/rooms/[id]/page.tsx"), read("../components/ask/RoomAskCard.tsx")];

describe("the forwarder has no per-payment fee exemption (why shares carry the fee)", () => {
  it("every payment goes through _split with the global feeBps; nothing exempts a payer, recipient or reference", () => {
    expect(forwarder).toMatch(/function _split\(uint256 gross\) private view returns \(uint256 fee, uint256 net\) \{\s*fee = \(gross \* feeBps\) \/ 10000;/);
    expect(forwarder.match(/_split\(/g)!.length).toBeGreaterThanOrEqual(3); // definition + native + ERC-20
    expect(forwarder).not.toMatch(/exempt|feeFree|noFee|waive/i);
    expect(forwarder).toMatch(/No payer or recipient can influence the fee for their own payment/);
  });
});

describe("a share is an ordinary transfer plan — no second path, no fee bypass", () => {
  it("the share's request is a plain PayAI send, created through the existing plan intake", () => {
    expect(service).toMatch(/const text = `send \$\{share\} \$\{room\.asset\.symbol\} to \$\{getAddress\(room\.recipient\)\}`/);
    expect(service).toMatch(/createPlanFromText\(auth, text\)/);
    expect(service).not.toMatch(/functionName:\s*"transfer"|sendTransaction|encodeFunctionData/);
  });
  it("confirmation requires the recipient to have received exactly the share (the fee is on top, never taken out of it)", () => {
    expect(service).toMatch(/amount\.value !== room\.shareUnits/);
    expect(service).toMatch(/net\.toString\(\) !== room\.shareUnits/);
  });
});

describe("what people are told", () => {
  it("every Rooms surface says the fee is added on top, and none says shares are free", () => {
    for (const src of pages) {
      expect(src).toMatch(/fee/i);
      expect(src).not.toMatch(/fee-free|no fee|free of (?:charge|fees)|without (?:a |any )?fee/i);
    }
    expect(pages[1]).toMatch(/PayAI&apos;s fee,\s*added on top/);
  });
  it("the spec records the limitation and the options, each needing a decision", () => {
    expect(spec).toMatch(/fee-free shares are\s+not possible on the current architecture/);
    expect(spec).toMatch(/payai\/room-share/);
  });
});
