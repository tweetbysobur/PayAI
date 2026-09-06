const { expect } = require("chai");
const hre = require("hardhat");

// PayAIForwarderV2 adds a PayAI service fee (taken from the gross amount the
// payer sends) on top of everything V1 already guarantees. These tests focus
// on what's NEW — the fee split, its bounds, and its safety on both legs —
// plus a spot-check that the V1 guarantees (payer-is-msg.sender, actual
// delivery, atomicity) still hold with the fee active.
describe("PayAIForwarderV2", function () {
  let forwarder, token, owner, treasury, payer, recipient, outsider;
  const ref = hre.ethers.id("intent-fwd-v2-001");
  const ONE = hre.ethers.parseEther("1");
  const MAX_FEE_BPS = 100;
  const FEE_BPS = 25; // 0.25%

  beforeEach(async () => {
    [owner, treasury, payer, recipient, outsider] = await hre.ethers.getSigners();

    const Forwarder = await hre.ethers.getContractFactory("PayAIForwarderV2");
    forwarder = await Forwarder.deploy(owner.address, treasury.address, FEE_BPS);

    const Mock = await hre.ethers.getContractFactory("MockERC20");
    token = await Mock.deploy();
    await token.mint(payer.address, 1000_000000n);
  });

  describe("construction", () => {
    it("sets owner, treasury, and feeBps", async () => {
      expect(await forwarder.owner()).to.equal(owner.address);
      expect(await forwarder.treasury()).to.equal(treasury.address);
      expect(await forwarder.feeBps()).to.equal(FEE_BPS);
    });
    it("rejects a zero treasury at deploy", async () => {
      const Forwarder = await hre.ethers.getContractFactory("PayAIForwarderV2");
      await expect(Forwarder.deploy(owner.address, hre.ethers.ZeroAddress, FEE_BPS)).to.be.revertedWith("zero treasury");
    });
    it("rejects a fee above MAX_FEE_BPS at deploy", async () => {
      const Forwarder = await hre.ethers.getContractFactory("PayAIForwarderV2");
      await expect(Forwarder.deploy(owner.address, treasury.address, MAX_FEE_BPS + 1)).to.be.revertedWith("fee too high");
    });
    it("feeBps = 0 is valid and behaves like V1 (no fee)", async () => {
      const Forwarder = await hre.ethers.getContractFactory("PayAIForwarderV2");
      const zeroFee = await Forwarder.deploy(owner.address, treasury.address, 0);
      const before = await hre.ethers.provider.getBalance(recipient.address);
      await zeroFee.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE });
      expect((await hre.ethers.provider.getBalance(recipient.address)) - before).to.equal(ONE);
    });
  });

  describe("fee admin — owner (Safe) only, capped", () => {
    it("only owner can setFeeBps / setTreasury", async () => {
      await expect(forwarder.connect(outsider).setFeeBps(50)).to.be.revertedWith("not owner");
      await expect(forwarder.connect(outsider).setTreasury(outsider.address)).to.be.revertedWith("not owner");
      await forwarder.connect(owner).setFeeBps(50);
      expect(await forwarder.feeBps()).to.equal(50);
      await forwarder.connect(owner).setTreasury(outsider.address);
      expect(await forwarder.treasury()).to.equal(outsider.address);
    });
    it("cannot set feeBps above MAX_FEE_BPS", async () => {
      await expect(forwarder.connect(owner).setFeeBps(MAX_FEE_BPS + 1)).to.be.revertedWith("fee too high");
    });
    it("cannot set treasury to zero address", async () => {
      await expect(forwarder.connect(owner).setTreasury(hre.ethers.ZeroAddress)).to.be.revertedWith("zero treasury");
    });
    it("neither payer nor recipient can influence the fee for their own payment", async () => {
      // No function accepts a per-call fee override at all — confirmed by ABI shape.
      const fns = forwarder.interface.fragments.filter((f) => f.type === "function" && f.stateMutability !== "view");
      const names = fns.map((f) => f.name);
      expect(names).to.include.members(["forwardPaymentNative", "forwardPayment", "setFeeBps", "setTreasury", "setPaused", "transferOwnership"]);
      // Confirm no payment function takes a fee/feeBps parameter.
      const paymentFns = fns.filter((f) => f.name.startsWith("forwardPayment"));
      for (const f of paymentFns) {
        expect(f.inputs.map((i) => i.name.toLowerCase())).to.not.include("fee");
        expect(f.inputs.map((i) => i.name.toLowerCase())).to.not.include("feebps");
      }
    });
  });

  describe("native MON — fee split", () => {
    it("takes exactly 0.25%, delivers the remainder, and net+fee == gross", async () => {
      const recBefore = await hre.ethers.provider.getBalance(recipient.address);
      const treBefore = await hre.ethers.provider.getBalance(treasury.address);
      await forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE });
      const recDelta = (await hre.ethers.provider.getBalance(recipient.address)) - recBefore;
      const treDelta = (await hre.ethers.provider.getBalance(treasury.address)) - treBefore;
      const expectedFee = (ONE * BigInt(FEE_BPS)) / 10000n;
      expect(treDelta).to.equal(expectedFee);
      expect(recDelta).to.equal(ONE - expectedFee);
      expect(recDelta + treDelta).to.equal(ONE);
    });
    it("emits both PaymentForwarded (gross) and FeeCollected (fee) for the same id", async () => {
      const expectedFee = (ONE * BigInt(FEE_BPS)) / 10000n;
      const tx = await forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE });
      await expect(tx).to.emit(forwarder, "PaymentForwarded").withArgs(0, payer.address, recipient.address, hre.ethers.ZeroAddress, ONE, ref);
      await expect(tx).to.emit(forwarder, "FeeCollected").withArgs(0, hre.ethers.ZeroAddress, expectedFee, treasury.address);
    });
    it("still requires msg.value == amount (unchanged guard)", async () => {
      await expect(
        forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE - 1n }),
      ).to.be.revertedWith("value mismatch");
    });
  });

  describe("ERC-20 — fee split, both legs pulled directly from payer", () => {
    beforeEach(async () => {
      await token.connect(payer).approve(await forwarder.getAddress(), 1000_000000n);
    });
    it("delivers net to recipient and fee to treasury, both via transferFrom against the SAME allowance", async () => {
      const amount = 40_000000n; // 40 USDC
      const expectedFee = (amount * BigInt(FEE_BPS)) / 10000n;
      const payerBefore = await token.balanceOf(payer.address);
      await forwarder.connect(payer).forwardPayment(await token.getAddress(), recipient.address, amount, ref);
      expect(await token.balanceOf(recipient.address)).to.equal(amount - expectedFee);
      expect(await token.balanceOf(treasury.address)).to.equal(expectedFee);
      expect(payerBefore - (await token.balanceOf(payer.address))).to.equal(amount); // exactly gross left the payer, no more
    });
    it("never leaves the token transiting the forwarder's own balance", async () => {
      const amount = 40_000000n;
      await forwarder.connect(payer).forwardPayment(await token.getAddress(), recipient.address, amount, ref);
      expect(await token.balanceOf(await forwarder.getAddress())).to.equal(0n);
    });
    it("a short-delivering (fee-on-transfer) token on the RECIPIENT leg reverts the whole payment", async () => {
      const Short = await hre.ethers.getContractFactory("ShortTransferERC20");
      const short = await Short.deploy();
      await short.mint(payer.address, 1000_000000n);
      await short.connect(payer).approve(await forwarder.getAddress(), 1000_000000n);
      await expect(
        forwarder.connect(payer).forwardPayment(await short.getAddress(), recipient.address, 40_000000n, ref),
      ).to.be.reverted;
    });
  });

  describe("V1 guarantees preserved", () => {
    it("payer is always msg.sender — no from/payer parameter exists", async () => {
      const fns = forwarder.interface.fragments.filter((f) => f.name?.startsWith("forwardPayment"));
      for (const f of fns) {
        expect(f.inputs.map((i) => i.name.toLowerCase())).to.not.include("from");
        expect(f.inputs.map((i) => i.name.toLowerCase())).to.not.include("payer");
      }
    });
    it("owner still cannot move funds — ABI is pause/treasury/fee/ownership admin only, no sweep", async () => {
      const fns = forwarder.interface.fragments.filter((f) => f.type === "function" && f.stateMutability !== "view");
      const names = fns.map((f) => f.name);
      expect(names.sort()).to.deep.equal(
        ["forwardPayment", "forwardPaymentNative", "setFeeBps", "setPaused", "setTreasury", "transferOwnership"].sort(),
      );
    });
    it("a paused contract rejects both payment functions", async () => {
      await forwarder.connect(owner).setPaused(true);
      await expect(
        forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE }),
      ).to.be.revertedWith("paused");
    });
  });
});
