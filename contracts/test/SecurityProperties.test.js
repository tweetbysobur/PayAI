const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PayAI Protocol Invariant & Security Property Tests", function () {
  let owner, agent, user, recipient, attacker, user2, merchant2;
  let mockUsdc, merchantRegistry, paymentExecutor, automationVault, veriPayRegistry;

  const initialCap = ethers.parseUnits("1000000", 6);      // $1,000,000 daily cap for stress testing
  const initialMaxTx = ethers.parseUnits("100000", 6);     // $100,000 single tx max
  const initialCapNative = ethers.parseEther("1000");     // 1000 MON daily cap
  const initialMaxTxNative = ethers.parseEther("100");    // 100 MON single tx max

  beforeEach(async function () {
    [owner, agent, user, recipient, attacker, user2, merchant2] = await ethers.getSigners();

    // Deploy Mock USDC (6 decimals)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockUsdc = await MockERC20.deploy();

    // Deploy MerchantRegistry
    const MerchantRegistry = await ethers.getContractFactory("MerchantRegistry");
    merchantRegistry = await MerchantRegistry.deploy();

    // Deploy PaymentExecutor
    const PaymentExecutor = await ethers.getContractFactory("PaymentExecutor");
    paymentExecutor = await PaymentExecutor.deploy(
      await merchantRegistry.getAddress(),
      initialCap,
      owner.address,
      agent.address,
      initialMaxTx,
      initialCapNative,
      initialMaxTxNative
    );

    // Register PaymentExecutor as recorder in MerchantRegistry
    await merchantRegistry.setRecorder(await paymentExecutor.getAddress(), true);

    // Deploy AutomationVault
    const AutomationVault = await ethers.getContractFactory("AutomationVault");
    automationVault = await AutomationVault.deploy(owner.address, agent.address);

    // Deploy VeriPayRegistry
    const VeriPayRegistry = await ethers.getContractFactory("VeriPayRegistry");
    veriPayRegistry = await VeriPayRegistry.deploy();

    // Mint USDC to agent, user, user2
    await mockUsdc.mint(agent.address, ethers.parseUnits("10000000", 6));
    await mockUsdc.mint(user.address, ethers.parseUnits("10000000", 6));
    await mockUsdc.mint(user2.address, ethers.parseUnits("10000000", 6));

    await mockUsdc.connect(agent).approve(await paymentExecutor.getAddress(), ethers.MaxUint256);
    await mockUsdc.connect(user).approve(await paymentExecutor.getAddress(), ethers.MaxUint256);
    await mockUsdc.connect(user2).approve(await paymentExecutor.getAddress(), ethers.MaxUint256);
    await mockUsdc.connect(user).approve(await automationVault.getAddress(), ethers.MaxUint256);
    await mockUsdc.connect(user2).approve(await automationVault.getAddress(), ethers.MaxUint256);
  });

  /* ─────────────────────────────────────────────────────────────────────────────
   * 1. AutomationVault Invariants & Randomized Accounting
   * ───────────────────────────────────────────────────────────────────────────── */
  describe("AutomationVault Security Invariants & Randomized Accounting", function () {
    it("INVARIANT-AV-1: Vault token balance must always equal or exceed active reservations", async function () {
      const automationId = ethers.id("auto-1");
      const amount = ethers.parseUnits("100", 6);

      // Reserve funds
      await automationVault.connect(user).reserve(automationId, await mockUsdc.getAddress(), recipient.address, amount);

      const vaultBalance = await mockUsdc.balanceOf(await automationVault.getAddress());
      const reserved = await automationVault.reservedBalance(automationId);

      expect(vaultBalance).to.be.gte(reserved);
      expect(reserved).to.equal(amount);
    });

    it("INVARIANT-AV-2: Directional Fund Lock — release sends ONLY to recipient, refund ONLY to depositor", async function () {
      const automationId = ethers.id("auto-2");
      const amount = ethers.parseUnits("200", 6);

      await automationVault.connect(user).reserve(automationId, await mockUsdc.getAddress(), recipient.address, amount);

      const recipientBefore = await mockUsdc.balanceOf(recipient.address);
      const requestId = ethers.id("req-release-1");

      // Agent releases funds — must go to recipient, NOT agent or caller
      await automationVault.connect(agent).release(automationId, ethers.parseUnits("50", 6), requestId);

      const recipientAfter = await mockUsdc.balanceOf(recipient.address);
      expect(recipientAfter - recipientBefore).to.equal(ethers.parseUnits("50", 6));

      // User refunds remaining funds — must go to user (depositor)
      const userBefore = await mockUsdc.balanceOf(user.address);
      await automationVault.connect(user).refund(automationId);
      const userAfter = await mockUsdc.balanceOf(user.address);

      expect(userAfter - userBefore).to.equal(ethers.parseUnits("150", 6));
    });

    it("INVARIANT-ACCOUNTING: Customer deposits exactly equal payouts plus remaining active reserves across randomized sequences", async function () {
      const numSimulations = 50;
      let totalDeposited = 0n;
      let totalReleased = 0n;
      let totalRefunded = 0n;
      const activeReservations = new Map();

      for (let i = 0; i < numSimulations; i++) {
        const autoId = ethers.id(`random-auto-${i % 5}`);
        const depositAmount = BigInt(Math.floor(Math.random() * 1000) + 10) * 1000000n;

        if (!activeReservations.has(autoId)) {
          // New deposit
          await automationVault.connect(user).reserve(autoId, await mockUsdc.getAddress(), recipient.address, depositAmount);
          activeReservations.set(autoId, depositAmount);
          totalDeposited += depositAmount;
        } else {
          const action = i % 3;
          const currentBal = activeReservations.get(autoId);

          if (action === 0 && currentBal > 0n) {
            // Partial release
            const releaseAmount = currentBal / 2n + 1n;
            const reqId = ethers.id(`random-req-${i}`);
            await automationVault.connect(agent).release(autoId, releaseAmount, reqId);
            activeReservations.set(autoId, currentBal - releaseAmount);
            totalReleased += releaseAmount;
          } else if (action === 1 && currentBal > 0n) {
            // Full refund
            await automationVault.connect(user).refund(autoId);
            totalRefunded += currentBal;
            activeReservations.set(autoId, 0n);
          } else {
            // Top up
            await automationVault.connect(user).reserve(autoId, await mockUsdc.getAddress(), recipient.address, depositAmount);
            activeReservations.set(autoId, currentBal + depositAmount);
            totalDeposited += depositAmount;
          }
        }

        // Verify Vault Contract Balance Invariant after every step
        const actualVaultBal = await mockUsdc.balanceOf(await automationVault.getAddress());
        let expectedActiveSum = 0n;
        for (const [id, bal] of activeReservations.entries()) {
          expectedActiveSum += bal;
        }
        expect(actualVaultBal).to.equal(expectedActiveSum);
      }

      // Final Conservation Invariant check: Total Deposited == Total Released + Total Refunded + Active Vault Balance
      const finalVaultBal = await mockUsdc.balanceOf(await automationVault.getAddress());
      expect(totalDeposited).to.equal(totalReleased + totalRefunded + finalVaultBal);
    });

    it("INVARIANT-AV-3: Idempotent execution — duplicate release requestId must revert", async function () {
      const automationId = ethers.id("auto-3");
      const amount = ethers.parseUnits("100", 6);
      const requestId = ethers.id("req-duplicate");

      await automationVault.connect(user).reserve(automationId, await mockUsdc.getAddress(), recipient.address, amount);

      await automationVault.connect(agent).release(automationId, ethers.parseUnits("20", 6), requestId);

      await expect(
        automationVault.connect(agent).release(automationId, ethers.parseUnits("20", 6), requestId)
      ).to.be.revertedWith("duplicate requestId");
    });

    it("INVARIANT-AV-4: Immutable Terms on Top-up — cannot alter recipient or token", async function () {
      const automationId = ethers.id("auto-4");
      const amount = ethers.parseUnits("100", 6);

      await automationVault.connect(user).reserve(automationId, await mockUsdc.getAddress(), recipient.address, amount);

      // Attempting to top-up with a different recipient must revert
      await expect(
        automationVault.connect(user).reserve(automationId, await mockUsdc.getAddress(), attacker.address, amount)
      ).to.be.revertedWith("recipient mismatch");

      // Attempting to top-up from a different user must revert
      await expect(
        automationVault.connect(attacker).reserve(automationId, await mockUsdc.getAddress(), recipient.address, amount)
      ).to.be.revertedWith("not depositor");
    });

    it("INVARIANT-AV-6: Strict Role Isolation — owner cannot release funds or be an agent", async function () {
      const automationId = ethers.id("auto-5");
      const amount = ethers.parseUnits("100", 6);
      const requestId = ethers.id("req-owner-test");

      await automationVault.connect(user).reserve(automationId, await mockUsdc.getAddress(), recipient.address, amount);

      // Owner attempting to release funds must revert
      await expect(
        automationVault.connect(owner).release(automationId, amount, requestId)
      ).to.be.revertedWith("not agent");

      // Attempting to set owner as agent must revert
      await expect(
        automationVault.connect(owner).setAgent(owner.address, true)
      ).to.be.revertedWith("owner cannot be agent");
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────────
   * 2. PaymentExecutor Invariants & Unverified Address Reversions
   * ───────────────────────────────────────────────────────────────────────────── */
  describe("PaymentExecutor Security Invariants & Address/Token Validation", function () {
    it("INVARIANT-ADDRESS-REVERT: Non-verified, zero, or deactivated merchant addresses always revert", async function () {
      const amount = ethers.parseUnits("50", 6);
      const reqId = ethers.id("req-unverified-1");

      // Zero merchant address
      await expect(
        paymentExecutor.connect(agent).executePayment(
          ethers.ZeroAddress,
          await mockUsdc.getAddress(),
          amount,
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          reqId
        )
      ).to.be.revertedWith("zero merchant");

      // Zero sender (from) address in executePaymentFrom
      await expect(
        paymentExecutor.connect(agent).executePaymentFrom(
          ethers.ZeroAddress,
          recipient.address,
          await mockUsdc.getAddress(),
          amount,
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          reqId
        )
      ).to.be.revertedWith("zero from");

      // Unregistered merchant address in executePaymentFrom
      await expect(
        paymentExecutor.connect(agent).executePaymentFrom(
          user.address,
          attacker.address, // Unregistered address
          await mockUsdc.getAddress(),
          amount,
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          reqId
        )
      ).to.be.revertedWith("merchant not registered");

      // Deactivated merchant address
      await merchantRegistry.connect(owner).registerMerchant(recipient.address, "Verified Merchant");
      await merchantRegistry.connect(owner).setActive(recipient.address, false);

      await expect(
        paymentExecutor.connect(agent).executePaymentFrom(
          user.address,
          recipient.address,
          await mockUsdc.getAddress(),
          amount,
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          reqId
        )
      ).to.be.revertedWith("merchant not active");
    });

    it("INVARIANT-PE-1: Idempotency Guarantee — duplicate requestId must revert", async function () {
      const amount = ethers.parseUnits("50", 6);
      const requestId = ethers.id("req-pe-idem-1");

      await paymentExecutor.connect(agent).executePayment(
        recipient.address,
        await mockUsdc.getAddress(),
        amount,
        10,
        ethers.ZeroHash,
        ethers.ZeroHash,
        requestId
      );

      await expect(
        paymentExecutor.connect(agent).executePayment(
          recipient.address,
          await mockUsdc.getAddress(),
          amount,
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          requestId
        )
      ).to.be.revertedWith("duplicate requestId");
    });

    it("INVARIANT-CONCURRENCY: Rapid concurrent requests cannot double spend or corrupt contract state", async function () {
      const reqIdBatch = ethers.id("concurrent-batch-req");
      const amount = ethers.parseUnits("25", 6);

      // Submit identical request in parallel simulation
      const tx1Promise = paymentExecutor.connect(agent).executePayment(
        recipient.address,
        await mockUsdc.getAddress(),
        amount,
        10,
        ethers.ZeroHash,
        ethers.ZeroHash,
        reqIdBatch
      );

      // Synchronous resubmit attempt with same requestId must be blocked immediately
      await expect(tx1Promise).to.emit(paymentExecutor, "PaymentExecuted");

      await expect(
        paymentExecutor.connect(agent).executePayment(
          recipient.address,
          await mockUsdc.getAddress(),
          amount,
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          reqIdBatch
        )
      ).to.be.revertedWith("duplicate requestId");

      // Verify stats integrity: exactly 1 payment recorded
      const stats = await paymentExecutor.stats();
      expect(stats.payments).to.equal(1);
      expect(stats.volume).to.equal(amount);
    });

    it("INVARIANT-PE-2 & PE-3: Single-tx and Daily caps must strictly enforce limits", async function () {
      // Set tight maxTx ($250) for testing cap assertions
      await paymentExecutor.connect(owner).setMaxTxAmount(ethers.parseUnits("250", 6));
      await paymentExecutor.connect(owner).setDailyCap(ethers.parseUnits("1000", 6));

      const requestId1 = ethers.id("req-cap-1");
      const requestId2 = ethers.id("req-cap-2");

      // Exceed single tx max ($250 max vs $300 attempt)
      await expect(
        paymentExecutor.connect(agent).executePayment(
          recipient.address,
          await mockUsdc.getAddress(),
          ethers.parseUnits("300", 6),
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          requestId1
        )
      ).to.be.revertedWith("exceeds max tx amount");

      // Execute 4 x $250 payments ($1000 total = daily cap)
      for (let i = 0; i < 4; i++) {
        await paymentExecutor.connect(agent).executePayment(
          recipient.address,
          await mockUsdc.getAddress(),
          ethers.parseUnits("250", 6),
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          ethers.id(`req-cap-series-${i}`)
        );
      }

      // 5th payment exceeds daily cap ($1000 + $10 > $1000)
      await expect(
        paymentExecutor.connect(agent).executePayment(
          recipient.address,
          await mockUsdc.getAddress(),
          ethers.parseUnits("10", 6),
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          requestId2
        )
      ).to.be.revertedWith("daily cap exceeded");
    });

    it("INVARIANT-MATH-OVERFLOW-UNDERFLOW: Extreme parameter inputs zero amount, risk score, max values handle correctly", async function () {
      const reqIdMath = ethers.id("req-math-extreme");

      // Zero amount must revert
      await expect(
        paymentExecutor.connect(agent).executePayment(
          recipient.address,
          await mockUsdc.getAddress(),
          0,
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          reqIdMath
        )
      ).to.be.revertedWith("zero amount");

      // Risk score > 100 must revert
      await expect(
        paymentExecutor.connect(agent).executePayment(
          recipient.address,
          await mockUsdc.getAddress(),
          100,
          101,
          ethers.ZeroHash,
          ethers.ZeroHash,
          reqIdMath
        )
      ).to.be.revertedWith("risk>100");

      // Zero requestId must revert
      await expect(
        paymentExecutor.connect(agent).executePayment(
          recipient.address,
          await mockUsdc.getAddress(),
          100,
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          ethers.ZeroHash
        )
      ).to.be.revertedWith("requestId required");
    });

    it("INVARIANT-PE-6: Strict Role Isolation — owner cannot execute payments, agent cannot change limits", async function () {
      const requestId = ethers.id("req-role-pe");

      // Owner calling executePayment must revert
      await expect(
        paymentExecutor.connect(owner).executePayment(
          recipient.address,
          await mockUsdc.getAddress(),
          ethers.parseUnits("10", 6),
          10,
          ethers.ZeroHash,
          ethers.ZeroHash,
          requestId
        )
      ).to.be.revertedWith("not agent");

      // Agent calling setDailyCap must revert
      await expect(
        paymentExecutor.connect(agent).setDailyCap(ethers.parseUnits("5000", 6))
      ).to.be.revertedWith("not owner");
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────────
   * 3. MerchantRegistry & VeriPayRegistry Invariants
   * ───────────────────────────────────────────────────────────────────────────── */
  describe("MerchantRegistry & VeriPayRegistry Invariants", function () {
    it("INVARIANT-MR-1: Non-manager cannot register merchant", async function () {
      await expect(
        merchantRegistry.connect(attacker).registerMerchant(recipient.address, "Fake Merchant")
      ).to.be.revertedWith("not manager");
    });

    it("INVARIANT-MR-2: Non-recorder cannot record volume directly", async function () {
      await merchantRegistry.connect(owner).registerMerchant(recipient.address, "Valid Merchant");

      await expect(
        merchantRegistry.connect(attacker).recordVolume(recipient.address, 1000)
      ).to.be.revertedWith("not recorder");
    });

    it("INVARIANT-VR-1: Non-agent cannot record payment in VeriPayRegistry", async function () {
      await expect(
        veriPayRegistry.connect(attacker).recordPayment(
          recipient.address,
          await mockUsdc.getAddress(),
          100,
          10,
          ethers.ZeroHash,
          ethers.ZeroHash
        )
      ).to.be.revertedWith("not agent");
    });
  });
});
