const { expect } = require("chai");
const hre = require("hardhat");

// PaymentExecutorV2 adds a PayAI service fee (taken from the gross `amount`
// requested) on top of every V1 guarantee. Focus: the fee split, its bounds,
// its safety on both legs, and that on-chain caps still bind the GROSS
// amount — plus a spot-check that idempotency/registry-gating/role isolation
// still hold with the fee active.
describe("PaymentExecutorV2", function () {
  let registry, executor, usdc, owner, agent, treasury, merchant, outsider;
  const aiHash = hre.ethers.id("decision-metadata");
  const ref = hre.ethers.id("intent-v2-001");
  const AMT = 40_000000n; // 40 USDC (6dp)
  const FEE_BPS = 25; // 0.25%
  const MAX_FEE_BPS = 100;

  function reqId(label) {
    return hre.ethers.id(label);
  }

  beforeEach(async () => {
    [owner, agent, treasury, merchant, outsider] = await hre.ethers.getSigners();

    const Mock = await hre.ethers.getContractFactory("MockERC20");
    usdc = await Mock.deploy();

    const Registry = await hre.ethers.getContractFactory("MerchantRegistry");
    registry = await Registry.deploy();

    const Executor = await hre.ethers.getContractFactory("PaymentExecutorV2");
    // (registry, dailyCap, owner, agent, maxTx, dailyCapNative, maxTxNative, treasury, feeBps)
    executor = await Executor.deploy(
      await registry.getAddress(), 0n, owner.address, agent.address, 0n, 0n, 0n, treasury.address, FEE_BPS,
    );

    await registry.setRecorder(await executor.getAddress(), true);
    await registry.registerMerchant(merchant.address, "Acme");

    await usdc.mint(agent.address, 1000_000000n);
    await usdc.connect(agent).approve(await executor.getAddress(), 1000_000000n);
  });

  describe("construction", () => {
    it("sets treasury and feeBps", async () => {
      expect(await executor.treasury()).to.equal(treasury.address);
      expect(await executor.feeBps()).to.equal(FEE_BPS);
    });
    it("rejects a zero treasury at deploy", async () => {
      const Executor = await hre.ethers.getContractFactory("PaymentExecutorV2");
      await expect(
        Executor.deploy(await registry.getAddress(), 0n, owner.address, agent.address, 0n, 0n, 0n, hre.ethers.ZeroAddress, FEE_BPS),
      ).to.be.revertedWith("zero treasury");
    });
    it("rejects a fee above MAX_FEE_BPS at deploy", async () => {
      const Executor = await hre.ethers.getContractFactory("PaymentExecutorV2");
      await expect(
        Executor.deploy(await registry.getAddress(), 0n, owner.address, agent.address, 0n, 0n, 0n, treasury.address, MAX_FEE_BPS + 1),
      ).to.be.revertedWith("fee too high");
    });
  });

  describe("fee admin — owner only, capped", () => {
    it("only owner can setFeeBps / setTreasury; agent cannot", async () => {
      await expect(executor.connect(agent).setFeeBps(50)).to.be.revertedWith("not owner");
      await expect(executor.connect(outsider).setTreasury(outsider.address)).to.be.revertedWith("not owner");
      await executor.connect(owner).setFeeBps(50);
      expect(await executor.feeBps()).to.equal(50);
    });
    it("cannot exceed MAX_FEE_BPS via setFeeBps", async () => {
      await expect(executor.connect(owner).setFeeBps(MAX_FEE_BPS + 1)).to.be.revertedWith("fee too high");
    });
  });

  describe("executePayment (agent-funded) — fee split", () => {
    it("delivers net to merchant, fee to treasury, net+fee == gross", async () => {
      const expectedFee = (AMT * BigInt(FEE_BPS)) / 10000n;
      await executor.connect(agent).executePayment(merchant.address, await usdc.getAddress(), AMT, 10, aiHash, ref, reqId("r1"));
      expect(await usdc.balanceOf(merchant.address)).to.equal(AMT - expectedFee);
      expect(await usdc.balanceOf(treasury.address)).to.equal(expectedFee);
    });
    it("records the GROSS amount on the Payment struct and in totalVolume/merchant registry volume (unchanged field semantics)", async () => {
      await executor.connect(agent).executePayment(merchant.address, await usdc.getAddress(), AMT, 10, aiHash, ref, reqId("r2"));
      const p = await executor.getPayment(0);
      expect(p.amount).to.equal(AMT);
      expect(await executor.totalVolume()).to.equal(AMT);
      const m = await registry.getMerchant(merchant.address);
      expect(m.volume).to.equal(AMT);
    });
    it("emits FeeCollected with the actual fee for the same payment id", async () => {
      const expectedFee = (AMT * BigInt(FEE_BPS)) / 10000n;
      await expect(executor.connect(agent).executePayment(merchant.address, await usdc.getAddress(), AMT, 10, aiHash, ref, reqId("r3")))
        .to.emit(executor, "FeeCollected").withArgs(0, await usdc.getAddress(), expectedFee, treasury.address);
    });
    it("on-chain per-tx cap still bounds the GROSS amount, not the net", async () => {
      await executor.connect(owner).setMaxTxAmount(AMT); // exactly at the gross cap
      await expect(
        executor.connect(agent).executePayment(merchant.address, await usdc.getAddress(), AMT, 10, aiHash, ref, reqId("r4")),
      ).to.not.be.reverted;
      await expect(
        executor.connect(agent).executePayment(merchant.address, await usdc.getAddress(), AMT + 1n, 10, aiHash, ref, reqId("r5")),
      ).to.be.revertedWith("exceeds max tx amount");
    });
    it("duplicate requestId still reverts (idempotency unchanged)", async () => {
      const id = reqId("dup");
      await executor.connect(agent).executePayment(merchant.address, await usdc.getAddress(), AMT, 10, aiHash, ref, id);
      await expect(
        executor.connect(agent).executePayment(merchant.address, await usdc.getAddress(), AMT, 10, aiHash, ref, id),
      ).to.be.revertedWith("duplicate requestId");
    });
  });

  describe("executePaymentFrom (pull payment) — fee split + registry gate", () => {
    let payer;
    beforeEach(async () => {
      [, , , , , payer] = await hre.ethers.getSigners();
      await usdc.mint(payer.address, 1000_000000n);
      await usdc.connect(payer).approve(await executor.getAddress(), 1000_000000n);
    });
    it("delivers net to merchant, fee to treasury, both pulled from `from` (not the agent)", async () => {
      const expectedFee = (AMT * BigInt(FEE_BPS)) / 10000n;
      const payerBefore = await usdc.balanceOf(payer.address);
      await executor.connect(agent).executePaymentFrom(payer.address, merchant.address, await usdc.getAddress(), AMT, 10, aiHash, ref, reqId("pf1"));
      expect(await usdc.balanceOf(merchant.address)).to.equal(AMT - expectedFee);
      expect(await usdc.balanceOf(treasury.address)).to.equal(expectedFee);
      expect(payerBefore - (await usdc.balanceOf(payer.address))).to.equal(AMT);
    });
    it("still requires the merchant be registered and active (INVARIANT-PE-4 unchanged)", async () => {
      await expect(
        executor.connect(agent).executePaymentFrom(payer.address, outsider.address, await usdc.getAddress(), AMT, 10, aiHash, ref, reqId("pf2")),
      ).to.be.revertedWith("merchant not registered");
    });
  });

  describe("native MON — fee split", () => {
    const ONE = hre.ethers.parseEther("1");
    it("delivers net to merchant, fee to treasury", async () => {
      const merchantBefore = await hre.ethers.provider.getBalance(merchant.address);
      const treasuryBefore = await hre.ethers.provider.getBalance(treasury.address);
      await executor.connect(agent).executePaymentNative(merchant.address, 10, aiHash, ref, reqId("n1"), { value: ONE });
      const expectedFee = (ONE * BigInt(FEE_BPS)) / 10000n;
      expect((await hre.ethers.provider.getBalance(merchant.address)) - merchantBefore).to.equal(ONE - expectedFee);
      expect((await hre.ethers.provider.getBalance(treasury.address)) - treasuryBefore).to.equal(expectedFee);
    });
  });

  describe("fee-on-transfer safety", () => {
    it("a short-delivering token on the merchant leg reverts the whole payment", async () => {
      const Short = await hre.ethers.getContractFactory("ShortTransferERC20");
      const short = await Short.deploy();
      await short.mint(agent.address, 1000_000000n);
      await short.connect(agent).approve(await executor.getAddress(), 1000_000000n);
      await expect(
        executor.connect(agent).executePayment(merchant.address, await short.getAddress(), AMT, 10, aiHash, ref, reqId("short1")),
      ).to.be.reverted;
    });
  });

  describe("role isolation preserved", () => {
    it("owner cannot execute payments; agent cannot change fee/limits", async () => {
      await expect(
        executor.connect(owner).executePayment(merchant.address, await usdc.getAddress(), AMT, 10, aiHash, ref, reqId("iso1")),
      ).to.be.revertedWith("not agent");
      await expect(executor.connect(agent).setFeeBps(0)).to.be.revertedWith("not owner");
      await expect(executor.connect(agent).setTreasury(agent.address)).to.be.revertedWith("not owner");
    });
  });
});
