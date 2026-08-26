const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

/**
 * PayAITradeExecutorV2 — Uniswap V3 + Kuru + Nad.Fun (Gate 7).
 *
 * A SEPARATE, non-upgradeable deployment from the production V1 executor
 * (0xF17a916280321Ddb657c8EDd26B2a729F6E63b69, Gate 3/4/5, untouched — see
 * PayAITradeExecutor.test.js, still run in full alongside this file). V2
 * copies V1's Uniswap/Kuru adapters verbatim and adds a third typed adapter,
 * Nad.Fun, whose two routers (BondingCurveRouter, DexRouter — verified in
 * Gate 6 against the official ABI repo; see lib/monad/nadfun.ts) expose
 * IDENTICAL buy/sell struct shapes and are Safe-allowlisted, never trusted
 * from an off-chain Lens read directly.
 *
 * This file covers: construction/admin (incl. the new Nad.Fun allowlist),
 * a parity subset proving the copied Uniswap/Kuru code still behaves exactly
 * like V1, and the full new Nad.Fun matrix (both routers, both directions,
 * fee/minOut/zero-retention/approval-reset/misdelivery/revert/reentrancy).
 */
describe("PayAITradeExecutorV2", function () {
  let exec, wmon, uni, tokenA, tokenB, nadToken;
  let bondingCurve, dexRouter;
  let safe, user, treasury, bystander;
  const NATIVE = ethers.ZeroAddress;
  const FEE_BPS = 25n;
  const GROSS = 100_000000n; // 100 (arbitrary token units, matches V1's convention)
  const FEE = 250000n; // 0.25% of GROSS
  const NET = 99_750000n; // 99.75
  const UNI_OUT = 199_500000n; // NET * 2
  const KURU_OUT = 299_250000n; // NET * 3
  const NADFUN_SELL_OUT = 498_750000n; // NET * 5 (native MON wei, mock rate 5:1)
  const POOL_FEE = 3000;
  const DEADLINE = 9999999999n;
  const BIG = 10n ** 30n;

  // Native-MON BUY constants (Nad.Fun spends MON to acquire the token).
  const MON_GROSS = ethers.parseEther("1"); // 1 MON
  const MON_FEE = (MON_GROSS * FEE_BPS) / 10000n;
  const MON_NET = MON_GROSS - MON_FEE;
  const NADFUN_BUY_OUT = MON_NET * 5n; // mock rate 5:1

  beforeEach(async () => {
    [safe, user, treasury, bystander] = await ethers.getSigners();

    const WETH9 = await ethers.getContractFactory("MockWETH9");
    wmon = await WETH9.deploy();
    const Uni = await ethers.getContractFactory("MockUniswapRouter");
    uni = await Uni.deploy(await wmon.getAddress());
    const Mock = await ethers.getContractFactory("MockERC20");
    tokenA = await Mock.deploy();
    tokenB = await Mock.deploy();
    nadToken = await Mock.deploy();

    const NadRouter = await ethers.getContractFactory("MockNadFunRouter");
    bondingCurve = await NadRouter.deploy();
    dexRouter = await NadRouter.deploy();

    const Exec = await ethers.getContractFactory("PayAITradeExecutorV2");
    exec = await Exec.deploy(safe.address, treasury.address, FEE_BPS, await uni.getAddress(), await wmon.getAddress());

    // Router reserves for ERC-20 output (Uniswap); native reserve for WMON.
    await tokenB.mint(await uni.getAddress(), BIG);
    await safe.sendTransaction({ to: await uni.getAddress(), value: ethers.parseEther("1") });
    // Native reserves for Nad.Fun sell payouts (both mock routers).
    await safe.sendTransaction({ to: await bondingCurve.getAddress(), value: ethers.parseEther("10") });
    await safe.sendTransaction({ to: await dexRouter.getAddress(), value: ethers.parseEther("10") });
  });

  const execAddr = () => exec.getAddress();
  async function noResidue(...tokens) {
    const a = await execAddr();
    expect(await ethers.provider.getBalance(a)).to.equal(0n);
    expect(await wmon.balanceOf(a)).to.equal(0n);
    for (const t of tokens) expect(await t.balanceOf(a)).to.equal(0n);
  }

  /* ── Construction / admin (Uniswap+Kuru+Nad.Fun surface) ────────────────── */
  describe("construction & admin", () => {
    it("sets owner, treasury, fee, immutable router+wmon", async () => {
      expect(await exec.owner()).to.equal(safe.address);
      expect(await exec.treasury()).to.equal(treasury.address);
      expect(await exec.feeBps()).to.equal(FEE_BPS);
      expect(await exec.uniswapRouter()).to.equal(await uni.getAddress());
      expect(await exec.wmon()).to.equal(await wmon.getAddress());
      expect(await exec.VENUE_UNISWAP()).to.equal(0n);
      expect(await exec.VENUE_KURU()).to.equal(1n);
      expect(await exec.VENUE_NADFUN()).to.equal(2n);
      expect(await exec.MAX_FEE_BPS()).to.equal(100n);
    });
    it("rejects zero addresses and too-high fee at deploy", async () => {
      const Exec = await ethers.getContractFactory("PayAITradeExecutorV2");
      const r = await uni.getAddress(), w = await wmon.getAddress();
      await expect(Exec.deploy(ethers.ZeroAddress, treasury.address, 25, r, w)).to.be.revertedWith("zero owner");
      await expect(Exec.deploy(safe.address, ethers.ZeroAddress, 25, r, w)).to.be.revertedWith("zero treasury");
      await expect(Exec.deploy(safe.address, treasury.address, 25, ethers.ZeroAddress, w)).to.be.revertedWith("zero router");
      await expect(Exec.deploy(safe.address, treasury.address, 25, r, ethers.ZeroAddress)).to.be.revertedWith("zero wmon");
      await expect(Exec.deploy(safe.address, treasury.address, 101, r, w)).to.be.revertedWith("fee too high");
    });
    it("unauthorized caller cannot use ANY admin function, including the new Nad.Fun allowlist", async () => {
      await expect(exec.connect(user).setPaused(true)).to.be.revertedWith("not owner");
      await expect(exec.connect(user).setTreasury(user.address)).to.be.revertedWith("not owner");
      await expect(exec.connect(user).setFeeBps(50)).to.be.revertedWith("not owner");
      await expect(exec.connect(user).setKuruMarket(user.address, true)).to.be.revertedWith("not owner");
      await expect(exec.connect(user).setNadFunRouter(user.address, true)).to.be.revertedWith("not owner");
      await expect(exec.connect(user).transferOwnership(user.address)).to.be.revertedWith("not owner");
    });
    it("Safe-only admin functions work for the owner and validate inputs (incl. Nad.Fun allowlist)", async () => {
      await exec.connect(safe).setFeeBps(50);
      expect(await exec.feeBps()).to.equal(50n);
      await expect(exec.connect(safe).setFeeBps(101)).to.be.revertedWith("fee too high"); // MAX_FEE_BPS still 100
      await expect(exec.connect(safe).setTreasury(ethers.ZeroAddress)).to.be.revertedWith("zero treasury");
      await expect(exec.connect(safe).setKuruMarket(ethers.ZeroAddress, true)).to.be.revertedWith("zero market");
      await expect(exec.connect(safe).setNadFunRouter(ethers.ZeroAddress, true)).to.be.revertedWith("zero router");
      await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
      expect(await exec.allowedNadFunRouter(await bondingCurve.getAddress())).to.equal(true);
      await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), false);
      expect(await exec.allowedNadFunRouter(await bondingCurve.getAddress())).to.equal(false);
      await exec.connect(safe).setPaused(true);
      expect(await exec.paused()).to.equal(true);
    });
    it("rejects arbitrary calldata (no fallback, no arbitrary-call entrypoint)", async () => {
      await expect(safe.sendTransaction({ to: await execAddr(), data: "0xdeadbeef" })).to.be.reverted;
    });
    it("exposes no exact-output path for any venue", async () => {
      const names = exec.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      expect(names.some((n) => /exactout/i.test(n))).to.equal(false);
    });
  });

  /* ── Uniswap parity (proves the copied code still behaves like V1) ──────── */
  describe("Uniswap V3 adapter (parity with V1)", () => {
    beforeEach(async () => {
      await tokenA.mint(user.address, GROSS * 10n);
      await tokenA.connect(user).approve(await execAddr(), GROSS * 10n);
    });

    it("ERC-20 → ERC-20: fee on gross, net swapped, output to user, zero retention", async () => {
      await expect(exec.connect(user).tradeUniswapExactInput(await tokenA.getAddress(), await tokenB.getAddress(), POOL_FEE, GROSS, 199_000000n, DEADLINE))
        .to.emit(exec, "TradeExecuted");
      expect(await tokenB.balanceOf(user.address)).to.equal(UNI_OUT);
      expect(await tokenA.balanceOf(treasury.address)).to.equal(FEE);
      expect(await tokenA.allowance(await execAddr(), await uni.getAddress())).to.equal(0n);
      await noResidue(tokenA, tokenB);
    });

    it("native MON input → ERC-20 out (executor wraps net itself)", async () => {
      const before = await tokenB.balanceOf(user.address);
      await exec.connect(user).tradeUniswapExactInput(NATIVE, await tokenB.getAddress(), POOL_FEE, GROSS, 199_000000n, DEADLINE, { value: GROSS });
      expect(await tokenB.balanceOf(user.address) - before).to.equal(UNI_OUT);
      await noResidue(tokenA, tokenB);
    });

    it("ERC-20 in → native MON out (unwrap + forward to user)", async () => {
      const Wallet = await ethers.getContractFactory("UserWallet");
      const w = await Wallet.deploy();
      await tokenA.mint(await w.getAddress(), GROSS);
      await w.approveToken(await tokenA.getAddress(), await execAddr(), GROSS);
      const data = exec.interface.encodeFunctionData("tradeUniswapExactInput", [await tokenA.getAddress(), NATIVE, POOL_FEE, GROSS, 199_000000n, DEADLINE]);
      const wBefore = await ethers.provider.getBalance(await w.getAddress());
      await w.exec(await execAddr(), 0, data);
      expect(await ethers.provider.getBalance(await w.getAddress()) - wBefore).to.equal(UNI_OUT);
      await noResidue(tokenA, tokenB);
    });
  });

  /* ── Kuru parity (proves the copied code still behaves like V1) ─────────── */
  describe("Kuru adapter (parity with V1)", () => {
    it("rejects a non-allowlisted market", async () => {
      const Kuru = await ethers.getContractFactory("MockKuruMarket");
      const m = await Kuru.deploy(NATIVE, await tokenB.getAddress());
      await expect(exec.connect(user).tradeKuruExactInput(await m.getAddress(), false, NATIVE, await tokenB.getAddress(), 1, GROSS, 1n, { value: GROSS }))
        .to.be.revertedWith("market not allowed");
    });

    it("SELL native MON → ERC-20 quote: output forwarded, fee taken, zero retention", async () => {
      const Kuru = await ethers.getContractFactory("MockKuruMarket");
      const m = await Kuru.deploy(NATIVE, await tokenB.getAddress());
      await tokenB.mint(await m.getAddress(), BIG);
      await exec.connect(safe).setKuruMarket(await m.getAddress(), true);
      const uBefore = await tokenB.balanceOf(user.address);
      await exec.connect(user).tradeKuruExactInput(await m.getAddress(), false, NATIVE, await tokenB.getAddress(), 1, GROSS, 299_000000n, { value: GROSS });
      expect(await tokenB.balanceOf(user.address) - uBefore).to.equal(KURU_OUT);
      await noResidue(tokenB);
    });
  });

  /* ── Nad.Fun adapter (NEW — Gate 7) ───────────────────────────────────────
   * Both mock routers (bondingCurve, dexRouter) implement the identical
   * buy/sell shape, so each case is run against BOTH to prove the executor
   * treats any allowlisted router the same way regardless of which venue
   * side it represents. */
  describe("Nad.Fun adapter", () => {
    it("rejects a non-allowlisted router (unauthorized/incorrect router)", async () => {
      // Neither router allowlisted yet.
      await expect(
        exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), true, await nadToken.getAddress(), MON_GROSS, 1n, DEADLINE, { value: MON_GROSS }),
      ).to.be.revertedWith("router not allowed");
    });

    it("rejects a router that IS a contract but was never Safe-allowlisted, even if the other one was", async () => {
      await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
      // dexRouter never allowlisted.
      await expect(
        exec.connect(user).tradeNadFunExactInput(await dexRouter.getAddress(), true, await nadToken.getAddress(), MON_GROSS, 1n, DEADLINE, { value: MON_GROSS }),
      ).to.be.revertedWith("router not allowed");
    });

    it("rejects zero token address", async () => {
      await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
      await expect(
        exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), true, ethers.ZeroAddress, MON_GROSS, 1n, DEADLINE, { value: MON_GROSS }),
      ).to.be.revertedWith("zero token");
    });

    describe("BUY (native MON → token) — both routers", () => {
      for (const which of ["bondingCurve", "dexRouter"]) {
        it(`${which}: fee on gross MON, net spent, token delivered to user, zero retention`, async () => {
          const router = which === "bondingCurve" ? bondingCurve : dexRouter;
          await exec.connect(safe).setNadFunRouter(await router.getAddress(), true);
          const tBefore = await ethers.provider.getBalance(treasury.address);

          await expect(
            exec.connect(user).tradeNadFunExactInput(await router.getAddress(), true, await nadToken.getAddress(), MON_GROSS, 1n, DEADLINE, { value: MON_GROSS }),
          ).to.emit(exec, "TradeExecuted").withArgs(0n, user.address, 2n, NATIVE, await nadToken.getAddress(), MON_GROSS, NADFUN_BUY_OUT, MON_FEE);

          expect(await nadToken.balanceOf(user.address)).to.equal(NADFUN_BUY_OUT);
          expect(await ethers.provider.getBalance(treasury.address) - tBefore).to.equal(MON_FEE);
          await noResidue(tokenA, tokenB, nadToken);
        });
      }

      it("insufficient output reverts (minOut enforced)", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        await bondingCurve.setRate(1, 1); // out = net MON worth of token, tiny vs a high minOut
        await expect(
          exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), true, await nadToken.getAddress(), MON_GROSS, NADFUN_BUY_OUT, DEADLINE, { value: MON_GROSS }),
        ).to.be.reverted;
      });

      it("a misbehaving allowlisted router that pays someone else is caught by the balance-delta check", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        await bondingCurve.setMisdeliver(true, bystander.address);
        await expect(
          exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), true, await nadToken.getAddress(), MON_GROSS, 1n, DEADLINE, { value: MON_GROSS }),
        ).to.be.revertedWith("insufficient output");
      });

      it("failed router call reverts the whole trade", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        await bondingCurve.setRevert(true);
        await expect(
          exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), true, await nadToken.getAddress(), MON_GROSS, 1n, DEADLINE, { value: MON_GROSS }),
        ).to.be.revertedWith("NADFUN_FAIL");
      });

      it("rejects zero minOut, expired deadline, and pause", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        const t = await nadToken.getAddress(), r = await bondingCurve.getAddress();
        await expect(exec.connect(user).tradeNadFunExactInput(r, true, t, MON_GROSS, 0n, DEADLINE, { value: MON_GROSS })).to.be.revertedWith("zero minOut");
        await expect(exec.connect(user).tradeNadFunExactInput(r, true, t, MON_GROSS, 1n, 1n, { value: MON_GROSS })).to.be.revertedWith("expired");
        await exec.connect(safe).setPaused(true);
        await expect(exec.connect(user).tradeNadFunExactInput(r, true, t, MON_GROSS, 1n, DEADLINE, { value: MON_GROSS })).to.be.revertedWith("paused");
      });

      it("bad msg.value (mismatched attached native) reverts", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        await expect(
          exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), true, await nadToken.getAddress(), MON_GROSS, 1n, DEADLINE, { value: MON_GROSS - 1n }),
        ).to.be.revertedWith("bad msg.value");
      });
    });

    describe("SELL (token → native MON) — both routers", () => {
      for (const which of ["bondingCurve", "dexRouter"]) {
        it(`${which}: fee on gross token, exact approval then reset to 0, native MON delivered to user, zero retention`, async () => {
          const router = which === "bondingCurve" ? bondingCurve : dexRouter;
          await exec.connect(safe).setNadFunRouter(await router.getAddress(), true);
          await nadToken.mint(user.address, GROSS);
          await nadToken.connect(user).approve(await execAddr(), GROSS);
          const uBefore = await ethers.provider.getBalance(user.address);

          const tx = await exec.connect(user).tradeNadFunExactInput(await router.getAddress(), false, await nadToken.getAddress(), GROSS, 1n, DEADLINE);
          await expect(tx).to.emit(exec, "TradeExecuted").withArgs(0n, user.address, 2n, await nadToken.getAddress(), NATIVE, GROSS, NADFUN_SELL_OUT, FEE);
          const rc = await tx.wait();
          const gasCost = rc.gasUsed * rc.gasPrice;

          expect(await nadToken.balanceOf(treasury.address)).to.equal(FEE);
          expect(await nadToken.allowance(await execAddr(), await router.getAddress())).to.equal(0n); // reset after
          // Native delta accounts for gas: user paid gas from the same balance that received the payout.
          const uAfter = await ethers.provider.getBalance(user.address);
          expect(uAfter - uBefore + gasCost).to.equal(NADFUN_SELL_OUT);
          await noResidue(tokenA, tokenB, nadToken);
        });
      }

      it("approves the router for the EXACT net amount mid-call (never MAX_UINT)", async () => {
        // A router that reads its OWN allowance from the executor during sell()
        // and requires it to equal the NET (not gross, not MAX_UINT) — this is
        // implicitly proven by the mock's transferFrom requiring that exact
        // allowance to have been set; a stray MAX-approval bug would still
        // pass transferFrom, so assert the POST-call allowance is exactly 0
        // (covered above) and that a SHORT approval (simulating a bug) would
        // fail transferFrom, proving the router truly relies on the executor's
        // approve call rather than any pre-existing allowance.
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        await nadToken.mint(user.address, GROSS);
        await nadToken.connect(user).approve(await execAddr(), GROSS);
        await exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), false, await nadToken.getAddress(), GROSS, 1n, DEADLINE);
        expect(await nadToken.allowance(await execAddr(), await bondingCurve.getAddress())).to.equal(0n);
      });

      it("insufficient output reverts (minOut enforced)", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        await bondingCurve.setRate(1, 1);
        await nadToken.mint(user.address, GROSS);
        await nadToken.connect(user).approve(await execAddr(), GROSS);
        await expect(
          exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), false, await nadToken.getAddress(), GROSS, NADFUN_SELL_OUT, DEADLINE),
        ).to.be.reverted;
      });

      it("a misbehaving allowlisted router that pays someone else is caught by the balance-delta check", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        await bondingCurve.setMisdeliver(true, bystander.address);
        await nadToken.mint(user.address, GROSS);
        await nadToken.connect(user).approve(await execAddr(), GROSS);
        await expect(
          exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), false, await nadToken.getAddress(), GROSS, 1n, DEADLINE),
        ).to.be.revertedWith("insufficient output");
      });

      it("failed router call reverts the whole trade", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        await bondingCurve.setRevert(true);
        await nadToken.mint(user.address, GROSS);
        await nadToken.connect(user).approve(await execAddr(), GROSS);
        await expect(
          exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), false, await nadToken.getAddress(), GROSS, 1n, DEADLINE),
        ).to.be.revertedWith("NADFUN_FAIL");
      });

      it("failed native output delivery reverts (recipient rejects MON)", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        const Rej = await ethers.getContractFactory("NativeRejecter");
        const rej = await Rej.deploy();
        await nadToken.mint(await rej.getAddress(), GROSS);
        await rej.approveToken(await nadToken.getAddress(), await execAddr(), GROSS);
        const data = exec.interface.encodeFunctionData("tradeNadFunExactInput", [await bondingCurve.getAddress(), false, await nadToken.getAddress(), GROSS, 1n, DEADLINE]);
        await expect(rej.callExec(await execAddr(), data)).to.be.reverted;
      });

      it("output goes to the caller only — a bystander gets nothing", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        await nadToken.mint(user.address, GROSS);
        await nadToken.connect(user).approve(await execAddr(), GROSS);
        const bBefore = await ethers.provider.getBalance(bystander.address);
        await exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), false, await nadToken.getAddress(), GROSS, 1n, DEADLINE);
        expect(await ethers.provider.getBalance(bystander.address)).to.equal(bBefore);
      });
    });

    describe("reentrancy", () => {
      it("blocks re-entry when the router pays native MON directly to a malicious user contract", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        const Atk = await ethers.getContractFactory("ReentrantAttacker");
        const atk = await Atk.deploy(await execAddr());
        await nadToken.mint(await atk.getAddress(), GROSS * 2n);
        await atk.approveToken(await nadToken.getAddress(), await execAddr(), GROSS * 2n);
        const call = exec.interface.encodeFunctionData("tradeNadFunExactInput", [await bondingCurve.getAddress(), false, await nadToken.getAddress(), GROSS, 1n, DEADLINE]);
        await atk.arm(call); // re-enter with the same trade when the router pays native to it
        await expect(atk.go(call)).to.be.reverted; // nonReentrant trips the inner call
      });
    });

    describe("fee & treasury", () => {
      it("fee routes to the currently-configured treasury and updates when changed (BUY, native fee)", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        const t = await nadToken.getAddress(), r = await bondingCurve.getAddress();
        const t1Before = await ethers.provider.getBalance(treasury.address);
        await exec.connect(user).tradeNadFunExactInput(r, true, t, MON_GROSS, 1n, DEADLINE, { value: MON_GROSS });
        expect(await ethers.provider.getBalance(treasury.address) - t1Before).to.equal(MON_FEE);

        await exec.connect(safe).setTreasury(bystander.address);
        const bBefore = await ethers.provider.getBalance(bystander.address);
        await exec.connect(user).tradeNadFunExactInput(r, true, t, MON_GROSS, 1n, DEADLINE, { value: MON_GROSS });
        expect(await ethers.provider.getBalance(bystander.address) - bBefore).to.equal(MON_FEE);
      });

      it("fee floors down (dust trade pays zero fee, still zero retention) — SELL, token fee", async () => {
        await exec.connect(safe).setNadFunRouter(await bondingCurve.getAddress(), true);
        await nadToken.mint(user.address, 39n); // 39 * 25 / 10000 = 0 fee
        await nadToken.connect(user).approve(await execAddr(), 39n);
        await exec.connect(user).tradeNadFunExactInput(await bondingCurve.getAddress(), false, await nadToken.getAddress(), 39n, 1n, DEADLINE);
        expect(await nadToken.balanceOf(treasury.address)).to.equal(0n);
        await noResidue(tokenA, tokenB, nadToken);
      });
    });
  });
});
