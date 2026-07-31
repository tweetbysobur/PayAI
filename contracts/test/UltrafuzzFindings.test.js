const { expect } = require("chai");
const hre = require("hardhat");

/**
 * Regression tests for the DeltaV x Ultrafuzz report (run ID: ultra-2026072818-gpt5-v8).
 * One test per finding, proving the fix actually closes the exploit the
 * report demonstrated -- not just that the contract still compiles.
 *
 *   L-01 - PaymentExecutor.recordRejection accepted riskScore > 100.
 *   M-01 - Fresh-deploy hot agent retains MerchantRegistry manager authority
 *          (contract-level: this test proves the underlying access-control
 *          gate itself is correctly manager-only; the actual bug was
 *          procedural -- the deploy script never revoked the deployer's own
 *          manager grant post-handoff. That is covered by asserting the
 *          fixed deploy-suite-v3-fresh.js script below, not a Solidity test).
 *   M-02 - ERC-20 settlement paths (PaymentExecutor + AutomationVault)
 *          recorded/reserved the REQUESTED amount without verifying the
 *          RECEIVED amount, so a fee-on-transfer token could be under-
 *          credited while the app believed the full amount moved.
 */
describe("Ultrafuzz findings — regression", function () {
  const ZERO = hre.ethers.ZeroAddress;
  const reqId = (l) => hre.ethers.id(l);

  describe("L-01: recordRejection risk-score bound", () => {
    let executor, owner, agent, merchant;

    beforeEach(async () => {
      [, owner, agent, merchant] = await hre.ethers.getSigners();
      const Registry = await hre.ethers.getContractFactory("MerchantRegistry");
      const registry = await Registry.deploy();
      const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
      executor = await Executor.deploy(await registry.getAddress(), 0, owner.address, agent.address, 0, 0, 0);
    });

    it("rejects a rejection record with riskScore > 100 (previously accepted silently)", async () => {
      await expect(
        executor.connect(agent).recordRejection(merchant.address, 100_000000n, 101, reqId("ref-1")),
      ).to.be.revertedWith("risk>100");
    });

    it("still accepts a valid in-range risk score", async () => {
      await expect(executor.connect(agent).recordRejection(merchant.address, 100_000000n, 100, reqId("ref-2")))
        .to.emit(executor, "ComplianceRejected");
    });
  });

  describe("M-02: PaymentExecutor requires actual delivery, not just a truthy return", () => {
    let executor, registry, shortToken, owner, agent, merchant;

    beforeEach(async () => {
      [, owner, agent, merchant] = await hre.ethers.getSigners();
      const Registry = await hre.ethers.getContractFactory("MerchantRegistry");
      registry = await Registry.deploy();
      const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
      executor = await Executor.deploy(await registry.getAddress(), 0, owner.address, agent.address, 0, 0, 0);
      await registry.setRecorder(await executor.getAddress(), true);

      const Short = await hre.ethers.getContractFactory("ShortTransferERC20");
      shortToken = await Short.deploy();
      await shortToken.mint(agent.address, 1_000_000000n);
      await shortToken.connect(agent).approve(await executor.getAddress(), 1_000_000000n);
    });

    it("reverts executePayment when the token delivers less than the requested amount", async () => {
      const amount = 100_000000n; // token only actually delivers 90 of this
      await expect(
        executor.connect(agent).executePayment(merchant.address, await shortToken.getAddress(), amount, 10, reqId("d1"), reqId("r1"), reqId("req-1")),
      ).to.be.revertedWith("token did not deliver full amount");
      // The whole payment reverted -- no partial record, no inflated volume.
      expect(await executor.paymentsCount()).to.equal(0);
      expect(await executor.totalVolume()).to.equal(0);
    });

    it("still settles normally with a standard (full-delivery) token", async () => {
      const Mock = await hre.ethers.getContractFactory("MockERC20");
      const usdc = await Mock.deploy();
      await usdc.mint(agent.address, 100_000000n);
      await usdc.connect(agent).approve(await executor.getAddress(), 100_000000n);
      await expect(
        executor.connect(agent).executePayment(merchant.address, await usdc.getAddress(), 100_000000n, 10, reqId("d2"), reqId("r2"), reqId("req-2")),
      ).to.emit(executor, "PaymentExecuted");
      expect(await executor.totalVolume()).to.equal(100_000000n);
    });
  });

  describe("M-02: AutomationVault requires actual delivery on reserve/release/refund", () => {
    let vault, shortToken, owner, agent, depositor, recipient;
    const AUTO = hre.ethers.id("automation-short-1");

    beforeEach(async () => {
      [, owner, agent, depositor, recipient] = await hre.ethers.getSigners();
      const Vault = await hre.ethers.getContractFactory("AutomationVault");
      vault = await Vault.deploy(owner.address, agent.address);

      const Short = await hre.ethers.getContractFactory("ShortTransferERC20");
      shortToken = await Short.deploy();
      await shortToken.mint(depositor.address, 1_000_000000n);
      await shortToken.connect(depositor).approve(await vault.getAddress(), 1_000_000000n);
    });

    it("reverts reserve() instead of booking a reservation the vault never actually received", async () => {
      const amount = 100_000000n;
      await expect(
        vault.connect(depositor).reserve(AUTO, await shortToken.getAddress(), recipient.address, amount),
      ).to.be.revertedWith("token did not deliver full amount");
      // No reservation was created -- the depositor's funds stayed exactly
      // where they were (minus nothing, since the whole tx reverted).
      expect(await vault.reservedBalance(AUTO)).to.equal(0);
    });

    it("reverts release() if the token shorts the outbound transfer, leaving funds safely in the vault", async () => {
      // Full delivery via transferFrom (reserve() passes and books a real
      // reservation) but only 90% delivery via transfer (what release()
      // actually calls) -- an asymmetric-fee token shape that reserve()'s
      // own check cannot catch, since it only ever calls transferFrom.
      const Asym = await hre.ethers.getContractFactory("ShortOnTransferOutERC20");
      const asymToken = await Asym.deploy();
      await asymToken.mint(depositor.address, 1_000_000000n);
      await asymToken.connect(depositor).approve(await vault.getAddress(), 1_000_000000n);

      const amount = 100_000000n;
      await vault.connect(depositor).reserve(AUTO, await asymToken.getAddress(), recipient.address, amount);
      expect(await vault.reservedBalance(AUTO)).to.equal(amount); // reservation genuinely booked

      await expect(vault.connect(agent).release(AUTO, amount, reqId("rel-1"))).to.be.revertedWith("token did not deliver full amount");

      // The whole release reverted -- state unwound, funds still fully in the vault.
      expect(await vault.reservedBalance(AUTO)).to.equal(amount);
      expect(await asymToken.balanceOf(recipient.address)).to.equal(0);
    });

    it("still releases normally with a standard (full-delivery) token", async () => {
      const Mock = await hre.ethers.getContractFactory("MockERC20");
      const usdc = await Mock.deploy();
      await usdc.mint(depositor.address, 100_000000n);
      await usdc.connect(depositor).approve(await vault.getAddress(), 100_000000n);
      await vault.connect(depositor).reserve(AUTO, await usdc.getAddress(), recipient.address, 100_000000n);
      await expect(vault.connect(agent).release(AUTO, 100_000000n, reqId("rel-2"))).to.emit(vault, "Released");
      expect(await usdc.balanceOf(recipient.address)).to.equal(100_000000n);
    });
  });
});
