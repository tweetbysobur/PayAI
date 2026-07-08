const { expect } = require("chai");
const hre = require("hardhat");

describe("PaymentExecutor + MerchantRegistry", function () {
  let registry, executor, usdc, owner, agent, merchant, outsider, deployer;
  const aiHash = hre.ethers.id("decision-metadata");
  const ref = hre.ethers.id("intent-001");
  const AMT = 50_000000n; // 50 USDC (6dp)

  function reqId(label) {
    return hre.ethers.id(label);
  }

  beforeEach(async () => {
    [deployer, owner, agent, merchant, outsider] = await hre.ethers.getSigners();

    const Mock = await hre.ethers.getContractFactory("MockERC20");
    usdc = await Mock.deploy();

    const Registry = await hre.ethers.getContractFactory("MerchantRegistry");
    registry = await Registry.deploy();

    const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
    // 0 = unlimited caps, owner/agent distinct (the whole point).
    // Args: (registry, dailyCapUsdc, owner, agent, maxTxUsdc, dailyCapNative, maxTxNative)
    executor = await Executor.deploy(await registry.getAddress(), 0n, owner.address, agent.address, 0n, 0n, 0n);

    // Wire roles: executor may record volume on the registry.
    await registry.setRecorder(await executor.getAddress(), true);

    // Fund + approve the agent.
    await usdc.mint(agent.address, 1000_000000n);
    await usdc.connect(agent).approve(await executor.getAddress(), 1000_000000n);
  });

  it("registers a merchant and emits", async () => {
    await expect(registry.registerMerchant(merchant.address, "Acme"))
      .to.emit(registry, "MerchantRegistered")
      .withArgs(merchant.address, "Acme");
    expect(await registry.isActive(merchant.address)).to.equal(true);
    expect(await registry.merchantCount()).to.equal(1n);
  });

  describe("role separation", () => {
    it("sets distinct owner and agent at deploy time", async () => {
      expect(await executor.owner()).to.equal(owner.address);
      expect(await executor.isAgent(agent.address)).to.equal(true);
      expect(await executor.isAgent(owner.address)).to.equal(false);
    });

    it("rejects deploying with owner === agent", async () => {
      const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
      await expect(
        Executor.deploy(await registry.getAddress(), 0n, owner.address, owner.address, 0n, 0n, 0n),
      ).to.be.revertedWith("owner and agent must differ");
    });

    it("only the owner can add/remove agents", async () => {
      await expect(executor.connect(agent).addAgent(outsider.address)).to.be.revertedWith("not owner");
      await expect(executor.connect(owner).addAgent(outsider.address))
        .to.emit(executor, "AgentSet")
        .withArgs(outsider.address, true);
      expect(await executor.isAgent(outsider.address)).to.equal(true);

      await executor.connect(owner).removeAgent(outsider.address);
      expect(await executor.isAgent(outsider.address)).to.equal(false);
    });

    it("the owner can never also be an agent", async () => {
      await expect(executor.connect(owner).addAgent(owner.address)).to.be.revertedWith("owner cannot be agent");
    });

    it("an agent has no admin power", async () => {
      await expect(executor.connect(agent).setPaused(true)).to.be.revertedWith("not owner");
      await expect(executor.connect(agent).setDailyCap(1n)).to.be.revertedWith("not owner");
      await expect(executor.connect(agent).setMaxTxAmount(1n)).to.be.revertedWith("not owner");
      await expect(executor.connect(agent).transferOwnership(agent.address)).to.be.revertedWith("not owner");
    });
  });

  it("executes a payment: moves USDC, records it, accrues volume, emits events", async () => {
    await registry.registerMerchant(merchant.address, "Acme");
    const tokenAddr = await usdc.getAddress();
    const id1 = reqId("req-1");

    await expect(
      executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 9, aiHash, ref, id1),
    )
      .to.emit(executor, "PaymentExecuted")
      .and.to.emit(executor, "ComplianceApproved");

    expect(await usdc.balanceOf(merchant.address)).to.equal(AMT);
    expect(await executor.paymentsCount()).to.equal(1n);

    const p = await executor.getPayment(0);
    expect(p.merchant).to.equal(merchant.address);
    expect(p.amount).to.equal(AMT);
    expect(p.riskScore).to.equal(9);
    expect(p.compliance).to.equal(1); // Approved
    expect(p.requestId).to.equal(id1);

    const m = await registry.getMerchant(merchant.address);
    expect(m.volume).to.equal(AMT);
    expect(m.paymentCount).to.equal(1n);

    const s = await executor.stats();
    expect(s.payments).to.equal(1n);
    expect(s.volume).to.equal(AMT);
    expect(s.approved).to.equal(1n);
  });

  it("blocks non-agents from executing", async () => {
    const tokenAddr = await usdc.getAddress();
    await expect(
      executor.connect(outsider).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("x")),
    ).to.be.revertedWith("not agent");
  });

  describe("executePaymentFrom (Wallet Automation — pull from user)", () => {
    // `outsider` plays the authorizing user here: they hold USDC and approve
    // the executor, then the agent pulls from them to the merchant.
    beforeEach(async () => {
      await usdc.mint(outsider.address, 500_000000n);
      await usdc.connect(outsider).approve(await executor.getAddress(), 500_000000n);
    });

    it("pulls funds from the approving user, not the agent", async () => {
      const tokenAddr = await usdc.getAddress();
      const agentBefore = await usdc.balanceOf(agent.address);
      await expect(
        executor.connect(agent).executePaymentFrom(outsider.address, merchant.address, tokenAddr, AMT, 7, aiHash, ref, reqId("wf-1")),
      ).to.emit(executor, "PaymentExecuted");
      expect(await usdc.balanceOf(merchant.address)).to.equal(AMT);
      // agent's own balance untouched — the user funded it.
      expect(await usdc.balanceOf(agent.address)).to.equal(agentBefore);
    });

    it("only an agent can trigger it", async () => {
      const tokenAddr = await usdc.getAddress();
      await expect(
        executor.connect(outsider).executePaymentFrom(outsider.address, merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("wf-x")),
      ).to.be.revertedWith("not agent");
    });

    it("is idempotent on requestId", async () => {
      const tokenAddr = await usdc.getAddress();
      await executor.connect(agent).executePaymentFrom(outsider.address, merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("wf-dup"));
      await expect(
        executor.connect(agent).executePaymentFrom(outsider.address, merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("wf-dup")),
      ).to.be.revertedWith("duplicate requestId");
    });

    it("reverts if the user has not approved enough", async () => {
      const tokenAddr = await usdc.getAddress();
      await usdc.connect(outsider).approve(await executor.getAddress(), 0n);
      await expect(
        executor.connect(agent).executePaymentFrom(outsider.address, merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("wf-noallow")),
      ).to.be.reverted;
    });

    it("still enforces the per-tx cap", async () => {
      const tokenAddr = await usdc.getAddress();
      await executor.connect(owner).setMaxTxAmount(40_000000n);
      await expect(
        executor.connect(agent).executePaymentFrom(outsider.address, merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("wf-cap")),
      ).to.be.revertedWith("exceeds max tx amount");
    });
  });

  describe("idempotency", () => {
    it("rejects a duplicate requestId (API retry / double-click)", async () => {
      const tokenAddr = await usdc.getAddress();
      const id1 = reqId("duplicate-me");
      await executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, id1);
      await expect(
        executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, id1),
      ).to.be.revertedWith("duplicate requestId");
      // Only one payment actually executed despite two calls.
      expect(await executor.paymentsCount()).to.equal(1n);
      expect(await usdc.balanceOf(merchant.address)).to.equal(AMT);
    });

    it("requires a non-zero requestId", async () => {
      const tokenAddr = await usdc.getAddress();
      await expect(
        executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, hre.ethers.ZeroHash),
      ).to.be.revertedWith("requestId required");
    });

    it("reports processed requestIds via isRequestProcessed", async () => {
      const tokenAddr = await usdc.getAddress();
      const id1 = reqId("processed-check");
      expect(await executor.isRequestProcessed(id1)).to.equal(false);
      await executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, id1);
      expect(await executor.isRequestProcessed(id1)).to.equal(true);
    });
  });

  describe("transaction limits", () => {
    it("enforces a global max-tx-amount set by the owner", async () => {
      const tokenAddr = await usdc.getAddress();
      await executor.connect(owner).setMaxTxAmount(40_000000n); // cap below AMT (50)
      await expect(
        executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("over-cap")),
      ).to.be.revertedWith("exceeds max tx amount");
    });

    it("lets a per-merchant cap override the global max", async () => {
      const tokenAddr = await usdc.getAddress();
      await executor.connect(owner).setMaxTxAmount(1000_000000n); // generous global cap
      await executor.connect(owner).setMerchantMaxTx(merchant.address, 10_000000n); // 10 USDC for this merchant only
      await expect(
        executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("over-merchant-cap")),
      ).to.be.revertedWith("exceeds max tx amount");
      // A smaller payment to the same merchant still works.
      await executor.connect(agent).executePayment(merchant.address, tokenAddr, 5_000000n, 0, aiHash, ref, reqId("under-merchant-cap"));
      expect(await usdc.balanceOf(merchant.address)).to.equal(5_000000n);
    });

    it("only the owner can change limits", async () => {
      await expect(executor.connect(agent).setMaxTxAmount(1n)).to.be.revertedWith("not owner");
      await expect(executor.connect(agent).setMerchantMaxTx(merchant.address, 1n)).to.be.revertedWith("not owner");
    });

    it("enforces a USDC per-tx cap set at DEPLOY time (no owner call needed)", async () => {
      // Fresh executor with a 40 USDC per-tx cap baked into the constructor.
      const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
      const ex2 = await Executor.deploy(await registry.getAddress(), 0n, owner.address, agent.address, 40_000000n, 0n, 0n);
      await registry.setRecorder(await ex2.getAddress(), true);
      await usdc.connect(agent).approve(await ex2.getAddress(), 1000_000000n);
      const tokenAddr = await usdc.getAddress();
      expect(await ex2.maxTxAmount()).to.equal(40_000000n);
      await expect(
        ex2.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("deploy-cap-over")),
      ).to.be.revertedWith("exceeds max tx amount");
      // Under the deploy-time cap still works.
      await ex2.connect(agent).executePayment(merchant.address, tokenAddr, 30_000000n, 0, aiHash, ref, reqId("deploy-cap-under"));
      expect(await usdc.balanceOf(merchant.address)).to.equal(30_000000n);
    });
  });

  describe("native MON payments", () => {
    it("forwards native value to the merchant and records the payment", async () => {
      const before = await hre.ethers.provider.getBalance(merchant.address);
      const value = hre.ethers.parseEther("1.5");

      await expect(
        executor.connect(agent).executePaymentNative(merchant.address, 5, aiHash, ref, reqId("native-1"), { value }),
      )
        .to.emit(executor, "PaymentExecuted")
        .withArgs(0, agent.address, merchant.address, hre.ethers.ZeroAddress, value, 5, aiHash, ref, reqId("native-1"));

      const after = await hre.ethers.provider.getBalance(merchant.address);
      expect(after - before).to.equal(value);

      const p = await executor.getPayment(0);
      expect(p.token).to.equal(hre.ethers.ZeroAddress);
      expect(p.amount).to.equal(value);
    });

    it("applies the same idempotency and limit checks as ERC-20 payments", async () => {
      const value = hre.ethers.parseEther("1");
      const id1 = reqId("native-dup");
      await executor.connect(agent).executePaymentNative(merchant.address, 0, aiHash, ref, id1, { value });
      await expect(
        executor.connect(agent).executePaymentNative(merchant.address, 0, aiHash, ref, id1, { value }),
      ).to.be.revertedWith("duplicate requestId");
    });

    it("blocks non-agents from sending native payments", async () => {
      await expect(
        executor.connect(outsider).executePaymentNative(merchant.address, 0, aiHash, ref, reqId("x"), {
          value: hre.ethers.parseEther("1"),
        }),
      ).to.be.revertedWith("not agent");
    });

    it("enforces maxTxAmountNative independently of the ERC-20 maxTxAmount", async () => {
      // Regression test for the production bug: a maxTxAmount sized for 6dp
      // USDC (e.g. 100e6) must never reject a native MON payment, and a
      // maxTxAmountNative sized for 18dp MON must never affect USDC.
      await executor.connect(owner).setMaxTxAmount(100_000000n); // 100 USDC — tiny in wei terms
      await executor.connect(owner).setMaxTxAmountNative(hre.ethers.parseEther("5")); // 5 MON cap

      // 3 MON native — well under the 5 MON native cap, must succeed even
      // though 3e18 vastly exceeds the unrelated 100e6 USDC-denominated cap.
      await expect(
        executor.connect(agent).executePaymentNative(merchant.address, 0, aiHash, ref, reqId("native-under-cap"), {
          value: hre.ethers.parseEther("3"),
        }),
      ).to.not.be.reverted;

      // 10 MON native — over the 5 MON native cap — must revert.
      await expect(
        executor.connect(agent).executePaymentNative(merchant.address, 0, aiHash, ref, reqId("native-over-cap"), {
          value: hre.ethers.parseEther("10"),
        }),
      ).to.be.revertedWith("exceeds max tx amount");

      // The unrelated ERC-20 cap is untouched by the native-specific setter.
      const tokenAddr = await usdc.getAddress();
      await expect(
        executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("usdc-under-cap")),
      ).to.not.be.reverted;
    });

    it("enforces dailyCapNative independently of the ERC-20 dailyCap", async () => {
      await executor.connect(owner).setDailyCapNative(hre.ethers.parseEther("4"));
      await executor.connect(agent).executePaymentNative(merchant.address, 0, aiHash, ref, reqId("native-day-1"), {
        value: hre.ethers.parseEther("3"),
      });
      await expect(
        executor.connect(agent).executePaymentNative(merchant.address, 0, aiHash, ref, reqId("native-day-2"), {
          value: hre.ethers.parseEther("2"),
        }),
      ).to.be.revertedWith("daily cap exceeded");
    });

    it("only the owner can change native limits", async () => {
      await expect(executor.connect(agent).setMaxTxAmountNative(1n)).to.be.revertedWith("not owner");
      await expect(executor.connect(agent).setDailyCapNative(1n)).to.be.revertedWith("not owner");
      await expect(executor.connect(agent).setMerchantMaxTxNative(merchant.address, 1n)).to.be.revertedWith("not owner");
    });
  });

  it("creates and pays a payment request", async () => {
    const tokenAddr = await usdc.getAddress();
    await registry.registerMerchant(merchant.address, "Acme");

    await expect(executor.connect(agent).createPaymentRequest(merchant.address, tokenAddr, AMT, ref))
      .to.emit(executor, "PaymentRequested")
      .withArgs(0, merchant.address, tokenAddr, AMT, ref);

    await expect(executor.connect(agent).payRequest(0, 12, aiHash, reqId("pay-request-1")))
      .to.emit(executor, "RequestPaid")
      .withArgs(0, 0);

    const r = await executor.getRequest(0);
    expect(r.paid).to.equal(true);
    expect(await usdc.balanceOf(merchant.address)).to.equal(AMT);
  });

  it("records a rejection without transferring", async () => {
    await expect(executor.connect(agent).recordRejection(merchant.address, AMT, 80, ref))
      .to.emit(executor, "ComplianceRejected")
      .withArgs(agent.address, merchant.address, AMT, 80, ref);
    expect(await executor.rejectedCount()).to.equal(1n);
    expect(await usdc.balanceOf(merchant.address)).to.equal(0n);
  });

  it("honors pause (owner-controlled emergency stop)", async () => {
    const tokenAddr = await usdc.getAddress();
    await executor.connect(owner).setPaused(true);
    await expect(
      executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("paused")),
    ).to.be.revertedWith("paused");
  });

  it("enforces the per-agent daily cap", async () => {
    const tokenAddr = await usdc.getAddress();
    await executor.connect(owner).setDailyCap(60_000000n); // 60 USDC/day
    // First 50 USDC payment is fine.
    await executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("day-1"));
    // A second 50 USDC payment (distinct requestId) would push the day's total to 100 > 60 → revert.
    await expect(
      executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("day-2")),
    ).to.be.revertedWith("daily cap exceeded");
  });

  it("tracks spentPerDay", async () => {
    const tokenAddr = await usdc.getAddress();
    await executor.connect(owner).setDailyCap(1000_000000n);
    await executor.connect(agent).executePayment(merchant.address, tokenAddr, AMT, 0, aiHash, ref, reqId("spend-track"));
    const day = BigInt(Math.floor((await hre.ethers.provider.getBlock("latest")).timestamp / 86400));
    expect(await executor.spentPerDay(agent.address, day)).to.equal(AMT);
  });
});
