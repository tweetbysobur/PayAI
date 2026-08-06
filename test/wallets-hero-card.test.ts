import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The Wallets page's hero card rendered the raw 42-character wallet address
 * as its primary label whenever no username or .nad domain was set, which is
 * the common case. In a flex row with no floor width reserved for the kind
 * badge, that pushed the badge's own text into a sliver so narrow it wrapped
 * onto three lines ("PayAI / Wallet / (Embedded)"), and shoved a MON/USDC
 * balance column into an awkward, disconnected position beside it — reported
 * as the card "lagging" with the balance "not well placed".
 *
 * The balance column was then reported a second time: it duplicated
 * Portfolio, rendered directly below, which already reads every holding —
 * MON and USDC included — from the chain with USD values. Repeating two of
 * those figures here wasn't a layout bug, it was two sources of the same
 * numbers on one screen. The fix removes the balance block from this card
 * entirely rather than re-laying it out; the card's job is identity, and
 * Portfolio's job is balance.
 */

const src = readFileSync(new URL("../app/dashboard/wallets/page.tsx", import.meta.url), "utf8");

describe("the wallet identity never renders as a raw address", () => {
  it("prefers a username, then a .nad domain, over the raw address", () => {
    // Same priority order Topbar already uses — this page must not
    // reinvent a worse one (the raw wallet.label, which is the full address
    // whenever nothing nicer is set).
    expect(src).toMatch(/handle\.hasUsername \? handle\.display : identity\.display/);
    expect(src).not.toMatch(/wallet\.kind === "embedded" \? wallet\.label : identity\.display/);
  });
});

describe("the kind badge cannot be squeezed into wrapping", () => {
  it("has both a floor width and forced single-line text", () => {
    expect(src).toMatch(/shrink-0 items-center whitespace-nowrap rounded-md border/);
  });
});

describe("identity column truncates instead of overflowing", () => {
  it("has min-w-0 so a long value can't force the row wider than its container", () => {
    expect(src).toMatch(/flex min-w-0 items-center gap-3\.5/);
  });
});

describe("the hero card no longer duplicates Portfolio's balance", () => {
  it("renders no MON/USDC balance figures of its own", () => {
    // Portfolio, rendered directly below this card, is the one place on the
    // page that shows what the wallet holds. TokenLogo was only ever
    // imported here to build that duplicate balance row.
    expect(src).not.toMatch(/import \{ TokenLogo \} from/);
    expect(src).not.toMatch(/balances\.mon \? Number\(balances\.mon\)/);
    expect(src).not.toMatch(/balances\.usdc \? Number\(balances\.usdc\)/);
  });

  it("still uses balances for the Asset allocation chart further down the page", () => {
    // Confirms the fix removed the DUPLICATE display, not the underlying
    // hook — useWalletBalances still backs the donut chart in the Wallet
    // Intelligence section.
    expect(src).toMatch(/const balances = useWalletBalances\(wallet\.address\)/);
    expect(src).toMatch(/const mon = Number\(balances\.mon \?\? 0\)/);
  });
});

describe("the redundant Connected Wallets card is gone", () => {
  it("no longer duplicates WalletManager's own active-wallet indicator", () => {
    // WalletManager (rendered directly above this point in the page) already
    // shows every wallet with its own "Active" badge and an add-wallet link —
    // this card said the same thing with less capability.
    expect(src).not.toMatch(/title="Connected Wallets"/);
  });

  it("keeps Recovery Status, which nothing else on the page shows", () => {
    expect(src).toMatch(/title="Recovery Status"/);
  });
});

describe("copying the address uses the shared, tested copy hook", () => {
  it("does not hand-roll a second clipboard implementation", () => {
    expect(src).toMatch(/import \{ useCopy \} from "@\/lib\/hooks\/useCopy"/);
    expect(src).toMatch(/copy\(wallet\.address!, "Address copied"\)/);
  });
});
