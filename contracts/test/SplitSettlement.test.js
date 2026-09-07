const { expect } = require("chai");
const hre = require("hardhat");

// SplitSettlement atomically splits a user's OWN payment across multiple
// recipients in one user-signed transaction. It is the N-ary generalization of
// PayAIForwarder's user-signed, no-custody model: the payer is always
// msg.sender, the contract never custodies funds, there is no agent role, no
// arbitrary-call surface, no fee, and no requestId map. These tests prove all
// of that, plus the Phase 4A-required corrections (delta-based zero-retention,
// contract-computed totalAmount, self-recipient revert, MAX_RECIPIENTS=10).

describe("SplitSettlement", function () {
  let split, owner, payer, a, b, c, outsider;
  const ref = hre.ethers.id("intent-split-001");
  const ONE = hre.ethers.parseEther("1");
  const Z = hre.ethers.ZeroAddress;

  beforeEach(async () => {
    [owner, payer, a, b, c, outsider] = await hre.ethers.getSigners();
    const S = await hre.ethers.getContractFactory("SplitSettlement");
    split = await S.deploy(owner.address);
  });

  async function newToken(mintTo, amount) {
    const Mock = await hre.ethers.getContractFactory("MockERC20");
    const t = await Mock.deploy();
    await t.mint(mintTo.address, amount);
    return t;
  }

  /* ── A. Deployment ────────────────────────────────────────────────────── */
  describe("A. deployment", () => {
    it("sets the initial owner", async () => {
      expect(await split.owner()).to.equal(owner.address);
    });
    it("starts unpaused with settlementCount 0 and MAX_RECIPIENTS 10", async () => {
      expect(await split.paused()).to.equal(false);
      expect(await split.settlementCount()).to.equal(0n);
      expect(await split.MAX_RECIPIENTS()).to.equal(10n);
    });
    it("rejects a zero owner at deploy", async () => {
      const S = await hre.ethers.getContractFactory("SplitSettlement");
      await expect(S.deploy(Z)).to.be.revertedWith("zero owner");
    });
    it("exposes exactly three state-changing functions (no execute/sweep/fee)", async () => {
      const fns = split.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f) => f.name)
        .sort();
      expect(fns).to.deep.equal(["setPaused", "splitPayment", "transferOwnership"]);
    });
  });

  /* ── B. Native success ────────────────────────────────────────────────── */
  describe("B. native success", () => {
    it("pays 1 recipient exactly", async () => {
      const before = await hre.ethers.provider.getBalance(a.address);
      await split.connect(payer).splitPayment(Z, [a.address], [ONE], ref, { value: ONE });
      expect(await hre.ethers.provider.getBalance(a.address)).to.equal(before + ONE);
    });
    it("pays 2 recipients exactly and emits one event with contract-computed total", async () => {
      const amts = [ONE, 2n * ONE];
      const beforeA = await hre.ethers.provider.getBalance(a.address);
      const beforeB = await hre.ethers.provider.getBalance(b.address);
      await expect(split.connect(payer).splitPayment(Z, [a.address, b.address], amts, ref, { value: 3n * ONE }))
        .to.emit(split, "SplitPaymentExecuted")
        .withArgs(0n, payer.address, Z, ref, 3n * ONE, [a.address, b.address], amts);
      expect(await hre.ethers.provider.getBalance(a.address)).to.equal(beforeA + ONE);
      expect(await hre.ethers.provider.getBalance(b.address)).to.equal(beforeB + 2n * ONE);
    });
    it("pays 3 recipients", async () => {
      const amts = [ONE, ONE, ONE];
      await split.connect(payer).splitPayment(Z, [a.address, b.address, c.address], amts, ref, { value: 3n * ONE });
      expect(await split.settlementCount()).to.equal(1n);
    });
    it("pays MAX_RECIPIENTS (10)", async () => {
      const rs = [];
      const amts = [];
      for (let i = 0; i < 10; i++) {
        rs.push(hre.ethers.Wallet.createRandom().address);
        amts.push(ONE);
      }
      await expect(split.connect(payer).splitPayment(Z, rs, amts, ref, { value: 10n * ONE }))
        .to.emit(split, "SplitPaymentExecuted");
      for (const r of rs) expect(await hre.ethers.provider.getBalance(r)).to.equal(ONE);
    });
  });

  /* ── C. Native failures ───────────────────────────────────────────────── */
  describe("C. native failures", () => {
    it("rejects msg.value below the declared total", async () => {
      await expect(
        split.connect(payer).splitPayment(Z, [a.address, b.address], [ONE, ONE], ref, { value: ONE }),
      ).to.be.revertedWith("bad msg.value");
    });
    it("rejects msg.value above the declared total", async () => {
      await expect(
        split.connect(payer).splitPayment(Z, [a.address], [ONE], ref, { value: 2n * ONE }),
      ).to.be.revertedWith("bad msg.value");
    });
    it("rejects a zero amount", async () => {
      await expect(
        split.connect(payer).splitPayment(Z, [a.address, b.address], [ONE, 0n], ref, { value: ONE }),
      ).to.be.revertedWith("zero amount");
    });
    it("rejects a zero-address recipient", async () => {
      await expect(
        split.connect(payer).splitPayment(Z, [a.address, Z], [ONE, ONE], ref, { value: 2n * ONE }),
      ).to.be.revertedWith("zero recipient");
    });
    it("rejects a self recipient (address(this))", async () => {
      const self = await split.getAddress();
      await expect(
        split.connect(payer).splitPayment(Z, [self], [ONE], ref, { value: ONE }),
      ).to.be.revertedWith("self recipient");
    });
    it("rejects empty recipients", async () => {
      await expect(split.connect(payer).splitPayment(Z, [], [], ref, { value: 0 })).to.be.revertedWith("no recipients");
    });
    it("rejects more than MAX_RECIPIENTS", async () => {
      const rs = [];
      const amts = [];
      for (let i = 0; i < 11; i++) {
        rs.push(hre.ethers.Wallet.createRandom().address);
        amts.push(ONE);
      }
      await expect(
        split.connect(payer).splitPayment(Z, rs, amts, ref, { value: 11n * ONE }),
      ).to.be.revertedWith("too many recipients");
    });
    it("rejects a length mismatch", async () => {
      await expect(
        split.connect(payer).splitPayment(Z, [a.address, b.address], [ONE], ref, { value: ONE }),
      ).to.be.revertedWith("length mismatch");
    });
    it("reverts the whole split when a recipient rejects native MON (no partial)", async () => {
      const Rev = await hre.ethers.getContractFactory("RevertingReceiver");
      const rev = await Rev.deploy();
      const beforeA = await hre.ethers.provider.getBalance(a.address);
      await expect(
        split.connect(payer).splitPayment(Z, [a.address, await rev.getAddress()], [ONE, ONE], ref, { value: 2n * ONE }),
      ).to.be.revertedWith("native send failed");
      // a's earlier transfer was unwound by the revert.
      expect(await hre.ethers.provider.getBalance(a.address)).to.equal(beforeA);
      expect(await split.settlementCount()).to.equal(0n);
    });
    it("blocks a reentrant recipient (nonReentrant covers the whole loop)", async () => {
      const R = await hre.ethers.getContractFactory("ReentrantSplitRecipient");
      const r = await R.deploy(await split.getAddress());
      await expect(
        split.connect(payer).splitPayment(Z, [await r.getAddress()], [ONE], ref, { value: ONE }),
      ).to.be.revertedWith("native send failed"); // inner reentrant call reverted -> outer send fails
      expect(await split.settlementCount()).to.equal(0n);
    });
  });

  /* ── D. ERC-20 success ────────────────────────────────────────────────── */
  describe("D. ERC-20 success", () => {
    it("delivers exact amounts to each recipient, contract holds nothing", async () => {
      const t = await newToken(payer, 1000n);
      await t.connect(payer).approve(await split.getAddress(), 300n);
      await expect(split.connect(payer).splitPayment(await t.getAddress(), [a.address, b.address], [100n, 200n], ref))
        .to.emit(split, "SplitPaymentExecuted")
        .withArgs(0n, payer.address, await t.getAddress(), ref, 300n, [a.address, b.address], [100n, 200n]);
      expect(await t.balanceOf(a.address)).to.equal(100n);
      expect(await t.balanceOf(b.address)).to.equal(200n);
      expect(await t.balanceOf(await split.getAddress())).to.equal(0n);
    });
    it("handles duplicate recipients correctly (each delta measured per-transfer)", async () => {
      const t = await newToken(payer, 1000n);
      await t.connect(payer).approve(await split.getAddress(), 300n);
      await split.connect(payer).splitPayment(await t.getAddress(), [a.address, a.address], [100n, 200n], ref);
      expect(await t.balanceOf(a.address)).to.equal(300n);
    });
    it("rejects any native value on the ERC-20 path", async () => {
      const t = await newToken(payer, 1000n);
      await t.connect(payer).approve(await split.getAddress(), 100n);
      await expect(
        split.connect(payer).splitPayment(await t.getAddress(), [a.address], [100n], ref, { value: 1n }),
      ).to.be.revertedWith("no native for erc20");
    });
  });

  /* ── E. ERC-20 failures ───────────────────────────────────────────────── */
  describe("E. ERC-20 failures", () => {
    it("reverts on a short-delivering (fee-on-transfer) token", async () => {
      const T = await hre.ethers.getContractFactory("ShortTransferERC20");
      const t = await T.deploy();
      await t.mint(payer.address, 1000n);
      await t.connect(payer).approve(await split.getAddress(), 100n);
      await expect(
        split.connect(payer).splitPayment(await t.getAddress(), [a.address], [100n], ref),
      ).to.be.revertedWith("token did not deliver full amount");
    });
    it("reverts on a false-returning token", async () => {
      const T = await hre.ethers.getContractFactory("FalseReturningERC20");
      const t = await T.deploy();
      await t.mint(payer.address, 1000n);
      await t.connect(payer).approve(await split.getAddress(), 100n);
      await expect(
        split.connect(payer).splitPayment(await t.getAddress(), [a.address], [100n], ref),
      ).to.be.revertedWith("transfer failed");
    });
    it("reverts on a no-return-data token (accepted v1 behavior)", async () => {
      const T = await hre.ethers.getContractFactory("NoReturnERC20");
      const t = await T.deploy();
      await t.mint(payer.address, 1000n);
      await t.connect(payer).approve(await split.getAddress(), 100n);
      await expect(split.connect(payer).splitPayment(await t.getAddress(), [a.address], [100n], ref)).to.be.reverted;
    });
    it("reverts on a reverting token", async () => {
      const T = await hre.ethers.getContractFactory("RevertingERC20");
      const t = await T.deploy();
      await t.mint(payer.address, 1000n);
      await t.connect(payer).approve(await split.getAddress(), 100n);
      await expect(
        split.connect(payer).splitPayment(await t.getAddress(), [a.address], [100n], ref),
      ).to.be.revertedWith("token transfer reverted");
    });
    it("reverts on insufficient allowance", async () => {
      const t = await newToken(payer, 1000n);
      await t.connect(payer).approve(await split.getAddress(), 50n);
      await expect(
        split.connect(payer).splitPayment(await t.getAddress(), [a.address], [100n], ref),
      ).to.be.revertedWith("allowance");
    });
    it("reverts on insufficient balance", async () => {
      const t = await newToken(payer, 50n);
      await t.connect(payer).approve(await split.getAddress(), 100n);
      await expect(
        split.connect(payer).splitPayment(await t.getAddress(), [a.address], [100n], ref),
      ).to.be.revertedWith("balance");
    });
    it("a mid-list token failure rolls back earlier deliveries (atomic)", async () => {
      // First recipient is fine, second amount exceeds remaining allowance.
      const t = await newToken(payer, 1000n);
      await t.connect(payer).approve(await split.getAddress(), 150n);
      await expect(
        split.connect(payer).splitPayment(await t.getAddress(), [a.address, b.address], [100n, 100n], ref),
      ).to.be.revertedWith("allowance");
      expect(await t.balanceOf(a.address)).to.equal(0n); // unwound
      expect(await split.settlementCount()).to.equal(0n);
    });
  });

  /* ── F. Replay / ref ──────────────────────────────────────────────────── */
  describe("F. replay / ref", () => {
    it("allows a zero ref and an arbitrary ref; same ref twice both settle", async () => {
      await split.connect(payer).splitPayment(Z, [a.address], [ONE], hre.ethers.ZeroHash, { value: ONE });
      await split.connect(payer).splitPayment(Z, [a.address], [ONE], hre.ethers.ZeroHash, { value: ONE });
      expect(await split.settlementCount()).to.equal(2n); // ref is not a replay gate
    });
    it("has no requestId / processed mapping in its ABI", async () => {
      const names = split.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      expect(names.some((n) => /request|processed|idempoten/i.test(n))).to.equal(false);
    });
  });

  /* ── G. Admin ─────────────────────────────────────────────────────────── */
  describe("G. admin", () => {
    it("owner can pause and unpause; paused blocks splits", async () => {
      await split.connect(owner).setPaused(true);
      await expect(
        split.connect(payer).splitPayment(Z, [a.address], [ONE], ref, { value: ONE }),
      ).to.be.revertedWith("paused");
      await split.connect(owner).setPaused(false);
      await expect(split.connect(payer).splitPayment(Z, [a.address], [ONE], ref, { value: ONE })).to.emit(
        split,
        "SplitPaymentExecuted",
      );
    });
    it("rejects a non-owner pause", async () => {
      await expect(split.connect(outsider).setPaused(true)).to.be.revertedWith("not owner");
    });
    it("transfers ownership; rejects zero address", async () => {
      await expect(split.connect(owner).transferOwnership(Z)).to.be.revertedWith("zero addr");
      await split.connect(owner).transferOwnership(outsider.address);
      expect(await split.owner()).to.equal(outsider.address);
    });
    it("owner has no fund-moving or settlement-bypass power (pause + transfer only)", async () => {
      const fns = split.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f) => f.name)
        .sort();
      expect(fns).to.deep.equal(["setPaused", "splitPayment", "transferOwnership"]);
      // splitPayment always moves ONLY msg.sender's funds — owner calling it is
      // treated identically to anyone else (needs its own value/approval).
      await expect(
        split.connect(owner).splitPayment(Z, [a.address], [ONE], ref, { value: 0 }),
      ).to.be.revertedWith("bad msg.value");
    });
  });

  /* ── H. Event correctness ─────────────────────────────────────────────── */
  describe("H. event", () => {
    it("emits exactly one SplitPaymentExecuted with correct decoded fields", async () => {
      const t = await newToken(payer, 1000n);
      await t.connect(payer).approve(await split.getAddress(), 300n);
      const tx = await split.connect(payer).splitPayment(await t.getAddress(), [a.address, b.address], [100n, 200n], ref);
      const rc = await tx.wait();
      const evs = rc.logs.filter((l) => {
        try {
          return split.interface.parseLog(l)?.name === "SplitPaymentExecuted";
        } catch {
          return false;
        }
      });
      expect(evs.length).to.equal(1);
      const p = split.interface.parseLog(evs[0]);
      expect(p.args.settlementId).to.equal(0n);
      expect(p.args.payer).to.equal(payer.address);
      expect(p.args.token).to.equal(await t.getAddress());
      expect(p.args.ref).to.equal(ref);
      expect(p.args.totalAmount).to.equal(300n); // contract-computed sum
      expect(p.args.recipients).to.deep.equal([a.address, b.address]);
      expect(p.args.amounts).to.deep.equal([100n, 200n]);
    });
    it("settlementId increments 0,1,2 across successful settlements", async () => {
      for (let i = 0; i < 3; i++) {
        await split.connect(payer).splitPayment(Z, [a.address], [ONE], ref, { value: ONE });
      }
      expect(await split.settlementCount()).to.equal(3n);
    });
  });

  /* ── J. Forced balance (delta-based zero-retention) ───────────────────── */
  describe("J. forced pre-existing native balance", () => {
    it("tolerates a forced balance; a valid split still succeeds and the forced balance remains", async () => {
      const addr = await split.getAddress();
      const F = await hre.ethers.getContractFactory("ForceSend");
      await F.deploy(addr, { value: ONE }); // selfdestructs ONE into split
      expect(await hre.ethers.provider.getBalance(addr)).to.equal(ONE);

      const beforeA = await hre.ethers.provider.getBalance(a.address);
      await split.connect(payer).splitPayment(Z, [a.address], [2n * ONE], ref, { value: 2n * ONE });
      // recipient got exactly the split amount...
      expect(await hre.ethers.provider.getBalance(a.address)).to.equal(beforeA + 2n * ONE);
      // ...and the pre-existing forced balance is untouched (no additional
      // current-call retention, and no sweep of the forced funds).
      expect(await hre.ethers.provider.getBalance(addr)).to.equal(ONE);
    });
  });

  /* ── K. Gas ───────────────────────────────────────────────────────────── */
  describe("K. gas (informational)", () => {
    it("measures native 1 / 3 / 10 and ERC-20 1 / 3 / 10 recipients", async () => {
      const measure = async (label, txPromise) => {
        const rc = await (await txPromise).wait();
        console.log(`      gas[${label}] = ${rc.gasUsed.toString()}`);
        return rc.gasUsed;
      };
      const mk = (n) => {
        const rs = [];
        const amts = [];
        for (let i = 0; i < n; i++) {
          rs.push(hre.ethers.Wallet.createRandom().address);
          amts.push(ONE);
        }
        return { rs, amts, total: BigInt(n) * ONE };
      };

      for (const n of [1, 3, 10]) {
        const { rs, amts, total } = mk(n);
        await measure(`native x${n}`, split.connect(payer).splitPayment(Z, rs, amts, ref, { value: total }));
      }

      for (const n of [1, 3, 10]) {
        const t = await newToken(payer, 100n * ONE);
        const { rs, amts, total } = mk(n);
        await t.connect(payer).approve(await split.getAddress(), total);
        await measure(`erc20 x${n}`, split.connect(payer).splitPayment(await t.getAddress(), rs, amts, ref));
      }
    });
  });
});
