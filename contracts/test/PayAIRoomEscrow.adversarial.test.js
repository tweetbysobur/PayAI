const { expect } = require("chai");
const hre = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// PayAIRoomEscrow — adversarial and operational cases for the pre-audit
// package. Real contract execution on Hardhat's local EVM (not Monad). Each
// test names the finding (PA-xx, see docs/rooms/ESCROW_PRE_AUDIT_PACKAGE.md)
// it demonstrates or the property it verifies.

const FIXED = 0;
const TARGET = 1;
const DAY = 86400;
const GAS = { gasLimit: 600_000 };

describe("PayAIRoomEscrow — adversarial (pre-audit)", function () {
  let escrow, owner, treasury, creator, beneficiary, a, b, c, outsider;
  const Z = hre.ethers.ZeroAddress;
  const ONE = hre.ethers.parseEther("1");
  const HASH = hre.ethers.id("terms:v1");

  beforeEach(async () => {
    [owner, treasury, creator, beneficiary, a, b, c, outsider] = await hre.ethers.getSigners();
    escrow = await (await hre.ethers.getContractFactory("PayAIRoomEscrow")).deploy(owner.address, treasury.address, 50, 1n);
  });
  const E = () => escrow.getAddress();
  const deadline = async (days = 3) => BigInt(await time.latest()) + BigInt(days * DAY);
  async function room(kind, token, opts = {}) {
    const share = opts.share ?? 0n, slots = opts.slots ?? 0, target = opts.target ?? share * BigInt(slots);
    await escrow.connect(creator).createRoom(kind, token, (opts.ben ?? beneficiary.address), share, slots, target, opts.min ?? (kind === TARGET ? 1n : 0n), await deadline(opts.days ?? 3), HASH);
    return (await escrow.roomCount()) - 1n;
  }
  async function blocklistToken(...holders) {
    const t = await (await hre.ethers.getContractFactory("PausableBlocklistERC20")).deploy();
    for (const h of holders) await t.mint(h.address, 1_000_000_000n);
    await escrow.connect(owner).setTokenSupported(await t.getAddress(), true);
    await escrow.connect(owner).setMinContributionFloor(await t.getAddress(), 1n);
    return t;
  }
  async function pay(t, who, id, amount) {
    await t.connect(who).approve(await E(), amount);
    return escrow.connect(who).contribute(id, amount);
  }

  /* ── Token issuer controls (USDC-like pause / blocklist) ─────────────── */
  describe("issuer pause and blocklist (USDC-like token)", () => {
    it("PA-03: a blocklisted beneficiary can't receive via claim(); claimTo() recovers the payout", async () => {
      const t = await blocklistToken(a, b);
      const id = await room(FIXED, await t.getAddress(), { share: 100_000_000n, slots: 2 });
      await pay(t, a, id, 100_000_000n); await pay(t, b, id, 100_000_000n);
      await t.setBlocked(beneficiary.address, true);
      await expect(escrow.connect(creator).claim(id)).to.be.revertedWith("blocklisted");
      await escrow.connect(beneficiary).claimTo(id, outsider.address);
      expect(await t.balanceOf(outsider.address)).to.equal(199_000_000n); // 200 - 0.5%
    });
    it("PA-03: a blocklisted contributor recovers via refundTo()", async () => {
      const t = await blocklistToken(a);
      const id = await room(TARGET, await t.getAddress(), { target: 1_000_000_000n, days: 1 });
      await pay(t, a, id, 5_000_000n);
      await time.increase(2 * DAY);
      await t.setBlocked(a.address, true);
      await expect(escrow.connect(a).refund(id)).to.be.revertedWith("blocklisted");
      await escrow.connect(a).refundTo(id, outsider.address);
      expect(await t.balanceOf(outsider.address)).to.equal(5_000_000n);
    });
    it("PA-01: a blocklisted TREASURY never blocks payouts, but its accrued fees can't be withdrawn while blocked (no redirect exists)", async () => {
      const t = await blocklistToken(a, b);
      const tk = await t.getAddress();
      const id = await room(FIXED, tk, { share: 100_000_000n, slots: 2 });
      await pay(t, a, id, 100_000_000n); await pay(t, b, id, 100_000_000n);
      await t.setBlocked(treasury.address, true);
      await escrow.connect(creator).claim(id); // payout unaffected
      expect(await t.balanceOf(beneficiary.address)).to.equal(199_000_000n);
      await expect(escrow.withdrawFees(treasury.address, tk)).to.be.revertedWith("blocklisted");
      expect(await escrow.feesOwed(treasury.address, tk)).to.equal(1_000_000n); // still owed, still held
      await t.setBlocked(treasury.address, false);
      await escrow.withdrawFees(treasury.address, tk);
      expect(await t.balanceOf(treasury.address)).to.equal(1_000_000n);
    });
    it("PA-02 (external): if the issuer blocklists the ESCROW itself, every movement of that token freezes until lifted", async () => {
      const t = await blocklistToken(a, b);
      const id = await room(TARGET, await t.getAddress(), { target: 100n, min: 1n, days: 1 });
      await pay(t, a, id, 40n);
      await t.setBlocked(await E(), true);
      await t.connect(b).approve(await E(), 10n);
      await expect(escrow.connect(b).contribute(id, 10n)).to.be.revertedWith("blocklisted");
      await time.increase(2 * DAY);
      await expect(escrow.connect(a).refund(id)).to.be.revertedWith("blocklisted");
      await expect(escrow.connect(a).refundTo(id, outsider.address)).to.be.revertedWith("blocklisted");
      await t.setBlocked(await E(), false);
      await escrow.connect(a).refund(id); // recovers once lifted — accounting was untouched
      expect(await t.balanceOf(a.address)).to.equal(1_000_000_000n);
    });
    it("PA-02 (external): an issuer pause spanning the deadline turns a room that would have completed into an expired, refundable one", async () => {
      const t = await blocklistToken(a, b);
      const id = await room(TARGET, await t.getAddress(), { target: 100n, min: 1n, days: 1 });
      await pay(t, a, id, 60n);
      await t.setPaused(true);
      await t.connect(b).approve(await E(), 40n);
      await expect(escrow.connect(b).contribute(id, 40n)).to.be.revertedWith("token paused");
      await time.increase(2 * DAY);
      await t.setPaused(false);
      expect(await escrow.statusOf(id)).to.equal(4n); // Expired
      await escrow.connect(a).refund(id);
      expect(await t.balanceOf(a.address)).to.equal(1_000_000_000n);
    });
  });

  /* ── Reentrant tokens ────────────────────────────────────────────────── */
  describe("token hooks that try to re-enter", () => {
    async function hookToken() {
      const t = await (await hre.ethers.getContractFactory("ReentrantHookERC20")).deploy();
      for (const h of [a, b]) await t.mint(h.address, 1_000_000n);
      await escrow.connect(owner).setTokenSupported(await t.getAddress(), true);
      await escrow.connect(owner).setMinContributionFloor(await t.getAddress(), 1n);
      return t;
    }
    it("re-entering contribute() from transferFrom is blocked; the outer contribution counts once", async () => {
      const t = await hookToken();
      const id = await room(TARGET, await t.getAddress(), { target: 1000n, min: 1n });
      await t.configure(await E(), 1, id);
      await pay(t, a, id, 100n);
      expect(await t.reentryBlocked()).to.equal(true);
      expect(await t.reentrySucceeded()).to.equal(false);
      expect((await escrow.getRoom(id)).raised).to.equal(100n);
    });
    it("re-entering refund() from transfer is blocked; refunded once", async () => {
      const t = await hookToken();
      const id = await room(TARGET, await t.getAddress(), { target: 1000n, min: 1n, days: 1 });
      await pay(t, a, id, 100n);
      await time.increase(2 * DAY);
      await t.configure(await E(), 2, id);
      await escrow.connect(a).refund(id);
      expect(await t.reentryBlocked()).to.equal(true);
      expect((await escrow.getRoom(id)).refunded).to.equal(100n);
    });
    it("re-entering claim() from the payout transfer is blocked; claimed once", async () => {
      const t = await hookToken();
      const id = await room(FIXED, await t.getAddress(), { share: 100n, slots: 2 });
      await pay(t, a, id, 100n); await pay(t, b, id, 100n);
      await t.configure(await E(), 3, id);
      await escrow.connect(creator).claim(id);
      expect(await t.reentryBlocked()).to.equal(true);
      expect(await t.balanceOf(beneficiary.address)).to.equal(199n); // 200 - floor(200*50/10000)=1
    });
  });

  it("re-entering ANY other entry point (createRoom, claimTo, refundTo, withdrawFees, cancel) from a token hook is blocked", async () => {
    const t = await (await hre.ethers.getContractFactory("ReentrantHookERC20")).deploy();
    await t.mint(a.address, 1_000_000n);
    await escrow.connect(owner).setTokenSupported(await t.getAddress(), true);
    await escrow.connect(owner).setMinContributionFloor(await t.getAddress(), 1n);
    for (const mode of [4, 5, 6, 7, 8]) {
      const id = await room(TARGET, await t.getAddress(), { target: 10_000n, min: 1n });
      await t.configure(await E(), mode, id);
      await t.connect(a).approve(await E(), 10n);
      await escrow.connect(a).contribute(id, 10n);
      expect(await t.reentryBlocked(), `mode ${mode}`).to.equal(true);
      expect(await t.reentrySucceeded(), `mode ${mode}`).to.equal(false);
      expect((await escrow.getRoom(id)).raised).to.equal(10n);
    }
  });

  /* ── Unsupported token shapes ────────────────────────────────────────── */
  it("PA-09: a token whose transfer functions return nothing (USDT-style) can't be used — contributions revert, nothing is held", async () => {
    const t = await (await hre.ethers.getContractFactory("NoReturnERC20")).deploy();
    await t.mint(a.address, 1000n);
    await escrow.connect(owner).setTokenSupported(await t.getAddress(), true);
    await escrow.connect(owner).setMinContributionFloor(await t.getAddress(), 1n);
    const id = await room(FIXED, await t.getAddress(), { share: 100n, slots: 2 });
    await t.connect(a).approve(await E(), 100n);
    await expect(escrow.connect(a).contribute(id, 100n)).to.be.reverted;
    expect((await escrow.getRoom(id)).raised).to.equal(0n);
  });

  /* ── Front-running near the target ───────────────────────────────────── */
  it("PA-05: with a 1-base-unit minimum, a 1-wei front-run makes an exact-remainder contribution revert (griefing, no loss)", async () => {
    const id = await room(TARGET, Z, { target: ONE * 10n, min: 1n });
    await escrow.connect(a).contribute(id, ONE * 9n, { value: ONE * 9n });
    await hre.network.provider.send("evm_setAutomine", [false]);
    const grief = await escrow.connect(outsider).contribute(id, 1n, { value: 1n, ...GAS });
    const victim = await escrow.connect(b).contribute(id, ONE, { value: ONE, ...GAS });
    await hre.network.provider.send("evm_mine", []);
    await hre.network.provider.send("evm_setAutomine", [true]);
    expect((await hre.ethers.provider.getTransactionReceipt(grief.hash)).status).to.equal(1);
    expect((await hre.ethers.provider.getTransactionReceipt(victim.hash)).status).to.equal(0);
    const r = await escrow.getRoom(id);
    expect(r.raised).to.equal(ONE * 9n + 1n); // the victim's MON never left their wallet
    await escrow.connect(b).contribute(id, ONE - 1n, { value: ONE - 1n }); // retry with the new remainder completes it
    expect(await escrow.statusOf(id)).to.equal(2n);
  });

  /* ── Fee withdrawal ──────────────────────────────────────────────────── */
  describe("fee withdrawal", () => {
    it("aggregates per treasury and token; withdraws exactly once; never touches room funds", async () => {
      const t = await blocklistToken(a, b);
      const tk = await t.getAddress();
      const r1 = await room(FIXED, Z, { share: ONE, slots: 2 });
      const r2 = await room(FIXED, Z, { share: ONE * 3n, slots: 2 });
      const r3 = await room(FIXED, tk, { share: 1_000_000n, slots: 2 });
      const open = await room(TARGET, Z, { target: ONE * 100n, min: 1n });
      for (const [id, v] of [[r1, ONE], [r2, ONE * 3n]]) { await escrow.connect(a).contribute(id, v, { value: v }); await escrow.connect(b).contribute(id, v, { value: v }); }
      await pay(t, a, r3, 1_000_000n); await pay(t, b, r3, 1_000_000n);
      await escrow.connect(c).contribute(open, ONE * 5n, { value: ONE * 5n });
      for (const id of [r1, r2, r3]) await escrow.connect(creator).claim(id);
      expect(await escrow.feesOwed(treasury.address, Z)).to.equal((ONE * 2n * 50n) / 10000n + (ONE * 6n * 50n) / 10000n);
      expect(await escrow.feesOwed(treasury.address, tk)).to.equal(10_000n);
      const before = await hre.ethers.provider.getBalance(treasury.address);
      await escrow.connect(outsider).withdrawFees(treasury.address, Z);
      expect((await hre.ethers.provider.getBalance(treasury.address)) - before).to.equal(ONE * 8n * 50n / 10000n);
      await expect(escrow.connect(outsider).withdrawFees(treasury.address, Z)).to.be.revertedWith("nothing owed");
      await expect(escrow.withdrawFees(outsider.address, Z)).to.be.revertedWith("nothing owed"); // no other treasury can draw
      expect(await hre.ethers.provider.getBalance(await E())).to.equal(ONE * 5n); // the open room's funds untouched
      expect(await escrow.contributionOf(open, c.address)).to.equal(ONE * 5n);
      await escrow.withdrawFees(treasury.address, tk);
      expect(await t.balanceOf(treasury.address)).to.equal(10_000n);
    });
  });

  /* ── Pause and ownership ─────────────────────────────────────────────── */
  describe("pause and ownership", () => {
    it("pause blocks only createRoom and contribute; cancel, claim, claimTo, refund, refundTo and withdrawFees still work", async () => {
      const done = await room(FIXED, Z, { share: ONE, slots: 2 });
      await escrow.connect(a).contribute(done, ONE, { value: ONE }); await escrow.connect(b).contribute(done, ONE, { value: ONE });
      const done2 = await room(FIXED, Z, { share: ONE, slots: 2 });
      await escrow.connect(a).contribute(done2, ONE, { value: ONE }); await escrow.connect(b).contribute(done2, ONE, { value: ONE });
      const open = await room(TARGET, Z, { target: ONE * 10n, min: 1n });
      await escrow.connect(a).contribute(open, ONE, { value: ONE }); await escrow.connect(b).contribute(open, ONE, { value: ONE });
      await escrow.connect(owner).setPaused(true);
      await expect(escrow.connect(c).contribute(open, ONE, { value: ONE })).to.be.revertedWith("paused");
      await escrow.connect(creator).claim(done);
      await escrow.connect(beneficiary).claimTo(done2, outsider.address);
      await escrow.connect(creator).cancel(open);
      await escrow.connect(a).refund(open);
      await escrow.connect(b).refundTo(open, outsider.address);
      await escrow.withdrawFees(treasury.address, Z);
      expect(await hre.ethers.provider.getBalance(await E())).to.equal(0n);
    });
    it("a pending owner can be replaced before acceptance; the replaced one can't accept; owner stays until accepted", async () => {
      await escrow.connect(owner).transferOwnership(a.address);
      await escrow.connect(owner).transferOwnership(b.address);
      await expect(escrow.connect(a).acceptOwnership()).to.be.revertedWith("not pending owner");
      expect(await escrow.owner()).to.equal(owner.address);
      await escrow.connect(owner).setPaused(true); // still the owner
      await escrow.connect(b).acceptOwnership();
      await expect(escrow.connect(b).acceptOwnership()).to.be.revertedWith("not pending owner");
      await expect(escrow.connect(owner).setPaused(false)).to.be.revertedWith("not owner");
      await expect(escrow.connect(owner).transferOwnership(Z)).to.be.revertedWith("not owner");
      await expect(escrow.connect(b).transferOwnership(Z)).to.be.revertedWith("owner zero");
    });
  });

  /* ── Force-sent MON ──────────────────────────────────────────────────── */
  it("PA-08: force-sent MON (selfdestruct) is an unowned surplus; it never inflates any room or fee", async () => {
    const id = await room(FIXED, Z, { share: ONE, slots: 2 });
    await escrow.connect(a).contribute(id, ONE, { value: ONE });
    await (await hre.ethers.getContractFactory("ForceSend")).deploy(await E(), { value: ONE * 7n });
    expect(await hre.ethers.provider.getBalance(await E())).to.equal(ONE * 8n);
    expect((await escrow.getRoom(id)).raised).to.equal(ONE);
    await escrow.connect(b).contribute(id, ONE, { value: ONE });
    await escrow.connect(creator).claim(id);
    await escrow.withdrawFees(treasury.address, Z);
    expect(await hre.ethers.provider.getBalance(await E())).to.equal(ONE * 7n); // surplus stays; nothing can withdraw it
  });

  /* ── Maximum room size and gas ───────────────────────────────────────── */
  it("1,000-slot fixed room: per-operation gas does not grow with the number of contributors", async function () {
    this.timeout(600_000);
    const N = 1000;
    const id = await room(FIXED, Z, { share: 1000n, slots: N, days: 30 });
    const funder = (await hre.ethers.getSigners())[0];
    const gas = [];
    for (let i = 0; i < N; i++) {
      const w = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
      await hre.network.provider.send("hardhat_setBalance", [w.address, "0xDE0B6B3A7640000"]); // 1 MON for gas
      const rc = await (await escrow.connect(w).contribute(id, 1000n, { value: 1000n })).wait();
      if (i === 0 || i === N - 2 || i === N - 1) gas.push(rc.gasUsed);
    }
    void funder;
    const r = await escrow.getRoom(id);
    expect(r.contributors).to.equal(BigInt(N));
    expect(await escrow.statusOf(id)).to.equal(2n);
    // Second-to-last vs first: same code path; must not grow with N (allow small storage-warmth variance).
    expect(gas[1] - gas[0]).to.be.lessThan(25_000n);
    const claimRc = await (await escrow.connect(creator).claim(id)).wait();
    expect(claimRc.gasUsed).to.be.lessThan(150_000n);
    console.log(`      gas: first contribute ${gas[0]}, 999th ${gas[1]}, completing 1000th ${gas[2]}, claim ${claimRc.gasUsed}`);
  });
});
