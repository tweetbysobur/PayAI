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
 *          under-backed and their refunds reverting. Fixed in two layers:
 *          (1) an exact-delta check on the vault's own balance around each
 *          release()/refund() transfer, and (2) an explicit
 *          `totalReservedByToken` ledger asserted against real custody
 *          (`balanceOf`/`address(this).balance`) on every reserve/release/
 *          refund, so INVARIANT-AV-1 is actively enforced rather than an
 *          emergent property of (1) alone -- no reservation's backing can
 *          ever be silently reduced by another reservation's release,
 *          refund, or surcharge.
 *   L-01 - PaymentExecutor.payRequest() only ever settled through the ERC-20
 *          path (it called executePayment, never executePaymentNative), so a
 *          request created with the native address(0) sentinel could never
 *          transition to paid. Fixed by giving payRequest() a native branch
 *          that settles through the same _settleNative core
 *          executePaymentNative uses -- a native request now follows the
 *          identical created -> paid/settled lifecycle as an ERC-20 request,
 *          funding and paying atomically via msg.value since native MON has
 *          no allowance mechanism to pull from later.
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

    it("totalReservedByToken tracks the exact sum of active reservations through reserve/release/refund", async () => {
      const Mock = await hre.ethers.getContractFactory("MockERC20");
      const usdc = await Mock.deploy();
      const [, , , depositor, recipient] = await hre.ethers.getSigners();
      await usdc.mint(depositor.address, AMOUNT * 2n);
      await usdc.connect(depositor).approve(await vault.getAddress(), AMOUNT * 2n);
      const usdcAddr = await usdc.getAddress();

      const relId = hre.ethers.id("ledger-release");
      const refId = hre.ethers.id("ledger-refund");

      await vault.connect(depositor).reserve(relId, usdcAddr, recipient.address, AMOUNT);
      expect(await vault.totalReservedByToken(usdcAddr)).to.equal(AMOUNT);

      await vault.connect(depositor).reserve(refId, usdcAddr, recipient.address, AMOUNT);
      expect(await vault.totalReservedByToken(usdcAddr)).to.equal(AMOUNT * 2n);

      await vault.connect(agent).release(relId, AMOUNT, reqId("ledger-release-req"));
      expect(await vault.totalReservedByToken(usdcAddr)).to.equal(AMOUNT);

      await vault.connect(depositor).refund(refId);
      expect(await vault.totalReservedByToken(usdcAddr)).to.equal(0n);
    });

    it("a reverted release/refund leaves the OTHER reservation's ledger entry and real custody completely untouched", async () => {
      // The whole point of INVARIANT-AV-1 being actively enforced: even
      // though this surcharge token makes ANY outbound transfer for THIS
      // reservation impossible (a token-compatibility limit, not a leak),
      // the second reservation's promised balance and the vault's real
      // custody for it are provably unaffected by the failed attempt.
      await expect(vault.connect(agent).release(firstId, AMOUNT, reqId("ledger-isolation"))).to.be.reverted;
      expect(await vault.reservedBalance(secondId)).to.equal(AMOUNT);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(AMOUNT * 2n);
      expect(await vault.totalReservedByToken(await token.getAddress())).to.equal(await token.balanceOf(await vault.getAddress()));
    });
  });

  describe("L-01: native payment requests follow the full created -> paid/settled lifecycle", () => {
    let executor, registry, owner, agent, merchant;

    beforeEach(async () => {
      [, owner, agent, merchant] = await hre.ethers.getSigners();
      const Registry = await hre.ethers.getContractFactory("MerchantRegistry");
      registry = await Registry.deploy();
      const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
      executor = await Executor.deploy(await registry.getAddress(), 0, owner.address, agent.address, 0, 0, 0);
      await registry.setRecorder(await executor.getAddress(), true);
    });

    it("creates a native request, then settles it atomically when payRequest carries the matching msg.value", async () => {
      const amount = hre.ethers.parseEther("2");
      await executor.connect(agent).createPaymentRequest(merchant.address, hre.ethers.ZeroAddress, amount, reqId("native-invoice"));
      const requestId = 0n;
      expect((await executor.getRequest(requestId)).paid).to.equal(false);

      const before = await hre.ethers.provider.getBalance(merchant.address);
      await expect(
        executor.connect(agent).payRequest(requestId, 10, reqId("decision"), reqId("native-pay"), { value: amount }),
      ).to.emit(executor, "RequestPaid");
      const after = await hre.ethers.provider.getBalance(merchant.address);

      const req = await executor.getRequest(requestId);
      expect(req.paid).to.equal(true);
      expect(after - before).to.equal(amount);
      const payment = await executor.getPayment(req.paymentId);
      expect(payment.token).to.equal(hre.ethers.ZeroAddress);
      expect(payment.amount).to.equal(amount);
    });

    it("reverts payRequest for a native request when msg.value doesn't match the request amount", async () => {
      const amount = hre.ethers.parseEther("2");
      await executor.connect(agent).createPaymentRequest(merchant.address, hre.ethers.ZeroAddress, amount, reqId("native-invoice-2"));
      await expect(
        executor.connect(agent).payRequest(0n, 10, reqId("decision"), reqId("wrong-value"), { value: hre.ethers.parseEther("1") }),
      ).to.be.revertedWith("native value must match request amount");
      expect((await executor.getRequest(0n)).paid).to.equal(false);
    });

    it("reverts payRequest for an ERC-20 request if native value is attached", async () => {
      const Mock = await hre.ethers.getContractFactory("MockERC20");
      const usdc = await Mock.deploy();
      await usdc.mint(agent.address, 1_000000n);
      await usdc.connect(agent).approve(await executor.getAddress(), 1_000000n);
      await executor.connect(agent).createPaymentRequest(merchant.address, await usdc.getAddress(), 1_000000n, reqId("erc20-invoice"));
      await expect(
        executor.connect(agent).payRequest(0n, 10, reqId("decision"), reqId("stray-value"), { value: 1n }),
      ).to.be.revertedWith("no native value for erc20 request");
    });

    it("still settles ERC-20 requests normally with no value attached", async () => {
      const Mock = await hre.ethers.getContractFactory("MockERC20");
      const usdc = await Mock.deploy();
      await usdc.mint(agent.address, 1_000000n);
      await usdc.connect(agent).approve(await executor.getAddress(), 1_000000n);
      await executor.connect(agent).createPaymentRequest(merchant.address, await usdc.getAddress(), 1_000000n, reqId("erc20-invoice-2"));
      await expect(executor.connect(agent).payRequest(0n, 10, reqId("decision"), reqId("erc20-pay"))).to.emit(executor, "RequestPaid");
      expect(await usdc.balanceOf(merchant.address)).to.equal(1_000000n);
    });

    it("standalone executePaymentNative and executePayment are unaffected by the shared settlement refactor", async () => {
      await expect(
        executor.connect(agent).executePaymentNative(merchant.address, 5, reqId("d"), reqId("r"), reqId("standalone-native"), { value: hre.ethers.parseEther("1") }),
      ).to.emit(executor, "PaymentExecuted");

      const Mock = await hre.ethers.getContractFactory("MockERC20");
      const usdc = await Mock.deploy();
      await usdc.mint(agent.address, 1_000000n);
      await usdc.connect(agent).approve(await executor.getAddress(), 1_000000n);
      await expect(
        executor.connect(agent).executePayment(merchant.address, await usdc.getAddress(), 1_000000n, 5, reqId("d2"), reqId("r2"), reqId("standalone-erc20")),
      ).to.emit(executor, "PaymentExecuted");
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
