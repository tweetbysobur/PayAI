const { expect } = require("chai");
const hre = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// PayAIRoomEscrow — real contract execution on Hardhat's local EVM (not
// Monad, not a deployed address). Organised by the lifecycle scenarios the
// product requires, then fees, administration and adversarial cases.
//
// Fee policy under test: PayAI's Rooms platform fee is 0.5% (50 bps) of a
// SUCCESSFUL room's proceeds, deducted from the payout and accrued to the
// room's snapshotted treasury; contributions are exact; failed/cancelled
// rooms and refunds pay no fee.

const FIXED = 0;
const TARGET = 1;
const FEE_BPS = 50;
const S = { None: 0n, Open: 1n, Completed: 2n, Claimed: 3n, Expired: 4n, Cancelled: 5n };
const DAY = 86400;
const GAS = { gasLimit: 600_000 };

describe("PayAIRoomEscrow", function () {
  let escrow, owner, treasury, creator, beneficiary, a, b, c, d, outsider;
  const Z = hre.ethers.ZeroAddress;
  const ONE = hre.ethers.parseEther("1");
  const USD = (n) => BigInt(Math.round(n * 1e6)); // 6-decimal token units
  const HASH = hre.ethers.id("terms:v1");

  beforeEach(async () => {
    [owner, treasury, creator, beneficiary, a, b, c, d, outsider] = await hre.ethers.getSigners();
    const E = await hre.ethers.getContractFactory("PayAIRoomEscrow");
    escrow = await E.deploy(owner.address, treasury.address, FEE_BPS, 1n);
  });

  const escrowAddr = () => escrow.getAddress();
  const bal = async (addr) => hre.ethers.provider.getBalance(addr);
  const deadline = async (days = 3) => BigInt(await time.latest()) + BigInt(days * DAY);
  const fee = (raised, bps = FEE_BPS) => (raised * BigInt(bps)) / 10000n;
  async function usdc(...holders) {
    const M = await hre.ethers.getContractFactory("MockERC20");
    const t = await M.deploy();
    for (const h of holders) await t.mint(h.address, USD(1_000_000));
    await escrow.connect(owner).setTokenSupported(await t.getAddress(), true);
    await escrow.connect(owner).setMinContributionFloor(await t.getAddress(), 1n);
    return t;
  }
  async function fixedRoom({ token = Z, share = ONE, slots = 3, days = 3, ben = beneficiary } = {}) {
    const dl = await deadline(days);
    await escrow.connect(creator).createRoom(FIXED, token, ben.address, share, slots, share * BigInt(slots), 0, dl, HASH);
    return { id: (await escrow.roomCount()) - 1n, deadline: dl };
  }
  async function targetRoom({ token = Z, target = ONE * 10n, min = ONE, days = 3, ben = beneficiary } = {}) {
    const dl = await deadline(days);
    await escrow.connect(creator).createRoom(TARGET, token, ben.address, 0, 0, target, min, dl, HASH);
    return { id: (await escrow.roomCount()) - 1n, deadline: dl };
  }
  async function payUsdc(t, who, id, amount) {
    await t.connect(who).approve(await escrowAddr(), amount);
    return escrow.connect(who).contribute(id, amount);
  }
  /** Sum of what the escrow owes for `token` across rooms 0..n-1, plus accrued fees. */
  async function liabilities(token) {
    let owed = 0n;
    const n = await escrow.roomCount();
    for (let i = 0n; i < n; i++) {
      const r = await escrow.getRoom(i);
      if (r.token === token && !r.claimed) owed += r.raised - r.refunded;
    }
    return owed + (await escrow.feesOwed(treasury.address, token));
  }
  /** Send several txs into ONE block (automine off), mine, and report which succeeded. */
  async function sameBlock(fns) {
    await hre.network.provider.send("evm_setAutomine", [false]);
    const sent = [];
    try {
      for (const f of fns) sent.push(await f());
      await hre.network.provider.send("evm_mine", []);
    } finally {
      await hre.network.provider.send("evm_setAutomine", [true]);
    }
    const out = [];
    for (const tx of sent) out.push((await hre.ethers.provider.getTransactionReceipt(tx.hash)).status === 1);
    return out;
  }

  /* ── Creation and terms validation ─────────────────────────────────── */
  describe("Creation and terms validation", () => {
    it("records every term and emits them in RoomCreated", async () => {
      const dl = await deadline();
      await expect(escrow.connect(creator).createRoom(FIXED, Z, beneficiary.address, ONE, 3, ONE * 3n, 0, dl, HASH))
        .to.emit(escrow, "RoomCreated")
        .withArgs(0n, creator.address, beneficiary.address, Z, FIXED, ONE, 3, ONE * 3n, 0, dl, FEE_BPS, treasury.address, HASH);
      const r = await escrow.getRoom(0);
      expect([r.creator, r.beneficiary, r.token, r.treasury]).to.deep.equal([creator.address, beneficiary.address, Z, treasury.address]);
      expect([r.feeBps, r.deadline, r.slots, r.share, r.target, r.minContribution, r.termsHash]).to.deep.equal([50n, dl, 3n, ONE, ONE * 3n, 0n, HASH]);
      expect(await escrow.statusOf(0)).to.equal(S.Open);
    });
    it("fixed-share rules", async () => {
      const dl = await deadline();
      const c = escrow.connect(creator);
      await expect(c.createRoom(FIXED, Z, beneficiary.address, 0, 3, 0, 0, dl, HASH)).to.be.revertedWith("target zero");
      await expect(c.createRoom(FIXED, Z, beneficiary.address, 0, 3, 1, 0, dl, HASH)).to.be.revertedWith("share zero");
      await expect(c.createRoom(FIXED, Z, beneficiary.address, ONE, 1, ONE, 0, dl, HASH)).to.be.revertedWith("bad slots");
      await expect(c.createRoom(FIXED, Z, beneficiary.address, 1, 1001, 1001, 0, dl, HASH)).to.be.revertedWith("bad slots");
      await expect(c.createRoom(FIXED, Z, beneficiary.address, ONE, 3, ONE * 4n, 0, dl, HASH)).to.be.revertedWith("target != share * slots");
      await expect(c.createRoom(FIXED, Z, beneficiary.address, ONE, 3, ONE * 3n, 1, dl, HASH)).to.be.revertedWith("min not allowed");
      await c.createRoom(FIXED, Z, beneficiary.address, 1, 1000, 1000, 0, dl, HASH); // MAX_SLOTS accepted
      await c.createRoom(FIXED, Z, beneficiary.address, 1, 2, 2, 0, dl, HASH);       // MIN_SLOTS accepted
    });
    it("target rules", async () => {
      const dl = await deadline();
      const c = escrow.connect(creator);
      await expect(c.createRoom(TARGET, Z, beneficiary.address, 1, 0, ONE, 0, dl, HASH)).to.be.revertedWith("share/slots not allowed");
      await expect(c.createRoom(TARGET, Z, beneficiary.address, 0, 2, ONE, 0, dl, HASH)).to.be.revertedWith("share/slots not allowed");
      await expect(c.createRoom(TARGET, Z, beneficiary.address, 0, 0, ONE, ONE + 1n, dl, HASH)).to.be.revertedWith("min > target");
      await c.createRoom(TARGET, Z, beneficiary.address, 0, 0, ONE, ONE, dl, HASH); // min == target accepted
    });
    it("deadline window: at least 1 hour, at most 90 days, measured at creation", async () => {
      const c = escrow.connect(creator);
      const now = BigInt(await time.latest());
      await time.setNextBlockTimestamp(now + 10n);
      await expect(c.createRoom(TARGET, Z, beneficiary.address, 0, 0, ONE, 1n, now + 10n + 3599n, HASH)).to.be.revertedWith("deadline too soon");
      await time.setNextBlockTimestamp(now + 20n);
      await c.createRoom(TARGET, Z, beneficiary.address, 0, 0, ONE, 1n, now + 20n + 3600n, HASH);
      await time.setNextBlockTimestamp(now + 30n);
      await c.createRoom(TARGET, Z, beneficiary.address, 0, 0, ONE, 1n, now + 30n + 90n * 86400n, HASH);
      await time.setNextBlockTimestamp(now + 40n);
      await expect(c.createRoom(TARGET, Z, beneficiary.address, 0, 0, ONE, 1n, now + 40n + 90n * 86400n + 1n, HASH)).to.be.revertedWith("deadline too far");
    });
    it("views: unknown rooms, claimed rooms, refundable amounts", async () => {
      expect(await escrow.statusOf(42)).to.equal(S.None);
      expect(await escrow.claimableOf(42)).to.deep.equal([0n, 0n]);
      expect(await escrow.refundableOf(42, a.address)).to.equal(0n);
      const { id } = await targetRoom({ target: ONE * 10n, min: ONE, days: 1 });
      await escrow.connect(a).contribute(id, ONE * 2n, { value: ONE * 2n });
      expect(await escrow.refundableOf(id, a.address)).to.equal(0n); // open: nothing refundable yet
      await time.increase(2 * DAY);
      expect(await escrow.refundableOf(id, a.address)).to.equal(ONE * 2n);
      expect(await escrow.refundableOf(id, b.address)).to.equal(0n);
      const { id: f } = await fixedRoom({ slots: 2 });
      await escrow.connect(a).contribute(f, ONE, { value: ONE });
      await escrow.connect(b).contribute(f, ONE, { value: ONE });
      await escrow.connect(creator).claim(f);
      expect(await escrow.statusOf(f)).to.equal(S.Claimed);
      expect(await escrow.claimableOf(f)).to.deep.equal([0n, 0n]);
      await expect(escrow.connect(beneficiary).claimTo(77, a.address)).to.be.revertedWith("no room");
    });
    it("a claim whose fee floors to zero pays everything to the beneficiary and accrues nothing", async () => {
      const { id } = await fixedRoom({ share: 99n, slots: 2 }); // raised 198 → fee floor(198*50/10000) = 0
      await escrow.connect(a).contribute(id, 99n, { value: 99n });
      await escrow.connect(b).contribute(id, 99n, { value: 99n });
      await expect(escrow.connect(creator).claim(id)).to.emit(escrow, "Claimed").withArgs(id, beneficiary.address, 198n, 0n, treasury.address);
      expect(await escrow.feesOwed(treasury.address, Z)).to.equal(0n);
    });
    it("target minimum: below-min refused unless it is exactly the remainder", async () => {
      const { id } = await targetRoom({ target: ONE * 10n, min: ONE * 3n });
      await expect(escrow.connect(a).contribute(id, ONE * 2n, { value: ONE * 2n })).to.be.revertedWith("below minimum");
      await escrow.connect(a).contribute(id, ONE * 3n, { value: ONE * 3n });
      await escrow.connect(b).contribute(id, ONE * 5n, { value: ONE * 5n }); // 2 left (< min)
      await expect(escrow.connect(c).contribute(id, ONE, { value: ONE })).to.be.revertedWith("below minimum");
      await escrow.connect(c).contribute(id, ONE * 2n, { value: ONE * 2n }); // exact remainder allowed
      expect(await escrow.statusOf(id)).to.equal(S.Completed);
    });
  });

  /* ── Scenario 1: successful fixed-share room ───────────────────────── */
  describe("Scenario 1 — successful fixed-share room", () => {
    it("completes only when every share arrives; one claim; exact 0.5% fee; exact net", async () => {
      const t = await usdc(a, b, c, d);
      const tk = await t.getAddress();
      const { id } = await fixedRoom({ token: tk, share: USD(20), slots: 3 });
      await payUsdc(t, a, id, USD(20));
      await expect(payUsdc(t, a, id, USD(20))).to.be.revertedWith("already contributed");
      await expect(escrow.connect(b).contribute(id, USD(19))).to.be.revertedWith("amount != share");
      await payUsdc(t, b, id, USD(20));
      expect(await escrow.statusOf(id)).to.equal(S.Open); // 2 of 3
      await expect(escrow.connect(creator).claim(id)).to.be.revertedWith("not complete");
      await expect(payUsdc(t, c, id, USD(20))).to.emit(escrow, "RoomCompleted").withArgs(id, USD(60));
      expect(await escrow.statusOf(id)).to.equal(S.Completed);
      await expect(payUsdc(t, d, id, USD(20))).to.be.revertedWith("complete");

      const before = await t.balanceOf(beneficiary.address);
      await expect(escrow.connect(creator).claim(id)).to.emit(escrow, "Claimed").withArgs(id, beneficiary.address, USD(59.7), USD(0.3), treasury.address);
      expect((await t.balanceOf(beneficiary.address)) - before).to.equal(USD(59.7));
      expect(await escrow.feesOwed(treasury.address, tk)).to.equal(USD(0.3));
      await expect(escrow.connect(beneficiary).claim(id)).to.be.revertedWith("already claimed");
      await expect(escrow.connect(creator).claim(id)).to.be.revertedWith("already claimed");
      await escrow.connect(outsider).withdrawFees(treasury.address, tk); // anyone can trigger; only the treasury receives
      expect(await t.balanceOf(treasury.address)).to.equal(USD(0.3));
      expect(await t.balanceOf(await escrowAddr())).to.equal(0n);
      for (const w of [a, b, c]) await expect(escrow.connect(w).refund(id)).to.be.revertedWith("complete");
    });
  });

  /* ── Scenario 2: successful target room ────────────────────────────── */
  describe("Scenario 2 — successful target-based room", () => {
    it("progress reflects contributions; target reached before deadline; 1,000 USDC → 5 fee, 995 net", async () => {
      const t = await usdc(a, b, c);
      const tk = await t.getAddress();
      const { id } = await targetRoom({ token: tk, target: USD(1000), min: USD(10) });
      await payUsdc(t, a, id, USD(300));
      expect((await escrow.getRoom(id)).raised).to.equal(USD(300));
      await payUsdc(t, b, id, USD(450));
      await payUsdc(t, a, id, USD(100)); // same wallet again — allowed in target rooms
      let r = await escrow.getRoom(id);
      expect(r.raised).to.equal(USD(850));
      expect(r.contributors).to.equal(2n);
      await expect(payUsdc(t, c, id, USD(151))).to.be.revertedWith("exceeds remaining");
      await payUsdc(t, c, id, USD(150));
      expect(await escrow.statusOf(id)).to.equal(S.Completed);
      await expect(payUsdc(t, c, id, USD(10))).to.be.revertedWith("complete");
      expect(await escrow.claimableOf(id)).to.deep.equal([USD(995), USD(5)]);
      await escrow.connect(beneficiary).claim(id);
      expect(await t.balanceOf(beneficiary.address)).to.equal(USD(995));
      await escrow.withdrawFees(treasury.address, tk);
      expect(await t.balanceOf(treasury.address)).to.equal(USD(5));
    });
    it("10 USDC → 0.05 fee, 9.95 net (native MON too: 10 MON → 0.05 / 9.95)", async () => {
      const t = await usdc(a);
      const { id } = await targetRoom({ token: await t.getAddress(), target: USD(10), min: USD(1) });
      await payUsdc(t, a, id, USD(10));
      expect(await escrow.claimableOf(id)).to.deep.equal([USD(9.95), USD(0.05)]);
      const { id: m } = await targetRoom({ target: ONE * 10n, min: ONE });
      await escrow.connect(a).contribute(m, ONE * 10n, { value: ONE * 10n });
      const before = await bal(beneficiary.address);
      await escrow.connect(creator).claim(m);
      expect((await bal(beneficiary.address)) - before).to.equal(hre.ethers.parseEther("9.95"));
      expect(await escrow.feesOwed(treasury.address, Z)).to.equal(hre.ethers.parseEther("0.05"));
    });
  });

  /* ── Scenario 3: failed target room ────────────────────────────────── */
  describe("Scenario 3 — failed target-based room", () => {
    it("not claimable; every contributor recovers their full amount; treasury gets nothing", async () => {
      const t = await usdc(a, b);
      const tk = await t.getAddress();
      const { id } = await targetRoom({ token: tk, target: USD(1000), min: USD(1) });
      await payUsdc(t, a, id, USD(123.456789));
      await payUsdc(t, b, id, USD(400));
      await payUsdc(t, a, id, USD(1));
      const aStart = await t.balanceOf(a.address), bStart = await t.balanceOf(b.address);
      await time.increase(4 * DAY);
      expect(await escrow.statusOf(id)).to.equal(S.Expired);
      expect(await escrow.claimableOf(id)).to.deep.equal([0n, 0n]);
      await expect(escrow.connect(creator).claim(id)).to.be.revertedWith("not complete");
      await expect(escrow.connect(beneficiary).claimTo(id, beneficiary.address)).to.be.revertedWith("not complete");
      await expect(payUsdc(t, c, id, USD(476))).to.be.reverted; // can't complete after the deadline
      await escrow.connect(a).refund(id);
      await escrow.connect(b).refund(id);
      expect((await t.balanceOf(a.address)) - aStart).to.equal(USD(124.456789));
      expect((await t.balanceOf(b.address)) - bStart).to.equal(USD(400));
      expect(await escrow.feesOwed(treasury.address, tk)).to.equal(0n);
      expect(await t.balanceOf(treasury.address)).to.equal(0n);
      expect(await t.balanceOf(await escrowAddr())).to.equal(0n);
      await expect(escrow.connect(a).refund(id)).to.be.revertedWith("nothing to refund");
      await expect(escrow.withdrawFees(treasury.address, tk)).to.be.revertedWith("nothing owed");
    });
    it("a fixed-share room that never fills is refundable after the deadline, fee-free", async () => {
      const { id } = await fixedRoom({ slots: 3 });
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      await escrow.connect(b).contribute(id, ONE, { value: ONE });
      await time.increase(4 * DAY);
      const before = await bal(a.address);
      const rc = await (await escrow.connect(a).refund(id)).wait();
      expect((await bal(a.address)) - before + rc.gasUsed * rc.gasPrice).to.equal(ONE);
      expect(await escrow.feesOwed(treasury.address, Z)).to.equal(0n);
    });
  });

  /* ── Scenario 4: cancellation ──────────────────────────────────────── */
  describe("Scenario 4 — creator cancellation", () => {
    it("open & empty: cancels; nothing to refund; can't be claimed", async () => {
      const { id } = await targetRoom();
      await escrow.connect(creator).cancel(id);
      expect(await escrow.statusOf(id)).to.equal(S.Cancelled);
      await expect(escrow.connect(a).refund(id)).to.be.revertedWith("nothing to refund");
      await expect(escrow.connect(creator).claim(id)).to.be.revertedWith("not complete");
    });
    it("open with contributions: contributors refund in full before the deadline; creator can't claim", async () => {
      const { id } = await targetRoom();
      await escrow.connect(a).contribute(id, ONE * 3n, { value: ONE * 3n });
      await expect(escrow.connect(beneficiary).cancel(id)).to.be.revertedWith("not creator");
      await expect(escrow.connect(owner).cancel(id)).to.be.revertedWith("not creator");
      await escrow.connect(creator).cancel(id);
      await expect(escrow.connect(b).contribute(id, ONE, { value: ONE })).to.be.revertedWith("cancelled");
      await expect(escrow.connect(creator).claim(id)).to.be.revertedWith("not complete");
      await escrow.connect(a).refund(id); // immediately, no waiting for the deadline
      expect(await escrow.feesOwed(treasury.address, Z)).to.equal(0n);
      expect(await bal(await escrowAddr())).to.equal(0n);
    });
    it("can't cancel a completed room, a claimed room, an expired room, or twice", async () => {
      const { id } = await fixedRoom({ slots: 2 });
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      await escrow.connect(b).contribute(id, ONE, { value: ONE });
      await expect(escrow.connect(creator).cancel(id)).to.be.revertedWith("complete");
      await escrow.connect(creator).claim(id);
      await expect(escrow.connect(creator).cancel(id)).to.be.revertedWith("complete");
      const { id: e } = await targetRoom({ days: 1 });
      await time.increase(2 * DAY);
      await expect(escrow.connect(creator).cancel(e)).to.be.revertedWith("deadline passed");
      const { id: x } = await targetRoom();
      await escrow.connect(creator).cancel(x);
      await expect(escrow.connect(creator).cancel(x)).to.be.revertedWith("cancelled");
    });
    it("cancel vs the completing contribution in one block: exactly one wins, state stays consistent", async () => {
      const { id } = await fixedRoom({ slots: 2 });
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      const [cancelOk, contribOk] = await sameBlock([
        () => escrow.connect(creator).cancel(id, GAS),
        () => escrow.connect(b).contribute(id, ONE, { value: ONE, ...GAS }),
      ]);
      expect(cancelOk).to.equal(true);
      expect(contribOk).to.equal(false); // cancelled first in the block
      expect(await escrow.statusOf(id)).to.equal(S.Cancelled);
      expect(await bal(await escrowAddr())).to.equal(ONE);
    });
  });

  /* ── Scenario 5: adversarial and boundary cases ────────────────────── */
  describe("Scenario 5 — adversarial and boundaries", () => {
    it("deadline: deadline-1 accepted; exactly at deadline and after rejected; refund opens exactly at deadline", async () => {
      const { id, deadline: dl } = await targetRoom({ target: ONE * 10n, min: 1n });
      await time.setNextBlockTimestamp(dl - 1n);
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      await time.setNextBlockTimestamp(dl);
      await expect(escrow.connect(b).contribute(id, ONE, { value: ONE })).to.be.revertedWith("deadline passed");
      await expect(escrow.connect(b).contribute(id, ONE, { value: ONE })).to.be.revertedWith("deadline passed");
      expect(await escrow.statusOf(id)).to.equal(S.Expired);
      await escrow.connect(a).refund(id);
    });
    it("a room completed in time stays claimable after its deadline and is never refundable", async () => {
      const { id } = await fixedRoom({ slots: 2 });
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      await escrow.connect(b).contribute(id, ONE, { value: ONE });
      await time.increase(30 * DAY);
      expect(await escrow.statusOf(id)).to.equal(S.Completed);
      await expect(escrow.connect(a).refund(id)).to.be.revertedWith("complete");
      expect(await escrow.refundableOf(id, a.address)).to.equal(0n);
      await escrow.connect(creator).claim(id);
    });
    it("concurrent contributions near the target: the one that would overshoot reverts; target never exceeded", async () => {
      const { id } = await targetRoom({ target: ONE * 10n, min: ONE });
      await escrow.connect(a).contribute(id, ONE * 7n, { value: ONE * 7n });
      const ok = await sameBlock([
        () => escrow.connect(b).contribute(id, ONE * 2n, { value: ONE * 2n, ...GAS }),
        () => escrow.connect(c).contribute(id, ONE * 2n, { value: ONE * 2n, ...GAS }),
        () => escrow.connect(d).contribute(id, ONE, { value: ONE, ...GAS }),
      ]);
      expect(ok).to.deep.equal([true, false, true]);
      const r = await escrow.getRoom(id);
      expect(r.raised).to.equal(r.target);
      expect(await bal(await escrowAddr())).to.equal(ONE * 10n); // the reverted contribution's MON never arrived
    });
    it("concurrent fixed shares for the last slot: one fills it, the other reverts", async () => {
      const { id } = await fixedRoom({ slots: 2 });
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      const ok = await sameBlock([
        () => escrow.connect(b).contribute(id, ONE, { value: ONE, ...GAS }),
        () => escrow.connect(c).contribute(id, ONE, { value: ONE, ...GAS }),
      ]);
      expect(ok).to.deep.equal([true, false]);
      expect((await escrow.getRoom(id)).contributors).to.equal(2n);
    });
    it("concurrent and repeated claims: paid exactly once", async () => {
      const { id } = await fixedRoom({ slots: 2 });
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      await escrow.connect(b).contribute(id, ONE, { value: ONE });
      const ok = await sameBlock([
        () => escrow.connect(creator).claim(id, GAS),
        () => escrow.connect(beneficiary).claim(id, GAS),
        () => escrow.connect(beneficiary).claimTo(id, d.address, GAS),
      ]);
      expect(ok.filter(Boolean).length).to.equal(1);
      expect(await bal(await escrowAddr())).to.equal(fee(ONE * 2n)); // only the accrued fee remains
    });
    it("concurrent and repeated refunds: each contributor refunded exactly once", async () => {
      const { id } = await targetRoom({ target: ONE * 10n, min: ONE });
      await escrow.connect(a).contribute(id, ONE * 2n, { value: ONE * 2n });
      await escrow.connect(b).contribute(id, ONE * 3n, { value: ONE * 3n });
      await time.increase(4 * DAY);
      const ok = await sameBlock([
        () => escrow.connect(a).refund(id, GAS),
        () => escrow.connect(a).refund(id, GAS),
        () => escrow.connect(b).refund(id, GAS),
        () => escrow.connect(a).refundTo(id, d.address, GAS),
      ]);
      expect(ok).to.deep.equal([true, false, true, false]);
      expect((await escrow.getRoom(id)).refunded).to.equal(ONE * 5n);
      expect(await bal(await escrowAddr())).to.equal(0n);
    });
    it("wrong token, unsupported token, zero amounts, wrong value, malformed ids", async () => {
      const t = await usdc(a);
      const { id } = await fixedRoom({ share: ONE, slots: 2 }); // a MON room
      await t.connect(a).approve(await escrowAddr(), ONE);
      await expect(escrow.connect(a).contribute(id, ONE)).to.be.revertedWith("value != amount"); // no MON sent
      await expect(escrow.connect(a).contribute(id, 0, { value: 0 })).to.be.revertedWith("amount zero");
      await expect(escrow.connect(a).contribute(id, ONE, { value: ONE - 1n })).to.be.revertedWith("value != amount");
      await expect(escrow.connect(a).contribute(999, ONE, { value: ONE })).to.be.revertedWith("no room");
      const { id: u } = await fixedRoom({ token: await t.getAddress(), share: USD(5), slots: 2 });
      await expect(escrow.connect(a).contribute(u, USD(5), { value: USD(5) })).to.be.revertedWith("native not accepted");
      const M = await hre.ethers.getContractFactory("MockERC20");
      const rogue = await M.deploy();
      await expect(escrow.connect(creator).createRoom(FIXED, await rogue.getAddress(), beneficiary.address, 1, 2, 2, 0, await deadline(), HASH)).to.be.revertedWith("token not supported");
      for (const fn of ["claim", "refund", "cancel"]) await expect(escrow.connect(creator)[fn](999)).to.be.revertedWith("no room");
    });
    it("invalid recipients are refused everywhere", async () => {
      const dl = await deadline();
      await expect(escrow.connect(creator).createRoom(TARGET, Z, Z, 0, 0, ONE, 0, dl, HASH)).to.be.revertedWith("bad beneficiary");
      await expect(escrow.connect(creator).createRoom(TARGET, Z, await escrowAddr(), 0, 0, ONE, 0, dl, HASH)).to.be.revertedWith("bad beneficiary");
      const { id } = await fixedRoom({ slots: 2 });
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      await escrow.connect(b).contribute(id, ONE, { value: ONE });
      await expect(escrow.connect(beneficiary).claimTo(id, Z)).to.be.revertedWith("bad recipient");
      await expect(escrow.connect(beneficiary).claimTo(id, await escrowAddr())).to.be.revertedWith("bad recipient");
      await expect(escrow.connect(creator).claimTo(id, creator.address)).to.be.revertedWith("not beneficiary");
      const { id: r2 } = await targetRoom({ days: 1 });
      await escrow.connect(a).contribute(r2, ONE, { value: ONE });
      await time.increase(2 * DAY);
      await expect(escrow.connect(a).refundTo(r2, Z)).to.be.revertedWith("bad recipient");
      await expect(escrow.connect(a).refundTo(r2, await escrowAddr())).to.be.revertedWith("bad recipient");
    });
    it("failed token transfers: short delivery reverts the contribution; a false-returning token reverts", async () => {
      const S1 = await hre.ethers.getContractFactory("ShortTransferERC20");
      const short = await S1.deploy();
      await short.mint(a.address, 1000n);
      await escrow.connect(owner).setTokenSupported(await short.getAddress(), true);
      await escrow.connect(owner).setMinContributionFloor(await short.getAddress(), 1n);
      const { id } = await fixedRoom({ token: await short.getAddress(), share: 100n, slots: 2 });
      await short.connect(a).approve(await escrowAddr(), 100n);
      await expect(escrow.connect(a).contribute(id, 100n)).to.be.revertedWith("short delivery");
      expect((await escrow.getRoom(id)).raised).to.equal(0n);
      const F = await hre.ethers.getContractFactory("FalseReturningERC20");
      const falsy = await F.deploy();
      await falsy.mint(a.address, 1000n);
      await escrow.connect(owner).setTokenSupported(await falsy.getAddress(), true);
      await escrow.connect(owner).setMinContributionFloor(await falsy.getAddress(), 1n);
      const { id: f } = await fixedRoom({ token: await falsy.getAddress(), share: 100n, slots: 2 });
      await falsy.connect(a).approve(await escrowAddr(), 100n);
      await expect(escrow.connect(a).contribute(f, 100n)).to.be.revertedWith("transferFrom failed");
    });
    it("reentrancy from refund and claim hooks is blocked; other rooms untouched", async () => {
      const Actor = await hre.ethers.getContractFactory("RoomEscrowActor");
      const actor = await Actor.deploy(await escrowAddr());
      const { id } = await targetRoom({ target: ONE * 10n, min: ONE });
      await actor.contribute(id, ONE, { value: ONE });
      await escrow.connect(b).contribute(id, ONE, { value: ONE });
      await time.increase(4 * DAY);
      await actor.setReenter(1, id);
      await actor.refund(id);
      expect(await actor.reentryBlocked()).to.equal(true);
      expect(await bal(await escrowAddr())).to.equal(ONE);

      const ben = await Actor.deploy(await escrowAddr());
      const dl = await deadline();
      await escrow.connect(creator).createRoom(FIXED, Z, await ben.getAddress(), ONE, 2, ONE * 2n, 0, dl, HASH);
      const rid = (await escrow.roomCount()) - 1n;
      await escrow.connect(a).contribute(rid, ONE, { value: ONE });
      await escrow.connect(b).contribute(rid, ONE, { value: ONE });
      await ben.setReenter(2, rid);
      await escrow.connect(creator).claim(rid);
      expect(await ben.reentryBlocked()).to.equal(true);
      expect((await escrow.getRoom(rid)).claimed).to.equal(true);
    });
    it("fee rounding: floors, never rounds up; small rooms can owe zero fee; 18 and 6 decimals", async () => {
      const t = await usdc(a);
      for (const [target, expFee] of [[USD(10), USD(0.05)], [USD(0.01), 50n], [199n, 0n], [200n, 1n], [399n, 1n], [1n, 0n]]) {
        const { id } = await targetRoom({ token: await t.getAddress(), target, min: 1n });
        await payUsdc(t, a, id, target);
        const [net, f] = await escrow.claimableOf(id);
        expect(f).to.equal(expFee);
        expect(net + f).to.equal(target);
      }
      const { id: m } = await targetRoom({ target: 1_000_000_000_000_000_001n, min: 1n });
      await escrow.connect(a).contribute(m, 1_000_000_000_000_000_001n, { value: 1_000_000_000_000_000_001n });
      expect((await escrow.claimableOf(m))[1]).to.equal(5_000_000_000_000_000n); // floor
    });
    it("a beneficiary that can't receive MON can't block itself forever: it redirects with claimTo", async () => {
      const Actor = await hre.ethers.getContractFactory("RoomEscrowActor");
      const ben = await Actor.deploy(await escrowAddr());
      await ben.setAcceptNative(false);
      const dl = await deadline();
      await escrow.connect(creator).createRoom(FIXED, Z, await ben.getAddress(), ONE, 2, ONE * 2n, 0, dl, HASH);
      const id = (await escrow.roomCount()) - 1n;
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      await escrow.connect(b).contribute(id, ONE, { value: ONE });
      await expect(escrow.connect(creator).claim(id)).to.be.revertedWith("native send failed");
      expect((await escrow.getRoom(id)).claimed).to.equal(false); // the failed attempt left no trace
      const before = await bal(d.address);
      await ben.claimTo(id, d.address);
      expect((await bal(d.address)) - before).to.equal(ONE * 2n - fee(ONE * 2n));
    });
    it("a treasury that can't receive never blocks a payout (fees accrue; only the treasury can ever get them)", async () => {
      const Actor = await hre.ethers.getContractFactory("RoomEscrowActor");
      const badTreasury = await Actor.deploy(await escrowAddr());
      await badTreasury.setAcceptNative(false);
      await escrow.connect(owner).setTreasury(await badTreasury.getAddress());
      const { id } = await fixedRoom({ slots: 2 });
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      await escrow.connect(b).contribute(id, ONE, { value: ONE });
      await escrow.connect(creator).claim(id); // succeeds despite the treasury
      await expect(escrow.withdrawFees(await badTreasury.getAddress(), Z)).to.be.revertedWith("native send failed");
      expect(await escrow.feesOwed(await badTreasury.getAddress(), Z)).to.equal(fee(ONE * 2n));
      await badTreasury.setAcceptNative(true);
      await escrow.connect(outsider).withdrawFees(await badTreasury.getAddress(), Z);
      expect(await escrow.feesOwed(await badTreasury.getAddress(), Z)).to.equal(0n);
    });
    it("a contributor that can't receive MON recovers via refundTo; others unaffected", async () => {
      const Actor = await hre.ethers.getContractFactory("RoomEscrowActor");
      const actor = await Actor.deploy(await escrowAddr());
      const { id } = await targetRoom({ target: ONE * 10n, min: ONE });
      await actor.contribute(id, ONE, { value: ONE });
      await escrow.connect(b).contribute(id, ONE, { value: ONE });
      await time.increase(4 * DAY);
      await actor.setAcceptNative(false);
      await expect(actor.refund(id)).to.be.revertedWith("native send failed");
      await escrow.connect(b).refund(id);
      const before = await bal(d.address);
      await actor.refundTo(id, d.address);
      expect((await bal(d.address)) - before).to.equal(ONE);
    });
    it("DESIGN LIMITATION: a token that short-delivers on OUTGOING transfers can't be paid out — only reachable via the owner's allowlist", async () => {
      const M = await hre.ethers.getContractFactory("ShortOnTransferOutERC20");
      const t = await M.deploy();
      await t.mint(a.address, 1000n); await t.mint(b.address, 1000n);
      await escrow.connect(owner).setTokenSupported(await t.getAddress(), true);
      await escrow.connect(owner).setMinContributionFloor(await t.getAddress(), 1n);
      const { id } = await fixedRoom({ token: await t.getAddress(), share: 100n, slots: 2 });
      for (const w of [a, b]) { await t.connect(w).approve(await escrowAddr(), 100n); await escrow.connect(w).contribute(id, 100n); }
      await expect(escrow.connect(creator).claim(id)).to.be.revertedWith("short transfer");
      expect((await escrow.getRoom(id)).claimed).to.equal(false); // reverted cleanly; nothing paid twice or lost to a third party
    });
    it("targets beyond MAX_TARGET are refused (claim arithmetic can never overflow)", async () => {
      const max = await escrow.MAX_TARGET();
      await expect(escrow.connect(creator).createRoom(TARGET, Z, beneficiary.address, 0, 0, max + 1n, 1n, await deadline(), HASH)).to.be.revertedWith("target too large");
      await escrow.connect(creator).createRoom(TARGET, Z, beneficiary.address, 0, 0, max, 1n, await deadline(), HASH);
      expect(max * 50n / 10000n).to.be.greaterThan(0n); // no overflow at the cap
    });
  });

  /* ── Fee configuration ─────────────────────────────────────────────── */
  describe("Fee configuration (0.5%)", () => {
    it("deploys at 50 bps; the cap is 50 bps; 51 and the old 100 are impossible", async () => {
      expect(await escrow.feeBps()).to.equal(50n);
      expect(await escrow.MAX_FEE_BPS()).to.equal(50n);
      const E = await hre.ethers.getContractFactory("PayAIRoomEscrow");
      await expect(E.deploy(owner.address, treasury.address, 51, 1n)).to.be.revertedWith("fee too high");
      await expect(escrow.connect(owner).setFeeBps(51)).to.be.revertedWith("fee too high");
      await expect(escrow.connect(owner).setFeeBps(100)).to.be.revertedWith("fee too high");
    });
    it("REGRESSION: a room created at 50 bps never pays the old 0.25%", async () => {
      const { id } = await fixedRoom({ share: ONE * 5n, slots: 2 });
      expect((await escrow.getRoom(id)).feeBps).to.equal(50n);
      await escrow.connect(a).contribute(id, ONE * 5n, { value: ONE * 5n });
      await escrow.connect(b).contribute(id, ONE * 5n, { value: ONE * 5n });
      const [, f] = await escrow.claimableOf(id);
      expect(f).to.equal(hre.ethers.parseEther("0.05"));
      expect(f).to.not.equal(hre.ethers.parseEther("0.025"));
    });
    it("fee and treasury changes apply only to rooms created afterwards (terms are snapshotted)", async () => {
      const { id } = await fixedRoom({ slots: 2 });
      await escrow.connect(owner).setFeeBps(10);
      await escrow.connect(owner).setTreasury(outsider.address);
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      await escrow.connect(b).contribute(id, ONE, { value: ONE });
      await escrow.connect(creator).claim(id);
      expect(await escrow.feesOwed(treasury.address, Z)).to.equal(fee(ONE * 2n, 50));
      expect(await escrow.feesOwed(outsider.address, Z)).to.equal(0n);
      const { id: id2 } = await fixedRoom({ slots: 2 });
      const r2 = await escrow.getRoom(id2);
      expect(r2.feeBps).to.equal(10n);
      expect(r2.treasury).to.equal(outsider.address);
    });
    it("contributors authorise exactly their contribution (no fee on top)", async () => {
      const t = await usdc(a);
      const { id } = await targetRoom({ token: await t.getAddress(), target: USD(100), min: 1n });
      await t.connect(a).approve(await escrowAddr(), USD(40));
      await escrow.connect(a).contribute(id, USD(40));
      expect(await t.allowance(a.address, await escrowAddr())).to.equal(0n);
      expect(await escrow.contributionOf(id, a.address)).to.equal(USD(40));
    });
  });

  /* ── Administration ────────────────────────────────────────────────── */
  describe("Administration", () => {
    it("only the owner administers; pause blocks only new rooms and contributions", async () => {
      for (const [fn, args] of [["setPaused", [true]], ["setFeeBps", [10]], ["setTreasury", [outsider.address]], ["setTokenSupported", [outsider.address, true]], ["setMinContributionFloor", [Z, 5n]], ["transferOwnership", [outsider.address]]]) {
        await expect(escrow.connect(outsider)[fn](...args)).to.be.revertedWith("not owner");
      }
      const { id: done } = await fixedRoom({ slots: 2 });
      await escrow.connect(a).contribute(done, ONE, { value: ONE });
      await escrow.connect(b).contribute(done, ONE, { value: ONE });
      const { id: open } = await targetRoom({ days: 1 });
      await escrow.connect(a).contribute(open, ONE, { value: ONE });
      await escrow.connect(owner).setPaused(true);
      await expect(escrow.connect(creator).createRoom(TARGET, Z, beneficiary.address, 0, 0, ONE, 0, await deadline(), HASH)).to.be.revertedWith("paused");
      await expect(escrow.connect(b).contribute(open, ONE, { value: ONE })).to.be.revertedWith("paused");
      await escrow.connect(creator).claim(done);
      await escrow.withdrawFees(treasury.address, Z);
      await escrow.connect(creator).cancel(open);
      await escrow.connect(a).refund(open);
    });
    it("two-step ownership: nothing changes until the new owner accepts", async () => {
      await escrow.connect(owner).transferOwnership(outsider.address);
      expect(await escrow.owner()).to.equal(owner.address);
      await expect(escrow.connect(a).acceptOwnership()).to.be.revertedWith("not pending owner");
      await escrow.connect(outsider).acceptOwnership();
      expect(await escrow.owner()).to.equal(outsider.address);
      expect(await escrow.pendingOwner()).to.equal(Z);
      await expect(escrow.connect(owner).setPaused(true)).to.be.revertedWith("not owner");
    });
    it("constructor validation; stray MON refused", async () => {
      const E = await hre.ethers.getContractFactory("PayAIRoomEscrow");
      await expect(E.deploy(Z, treasury.address, 50, 1n)).to.be.revertedWith("owner zero");
      await expect(E.deploy(owner.address, Z, 50, 1n)).to.be.revertedWith("bad treasury");
      await expect(escrow.connect(owner).setTreasury(await escrowAddr())).to.be.revertedWith("bad treasury");
      await expect(escrow.connect(owner).setTokenSupported(Z, true)).to.be.revertedWith("native always supported");
      await expect(a.sendTransaction({ to: await escrowAddr(), value: 1n })).to.be.revertedWith("use contribute");
    });
    it("delisting a token blocks new rooms in it but never touches existing rooms", async () => {
      const t = await usdc(a, b);
      const tk = await t.getAddress();
      const { id } = await fixedRoom({ token: tk, share: USD(1), slots: 2 });
      await escrow.connect(owner).setTokenSupported(tk, false);
      await payUsdc(t, a, id, USD(1));
      await payUsdc(t, b, id, USD(1));
      await escrow.connect(creator).claim(id);
      await expect(escrow.connect(creator).createRoom(FIXED, tk, beneficiary.address, 1, 2, 2, 0, await deadline(), HASH)).to.be.revertedWith("token not supported");
    });
    it("the complete mutating surface — no owner function moves room funds; recoverFees only re-assigns accrued fees", async () => {
      const fns = escrow.interface.fragments.filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)).map((f) => f.name).sort();
      expect(fns).to.deep.equal(["acceptOwnership", "cancel", "claim", "claimTo", "contribute", "createRoom", "recoverFees", "refund", "refundTo", "setFeeBps", "setMinContributionFloor", "setPaused", "setTokenSupported", "setTreasury", "transferOwnership", "withdrawFees"]);
    });
  });

  /* ── Invariants ────────────────────────────────────────────────────── */
  describe("Solvency invariant", () => {
    it("after every step, the escrow's balance equals unclaimed room funds plus accrued fees (MON and USDC)", async () => {
      const t = await usdc(a, b, c);
      const tk = await t.getAddress();
      const { id: m1 } = await targetRoom({ target: ONE * 5n, min: 1n, days: 2 });
      const { id: m2 } = await fixedRoom({ slots: 2, days: 5 });
      const { id: u1 } = await targetRoom({ token: tk, target: USD(50), min: USD(1), days: 5 });
      const steps = [
        () => escrow.connect(a).contribute(m1, ONE, { value: ONE }),
        () => escrow.connect(b).contribute(m2, ONE, { value: ONE }),
        () => payUsdc(t, a, u1, USD(20)),
        () => escrow.connect(c).contribute(m1, ONE * 2n, { value: ONE * 2n }),
        () => escrow.connect(a).contribute(m2, ONE, { value: ONE }),
        () => payUsdc(t, b, u1, USD(30)),
        () => escrow.connect(creator).claim(m2),
        () => escrow.connect(beneficiary).claim(u1),
        () => time.increase(3 * DAY),
        () => escrow.connect(a).refund(m1),
        () => escrow.withdrawFees(treasury.address, Z),
        () => escrow.connect(c).refund(m1),
        () => escrow.withdrawFees(treasury.address, tk),
      ];
      for (const s of steps) {
        await s();
        expect(await bal(await escrowAddr())).to.equal(await liabilities(Z));
        expect(await t.balanceOf(await escrowAddr())).to.equal(await liabilities(tk));
      }
      expect(await bal(await escrowAddr())).to.equal(0n);
      expect(await t.balanceOf(await escrowAddr())).to.equal(0n);
    });
  });
});
