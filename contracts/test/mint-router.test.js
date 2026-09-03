const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MintRouter", function () {
  const PRICE = ethers.parseEther("1"); // 1 MON mint price
  const FEE_BPS = 1000; // 10%

  async function deploy() {
    const [owner, buyer, feeRecipient, caller] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("MockMintNFT");
    const nft = await NFT.deploy(PRICE);
    const Router = await ethers.getContractFactory("MintRouter");
    const router = await Router.deploy(feeRecipient.address, FEE_BPS);
    // Configure: point at the NFT, set price, set mint() selector as calldata.
    await router.setTarget(await nft.getAddress(), PRICE);
    const mintSelector = nft.interface.getFunction("mint").selector;
    await router.setMintCalldata(mintSelector);
    return { owner, buyer, feeRecipient, caller, nft, router };
  }

  it("quotes price plus 10% fee", async function () {
    const { router } = await deploy();
    const [total, fee] = await router.quote();
    expect(fee).to.equal(ethers.parseEther("0.1"));
    expect(total).to.equal(ethers.parseEther("1.1"));
  });

  it("mints, delivers NFT to buyer, and pays the fee", async function () {
    const { buyer, feeRecipient, caller, nft, router } = await deploy();
    const feeBefore = await ethers.provider.getBalance(feeRecipient.address);

    await router.connect(caller).mintFor(buyer.address, { value: ethers.parseEther("1.1") });

    // Buyer owns token 0.
    expect(await nft.ownerOf(0)).to.equal(buyer.address);
    // Router keeps nothing.
    expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0n);
    // Fee recipient received 0.1 MON.
    const feeAfter = await ethers.provider.getBalance(feeRecipient.address);
    expect(feeAfter - feeBefore).to.equal(ethers.parseEther("0.1"));
  });

  it("refunds excess payment to the caller", async function () {
    const { buyer, caller, router } = await deploy();
    const before = await ethers.provider.getBalance(caller.address);
    const tx = await router.connect(caller).mintFor(buyer.address, { value: ethers.parseEther("2") });
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    const after = await ethers.provider.getBalance(caller.address);
    // Caller paid exactly 1.1 (total) + gas; the extra 0.9 came back.
    expect(before - after - gas).to.equal(ethers.parseEther("1.1"));
  });

  it("reverts when underpaid", async function () {
    const { buyer, caller, router } = await deploy();
    await expect(
      router.connect(caller).mintFor(buyer.address, { value: ethers.parseEther("1") }),
    ).to.be.revertedWithCustomError(router, "InsufficientPayment");
  });

  it("reverts when not configured", async function () {
    const [, , feeRecipient] = await ethers.getSigners();
    const Router = await ethers.getContractFactory("MintRouter");
    const router = await Router.deploy(feeRecipient.address, FEE_BPS);
    await expect(
      router.mintFor(feeRecipient.address, { value: PRICE }),
    ).to.be.revertedWithCustomError(router, "NotConfigured");
  });

  it("only owner can set target and fee", async function () {
    const { caller, nft, router } = await deploy();
    await expect(
      router.connect(caller).setTarget(await nft.getAddress(), PRICE),
    ).to.be.revertedWithCustomError(router, "NotOwner");
    await expect(
      router.connect(caller).setFeeConfig(500, caller.address),
    ).to.be.revertedWithCustomError(router, "NotOwner");
  });

  it("rejects a fee above the 50% cap", async function () {
    const [, , feeRecipient] = await ethers.getSigners();
    const Router = await ethers.getContractFactory("MintRouter");
    await expect(Router.deploy(feeRecipient.address, 5001)).to.be.revertedWithCustomError(
      Router,
      "FeeTooHigh",
    );
  });
});
