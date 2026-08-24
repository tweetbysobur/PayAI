const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

/**
 * PayAITradeExecutor — Uniswap V3 + Kuru only (Gate 3).
 * Exact-input, allowlist-only typed adapters, Safe-owned, 0.25% fee on gross
 * input, post-fee minOut, output balance-delta verification, zero retention,
 * Kuru output forwarded to the user (ERC-20 and native MON), nonReentrant,
 * pausable. Mocks reproduce the venue behaviors verified on live Monad in
 * Gate 2.1/2.2 (Uniswap has a recipient; Kuru has none and pays native on buy).
 */
describe("PayAITradeExecutor", function () {
  let exec, wmon, uni, tokenA, tokenB;
  let safe, user, treasury, bystander;
  const NATIVE = ethers.ZeroAddress;
  const FEE_BPS = 25n;
  const GROSS = 100_000000n; // 100 (6dp)
  const FEE = 250000n; // 0.25
  const NET = 99_750000n; // 99.75
  const UNI_OUT = 199_500000n; // NET * 2
  const KURU_OUT = 299_250000n; // NET * 3
  const POOL_FEE = 3000;
  const DEADLINE = 9999999999n;
  const BIG = 10n ** 30n;

  beforeEach(async () => {
    [safe, user, treasury, bystander] = await ethers.getSigners();

    const WETH9 = await ethers.getContractFactory("MockWETH9");
    wmon = await WETH9.deploy();
    const Uni = await ethers.getContractFactory("MockUniswapRouter");
    uni = await Uni.deploy(await wmon.getAddress());
    const Mock = await ethers.getContractFactory("MockERC20");
    tokenA = await Mock.deploy();
    tokenB = await Mock.deploy();

    const Exec = await ethers.getContractFactory("PayAITradeExecutor");
    exec = await Exec.deploy(safe.address, treasury.address, FEE_BPS, await uni.getAddress(), await wmon.getAddress());

    // Router reserves for ERC-20 output; native reserve for WMON output paths.
    await tokenB.mint(await uni.getAddress(), BIG);
    await safe.sendTransaction({ to: await uni.getAddress(), value: ethers.parseEther("1") });
  });

  const execAddr = () => exec.getAddress();
  async function noResidue(...tokens) {
    const a = await execAddr();
    expect(await ethers.provider.getBalance(a)).to.equal(0n);
    expect(await wmon.balanceOf(a)).to.equal(0n);
    for (const t of tokens) expect(await t.balanceOf(a)).to.equal(0n);
  }

  /* ── Construction / admin / zero-address / fee-treasury validation ─────── */
  describe("construction & admin", () => {
    it("sets owner, treasury, fee, immutable router+wmon", async () => {
      expect(await exec.owner()).to.equal(safe.address);
      expect(await exec.treasury()).to.equal(treasury.address);
      expect(await exec.feeBps()).to.equal(FEE_BPS);
      expect(await exec.uniswapRouter()).to.equal(await uni.getAddress());
    });
    it("rejects zero addresses and too-high fee at deploy", async () => {
      const Exec = await ethers.getContractFactory("PayAITradeExecutor");
      const r = await uni.getAddress(), w = await wmon.getAddress();
      await expect(Exec.deploy(ethers.ZeroAddress, treasury.address, 25, r, w)).to.be.revertedWith("zero owner");
      await expect(Exec.deploy(safe.address, ethers.ZeroAddress, 25, r, w)).to.be.revertedWith("zero treasury");
      await expect(Exec.deploy(safe.address, treasury.address, 25, ethers.ZeroAddress, w)).to.be.revertedWith("zero router");
      await expect(Exec.deploy(safe.address, treasury.address, 25, r, ethers.ZeroAddress)).to.be.revertedWith("zero wmon");
      await expect(Exec.deploy(safe.address, treasury.address, 101, r, w)).to.be.revertedWith("fee too high");
    });
    it("unauthorized caller cannot use admin functions", async () => {
      await expect(exec.connect(user).setPaused(true)).to.be.revertedWith("not owner");
      await expect(exec.connect(user).setTreasury(user.address)).to.be.revertedWith("not owner");
      await expect(exec.connect(user).setFeeBps(50)).to.be.revertedWith("not owner");
      await expect(exec.connect(user).setKuruMarket(user.address, true)).to.be.revertedWith("not owner");
      await expect(exec.connect(user).transferOwnership(user.address)).to.be.revertedWith("not owner");
    });
    it("Safe-only admin functions work for the owner and validate inputs", async () => {
      await exec.connect(safe).setFeeBps(50);
      expect(await exec.feeBps()).to.equal(50n);
      await expect(exec.connect(safe).setFeeBps(101)).to.be.revertedWith("fee too high");
      await expect(exec.connect(safe).setTreasury(ethers.ZeroAddress)).to.be.revertedWith("zero treasury");
      await expect(exec.connect(safe).setKuruMarket(ethers.ZeroAddress, true)).to.be.revertedWith("zero market");
      await exec.connect(safe).setPaused(true);
      expect(await exec.paused()).to.equal(true);
    });
    it("rejects arbitrary calldata (no fallback, no arbitrary-call entrypoint)", async () => {
      await expect(safe.sendTransaction({ to: await execAddr(), data: "0xdeadbeef" })).to.be.reverted;
    });
  });

  /* ── Uniswap adapter ──────────────────────────────────────────────────── */
  describe("Uniswap V3 adapter", () => {
    beforeEach(async () => {
      await tokenA.mint(user.address, GROSS * 10n);
      await tokenA.connect(user).approve(await execAddr(), GROSS * 10n);
    });

    it("ERC-20 → ERC-20: fee on gross, net swapped, output to user, zero retention", async () => {
      await expect(exec.connect(user).tradeUniswapExactInput(await tokenA.getAddress(), await tokenB.getAddress(), POOL_FEE, GROSS, 199_000000n, DEADLINE))
        .to.emit(exec, "TradeExecuted");
      expect(await tokenB.balanceOf(user.address)).to.equal(UNI_OUT);
      expect(await tokenA.balanceOf(treasury.address)).to.equal(FEE); // 0.25% of gross
      expect(await tokenA.allowance(await execAddr(), await uni.getAddress())).to.equal(0n); // exact approval reset
      await noResidue(tokenA, tokenB);
    });

    it("post-fee minOut: minOut computed from NET passes; minOut from GROSS fails", async () => {
      // NET*2 = 199.5 passes
      await exec.connect(user).tradeUniswapExactInput(await tokenA.getAddress(), await tokenB.getAddress(), POOL_FEE, GROSS, UNI_OUT, DEADLINE);
      // GROSS*2 = 200 would exceed what NET can produce -> revert
      await expect(exec.connect(user).tradeUniswapExactInput(await tokenA.getAddress(), await tokenB.getAddress(), POOL_FEE, GROSS, 200_000000n, DEADLINE)).to.be.reverted;
    });

    it("insufficient output / slippage: reverts when output < minOut", async () => {
      await uni.setRate(1, 1); // out = net (99.75) < minOut
      await expect(exec.connect(user).tradeUniswapExactInput(await tokenA.getAddress(), await tokenB.getAddress(), POOL_FEE, GROSS, 199_000000n, DEADLINE)).to.be.reverted;
    });

    it("native MON input → ERC-20 out (executor wraps net itself)", async () => {
      const before = await tokenB.balanceOf(user.address);
      const tBefore = await ethers.provider.getBalance(treasury.address);
      await exec.connect(user).tradeUniswapExactInput(NATIVE, await tokenB.getAddress(), POOL_FEE, GROSS, 199_000000n, DEADLINE, { value: GROSS });
      expect(await tokenB.balanceOf(user.address) - before).to.equal(UNI_OUT);
      expect(await ethers.provider.getBalance(treasury.address) - tBefore).to.equal(FEE); // native fee
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
      expect(await ethers.provider.getBalance(await w.getAddress()) - wBefore).to.equal(UNI_OUT); // native received
      expect(await tokenA.balanceOf(treasury.address)).to.equal(FEE);
      await noResidue(tokenA, tokenB);
    });

    it("failed DEX call reverts the whole trade", async () => {
      await uni.setRevert(true);
      await expect(exec.connect(user).tradeUniswapExactInput(await tokenA.getAddress(), await tokenB.getAddress(), POOL_FEE, GROSS, 199_000000n, DEADLINE)).to.be.revertedWith("DEX_FAIL");
    });

    it("failed native output transfer reverts (recipient rejects MON)", async () => {
      const Rej = await ethers.getContractFactory("NativeRejecter");
      const rej = await Rej.deploy();
      await tokenA.mint(await rej.getAddress(), GROSS);
      await rej.approveToken(await tokenA.getAddress(), await execAddr(), GROSS);
      const data = exec.interface.encodeFunctionData("tradeUniswapExactInput", [await tokenA.getAddress(), NATIVE, POOL_FEE, GROSS, 199_000000n, DEADLINE]);
      await expect(rej.callExec(await execAddr(), data)).to.be.reverted;
    });

    it("rejects same-token, zero amount, zero minOut, expired deadline, and pause", async () => {
      const a = await tokenA.getAddress(), b = await tokenB.getAddress();
      await expect(exec.connect(user).tradeUniswapExactInput(a, a, POOL_FEE, GROSS, 1n, DEADLINE)).to.be.revertedWith("same token");
      await expect(exec.connect(user).tradeUniswapExactInput(a, b, POOL_FEE, 0n, 1n, DEADLINE)).to.be.revertedWith("zero amount");
      await expect(exec.connect(user).tradeUniswapExactInput(a, b, POOL_FEE, GROSS, 0n, DEADLINE)).to.be.revertedWith("zero minOut");
      await expect(exec.connect(user).tradeUniswapExactInput(a, b, POOL_FEE, GROSS, 1n, 1n)).to.be.revertedWith("expired");
      await exec.connect(safe).setPaused(true);
      await expect(exec.connect(user).tradeUniswapExactInput(a, b, POOL_FEE, GROSS, 1n, DEADLINE)).to.be.revertedWith("paused");
    });

    it("output goes to the caller only — a bystander gets nothing", async () => {
      const bBefore = await tokenB.balanceOf(bystander.address);
      await exec.connect(user).tradeUniswapExactInput(await tokenA.getAddress(), await tokenB.getAddress(), POOL_FEE, GROSS, 199_000000n, DEADLINE);
      expect(await tokenB.balanceOf(bystander.address)).to.equal(bBefore); // unchanged
      expect(await tokenB.balanceOf(user.address)).to.equal(UNI_OUT);
    });
  });

  /* ── Kuru adapter (allowlist + forwarding) ────────────────────────────── */
  describe("Kuru adapter", () => {
    it("rejects a non-allowlisted market (arbitrary-target rejection)", async () => {
      const Kuru = await ethers.getContractFactory("MockKuruMarket");
      const m = await Kuru.deploy(NATIVE, await tokenB.getAddress()); // not allowlisted
      await expect(exec.connect(user).tradeKuruExactInput(await m.getAddress(), false, NATIVE, await tokenB.getAddress(), 1, GROSS, 1n, { value: GROSS }))
        .to.be.revertedWith("market not allowed");
    });

    it("SELL native MON → ERC-20 quote: output forwarded to user, fee taken, zero retention", async () => {
      const Kuru = await ethers.getContractFactory("MockKuruMarket");
      const m = await Kuru.deploy(NATIVE, await tokenB.getAddress()); // base=native, quote=tokenB
      await tokenB.mint(await m.getAddress(), BIG);
      await exec.connect(safe).setKuruMarket(await m.getAddress(), true);
      const tBefore = await ethers.provider.getBalance(treasury.address);
      const uBefore = await tokenB.balanceOf(user.address);
      await exec.connect(user).tradeKuruExactInput(await m.getAddress(), false, NATIVE, await tokenB.getAddress(), 1, GROSS, 299_000000n, { value: GROSS });
      expect(await tokenB.balanceOf(user.address) - uBefore).to.equal(KURU_OUT); // ERC-20 forwarded
      expect(await ethers.provider.getBalance(treasury.address) - tBefore).to.equal(FEE);
      await noResidue(tokenB);
    });

    it("BUY ERC-20 quote → native MON base: native output forwarded to user, exact approval reset", async () => {
      const Kuru = await ethers.getContractFactory("MockKuruMarket");
      const m = await Kuru.deploy(NATIVE, await tokenB.getAddress()); // base=native, quote=tokenB
      await safe.sendTransaction({ to: await m.getAddress(), value: ethers.parseEther("1") }); // native reserve
      await exec.connect(safe).setKuruMarket(await m.getAddress(), true);

      const Wallet = await ethers.getContractFactory("UserWallet");
      const w = await Wallet.deploy();
      await tokenB.mint(await w.getAddress(), GROSS);
      await w.approveToken(await tokenB.getAddress(), await execAddr(), GROSS);
      const data = exec.interface.encodeFunctionData("tradeKuruExactInput", [await m.getAddress(), true, await tokenB.getAddress(), NATIVE, 1, GROSS, 299_000000n]);
      const wBefore = await ethers.provider.getBalance(await w.getAddress());
      await w.exec(await execAddr(), 0, data);
      expect(await ethers.provider.getBalance(await w.getAddress()) - wBefore).to.equal(KURU_OUT); // native forwarded
      expect(await tokenB.balanceOf(treasury.address)).to.equal(FEE);
      expect(await tokenB.allowance(await execAddr(), await m.getAddress())).to.equal(0n);
      await noResidue(tokenB);
    });

    it("refunds residual input if Kuru consumes less than net (zero retention preserved)", async () => {
      const Kuru = await ethers.getContractFactory("MockKuruMarket");
      const m = await Kuru.deploy(await tokenA.getAddress(), await tokenB.getAddress()); // base=tokenA, quote=tokenB
      await tokenB.mint(await m.getAddress(), BIG);
      await m.setUnderfill(1000); // consume only 90% of net
      await exec.connect(safe).setKuruMarket(await m.getAddress(), true);
      await tokenA.mint(user.address, GROSS);
      await tokenA.connect(user).approve(await execAddr(), GROSS);
      const uaBefore = await tokenA.balanceOf(user.address);
      await exec.connect(user).tradeKuruExactInput(await m.getAddress(), false, await tokenA.getAddress(), await tokenB.getAddress(), 1, GROSS, 1n);
      // executor kept nothing: user got back the 10% Kuru didn't spend
      const refund = NET - (NET - (NET * 1000n) / 10000n); // 10% of net
      expect(uaBefore - await tokenA.balanceOf(user.address)).to.equal(GROSS - refund);
      await noResidue(tokenA, tokenB);
    });

    it("insufficient output reverts (Kuru minOut)", async () => {
      const Kuru = await ethers.getContractFactory("MockKuruMarket");
      const m = await Kuru.deploy(NATIVE, await tokenB.getAddress());
      await tokenB.mint(await m.getAddress(), BIG);
      await m.setRate(1, 1); // out = net < minOut
      await exec.connect(safe).setKuruMarket(await m.getAddress(), true);
      await expect(exec.connect(user).tradeKuruExactInput(await m.getAddress(), false, NATIVE, await tokenB.getAddress(), 1, GROSS, 299_000000n, { value: GROSS })).to.be.reverted;
    });
  });

  /* ── Reentrancy ───────────────────────────────────────────────────────── */
  describe("reentrancy", () => {
    it("blocks re-entry on native-output delivery (nonReentrant)", async () => {
      const Kuru = await ethers.getContractFactory("MockKuruMarket");
      const m = await Kuru.deploy(NATIVE, await tokenB.getAddress());
      await safe.sendTransaction({ to: await m.getAddress(), value: ethers.parseEther("1") });
      await exec.connect(safe).setKuruMarket(await m.getAddress(), true);

      const Atk = await ethers.getContractFactory("ReentrantAttacker");
      const atk = await Atk.deploy(await execAddr());
      await tokenB.mint(await atk.getAddress(), GROSS * 2n);
      await atk.approveToken(await tokenB.getAddress(), await execAddr(), GROSS * 2n);
      const call = exec.interface.encodeFunctionData("tradeKuruExactInput", [await m.getAddress(), true, await tokenB.getAddress(), NATIVE, 1, GROSS, 1n]);
      await atk.arm(call); // re-enter with the same trade on native receipt
      await expect(atk.go(call)).to.be.reverted; // nonReentrant trips the inner call
    });
  });

  /* ── Fee treasury validation ──────────────────────────────────────────── */
  describe("fee & treasury", () => {
    it("fee routes to the currently-configured treasury and updates when changed", async () => {
      await tokenA.mint(user.address, GROSS * 2n);
      await tokenA.connect(user).approve(await execAddr(), GROSS * 2n);
      await exec.connect(user).tradeUniswapExactInput(await tokenA.getAddress(), await tokenB.getAddress(), POOL_FEE, GROSS, 199_000000n, DEADLINE);
      expect(await tokenA.balanceOf(treasury.address)).to.equal(FEE);
      await exec.connect(safe).setTreasury(bystander.address); // new treasury
      await exec.connect(user).tradeUniswapExactInput(await tokenA.getAddress(), await tokenB.getAddress(), POOL_FEE, GROSS, 199_000000n, DEADLINE);
      expect(await tokenA.balanceOf(bystander.address)).to.equal(FEE);
    });
    it("fee floors down (dust trade pays zero fee, still zero retention)", async () => {
      await tokenA.mint(user.address, 39n); // 39 * 25 / 10000 = 0 fee
      await tokenA.connect(user).approve(await execAddr(), 39n);
      await exec.connect(user).tradeUniswapExactInput(await tokenA.getAddress(), await tokenB.getAddress(), POOL_FEE, 39n, 1n, DEADLINE);
      expect(await tokenA.balanceOf(treasury.address)).to.equal(0n);
      await noResidue(tokenA, tokenB);
    });
  });
});
