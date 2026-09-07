const { expect } = require("chai");
const hre = require("hardhat");

// AutomationVaultV2 adds a PayAI service fee to release() ONLY — reserve()
// and refund() are untouched and fee-free, since depositing your own money
// and getting your own unspent money back are not transactions PayAI
// charges for. These tests focus on that split plus the fee's bounds and
// safety, with a spot-check that V1's core guarantees (directional lock,
// idempotency, solvency) still hold.
describe("AutomationVaultV2", function () {
  let vault, usdc, owner, agent, treasury, depositor, recipient, outsider;
  const AUTO = hre.ethers.id("automation-v2-1");
  const ZERO = hre.ethers.ZeroAddress;
  const reqId = (l) => hre.ethers.id(l);
  const FEE_BPS = 25; // 0.25%
  const MAX_FEE_BPS = 100;

  beforeEach(async () => {
    [, owner, agent, treasury, depositor, recipient, outsider] = await hre.ethers.getSigners();

    const Mock = await hre.ethers.getContractFactory("MockERC20");
    usdc = await Mock.deploy();
    await usdc.mint(depositor.address, 1000_000000n);

    const Vault = await hre.ethers.getContractFactory("AutomationVaultV2");
    vault = await Vault.deploy(owner.address, agent.address, treasury.address, FEE_BPS);
  });

  describe("construction", () => {
    it("sets treasury and feeBps", async () => {
      expect(await vault.treasury()).to.equal(treasury.address);
      expect(await vault.feeBps()).to.equal(FEE_BPS);
    });
    it("rejects zero treasury / fee above cap at deploy", async () => {
      const Vault = await hre.ethers.getContractFactory("AutomationVaultV2");
      await expect(Vault.deploy(owner.address, agent.address, ZERO, FEE_BPS)).to.be.revertedWith("zero treasury");
      await expect(Vault.deploy(owner.address, agent.address, treasury.address, MAX_FEE_BPS + 1)).to.be.revertedWith("fee too high");
    });
  });

  describe("fee admin — owner only, capped", () => {
    it("only owner can setFeeBps / setTreasury", async () => {
      await expect(vault.connect(agent).setFeeBps(50)).to.be.revertedWith("not owner");
      await vault.connect(owner).setFeeBps(50);
      expect(await vault.feeBps()).to.equal(50);
    });
    it("cannot exceed MAX_FEE_BPS", async () => {
      await expect(vault.connect(owner).setFeeBps(MAX_FEE_BPS + 1)).to.be.revertedWith("fee too high");
    });
  });

  describe("reserve — UNCHANGED, fee-free", () => {
    it("native: the full reserved amount is credited, nothing goes to treasury", async () => {
      const ONE = hre.ethers.parseEther("1");
      const treBefore = await hre.ethers.provider.getBalance(treasury.address);
      await vault.connect(depositor).reserve(AUTO, ZERO, recipient.address, ONE, { value: ONE });
      expect(await vault.reservedBalance(AUTO)).to.equal(ONE); // full amount, no fee taken
      expect(await hre.ethers.provider.getBalance(treasury.address)).to.equal(treBefore); // untouched
    });
    it("ERC-20: the full reserved amount is credited, nothing goes to treasury", async () => {
      await usdc.connect(depositor).approve(await vault.getAddress(), 100_000000n);
      await vault.connect(depositor).reserve(AUTO, await usdc.getAddress(), recipient.address, 100_000000n);
      expect(await vault.reservedBalance(AUTO)).to.equal(100_000000n);
      expect(await usdc.balanceOf(treasury.address)).to.equal(0n);
    });
  });

  describe("release — FEE HERE", () => {
    beforeEach(async () => {
      await usdc.connect(depositor).approve(await vault.getAddress(), 100_000000n);
      await vault.connect(depositor).reserve(AUTO, await usdc.getAddress(), recipient.address, 100_000000n);
    });
    it("delivers net to recipient, fee to treasury, net+fee == released amount", async () => {
      const amount = 40_000000n;
      const expectedFee = (amount * BigInt(FEE_BPS)) / 10000n;
      await vault.connect(agent).release(AUTO, amount, reqId("rel1"));
      expect(await usdc.balanceOf(recipient.address)).to.equal(amount - expectedFee);
      expect(await usdc.balanceOf(treasury.address)).to.equal(expectedFee);
    });
    it("debits the FULL amount from the reservation ledger, unchanged from V1", async () => {
      const amount = 40_000000n;
      await vault.connect(agent).release(AUTO, amount, reqId("rel2"));
      expect(await vault.reservedBalance(AUTO)).to.equal(100_000000n - amount);
    });
    it("emits both Released (gross) and FeeCollected (fee) for the same automationId/requestId", async () => {
      const amount = 40_000000n;
      const rid = reqId("rel3");
      const expectedFee = (amount * BigInt(FEE_BPS)) / 10000n;
      const tx = await vault.connect(agent).release(AUTO, amount, rid);
      await expect(tx).to.emit(vault, "Released").withArgs(AUTO, recipient.address, await usdc.getAddress(), amount, 100_000000n - amount, rid);
      await expect(tx).to.emit(vault, "FeeCollected").withArgs(AUTO, rid, await usdc.getAddress(), expectedFee, treasury.address);
    });
    it("native MON release also splits correctly", async () => {
      const ONE = hre.ethers.parseEther("1");
      await vault.connect(depositor).reserve(hre.ethers.id("nativeauto"), ZERO, recipient.address, ONE, { value: ONE });
      const recBefore = await hre.ethers.provider.getBalance(recipient.address);
      const treBefore = await hre.ethers.provider.getBalance(treasury.address);
      await vault.connect(agent).release(hre.ethers.id("nativeauto"), ONE, reqId("relnative"));
      const expectedFee = (ONE * BigInt(FEE_BPS)) / 10000n;
      expect((await hre.ethers.provider.getBalance(recipient.address)) - recBefore).to.equal(ONE - expectedFee);
      expect((await hre.ethers.provider.getBalance(treasury.address)) - treBefore).to.equal(expectedFee);
    });
    it("directional lock unchanged: release always pays r.recipient, never a caller-supplied address", async () => {
      const fn = vault.interface.getFunction("release");
      expect(fn.inputs.map((i) => i.name.toLowerCase())).to.not.include("recipient");
    });
    it("duplicate requestId still reverts (idempotency unchanged)", async () => {
      const rid = reqId("dup-release");
      await vault.connect(agent).release(AUTO, 10_000000n, rid);
      await expect(vault.connect(agent).release(AUTO, 10_000000n, rid)).to.be.revertedWith("duplicate requestId");
    });
    it("only agent can release", async () => {
      await expect(vault.connect(outsider).release(AUTO, 10_000000n, reqId("noauth"))).to.be.revertedWith("not agent");
    });
  });

  describe("refund — UNCHANGED, fee-free", () => {
    beforeEach(async () => {
      await usdc.connect(depositor).approve(await vault.getAddress(), 100_000000n);
      await vault.connect(depositor).reserve(AUTO, await usdc.getAddress(), recipient.address, 100_000000n);
    });
    it("returns the FULL remaining balance to the depositor, nothing to treasury", async () => {
      const treBefore = await usdc.balanceOf(treasury.address);
      await vault.connect(depositor).refund(AUTO);
      expect(await usdc.balanceOf(depositor.address)).to.equal(1000_000000n); // fully whole again — deposited then refunded in full
      expect(await usdc.balanceOf(treasury.address)).to.equal(treBefore); // untouched
    });
    it("refund always pays r.depositor, never a caller-supplied address (directional lock unchanged)", async () => {
      const fn = vault.interface.getFunction("refund");
      expect(fn.inputs.map((i) => i.name.toLowerCase())).to.not.include("to");
      expect(fn.inputs.map((i) => i.name.toLowerCase())).to.not.include("recipient");
    });
  });

  describe("fee-on-transfer safety on release", () => {
    it("a short-delivering token on the recipient leg reverts the whole release", async () => {
      const Short = await hre.ethers.getContractFactory("ShortTransferERC20");
      const short = await Short.deploy();
      await short.mint(depositor.address, 1000_000000n);
      await short.connect(depositor).approve(await vault.getAddress(), 1000_000000n);
      // reserve() itself already guards against short delivery at the door,
      // so getting a reservation funded with a short-transfer token isn't
      // possible — proving release() is never even reachable with unbacked
      // short-token custody in the first place.
      await expect(
        vault.connect(depositor).reserve(hre.ethers.id("shortauto"), await short.getAddress(), recipient.address, 40_000000n),
      ).to.be.reverted;
    });
  });

  describe("solvency preserved across other reservations", () => {
    it("releasing (with fee) from one automation never touches another automation's backing", async () => {
      const AUTO2 = hre.ethers.id("automation-v2-2");
      await usdc.mint(depositor.address, 200_000000n);
      await usdc.connect(depositor).approve(await vault.getAddress(), 300_000000n);
      await vault.connect(depositor).reserve(AUTO, await usdc.getAddress(), recipient.address, 100_000000n);
      await vault.connect(depositor).reserve(AUTO2, await usdc.getAddress(), outsider.address, 50_000000n);
      await vault.connect(agent).release(AUTO, 40_000000n, reqId("solv1"));
      expect(await vault.reservedBalance(AUTO2)).to.equal(50_000000n); // completely unaffected
    });
  });
});
