const { expect } = require("chai");
const hre = require("hardhat");

describe("VeriPayRegistry", function () {
  let registry, owner, agent, outsider, recipient;
  const TOKEN = "0xaC0893567D43C3E7e6e35a72803df05416C1f20D"; // sandbox aUSDC
  const purposeHash = hre.ethers.id("design work");
  const ref = hre.ethers.id("intent-001");

  beforeEach(async () => {
    [owner, agent, outsider, recipient] = await hre.ethers.getSigners();
    const F = await hre.ethers.getContractFactory("VeriPayRegistry");
    registry = await F.deploy();
    await registry.waitForDeployment();
  });

  it("makes the deployer owner + first agent", async () => {
    expect(await registry.owner()).to.equal(owner.address);
    expect(await registry.isAgent(owner.address)).to.equal(true);
  });

  it("records a payment and emits an event", async () => {
    await expect(
      registry.recordPayment(recipient.address, TOKEN, 50_000000n, 9, purposeHash, ref),
    )
      .to.emit(registry, "PaymentRecorded")
      .withArgs(0, owner.address, recipient.address, TOKEN, 50_000000n, 9, purposeHash, ref);

    expect(await registry.paymentsCount()).to.equal(1n);
    const p = await registry.getPayment(0);
    expect(p.recipient).to.equal(recipient.address);
    expect(p.amount).to.equal(50_000000n);
    expect(p.riskScore).to.equal(9);
    expect(await registry.paymentsOf(recipient.address)).to.deep.equal([0n]);
  });

  it("blocks non-agents", async () => {
    await expect(
      registry.connect(outsider).recordPayment(recipient.address, TOKEN, 1n, 0, purposeHash, ref),
    ).to.be.revertedWith("not agent");
  });

  it("lets the owner add an agent", async () => {
    await registry.setAgent(agent.address, true);
    await expect(
      registry.connect(agent).recordPayment(recipient.address, TOKEN, 1n, 0, purposeHash, ref),
    ).to.emit(registry, "PaymentRecorded");
  });

  it("rejects risk scores above 100", async () => {
    await expect(
      registry.recordPayment(recipient.address, TOKEN, 1n, 101, purposeHash, ref),
    ).to.be.revertedWith("risk>100");
  });

  it("honors pause", async () => {
    await registry.setPaused(true);
    await expect(
      registry.recordPayment(recipient.address, TOKEN, 1n, 0, purposeHash, ref),
    ).to.be.revertedWith("paused");
  });
});
