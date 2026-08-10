const { expect } = require("chai");
const hre = require("hardhat");

/**
 * Regression tests for the DeltaV x Ultrafuzz report (run ID: private-02-r5-20260806-2148).
 * One test per finding actually fixed in this pass -- proving the fix closes
 * the exploit the report demonstrated, not just that the contract compiles.
 *
 *   M-01 - AutomationVault release()/refund() verified the RECIPIENT received
 *          the full amount but never verified the VAULT's own balance fell by
 *          exactly that amount. A sender-surcharge token (charges its fee on
 *          the outgoing side, on top of the stated amount) could drain more
 *          than the released reservation's share from the shared pool,
 *          leaving other depositors' still-fully-recorded reservations
 *          under-backed and their refunds reverting.
 *   L-01 - PaymentExecutor.createPaymentRequest accepted the native token
 *          sentinel address(0), but payRequest() only ever settles through
 *          the ERC-20 path -- so a native request could be created and then
 *          never transition to paid. Now rejected at creation.
 *   (non-production outcome) - PaymentExecutor.setAgent could authorize
 *          address(0), inconsistent with addAgent's zero-address guard.
 *   (non-production outcome) - VeriPayRegistry.payAndRecord recorded the
 *          nominal amount without verifying the recipient's balance actually
 *          grew by that amount, unlike PaymentExecutor/AutomationVault.
 */
describe("Ultrafuzz findings (private-02-r5-20260806-2148) — regression", function () {
  const reqId = (l) => hre.ethers.id(l);

  describe("M-01: AutomationVault verifies its own outbound debit, not just recipient delivery", () => {
    let vault, token, owner, agent, firstDepositor, firstRecipient, secondDepositor;
    const firstId = hre.ethers.id("surcharge-first-reservation");
    const secondId = hre.ethers.id("surcharge-second-reservation");
    const AMOUNT = 100_000000n;

    beforeEach(async () => {
      [, owner, agent, firstDepositor, firstRecipient, secondDepositor] = await hre.ethers.getSigners();

      const Vault = await hre.ethers.getContractFactory("AutomationVault");
      vault = await Vault.deploy(owner.address, agent.address);

      const Token = await hre.ethers.getContractFactory("SenderSurchargeERC20");
      token = await Token.deploy();

      const fee = await token.feeFor(AMOUNT);
      const debit = AMOUNT + fee; // depositor's balance must cover amount + surcharge
      await token.mint(firstDepositor.address, debit);
      await token.mint(secondDepositor.address, debit);
      await token.connect(firstDepositor).approve(await vault.getAddress(), AMOUNT);
      await token.connect(secondDepositor).approve(await vault.getAddress(), AMOUNT);

      await vault.connect(firstDepositor).reserve(firstId, await token.getAddress(), firstRecipient.address, AMOUNT);
      await vault.connect(secondDepositor).reserve(secondId, await token.getAddress(), secondDepositor.address, AMOUNT);
    });

    it("reverts release() when the token debits more than `amount` from the vault, instead of silently draining pooled custody", async () => {
      await expect(vault.connect(agent).release(firstId, AMOUNT, reqId("surcharge-release"))).to.be.revertedWith(
        "token debited more than amount from vault",
      );
      // Whole tx reverted -- both reservations remain fully backed and intact.
      expect(await vault.reservedBalance(firstId)).to.equal(AMOUNT);
      expect(await vault.reservedBalance(secondId)).to.equal(AMOUNT);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(AMOUNT * 2n);
    });

    it("reverts refund() the same way", async () => {
      await expect(vault.connect(firstDepositor).refund(firstId)).to.be.revertedWith(
        "token debited more than amount from vault",
      );
      expect(await vault.reservedBalance(firstId)).to.equal(AMOUNT);
    });

    it("still releases and refunds normally with a standard (no-surcharge) token", async () => {
      const Mock = await hre.ethers.getContractFactory("MockERC20");
      const usdc = await Mock.deploy();
      const [, , , depositor, recipient] = await hre.ethers.getSigners();
      await usdc.mint(depositor.address, AMOUNT * 2n);
      await usdc.connect(depositor).approve(await vault.getAddress(), AMOUNT * 2n);

      const releaseId = hre.ethers.id("normal-release");
      const refundId = hre.ethers.id("normal-refund");
      await vault.connect(depositor).reserve(releaseId, await usdc.getAddress(), recipient.address, AMOUNT);
      await expect(vault.connect(agent).release(releaseId, AMOUNT, reqId("normal-release-req"))).to.emit(vault, "Released");
      expect(await usdc.balanceOf(recipient.address)).to.equal(AMOUNT);

      await vault.connect(depositor).reserve(refundId, await usdc.getAddress(), recipient.address, AMOUNT);
      await expect(vault.connect(depositor).refund(refundId)).to.emit(vault, "Refunded");
    });
  });

  describe("L-01: PaymentExecutor rejects native (address(0)) payment requests at creation", () => {
    let executor, owner, agent, merchant;

    beforeEach(async () => {
      [, owner, agent, merchant] = await hre.ethers.getSigners();
      const Registry = await hre.ethers.getContractFactory("MerchantRegistry");
      const registry = await Registry.deploy();
      const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
      executor = await Executor.deploy(await registry.getAddress(), 0, owner.address, agent.address, 0, 0, 0);
    });

    it("reverts createPaymentRequest with the native sentinel, instead of booking a request that can never be paid", async () => {
      await expect(
        executor.connect(agent).createPaymentRequest(merchant.address, hre.ethers.ZeroAddress, 1_000000n, reqId("native-req")),
      ).to.be.revertedWith("native requests unsupported");
    });

    it("still accepts an ERC-20 request", async () => {
      const Mock = await hre.ethers.getContractFactory("MockERC20");
      const usdc = await Mock.deploy();
      await expect(executor.connect(agent).createPaymentRequest(merchant.address, await usdc.getAddress(), 1_000000n, reqId("erc20-req")))
        .to.emit(executor, "PaymentRequested");
    });
  });

  describe("non-production outcome: PaymentExecutor.setAgent rejects address(0), matching addAgent", () => {
    it("reverts setAgent(address(0), true)", async () => {
      const [, owner, agent] = await hre.ethers.getSigners();
      const Registry = await hre.ethers.getContractFactory("MerchantRegistry");
      const registry = await Registry.deploy();
      const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
      const executor = await Executor.deploy(await registry.getAddress(), 0, owner.address, agent.address, 0, 0, 0);
      await expect(executor.connect(owner).setAgent(hre.ethers.ZeroAddress, true)).to.be.revertedWith("zero agent");
    });
  });

  describe("non-production outcome: VeriPayRegistry.payAndRecord requires actual delivery", () => {
    it("reverts when the token delivers less than the requested amount", async () => {
      const [, agent, recipient] = await hre.ethers.getSigners();
      const Registry = await hre.ethers.getContractFactory("VeriPayRegistry");
      const registry = await Registry.deploy();

      const Short = await hre.ethers.getContractFactory("ShortTransferERC20");
      const shortToken = await Short.deploy();
      await shortToken.mint(agent.address, 1_000000n);
      await shortToken.connect(agent).approve(await registry.getAddress(), 1_000000n);

      await expect(
        registry.connect(agent).payAndRecord(recipient.address, await shortToken.getAddress(), 1_000000n, 10, reqId("purpose"), reqId("ref")),
      ).to.be.revertedWith("token did not deliver full amount");
      expect(await registry.paymentsCount()).to.equal(0);
    });
  });
});
