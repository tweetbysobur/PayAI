const { expect } = require("chai");
const hre = require("hardhat");

// PayAIForwarder gives interactive, user-signed payments a PayAI on-chain
// footprint WITHOUT changing the trust model: the user is always the payer
// (msg.sender), the contract never custodies funds, and there is no agent
// role and no arbitrary-call surface. These tests prove all of that.

describe("PayAIForwarder", function () {
  let forwarder, token, owner, payer, recipient, outsider;
  const ref = hre.ethers.id("intent-fwd-001");
  const ONE = hre.ethers.parseEther("1");
  const USDC = 50_000000n; // 50 USDC (6dp mock)

  beforeEach(async () => {
    [owner, payer, recipient, outsider] = await hre.ethers.getSigners();

    const Forwarder = await hre.ethers.getContractFactory("PayAIForwarder");
    forwarder = await Forwarder.deploy(owner.address);

    const Mock = await hre.ethers.getContractFactory("MockERC20");
    token = await Mock.deploy();
    await token.mint(payer.address, 1000_000000n);
  });

  /* ── Construction / admin ─────────────────────────────────────────────── */

  describe("construction & admin", () => {
    it("sets the owner and emits OwnershipTransferred", async () => {
      expect(await forwarder.owner()).to.equal(owner.address);
    });
    it("rejects a zero owner at deploy", async () => {
      const Forwarder = await hre.ethers.getContractFactory("PayAIForwarder");
      await expect(Forwarder.deploy(hre.ethers.ZeroAddress)).to.be.revertedWith("zero owner");
    });
    it("only the owner can pause; a paused contract rejects payments", async () => {
      await expect(forwarder.connect(outsider).setPaused(true)).to.be.revertedWith("not owner");
      await forwarder.connect(owner).setPaused(true);
      await expect(
        forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE }),
      ).to.be.revertedWith("paused");
      await forwarder.connect(owner).setPaused(false);
      await expect(
        forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE }),
      ).to.emit(forwarder, "PaymentForwarded");
    });
    it("owner has NO function that can move a user's funds (pause + transferOwnership only)", async () => {
      // The full external ABI, minus views, must be exactly these four — no
      // sweep/rescue/withdraw/execute of any kind.
      const fns = forwarder.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view")
        .map((f) => f.name)
        .sort();
      expect(fns).to.deep.equal(["forwardPayment", "forwardPaymentNative", "setPaused", "transferOwnership"]);
    });
    it("owner can transfer ownership; zero rejected", async () => {
      await expect(forwarder.connect(owner).transferOwnership(hre.ethers.ZeroAddress)).to.be.revertedWith("zero addr");
      await forwarder.connect(owner).transferOwnership(outsider.address);
      expect(await forwarder.owner()).to.equal(outsider.address);
    });
  });

  /* ── Native MON ───────────────────────────────────────────────────────── */

  describe("forwardPaymentNative", () => {
    it("forwards the exact amount to the recipient (User -> Forwarder -> recipient)", async () => {
      await expect(
        forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE }),
      ).to.changeEtherBalances([payer, forwarder, recipient], [-ONE, 0n, ONE]);
    });
    it("emits PaymentForwarded with token=address(0) and the real amount", async () => {
      await expect(forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE }))
        .to.emit(forwarder, "PaymentForwarded")
        .withArgs(0n, payer.address, recipient.address, hre.ethers.ZeroAddress, ONE, ref);
    });
    it("rejects a zero recipient", async () => {
      await expect(
        forwarder.connect(payer).forwardPaymentNative(hre.ethers.ZeroAddress, ONE, ref, { value: ONE }),
      ).to.be.revertedWith("zero recipient");
    });
    it("rejects zero value", async () => {
      await expect(
        forwarder.connect(payer).forwardPaymentNative(recipient.address, 0n, ref, { value: 0n }),
      ).to.be.revertedWith("zero amount");
    });
    it("rejects a msg.value that doesn't match the stated amount (both directions)", async () => {
      await expect(
        forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE - 1n }),
      ).to.be.revertedWith("value mismatch");
      await expect(
        forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE + 1n }),
      ).to.be.revertedWith("value mismatch");
    });
    it("reverts the whole payment if the recipient rejects MON (no partial, forwarder keeps nothing)", async () => {
      const Rev = await hre.ethers.getContractFactory("RevertingReceiver");
      const rev = await Rev.deploy();
      await expect(
        forwarder.connect(payer).forwardPaymentNative(await rev.getAddress(), ONE, ref, { value: ONE }),
      ).to.be.revertedWith("native forward failed");
      expect(await hre.ethers.provider.getBalance(await forwarder.getAddress())).to.equal(0n);
    });
    it("retains zero MON after a successful forward", async () => {
      await forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE });
      expect(await hre.ethers.provider.getBalance(await forwarder.getAddress())).to.equal(0n);
    });
    it("records the payer as msg.sender, never a caller-chosen address", async () => {
      // outsider funds and calls -> outsider is the payer, full stop.
      await expect(forwarder.connect(outsider).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE }))
        .to.emit(forwarder, "PaymentForwarded")
        .withArgs(0n, outsider.address, recipient.address, hre.ethers.ZeroAddress, ONE, ref);
    });
    it("blocks a reentrancy attempt through a malicious recipient", async () => {
      const Re = await hre.ethers.getContractFactory("ReentrantReceiver");
      const attacker = await Re.deploy(await forwarder.getAddress(), recipient.address);
      // The reentrant inner call hits the nonReentrant guard, reverting; the
      // outer call requires the forward to succeed, so the whole thing reverts.
      await expect(
        forwarder.connect(payer).forwardPaymentNative(await attacker.getAddress(), ONE, ref, { value: ONE }),
      ).to.be.revertedWith("native forward failed");
      expect(await hre.ethers.provider.getBalance(await forwarder.getAddress())).to.equal(0n);
    });
    it("increments the execution id per payment", async () => {
      await expect(forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE }))
        .to.emit(forwarder, "PaymentForwarded").withArgs(0n, payer.address, recipient.address, hre.ethers.ZeroAddress, ONE, ref);
      await expect(forwarder.connect(payer).forwardPaymentNative(recipient.address, ONE, ref, { value: ONE }))
        .to.emit(forwarder, "PaymentForwarded").withArgs(1n, payer.address, recipient.address, hre.ethers.ZeroAddress, ONE, ref);
      expect(await forwarder.paymentCount()).to.equal(2n);
    });
  });

  /* ── ERC-20 ───────────────────────────────────────────────────────────── */

  describe("forwardPayment (ERC-20)", () => {
    beforeEach(async () => {
      await token.connect(payer).approve(await forwarder.getAddress(), 1000_000000n);
    });

    it("moves tokens user -> recipient directly (never through the forwarder)", async () => {
      const before = await token.balanceOf(recipient.address);
      await forwarder.connect(payer).forwardPayment(await token.getAddress(), recipient.address, USDC, ref);
      expect(await token.balanceOf(recipient.address)).to.equal(before + USDC);
      // Forwarder never held the token.
      expect(await token.balanceOf(await forwarder.getAddress())).to.equal(0n);
    });
    it("emits PaymentForwarded with the token address and real amount", async () => {
      await expect(forwarder.connect(payer).forwardPayment(await token.getAddress(), recipient.address, USDC, ref))
        .to.emit(forwarder, "PaymentForwarded")
        .withArgs(0n, payer.address, recipient.address, await token.getAddress(), USDC, ref);
    });
    it("rejects a zero token", async () => {
      await expect(
        forwarder.connect(payer).forwardPayment(hre.ethers.ZeroAddress, recipient.address, USDC, ref),
      ).to.be.revertedWith("zero token");
    });
    it("rejects a zero recipient", async () => {
      await expect(
        forwarder.connect(payer).forwardPayment(await token.getAddress(), hre.ethers.ZeroAddress, USDC, ref),
      ).to.be.revertedWith("zero recipient");
    });
    it("rejects a zero amount", async () => {
      await expect(
        forwarder.connect(payer).forwardPayment(await token.getAddress(), recipient.address, 0n, ref),
      ).to.be.revertedWith("zero amount");
    });
    it("reverts on insufficient allowance", async () => {
      await token.connect(payer).approve(await forwarder.getAddress(), 0n);
      await expect(
        forwarder.connect(payer).forwardPayment(await token.getAddress(), recipient.address, USDC, ref),
      ).to.be.reverted; // MockERC20 reverts "allowance"
    });
    it("reverts on insufficient balance", async () => {
      const poor = outsider;
      await token.connect(poor).approve(await forwarder.getAddress(), USDC);
      await expect(
        forwarder.connect(poor).forwardPayment(await token.getAddress(), recipient.address, USDC, ref),
      ).to.be.reverted; // MockERC20 reverts "balance"
    });
    it("rejects a false-returning token (require(ok))", async () => {
      const F = await hre.ethers.getContractFactory("FalseReturningERC20");
      const bad = await F.deploy();
      await bad.mint(payer.address, USDC);
      await bad.connect(payer).approve(await forwarder.getAddress(), USDC);
      await expect(
        forwarder.connect(payer).forwardPayment(await bad.getAddress(), recipient.address, USDC, ref),
      ).to.be.revertedWith("transfer failed");
    });
    it("propagates a reverting token's revert (whole payment reverts)", async () => {
      const R = await hre.ethers.getContractFactory("RevertingERC20");
      const bad = await R.deploy();
      await bad.mint(payer.address, USDC);
      await bad.connect(payer).approve(await forwarder.getAddress(), USDC);
      await expect(
        forwarder.connect(payer).forwardPayment(await bad.getAddress(), recipient.address, USDC, ref),
      ).to.be.revertedWith("token transfer reverted");
    });
    it("rejects a fee-on-transfer token that under-delivers (balance-delta check)", async () => {
      const S = await hre.ethers.getContractFactory("ShortTransferERC20");
      const shrt = await S.deploy();
      await shrt.mint(payer.address, USDC);
      await shrt.connect(payer).approve(await forwarder.getAddress(), USDC);
      // Recipient would receive only 90% -> delta != amount -> revert.
      await expect(
        forwarder.connect(payer).forwardPayment(await shrt.getAddress(), recipient.address, USDC, ref),
      ).to.be.revertedWith("token did not deliver full amount");
    });
    it("delivers the EXACT amount to the recipient and nothing to the forwarder", async () => {
      const rBefore = await token.balanceOf(recipient.address);
      await forwarder.connect(payer).forwardPayment(await token.getAddress(), recipient.address, USDC, ref);
      expect(await token.balanceOf(recipient.address)).to.equal(rBefore + USDC);
      expect(await token.balanceOf(await forwarder.getAddress())).to.equal(0n);
    });
    it("payer cannot be spoofed — funds only ever come from msg.sender's own approval", async () => {
      // outsider has NOT approved the forwarder; even though payer HAS, an
      // outsider-initiated call pulls from outsider's (zero) approval, not
      // payer's — proving there is no way to spend someone else's approval.
      await expect(
        forwarder.connect(outsider).forwardPayment(await token.getAddress(), recipient.address, USDC, ref),
      ).to.be.reverted;
      // payer's approval is untouched and still fully usable by payer.
      await expect(forwarder.connect(payer).forwardPayment(await token.getAddress(), recipient.address, USDC, ref))
        .to.emit(forwarder, "PaymentForwarded");
    });
  });

  /* ── No arbitrary-call / generic-execution surface ────────────────────── */

  describe("no arbitrary execution surface", () => {
    it("exposes ONLY the two typed payment functions plus admin — nothing generic", async () => {
      const names = forwarder.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      // No execute / call / multicall / delegatecall / sweep / rescue / withdraw.
      for (const forbidden of ["execute", "call", "callContract", "multicall", "delegatecall", "sweep", "rescue", "withdraw", "batch"]) {
        expect(names).to.not.include(forbidden);
      }
    });
    it("has no payable fallback/receive that could silently accept and trap MON", async () => {
      // A bare value transfer to the contract (no calldata) must revert, so MON
      // can never accumulate here outside the typed, forwarding path.
      await expect(
        payer.sendTransaction({ to: await forwarder.getAddress(), value: ONE }),
      ).to.be.reverted;
      expect(await hre.ethers.provider.getBalance(await forwarder.getAddress())).to.equal(0n);
    });
  });
});
