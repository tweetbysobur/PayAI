import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The Wallets page's hero card rendered the raw 42-character wallet address
 * as its primary label whenever no username or .nad domain was set, which is
 * the common case. In a flex row with no floor width reserved for the kind
 * badge, that pushed the badge's own text into a sliver so narrow it wrapped
 * onto three lines ("PayAI / Wallet / (Embedded)"), and shoved the balance
 * column into an awkward, disconnected position beside it — reported as the
 * card "lagging" with the balance "not well placed".
 *
 * These hold the fix: a shortened/resolved identity as the primary label,
 * a badge that can't be squeezed, and a balance block that is always its own
 * clearly bounded region rather than whatever space is left over.
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

describe("identity and balance are two clearly separated regions", () => {
  it("gives the identity column min-w-0 so it truncates instead of overflowing", () => {
    expect(src).toMatch(/flex min-w-0 items-center gap-3\.5/);
  });

  it("gives the balance its own shrink-0 block, not squeezed leftover space", () => {
    expect(src).toMatch(/flex shrink-0 items-center gap-4 border-t border-border/);
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
