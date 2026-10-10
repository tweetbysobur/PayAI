const { expect } = require("chai");
const hre = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// PayAIRoomEscrow — the four 2026-10 decisions (PA-01, PA-04, PA-05, PA-11).
// PA-05 runs against an escrow deployed with the approved policy floors.
// Real contract execution on Hardhat's local EVM (not Monad).

const FIXED = 0;
const TARGET = 1;
const DAY = 86400;
const GAS = { gasLimit: 600_000 };
const S = { None: 0n, Open: 1n, Completed: 2n, Claimed: 3n, Expired: 4n, Cancelled: 5n };

describe("PayAIRoomEscrow — 2026-10 decisions", function () {
  let escrow, owner, t1, t2, t3, creator, ben, a, b, c, outsider;
  const Z = hre.ethers.ZeroAddress;
  const ONE = hre.ethers.parseEther("1");
  const HASH = hre.ethers.id("terms");
  const fee = (raised) => (raised * 50n) / 10000n;

  beforeEach(async () => {
    [owner, t1, t2, t3, creator, ben, a, b, c, outsider] = await hre.ethers.getSigners();
    escrow = await (await hre.ethers.getContractFactory("PayAIRoomEscrow")).deploy(owner.address, t1.address, 50, 1n);
  });
  const E = () => escrow.getAddress();
  const bal = (x) => hre.ethers.provider.getBalance(x);
  async function room(kind, opts = {}) {
    const share = opts.share ?? 0n, slots = opts.slots ?? 0, target = opts.target ?? share * BigInt(slots);
    const dl = BigInt(await time.latest()) + BigInt((opts.days ?? 3) * DAY);
    await escrow.connect(creator).createRoom(kind, opts.token ?? Z, opts.ben ?? ben.address, share, slots, target, opts.min ?? 0n, dl, HASH);
    return (await escrow.roomCount()) - 1n;
  }
  async function fill(id, value, who = [a, b]) {
    for (const w of who) await escrow.connect(w).contribute(id, value, { value });
  }
  async function sameBlock(fns) {
    await hre.network.provider.send("evm_setAutomine", [false]);
    const sent = [];
    try { for (const f of fns) sent.push(await f()); await hre.network.provider.send("evm_mine", []); }
    finally { await hre.network.provider.send("evm_setAutomine", [true]); }
    return Promise.all(sent.map(async (tx) => (await hre.ethers.provider.getTransactionReceipt(tx.hash)).status === 1));
  }

  /* ══ PA-01 — treasury fee recovery ═══════════════════════════════════ */
  describe("PA-01 recoverFees (owner-only, accounting-only, always to the CURRENT treasury)", () => {
    async function accrueAtT1() {
      const id = await room(FIXED, { share: ONE, slots: 2 });
      await fill(id, ONE);
      await escrow.connect(creator).claim(id);
      expect(await escrow.feesOwed(t1.address, Z)).to.equal(fee(ONE * 2n));
      return id;
    }

    it("only the owner can recover; not the old treasury, the new treasury, creators or anyone else", async () => {
      await accrueAtT1();
      await escrow.connect(owner).setTreasury(t2.address);
      for (const who of [t1, t2, creator, ben, outsider]) {
        await expect(escrow.connect(who).recoverFees(t1.address, Z)).to.be.revertedWith("not owner");
      }
    });

    it("moves the accrued balance to the current treasury: no tokens move, totals and solvency unchanged, event emitted", async () => {
      await accrueAtT1();
      const open = await room(TARGET, { target: ONE * 10n, min: 1n });
      await escrow.connect(c).contribute(open, ONE * 4n, { value: ONE * 4n });
      await escrow.connect(owner).setTreasury(t2.address);
      const before = await bal(await E());
      await expect(escrow.connect(owner).recoverFees(t1.address, Z)).to.emit(escrow, "FeesRecovered").withArgs(t1.address, t2.address, Z, fee(ONE * 2n));
      expect(await bal(await E())).to.equal(before); // accounting only
      expect(await escrow.feesOwed(t1.address, Z)).to.equal(0n);
      expect(await escrow.feesOwed(t2.address, Z)).to.equal(fee(ONE * 2n));
      await expect(escrow.withdrawFees(t1.address, Z)).to.be.revertedWith("nothing owed");
      const t2Before = await bal(t2.address);
      await escrow.connect(outsider).withdrawFees(t2.address, Z);
      expect((await bal(t2.address)) - t2Before).to.equal(fee(ONE * 2n));
      expect(await bal(await E())).to.equal(ONE * 4n); // exactly the open room's principal remains
    });

    it("validates the destination: zero / escrow can't become treasury; recovery to the same treasury and of nothing are refused", async () => {
      await accrueAtT1();
      await expect(escrow.connect(owner).setTreasury(Z)).to.be.revertedWith("bad treasury");
      await expect(escrow.connect(owner).setTreasury(await E())).to.be.revertedWith("bad treasury");
      await expect(escrow.connect(owner).recoverFees(t1.address, Z)).to.be.revertedWith("already current treasury");
      await escrow.connect(owner).setTreasury(t2.address);
      await expect(escrow.connect(owner).recoverFees(t3.address, Z)).to.be.revertedWith("nothing owed");
      await expect(escrow.connect(owner).recoverFees(t1.address, outsider.address)).to.be.revertedWith("nothing owed");
    });

    it("can't reach room principal: no address but a fee-holding treasury has anything to recover", async () => {
      const open = await room(TARGET, { target: ONE * 10n, min: 1n });
      await escrow.connect(a).contribute(open, ONE * 3n, { value: ONE * 3n });
      await escrow.connect(owner).setTreasury(t2.address);
      for (const from of [a.address, ben.address, creator.address, await E(), Z, t1.address]) {
        await expect(escrow.connect(owner).recoverFees(from, Z)).to.be.revertedWith("nothing owed");
      }
      expect(await bal(await E())).to.equal(ONE * 3n);
    });

    it("repeated redirection: T1→T2, then T2→T3; rooms keep their snapshot and later fees can be recovered again", async () => {
      const early = await room(FIXED, { share: ONE, slots: 2 }); // snapshot T1, unclaimed
      await accrueAtT1();
      await escrow.connect(owner).setTreasury(t2.address);
      await escrow.connect(owner).recoverFees(t1.address, Z);
      await escrow.connect(owner).setTreasury(t3.address);
      await escrow.connect(owner).recoverFees(t2.address, Z);
      expect(await escrow.feesOwed(t3.address, Z)).to.equal(fee(ONE * 2n));
      // The early room still has T1 as its snapshotted treasury.
      expect((await escrow.getRoom(early)).treasury).to.equal(t1.address);
      await fill(early, ONE);
      await escrow.connect(outsider).claim(early);
      expect(await escrow.feesOwed(t1.address, Z)).to.equal(fee(ONE * 2n)); // accrued at its snapshot, not silently elsewhere
      await escrow.connect(owner).recoverFees(t1.address, Z); // explicit, evented, again
      expect(await escrow.feesOwed(t3.address, Z)).to.equal(fee(ONE * 2n) * 2n);
      expect(await escrow.feesOwed(t1.address, Z)).to.equal(0n);
    });

    it("refunds, payouts and fee snapshots are unaffected by a recovery", async () => {
      await accrueAtT1();
      const expiring = await room(TARGET, { target: ONE * 10n, min: 1n, days: 1 });
      await escrow.connect(a).contribute(expiring, ONE * 2n, { value: ONE * 2n });
      const pending = await room(FIXED, { share: ONE, slots: 2 });
      await escrow.connect(owner).setTreasury(t2.address);
      await escrow.connect(owner).recoverFees(t1.address, Z);
      await fill(pending, ONE);
      const benBefore = await bal(ben.address);
      await escrow.connect(outsider).claim(pending);
      expect((await bal(ben.address)) - benBefore).to.equal(ONE * 2n - fee(ONE * 2n));
      await time.increase(2 * DAY);
      const aBefore = await bal(a.address);
      const rc = await (await escrow.connect(a).refund(expiring)).wait();
      expect((await bal(a.address)) - aBefore + rc.gasUsed * rc.gasPrice).to.equal(ONE * 2n);
    });

    it("works per token: recovering MON fees leaves token fees untouched", async () => {
      const t = await (await hre.ethers.getContractFactory("MockERC20")).deploy();
      for (const w of [a, b]) await t.mint(w.address, 10_000_000n);
      await escrow.connect(owner).setTokenSupported(await t.getAddress(), true);
      await escrow.connect(owner).setMinContributionFloor(await t.getAddress(), 1n);
      const u = await room(FIXED, { share: 1_000_000n, slots: 2, token: await t.getAddress() });
      for (const w of [a, b]) { await t.connect(w).approve(await E(), 1_000_000n); await escrow.connect(w).contribute(u, 1_000_000n); }
      await escrow.connect(creator).claim(u);
      await accrueAtT1();
      await escrow.connect(owner).setTreasury(t2.address);
      await escrow.connect(owner).recoverFees(t1.address, Z);
      expect(await escrow.feesOwed(t1.address, await t.getAddress())).to.equal(10_000n);
      expect(await escrow.feesOwed(t2.address, await t.getAddress())).to.equal(0n);
    });
  });

  /* ══ PA-04 — cancellation vs the final contribution ═══════════════════ */
  describe("PA-04 cancellation races (policy unchanged)", () => {
    it("cancel lands first: the completing contribution reverts; everyone already in refunds in full; no fee; never claimable", async () => {
      const id = await room(TARGET, { target: ONE * 10n, min: 1n });
      await escrow.connect(a).contribute(id, ONE * 7n, { value: ONE * 7n });
      const [cancelled, completed] = await sameBlock([
        () => escrow.connect(creator).cancel(id, GAS),
        () => escrow.connect(b).contribute(id, ONE * 3n, { value: ONE * 3n, ...GAS }),
      ]);
      expect([cancelled, completed]).to.deep.equal([true, false]);
      expect(await escrow.statusOf(id)).to.equal(S.Cancelled);
      await expect(escrow.connect(outsider).claim(id)).to.be.revertedWith("not complete");
      const before = await bal(a.address);
      const rc = await (await escrow.connect(a).refund(id)).wait();
      expect((await bal(a.address)) - before + rc.gasUsed * rc.gasPrice).to.equal(ONE * 7n);
      expect(await escrow.feesOwed(t1.address, Z)).to.equal(0n);
      await time.increase(10 * DAY);
      await expect(escrow.connect(outsider).claim(id)).to.be.revertedWith("not complete"); // still never claimable
    });
    it("completion lands first: cancel reverts; the claim stays valid; nobody can refund", async () => {
      const id = await room(TARGET, { target: ONE * 10n, min: 1n });
      await escrow.connect(a).contribute(id, ONE * 7n, { value: ONE * 7n });
      const [completed, cancelled] = await sameBlock([
        () => escrow.connect(b).contribute(id, ONE * 3n, { value: ONE * 3n, ...GAS }),
        () => escrow.connect(creator).cancel(id, GAS),
      ]);
      expect([completed, cancelled]).to.deep.equal([true, false]);
      expect(await escrow.statusOf(id)).to.equal(S.Completed);
      await expect(escrow.connect(a).refund(id)).to.be.revertedWith("complete");
      await escrow.connect(outsider).claim(id);
      expect(await escrow.statusOf(id)).to.equal(S.Claimed);
    });
    it("only the creator can cancel; a cancelled room can't be revived by more contributions", async () => {
      const id = await room(FIXED, { share: ONE, slots: 3 });
      await escrow.connect(a).contribute(id, ONE, { value: ONE });
      for (const w of [ben, a, outsider, owner]) await expect(escrow.connect(w).cancel(id)).to.be.revertedWith("not creator");
      await escrow.connect(creator).cancel(id);
      await expect(escrow.connect(b).contribute(id, ONE, { value: ONE })).to.be.revertedWith("cancelled");
      await expect(escrow.connect(c).contribute(id, ONE, { value: ONE })).to.be.revertedWith("cancelled");
    });
  });

  /* ══ PA-05 — what a per-room minimum does and does NOT prevent ════════ */
  describe("PA-05 platform minimum contribution (approved 2026-10-10: 0.5 USDC, 1 MON)", () => {
    // Policy values, in base units. USDC is assumed to have 6 decimals; the mock
    // asserts that below, and the app refuses to run escrow if the live token differs.
    const MON_MIN = ONE;              // 1 MON = 10^18 wei
    const USDC_MIN = 500_000n;        // 0.5 USDC = 500,000 base units (6 decimals)
    let p, usdc, U;
    beforeEach(async () => {
      p = await (await hre.ethers.getContractFactory("PayAIRoomEscrow")).deploy(owner.address, t1.address, 50, MON_MIN);
      usdc = await (await hre.ethers.getContractFactory("MockERC20")).deploy();
      U = await usdc.getAddress();
      expect(await usdc.decimals()).to.equal(6n);
      await p.connect(owner).setTokenSupported(U, true);
      await p.connect(owner).setMinContributionFloor(U, USDC_MIN);
      for (const w of [a, b, c, outsider]) { await usdc.mint(w.address, 10n ** 12n); await usdc.connect(w).approve(await p.getAddress(), 2n ** 255n); }
    });
    const dl = async () => BigInt(await time.latest()) + BigInt(3 * DAY);
    async function mk(kind, token, { share = 0n, slots = 0, target, min = 0n } = {}) {
      await p.connect(creator).createRoom(kind, token, ben.address, share, slots, target ?? share * BigInt(slots), min, await dl(), HASH);
      return (await p.roomCount()) - 1n;
    }
    const pay = (who, id, token, amt, extra = {}) => p.connect(who).contribute(id, amt, token === Z ? { value: amt, ...extra } : extra);

    it("configuration: native floor set at deploy, USDC by the owner; zero floors refused; owner-only; evented", async () => {
      expect(await p.minContributionFloor(Z)).to.equal(MON_MIN);
      expect(await p.minContributionFloor(U)).to.equal(USDC_MIN);
      const F = await hre.ethers.getContractFactory("PayAIRoomEscrow");
      await expect(F.deploy(owner.address, t1.address, 50, 0n)).to.be.revertedWith("floor zero");
      await expect(p.connect(owner).setMinContributionFloor(U, 0n)).to.be.revertedWith("floor zero");
      for (const who of [creator, ben, t1, outsider]) await expect(p.connect(who).setMinContributionFloor(U, 1n)).to.be.revertedWith("not owner");
      await expect(p.connect(owner).setMinContributionFloor(U, USDC_MIN)).to.emit(p, "MinContributionFloorSet").withArgs(U, USDC_MIN);
    });

    it("fails closed: an allowlisted token with no floor can't be used for rooms", async () => {
      const t = await (await hre.ethers.getContractFactory("MockERC20")).deploy();
      await p.connect(owner).setTokenSupported(await t.getAddress(), true);
      await expect(mk(TARGET, await t.getAddress(), { target: 10n ** 9n, min: 10n ** 6n })).to.be.revertedWith("no minimum set");
    });

    for (const [name, token, MIN] of [["MON", () => Z, MON_MIN], ["USDC", () => U, USDC_MIN]]) {
      it(`${name} creation boundaries: fixed share and target minimum below / at / above ${name} floor`, async () => {
        const tk = token();
        await expect(mk(FIXED, tk, { share: MIN - 1n, slots: 2 })).to.be.revertedWith("share below minimum");
        await mk(FIXED, tk, { share: MIN, slots: 2 });
        await mk(FIXED, tk, { share: MIN + 1n, slots: 2 });
        await expect(mk(TARGET, tk, { target: MIN * 10n, min: 0n })).to.be.revertedWith("min below minimum");
        await expect(mk(TARGET, tk, { target: MIN * 10n, min: MIN - 1n })).to.be.revertedWith("min below minimum");
        await mk(TARGET, tk, { target: MIN * 10n, min: MIN });
        await mk(TARGET, tk, { target: MIN * 10n, min: MIN + 1n });
        await expect(mk(TARGET, tk, { target: MIN - 1n, min: MIN - 1n })).to.be.revertedWith("target below minimum");
        await mk(TARGET, tk, { target: MIN, min: MIN }); // a one-contribution room at exactly the floor is valid
      });

      it(`${name} contribution boundaries: below / at / above the minimum; exact remainder below it completes`, async () => {
        const tk = token();
        const id = await mk(TARGET, tk, { target: MIN * 5n / 2n, min: MIN }); // 2.5 × floor
        await expect(pay(a, id, tk, MIN - 1n)).to.be.revertedWith("below minimum");
        await expect(pay(a, id, tk, 1n)).to.be.revertedWith("below minimum");
        await pay(a, id, tk, MIN);                    // exactly at: ok
        await pay(b, id, tk, MIN + 1n);               // above: ok → remaining = MIN/2 − 1 (< floor)
        const left = MIN * 5n / 2n - MIN - (MIN + 1n);
        expect(left).to.be.lessThan(MIN);
        await expect(pay(c, id, tk, left - 1n)).to.be.revertedWith("below minimum"); // not the exact remainder
        await expect(pay(c, id, tk, left + 1n)).to.be.revertedWith("exceeds remaining"); // no partial fill
        await pay(c, id, tk, left);                   // exact remainder below the floor: completes
        expect(await p.statusOf(id)).to.equal(S.Completed);
        const r = await p.getRoom(id);
        expect(r.raised).to.equal(r.target);
        const [net, f] = await p.claimableOf(id);
        expect(f).to.equal(fee(r.target));           // 0.5% unchanged
        expect(net + f).to.equal(r.target);
      });

      it(`${name} fixed share: every contribution is exactly the share (>= floor); anything else reverts`, async () => {
        const tk = token();
        const id = await mk(FIXED, tk, { share: MIN, slots: 2 });
        await expect(pay(a, id, tk, MIN - 1n)).to.be.revertedWith("amount != share");
        await expect(pay(a, id, tk, MIN + 1n)).to.be.revertedWith("amount != share");
        await pay(a, id, tk, MIN);
        await pay(b, id, tk, MIN);
        expect(await p.statusOf(id)).to.equal(S.Completed);
      });
    }

    it("a valid room is always completable: a griefer can push the remainder to 1 base unit, and 1 unit still completes it", async () => {
      const id = await mk(TARGET, U, { target: 3_000_000n, min: USDC_MIN }); // 3 USDC
      await pay(a, id, U, 2_000_000n);
      await pay(outsider, id, U, 999_999n);            // leaves exactly 1 base unit
      await expect(pay(b, id, U, USDC_MIN)).to.be.revertedWith("exceeds remaining");
      await pay(b, id, U, 1n);                         // the exact remainder, 1 unit, is accepted
      expect(await p.statusOf(id)).to.equal(S.Completed);
    });

    it("the reported grief: a 1-unit front-run is now impossible; the cheapest grief costs the floor and still only delays", async () => {
      for (const [tk, MIN] of [[Z, MON_MIN], [U, USDC_MIN]]) {
        const id = await mk(TARGET, tk, { target: MIN * 10n, min: MIN });
        await pay(a, id, tk, MIN * 7n);                // 3 × floor left
        // The original attack: 1 base unit ahead of the exact remainder.
        await expect(pay(outsider, id, tk, 1n)).to.be.revertedWith("below minimum");
        // The cheapest remaining grief: front-run with exactly the floor.
        const [grief, victim] = await sameBlock([
          () => pay(outsider, id, tk, MIN, GAS),
          () => pay(b, id, tk, MIN * 3n, GAS),
        ]);
        expect([grief, victim]).to.deep.equal([true, false]); // minimums REDUCE griefing; they don't eliminate it
        expect(await p.contributionOf(id, b.address)).to.equal(0n); // the victim lost only gas
        await pay(b, id, tk, MIN * 2n);                 // retry with the new remainder
        expect(await p.statusOf(id)).to.equal(S.Completed);
        expect(await p.contributionOf(id, outsider.address)).to.equal(MIN); // the griefer's floor went into the room
        await expect(p.connect(outsider).refund(id)).to.be.revertedWith("complete"); // …and is now the beneficiary's
      }
    });

    it("floor changes apply to future rooms only; existing rooms keep the minimum they were created with", async () => {
      const old = await mk(TARGET, U, { target: 5_000_000n, min: USDC_MIN });
      await p.connect(owner).setMinContributionFloor(U, 2_000_000n);   // raise to 2 USDC
      await pay(a, old, U, USDC_MIN);                                   // still 0.5 for the old room
      await expect(mk(TARGET, U, { target: 5_000_000n, min: USDC_MIN })).to.be.revertedWith("min below minimum");
      await p.connect(owner).setMinContributionFloor(U, 100_000n);     // lower to 0.1 USDC
      await expect(pay(b, old, U, 100_000n)).to.be.revertedWith("below minimum"); // old room's 0.5 holds
      expect((await p.getRoom(old)).minContribution).to.equal(USDC_MIN);
    });

    it("fixed-share rooms: the only 'grief' is taking the last slot by paying a full share; the room still succeeds", async () => {
      const id = await mk(FIXED, Z, { share: MON_MIN, slots: 2 });
      await pay(a, id, Z, MON_MIN);
      const [taker, victim] = await sameBlock([
        () => pay(outsider, id, Z, MON_MIN, GAS),
        () => pay(b, id, Z, MON_MIN, GAS),
      ]);
      expect([taker, victim]).to.deep.equal([true, false]);
      expect(await p.statusOf(id)).to.equal(S.Completed);
    });
  });

  /* ══ PA-11 — permissionless claim ═════════════════════════════════════ */
  describe("PA-11 claim() by anyone, payee fixed", () => {
    it("an unrelated account triggers the claim; the fixed beneficiary is paid; the caller gets nothing; fee accrues at the snapshot", async () => {
      const t = await (await hre.ethers.getContractFactory("MockERC20")).deploy();
      for (const w of [a, b]) await t.mint(w.address, 1_000_000_000n);
      const tk = await t.getAddress();
      await escrow.connect(owner).setTokenSupported(tk, true);
      await escrow.connect(owner).setMinContributionFloor(tk, 1n);
      const id = await room(TARGET, { token: tk, target: 1_000_000_000n, min: 1n });
      for (const [w, v] of [[a, 600_000_000n], [b, 400_000_000n]]) { await t.connect(w).approve(await E(), v); await escrow.connect(w).contribute(id, v); }
      await expect(escrow.connect(outsider).claim(id)).to.emit(escrow, "Claimed").withArgs(id, ben.address, 995_000_000n, 5_000_000n, t1.address);
      expect(await t.balanceOf(ben.address)).to.equal(995_000_000n);
      expect(await t.balanceOf(outsider.address)).to.equal(0n);
      expect(await escrow.feesOwed(t1.address, tk)).to.equal(5_000_000n);
      expect(await t.balanceOf(await E())).to.equal(5_000_000n); // only the fee remains
    });
    it("the caller can't choose a recipient: claim() takes none, claimTo() is beneficiary-only (owner included)", async () => {
      const id = await room(FIXED, { share: ONE, slots: 2 });
      await fill(id, ONE);
      for (const w of [outsider, creator, owner, a]) await expect(escrow.connect(w).claimTo(id, w.address)).to.be.revertedWith("not beneficiary");
      const before = await bal(ben.address);
      await escrow.connect(outsider).claim(id);
      expect((await bal(ben.address)) - before).to.equal(ONE * 2n - fee(ONE * 2n));
    });
    it("at most once, by anyone, through either path", async () => {
      const id = await room(FIXED, { share: ONE, slots: 2 });
      await fill(id, ONE);
      const ok = await sameBlock([
        () => escrow.connect(outsider).claim(id, GAS),
        () => escrow.connect(c).claim(id, GAS),
        () => escrow.connect(ben).claimTo(id, c.address, GAS),
      ]);
      expect(ok.filter(Boolean).length).to.equal(1);
      await expect(escrow.connect(creator).claim(id)).to.be.revertedWith("already claimed");
      expect(await escrow.feesOwed(t1.address, Z)).to.equal(fee(ONE * 2n)); // accrued once
    });
    it("never before completion, never for expired or cancelled rooms, never for unknown rooms — owner included", async () => {
      const open = await room(TARGET, { target: ONE * 10n, min: 1n, days: 1 });
      await escrow.connect(a).contribute(open, ONE, { value: ONE });
      for (const w of [outsider, owner, creator, ben]) await expect(escrow.connect(w).claim(open)).to.be.revertedWith("not complete");
      await time.increase(2 * DAY);
      await expect(escrow.connect(outsider).claim(open)).to.be.revertedWith("not complete");
      const cancelled = await room(TARGET, { target: ONE * 10n, min: 1n });
      await escrow.connect(a).contribute(cancelled, ONE, { value: ONE });
      await escrow.connect(creator).cancel(cancelled);
      await expect(escrow.connect(outsider).claim(cancelled)).to.be.revertedWith("not complete");
      await expect(escrow.connect(outsider).claim(999)).to.be.revertedWith("no room");
    });
    it("a failed payout reverts cleanly (no state change); the beneficiary can still redirect", async () => {
      const Actor = await hre.ethers.getContractFactory("RoomEscrowActor");
      const rejecting = await Actor.deploy(await E());
      await rejecting.setAcceptNative(false);
      const id = await room(FIXED, { share: ONE, slots: 2, ben: await rejecting.getAddress() });
      await fill(id, ONE);
      await expect(escrow.connect(outsider).claim(id)).to.be.revertedWith("native send failed");
      expect((await escrow.getRoom(id)).claimed).to.equal(false);
      expect(await escrow.feesOwed(t1.address, Z)).to.equal(0n); // fee not accrued by the failed attempt
      await rejecting.claimTo(id, c.address);
      expect(await escrow.feesOwed(t1.address, Z)).to.equal(fee(ONE * 2n));
    });
    it("re-entry from the beneficiary's receive hook can't claim again or bypass state", async () => {
      const Actor = await hre.ethers.getContractFactory("RoomEscrowActor");
      const hook = await Actor.deploy(await E());
      const id = await room(FIXED, { share: ONE, slots: 2, ben: await hook.getAddress() });
      await fill(id, ONE);
      await hook.setReenter(2, id); // re-enter claim()
      await escrow.connect(outsider).claim(id);
      expect(await hook.reentryBlocked()).to.equal(true);
      expect(await bal(await hook.getAddress())).to.equal(ONE * 2n - fee(ONE * 2n)); // paid exactly once
    });
  });
});
