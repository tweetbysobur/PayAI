const { expect } = require("chai");
const hre = require("hardhat");

describe("AutomationVault (Reserved Funds)", function () {
  let vault, usdc, owner, agent, depositor, recipient, outsider;
  const AUTO = hre.ethers.id("automation-1");
  const ZERO = hre.ethers.ZeroAddress;
  const reqId = (l) => hre.ethers.id(l);

  beforeEach(async () => {
    [, owner, agent, depositor, recipient, outsider] = await hre.ethers.getSigners();

    const Mock = await hre.ethers.getContractFactory("MockERC20");
    usdc = await Mock.deploy();
    await usdc.mint(depositor.address, 1000_000000n);

    const Vault = await hre.ethers.getContractFactory("AutomationVault");
    vault = await Vault.deploy(owner.address, agent.address);
  });

  describe("role separation", () => {
    it("sets distinct owner and agent, rejects owner === agent", async () => {
      expect(await vault.owner()).to.equal(owner.address);
      expect(await vault.isAgent(agent.address)).to.equal(true);
      const Vault = await hre.ethers.getContractFactory("AutomationVault");
      await expect(Vault.deploy(owner.address, owner.address)).to.be.revertedWith("owner and agent must differ");
    });

    it("an agent has no admin power", async () => {
      await expect(vault.connect(agent).setPaused(true)).to.be.revertedWith("not owner");
      await expect(vault.connect(agent).setAgent(outsider.address, true)).to.be.revertedWith("not owner");
    });
  });

  describe("reserve (native MON)", () => {
    it("holds native funds isolated per automation", async () => {
      const amount = hre.ethers.parseEther("5");
      await expect(vault.connect(depositor).reserve(AUTO, ZERO, recipient.address, amount, { value: amount }))
        .to.emit(vault, "Reserved");
      expect(await vault.reservedBalance(AUTO)).to.equal(amount);
      expect(await hre.ethers.provider.getBalance(await vault.getAddress())).to.equal(amount);
    });

    it("rejects a native reserve whose msg.value != amount", async () => {
      const amount = hre.ethers.parseEther("5");
      await expect(
        vault.connect(depositor).reserve(AUTO, ZERO, recipient.address, amount, { value: hre.ethers.parseEther("4") }),
      ).to.be.revertedWith("bad msg.value");
    });
  });

  describe("reserve (ERC-20)", () => {
    beforeEach(async () => {
      await usdc.connect(depositor).approve(await vault.getAddress(), 1000_000000n);
    });

    it("pulls ERC-20 into the vault", async () => {
      await vault.connect(depositor).reserve(AUTO, await usdc.getAddress(), recipient.address, 100_000000n);
      expect(await vault.reservedBalance(AUTO)).to.equal(100_000000n);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(100_000000n);
    });

    it("top-up must match depositor, token, and recipient", async () => {
      const tok = await usdc.getAddress();
      await vault.connect(depositor).reserve(AUTO, tok, recipient.address, 50_000000n);
      // wrong recipient
      await expect(vault.connect(depositor).reserve(AUTO, tok, outsider.address, 10_000000n)).to.be.revertedWith("recipient mismatch");
      // wrong depositor
      await expect(vault.connect(outsider).reserve(AUTO, tok, recipient.address, 10_000000n)).to.be.revertedWith("not depositor");
      // valid top-up
      await vault.connect(depositor).reserve(AUTO, tok, recipient.address, 25_000000n);
      expect(await vault.reservedBalance(AUTO)).to.equal(75_000000n);
    });
  });

  describe("release", () => {
    beforeEach(async () => {
      await usdc.connect(depositor).approve(await vault.getAddress(), 1000_000000n);
      await vault.connect(depositor).reserve(AUTO, await usdc.getAddress(), recipient.address, 100_000000n);
    });

    it("pays only the committed recipient, debits the reservation", async () => {
      await expect(vault.connect(agent).release(AUTO, 30_000000n, reqId("r1")))
        .to.emit(vault, "Released");
      expect(await usdc.balanceOf(recipient.address)).to.equal(30_000000n);
      expect(await vault.reservedBalance(AUTO)).to.equal(70_000000n);
    });

    it("blocks non-agents", async () => {
      await expect(vault.connect(outsider).release(AUTO, 10_000000n, reqId("x"))).to.be.revertedWith("not agent");
      await expect(vault.connect(depositor).release(AUTO, 10_000000n, reqId("y"))).to.be.revertedWith("not agent");
    });

    it("is idempotent — a duplicate requestId reverts (no double payment)", async () => {
      await vault.connect(agent).release(AUTO, 20_000000n, reqId("dup"));
      await expect(vault.connect(agent).release(AUTO, 20_000000n, reqId("dup"))).to.be.revertedWith("duplicate requestId");
      expect(await usdc.balanceOf(recipient.address)).to.equal(20_000000n);
    });

    it("cannot release more than reserved", async () => {
      await expect(vault.connect(agent).release(AUTO, 200_000000n, reqId("over"))).to.be.revertedWith("amount exceeds reserved");
    });

    it("honors pause", async () => {
      await vault.connect(owner).setPaused(true);
      await expect(vault.connect(agent).release(AUTO, 10_000000n, reqId("p"))).to.be.revertedWith("paused");
    });
  });

  describe("refund", () => {
    beforeEach(async () => {
      await usdc.connect(depositor).approve(await vault.getAddress(), 1000_000000n);
      await vault.connect(depositor).reserve(AUTO, await usdc.getAddress(), recipient.address, 100_000000n);
    });

    it("returns the remaining balance to the original depositor", async () => {
      await vault.connect(agent).release(AUTO, 40_000000n, reqId("partial"));
      const before = await usdc.balanceOf(depositor.address);
      await expect(vault.connect(depositor).refund(AUTO)).to.emit(vault, "Refunded");
      const after = await usdc.balanceOf(depositor.address);
      expect(after - before).to.equal(60_000000n);
      expect(await vault.reservedBalance(AUTO)).to.equal(0n);
    });

    it("an agent can refund on cancel, but funds still go to the depositor", async () => {
      const before = await usdc.balanceOf(depositor.address);
      await vault.connect(agent).refund(AUTO);
      const after = await usdc.balanceOf(depositor.address);
      expect(after - before).to.equal(100_000000n);
    });

    it("cannot double-refund", async () => {
      await vault.connect(depositor).refund(AUTO);
      await expect(vault.connect(depositor).refund(AUTO)).to.be.revertedWith("nothing to refund");
    });

    it("an outsider cannot trigger a refund", async () => {
      await expect(vault.connect(outsider).refund(AUTO)).to.be.revertedWith("not authorized");
    });
  });
});
