const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MerchantRegistry migration path (registerMerchantWithHistory / closeMigration)", function () {
  let owner, manager, registrar, agent, attacker, merchantWallet, merchant2;
  let registry;

  beforeEach(async function () {
    [owner, manager, registrar, agent, attacker, merchantWallet, merchant2] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("MerchantRegistry");
    registry = await Registry.connect(owner).deploy();
  });

  describe("registerMerchantWithHistory", function () {
    it("lets the owner carry over historical volume/paymentCount/registeredAt", async function () {
      const oldRegisteredAt = 1_700_000_000;
      await registry.connect(owner).registerMerchantWithHistory(
        merchantWallet.address, "Legacy Merchant", true, 12345n, 7n, oldRegisteredAt,
      );

      const m = await registry.getMerchant(merchantWallet.address);
      expect(m.wallet).to.equal(merchantWallet.address);
      expect(m.name).to.equal("Legacy Merchant");
      expect(m.active).to.equal(true);
      expect(m.volume).to.equal(12345n);
      expect(m.paymentCount).to.equal(7n);
      expect(m.registeredAt).to.equal(oldRegisteredAt);
      expect(await registry.merchantCount()).to.equal(1);
    });

    it("can migrate an inactive merchant as inactive", async function () {
      await registry.connect(owner).registerMerchantWithHistory(
        merchantWallet.address, "Deactivated Merchant", false, 0n, 3n, 1_700_000_000,
      );
      expect((await registry.getMerchant(merchantWallet.address)).active).to.equal(false);
      expect(await registry.isActive(merchantWallet.address)).to.equal(false);
    });

    it("reverts for a non-owner, even a full manager or registrar", async function () {
      await registry.connect(owner).setManager(manager.address, true);
      await registry.connect(owner).setRegistrar(registrar.address, true);

      for (const signer of [manager, registrar, agent, attacker]) {
        await expect(
          registry.connect(signer).registerMerchantWithHistory(
            merchantWallet.address, "X", true, 1n, 1n, 1_700_000_000,
          ),
        ).to.be.revertedWith("not owner");
      }
    });

    it("reverts registering the same wallet twice", async function () {
      await registry.connect(owner).registerMerchantWithHistory(
        merchantWallet.address, "First", true, 1n, 1n, 1_700_000_000,
      );
      await expect(
        registry.connect(owner).registerMerchantWithHistory(
          merchantWallet.address, "Second", true, 2n, 2n, 1_700_000_001,
        ),
      ).to.be.revertedWith("already registered");
    });

    it("reverts a zero registeredAt (would be indistinguishable from unregistered)", async function () {
      await expect(
        registry.connect(owner).registerMerchantWithHistory(merchantWallet.address, "X", true, 1n, 1n, 0),
      ).to.be.revertedWith("zero registeredAt");
    });

    it("reverts a zero wallet address", async function () {
      await expect(
        registry.connect(owner).registerMerchantWithHistory(ethers.ZeroAddress, "X", true, 1n, 1n, 1_700_000_000),
      ).to.be.revertedWith("zero wallet");
    });

    it("a migrated merchant can still accrue volume normally afterward via recordVolume", async function () {
      await registry.connect(owner).registerMerchantWithHistory(
        merchantWallet.address, "Legacy", true, 1000n, 5n, 1_700_000_000,
      );
      await registry.connect(owner).setRecorder(owner.address, true);
      await registry.connect(owner).recordVolume(merchantWallet.address, 500n);

      const m = await registry.getMerchant(merchantWallet.address);
      expect(m.volume).to.equal(1500n);
      expect(m.paymentCount).to.equal(6n);
    });
  });

  describe("closeMigration", function () {
    it("permanently disables registerMerchantWithHistory once called", async function () {
      expect(await registry.migrationOpen()).to.equal(true);
      await registry.connect(owner).closeMigration();
      expect(await registry.migrationOpen()).to.equal(false);

      await expect(
        registry.connect(owner).registerMerchantWithHistory(
          merchantWallet.address, "Too Late", true, 1n, 1n, 1_700_000_000,
        ),
      ).to.be.revertedWith("migration closed");
    });

    it("only the owner can call closeMigration", async function () {
      await expect(registry.connect(attacker).closeMigration()).to.be.revertedWith("not owner");
    });

    it("does not affect the normal registerMerchant path at all", async function () {
      await registry.connect(owner).closeMigration();
      await registry.connect(owner).setRegistrar(registrar.address, true);
      await registry.connect(registrar).registerMerchant(merchant2.address, "Brand New Merchant");

      const m = await registry.getMerchant(merchant2.address);
      expect(m.name).to.equal("Brand New Merchant");
      expect(m.volume).to.equal(0n);
      expect(m.paymentCount).to.equal(0n);
    });
  });

  describe("L-02 remains fully in effect alongside the migration path", function () {
    it("registerMerchant still requires isManager or isRegistrar (unaffected by the new function existing)", async function () {
      await expect(
        registry.connect(attacker).registerMerchant(merchant2.address, "Fake"),
      ).to.be.revertedWith("not authorized to register");
    });

    it("registerMerchantWithHistory existing does not grant registrar/manager power to anyone", async function () {
      // Migrating a merchant via the owner-only path must not, as a side
      // effect, authorize that merchant's own wallet (or anyone else) to
      // call the normal registerMerchant/setActive paths.
      await registry.connect(owner).registerMerchantWithHistory(
        merchantWallet.address, "Legacy", true, 1n, 1n, 1_700_000_000,
      );
      await expect(
        registry.connect(merchantWallet).registerMerchant(merchant2.address, "Should fail"),
      ).to.be.revertedWith("not authorized to register");
      await expect(
        registry.connect(merchantWallet).setActive(merchantWallet.address, false),
      ).to.be.revertedWith("not manager");
    });
  });
});
