// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title PayAITradeExecutorV2
 * @notice PayAI's on-chain footprint for INTERACTIVE, user-signed TRADES on
 *         Monad — Gate 7: adds Nad.Fun to the Uniswap V3 + Kuru executor
 *         (PayAITradeExecutor, Gate 3/4/5) as a third typed venue. This is a
 *         SEPARATE, non-upgradeable deployment — the original executor at
 *         0xF17a916280321Ddb657c8EDd26B2a729F6E63b69 is untouched and remains
 *         the production Uniswap/Kuru executor until this contract is fully
 *         tested, canaried, and approved.
 *
 *         It is NOT an arbitrary-call contract: there is no entry point that
 *         takes a caller-supplied target + calldata. Every trade goes through
 *         a TYPED adapter (Uniswap, Kuru, or Nad.Fun) whose router is fixed at
 *         deploy (Uniswap) or held in a Safe-controlled allowlist (Kuru
 *         markets; Nad.Fun's two routers). The payer/beneficiary is ALWAYS
 *         `msg.sender`.
 *
 *         Trust model (identical to V1):
 *           - The user signs the trade from their own wallet; `msg.sender` is
 *             the payer AND the sole beneficiary — there is no `from`/`to`
 *             parameter a caller could point at someone else.
 *           - The contract retains ZERO user funds after a successful trade:
 *             input is pulled, the fee goes to the Safe treasury, the net is
 *             swapped, and 100% of the output is delivered to the user. Any
 *             residue reverts the trade (INV-ZERO-RETENTION).
 *           - Output is measured by the USER's real balance delta, never a
 *             router's return value (INV-OUTPUT-DELTA).
 *           - Admin (owner) is the PayAI Safe multisig. The owner can only set
 *             the fee (capped), treasury, the Kuru/Nad.Fun allowlists, and
 *             pause — it can NEVER move a user's funds.
 *
 *         Exact-input only. Exact-output is deliberately absent for every
 *         venue (no refund path to get wrong) — Nad.Fun's own `exactOutBuy`/
 *         `exactOutSell` exist on its routers but are never called here.
 *
 *         Venue output behavior:
 *           - Uniswap V3: has a recipient — ERC-20 output is sent straight to
 *             the user; native output is produced as WMON to this contract,
 *             then unwrapped and forwarded.
 *           - Kuru: NO recipient parameter — output (ERC-20 quote, or NATIVE
 *             MON on a buy) lands in THIS contract (msg.sender) and MUST be
 *             forwarded to the user. Hence the `receive()` below.
 *           - Nad.Fun: HAS a recipient (`to`) on both `buy` and `sell` — set
 *             to the user directly, so output never lands at this contract at
 *             all (verified against the official ABI repo in Gate 6; see
 *             lib/monad/nadfun.ts). No WMON leg either — Nad.Fun's routers
 *             take/return native MON directly, never wrapped.
 */

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IKuruMarket {
    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill) external payable returns (uint256);
    function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill) external payable returns (uint256);
}

/// BondingCurveRouter and DexRouter expose IDENTICAL buy/sell struct shapes
/// (verified against the official Nad.Fun ABI repo in Gate 6 / lib/monad/nadfun.ts's
/// NADFUN_ROUTER_ABI) — one shared interface is used for calls to EITHER contract.
interface INadFunRouter {
    struct BuyParams {
        uint256 amountOutMin;
        address token;
        address to;
        uint256 deadline;
    }
    struct SellParams {
        uint256 amountIn;
        uint256 amountOutMin;
        address token;
        address to;
        uint256 deadline;
    }
    function buy(BuyParams calldata params) external payable;
    function sell(SellParams calldata params) external;
}

contract PayAITradeExecutorV2 {
    /* ── Venue tag (event only) ─────────────────────────────────────────── */
    uint8 public constant VENUE_UNISWAP = 0;
    uint8 public constant VENUE_KURU = 1;
    uint8 public constant VENUE_NADFUN = 2;

    /// Sentinel for native MON in token params.
    address public constant NATIVE = address(0);

    /// Hard cap on the platform fee — the owner can never set a rug-level fee.
    uint16 public constant MAX_FEE_BPS = 100; // 1.00%

    /* ── Admin state (owner = PayAI Safe multisig) ──────────────────────── */
    address public owner;
    address public treasury;
    uint16 public feeBps; // 25 = 0.25%
    bool public paused;

    /* ── Immutable venue wiring (set once at deploy, never client-supplied) */
    address public immutable uniswapRouter;
    IWETH9 public immutable wmon;

    /// Safe-controlled Kuru market allowlist. A trade can only ever be sent to
    /// a market the Safe has explicitly allowed.
    mapping(address => bool) public allowedKuruMarket;

    /// Safe-controlled Nad.Fun router allowlist. A trade can only ever be sent
    /// to a router the Safe has explicitly allowed — intended to hold exactly
    /// the two verified Nad.Fun routers (BondingCurveRouter, DexRouter) and
    /// nothing else; never derived from a token address or any other
    /// user/Lens-controlled input.
    mapping(address => bool) public allowedNadFunRouter;

    /* ── Bookkeeping ─────────────────────────────────────────────────────── */
    uint256 public tradeCount;
    bool private _locked;

    /* ── Events ──────────────────────────────────────────────────────────── */
    event TradeExecuted(
        uint256 indexed tradeId,
        address indexed user,
        uint8 venue,
        address tokenIn,
        address tokenOut,
        uint256 amountIn, // gross input (pre-fee), the amount the user committed
        uint256 amountOut, // actual delivered output (user balance delta)
        uint256 feeAmount
    );
    event FeeCollected(uint256 indexed tradeId, address token, uint256 feeAmount, address treasury);
    event PausedSet(bool paused);
    event TreasurySet(address treasury);
    event FeeBpsSet(uint16 feeBps);
    event KuruMarketSet(address market, bool allowed);
    event NadFunRouterSet(address router, bool allowed);
    event OwnershipTransferred(address indexed from, address indexed to);

    /* ── Modifiers ───────────────────────────────────────────────────────── */
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }
    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }
    modifier nonReentrant() {
        require(!_locked, "reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    /**
     * @param initialOwner  Safe multisig admin (pause + config only).
     * @param treasury_     Where the fee is sent. Safe-controlled.
     * @param feeBps_       Initial fee in basis points (<= MAX_FEE_BPS).
     * @param uniswapRouter_ Uniswap V3 SwapRouter02 (immutable).
     * @param wmon_         Wrapped MON (WETH9) used for native wrap/unwrap.
     *
     * Nad.Fun's two routers are NOT constructor params — like Kuru markets,
     * they're seeded post-deploy via setNadFunRouter(), a Safe-only call, so
     * the same deploy script/shape as V1 still applies and the allowlist is
     * verifiable on-chain independent of the deploy transaction.
     */
    constructor(address initialOwner, address treasury_, uint16 feeBps_, address uniswapRouter_, address wmon_) {
        require(initialOwner != address(0), "zero owner");
        require(treasury_ != address(0), "zero treasury");
        require(uniswapRouter_ != address(0), "zero router");
        require(wmon_ != address(0), "zero wmon");
        require(feeBps_ <= MAX_FEE_BPS, "fee too high");
        owner = initialOwner;
        treasury = treasury_;
        feeBps = feeBps_;
        uniswapRouter = uniswapRouter_;
        wmon = IWETH9(wmon_);
        emit OwnershipTransferred(address(0), initialOwner);
    }

    /* ── Admin (owner/Safe only — never moves user funds) ───────────────── */
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }
    function setTreasury(address t) external onlyOwner {
        require(t != address(0), "zero treasury");
        treasury = t;
        emit TreasurySet(t);
    }
    function setFeeBps(uint16 b) external onlyOwner {
        require(b <= MAX_FEE_BPS, "fee too high");
        feeBps = b;
        emit FeeBpsSet(b);
    }
    function setKuruMarket(address market, bool allowed) external onlyOwner {
        require(market != address(0), "zero market");
        allowedKuruMarket[market] = allowed;
        emit KuruMarketSet(market, allowed);
    }
    function setNadFunRouter(address router, bool allowed) external onlyOwner {
        require(router != address(0), "zero router");
        allowedNadFunRouter[router] = allowed;
        emit NadFunRouterSet(router, allowed);
    }
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /// Accept native MON: (a) native input attached to a trade, (b) native
    /// output that Kuru/our unwrap sends here before we forward it to the user.
    /// Nad.Fun never sends native MON here (its routers pay `to` directly).
    receive() external payable {}

    /* ── Internal helpers (identical to V1) ──────────────────────────────── */

    /// Pull `gross` of `token` from the user into this contract and return the
    /// fee (already sent to the treasury) so the caller can compute `net`.
    /// Native (token == address(0)) is validated against msg.value; ERC-20 is
    /// pulled via transferFrom with a balance-delta check (fee-on-transfer safe).
    function _pullAndFee(address token, uint256 gross, uint256 tradeId) private returns (uint256 fee, uint256 net) {
        require(gross > 0, "zero amount");
        fee = (gross * feeBps) / 10000; // floors down; never overcharges
        net = gross - fee;
        if (token == NATIVE) {
            require(msg.value == gross, "bad msg.value");
            if (fee > 0) {
                (bool ok, ) = treasury.call{value: fee}("");
                require(ok, "fee xfer failed");
            }
        } else {
            require(msg.value == 0, "no native for erc20 in");
            uint256 balBefore = IERC20(token).balanceOf(address(this));
            require(IERC20(token).transferFrom(msg.sender, address(this), gross), "pull failed");
            require(IERC20(token).balanceOf(address(this)) - balBefore == gross, "pull short");
            if (fee > 0) require(IERC20(token).transfer(treasury, fee), "fee xfer failed");
        }
        emit FeeCollected(tradeId, token, fee, treasury);
    }

    /// Deliver the full `amount` of output `token` (native or ERC-20) to `user`.
    function _deliver(address token, address user, uint256 amount) private {
        if (amount == 0) return;
        if (token == NATIVE) {
            (bool ok, ) = user.call{value: amount}("");
            require(ok, "native deliver failed");
        } else {
            require(IERC20(token).transfer(user, amount), "erc20 deliver failed");
        }
    }

    /// Refund any residual `token` this contract still holds back to `user`
    /// (should be zero for a clean exact-input fill; a partial DEX pull must
    /// never strand user funds here).
    function _refundResidualInput(address token, address user) private {
        if (token == NATIVE) {
            uint256 bal = address(this).balance;
            if (bal > 0) { (bool ok, ) = user.call{value: bal}(""); require(ok, "refund failed"); }
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) require(IERC20(token).transfer(user, bal), "refund failed");
        }
    }

    /// The user's balance of `token` (native or ERC-20) — used for the
    /// authoritative output-delta measurement.
    function _balanceOf(address token, address who) private view returns (uint256) {
        return token == NATIVE ? who.balance : IERC20(token).balanceOf(who);
    }

    /// Post-trade zero-retention assertion: this contract must hold none of the
    /// input token, output token, wmon, or native MON.
    function _assertZeroRetention(address tokenIn, address tokenOut) private view {
        require(address(this).balance == 0, "native retained");
        if (tokenIn != NATIVE) require(IERC20(tokenIn).balanceOf(address(this)) == 0, "tokenIn retained");
        if (tokenOut != NATIVE) require(IERC20(tokenOut).balanceOf(address(this)) == 0, "tokenOut retained");
        require(wmon.balanceOf(address(this)) == 0, "wmon retained");
    }

    /// Exact-input Uniswap V3 single-hop: exact-amount approve, swap, reset. Kept
    /// in its own private frame so the public adapter stays under the stack limit.
    function _swapUniswap(
        address swapIn,
        address swapOut,
        uint24 poolFee,
        uint256 net,
        uint256 minOut,
        address recipient
    ) private {
        require(IERC20(swapIn).approve(uniswapRouter, net), "approve failed");
        IUniswapV3Router(uniswapRouter).exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn: swapIn,
                tokenOut: swapOut,
                fee: poolFee,
                recipient: recipient,
                amountIn: net,
                amountOutMinimum: minOut, // router-side floor; re-checked by delta in the adapter
                sqrtPriceLimitX96: 0
            })
        );
        require(IERC20(swapIn).approve(uniswapRouter, 0), "approve reset failed");
    }

    /// Kuru market call in its own private frame (buy/sell), keeping the public
    /// adapter under the stack limit. Native input is attached as `nativeValue`.
    function _executeKuru(address market, bool isBuy, uint96 kuruSize, uint256 minOut, uint256 nativeValue) private {
        if (isBuy) {
            IKuruMarket(market).placeAndExecuteMarketBuy{value: nativeValue}(kuruSize, minOut, false, true);
        } else {
            IKuruMarket(market).placeAndExecuteMarketSell{value: nativeValue}(kuruSize, minOut, false, true);
        }
    }

    /* ── Uniswap V3 adapter (identical to V1) ─────────────────────────────── */
    /**
     * Exact-input Uniswap V3 single-hop trade. `tokenIn`/`tokenOut == address(0)`
     * means native MON (this contract wraps/unwraps via WMON itself). The
     * Uniswap router is immutable; the recipient is set by THIS contract; the
     * pool `fee` tier is a trade routing parameter (a wrong tier simply reverts
     * on a nonexistent pool — it is not arbitrary calldata).
     */
    function tradeUniswapExactInput(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 grossAmountIn,
        uint256 minOut,
        uint256 deadline
    ) external payable whenNotPaused nonReentrant returns (uint256 amountOut) {
        require(tokenIn != tokenOut, "same token");
        require(minOut > 0, "zero minOut");
        require(block.timestamp <= deadline, "expired");
        uint256 tradeId = tradeCount++;

        (uint256 fee, uint256 net) = _pullAndFee(tokenIn, grossAmountIn, tradeId);
        // The whole swap/deliver/verify body lives in its own frame so this
        // adapter stays well under the EVM stack limit (no viaIR needed).
        amountOut = _runUniswap(tokenIn, tokenOut, poolFee, net, minOut);

        emit TradeExecuted(tradeId, msg.sender, VENUE_UNISWAP, tokenIn, tokenOut, grossAmountIn, amountOut, fee);
    }

    /// Swap → (unwrap native out) → refund residual → measure user delta →
    /// enforce minOut → assert zero retention. Runs inside the caller's
    /// nonReentrant lock. `net` is the post-fee input; `msg.sender` is the user.
    function _runUniswap(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 net,
        uint256 minOut
    ) private returns (uint256 amountOut) {
        address user = msg.sender;

        if (tokenIn == NATIVE) {
            wmon.deposit{value: net}(); // executor wraps the net itself
        }

        // Native out → send WMON here, then unwrap+forward. ERC-20 out → user directly.
        uint256 userOutBefore = _balanceOf(tokenOut, user);

        _swapUniswap(
            tokenIn == NATIVE ? address(wmon) : tokenIn,
            tokenOut == NATIVE ? address(wmon) : tokenOut,
            poolFee,
            net,
            minOut,
            tokenOut == NATIVE ? address(this) : user
        );

        if (tokenOut == NATIVE) {
            // Unwrap the WMON we received and forward native MON to the user.
            uint256 wbal = wmon.balanceOf(address(this));
            wmon.withdraw(wbal);
            _deliver(NATIVE, user, wbal);
        }

        // Refund any residual input (defensive; exact-input should leave none).
        _refundResidualInput(tokenIn, user);

        amountOut = _balanceOf(tokenOut, user) - userOutBefore;
        require(amountOut >= minOut, "insufficient output");
        _assertZeroRetention(tokenIn, tokenOut);
    }

    /* ── Kuru adapter (identical to V1) ──────────────────────────────────── */
    /**
     * Exact-input Kuru market trade. `market` must be Safe-allowlisted. Kuru has
     * NO recipient parameter, so output lands in THIS contract and is forwarded
     * to the user (native MON on a buy, ERC-20 quote on a sell). `kuruSize` is
     * the venue's precision-scaled size (computed off-chain like `minOut`); a
     * wrong size cannot harm the user — the exact-amount approval bounds the
     * input, residual is refunded, and the output-delta check enforces `minOut`.
     */
    function tradeKuruExactInput(
        address market,
        bool isBuy,
        address tokenIn,
        address tokenOut,
        uint96 kuruSize,
        uint256 grossAmountIn,
        uint256 minOut
    ) external payable whenNotPaused nonReentrant returns (uint256 amountOut) {
        require(allowedKuruMarket[market], "market not allowed");
        require(tokenIn != tokenOut, "same token");
        require(minOut > 0, "zero minOut");
        uint256 tradeId = tradeCount++;

        (uint256 fee, uint256 net) = _pullAndFee(tokenIn, grossAmountIn, tradeId);
        // The whole execute/forward/verify body lives in its own frame so this
        // adapter stays well under the EVM stack limit (no viaIR needed).
        amountOut = _runKuru(market, isBuy, tokenIn, tokenOut, kuruSize, net, minOut);

        emit TradeExecuted(tradeId, msg.sender, VENUE_KURU, tokenIn, tokenOut, grossAmountIn, amountOut, fee);
    }

    /// Approve (exact) → execute market order → reset approval → forward output
    /// → refund residual → measure user delta → enforce minOut → assert zero
    /// retention. Runs inside the caller's nonReentrant lock. `msg.sender` is user.
    function _runKuru(
        address market,
        bool isBuy,
        address tokenIn,
        address tokenOut,
        uint96 kuruSize,
        uint256 net,
        uint256 minOut
    ) private returns (uint256 amountOut) {
        address user = msg.sender;

        if (tokenIn != NATIVE) {
            require(IERC20(tokenIn).approve(market, net), "approve failed"); // exact-amount, never MAX
        }

        uint256 userOutBefore = _balanceOf(tokenOut, user);

        // Native input is attached as msg.value; ERC-20 input was approved above.
        _executeKuru(market, isBuy, kuruSize, minOut, tokenIn == NATIVE ? net : 0);

        // Reset any ERC-20 approval to zero.
        if (tokenIn != NATIVE) require(IERC20(tokenIn).approve(market, 0), "approve reset failed");

        // Kuru has no recipient, so output landed in THIS contract — forward it.
        // Native output is this contract's own native balance (MON from a buy);
        // ERC-20 output is its token balance.
        if (tokenOut == NATIVE) {
            _deliver(NATIVE, user, address(this).balance);
        } else {
            _deliver(tokenOut, user, _balanceOf(tokenOut, address(this)));
        }

        // Refund any residual input Kuru did not consume.
        _refundResidualInput(tokenIn, user);

        amountOut = _balanceOf(tokenOut, user) - userOutBefore;
        require(amountOut >= minOut, "insufficient output");
        _assertZeroRetention(tokenIn, tokenOut);
    }

    /* ── Nad.Fun adapter (NEW — Gate 7) ───────────────────────────────────── */
    /**
     * Exact-input Nad.Fun trade. `router` must be on the Safe-controlled
     * Nad.Fun allowlist (exactly the BondingCurveRouter and DexRouter — never
     * derived from anything the caller or the off-chain Lens supplies). The
     * Lens (off-chain, in lib/monad/nadfun.ts) decides bonding-curve-vs-DEX and
     * hands the app the correct router; this adapter independently re-validates
     * it against the allowlist before ever using it as a call target.
     *
     * `token` is always the non-MON side, regardless of direction:
     *   isBuy  = true  -> spend native MON, acquire `token` (bonding curve or
     *                      graduated DEX pool, whichever `router` serves).
     *   isBuy  = false -> spend `token`, acquire native MON.
     *
     * Unlike Kuru, both `buy` and `sell` take a `to` recipient — set to
     * `msg.sender` directly, so output NEVER lands at this contract (no
     * forwarding step, no custody window at all for the output leg). Unlike
     * Uniswap, there is no WMON leg — Nad.Fun's routers move native MON
     * directly. Output is still verified by the USER's real balance delta,
     * never trusted from the router's return value or its `to` field alone —
     * a misbehaving allowlisted router that fails to pay `to` in full simply
     * fails the amountOut >= minOut check below and reverts the whole trade.
     */
    function tradeNadFunExactInput(
        address router,
        bool isBuy,
        address token,
        uint256 grossAmountIn,
        uint256 minOut,
        uint256 deadline
    ) external payable whenNotPaused nonReentrant returns (uint256 amountOut) {
        require(allowedNadFunRouter[router], "router not allowed");
        require(token != address(0), "zero token");
        require(minOut > 0, "zero minOut");
        require(block.timestamp <= deadline, "expired");
        uint256 tradeId = tradeCount++;
        address tokenIn = isBuy ? NATIVE : token;
        address tokenOut = isBuy ? token : NATIVE;

        (uint256 fee, uint256 net) = _pullAndFee(tokenIn, grossAmountIn, tradeId);
        // The whole buy/sell/verify body lives in its own frame so this
        // adapter stays well under the EVM stack limit (no viaIR needed).
        amountOut = _runNadFun(router, isBuy, token, net, minOut, deadline, tokenIn, tokenOut);

        emit TradeExecuted(tradeId, msg.sender, VENUE_NADFUN, tokenIn, tokenOut, grossAmountIn, amountOut, fee);
    }

    /// buy/sell (recipient = user directly) → (sell only: reset approval) →
    /// refund residual → measure user delta → enforce minOut → assert zero
    /// retention. Runs inside the caller's nonReentrant lock. `msg.sender` is user.
    function _runNadFun(
        address router,
        bool isBuy,
        address token,
        uint256 net,
        uint256 minOut,
        uint256 deadline,
        address tokenIn,
        address tokenOut
    ) private returns (uint256 amountOut) {
        address user = msg.sender;
        uint256 userOutBefore = _balanceOf(tokenOut, user);

        if (isBuy) {
            INadFunRouter(router).buy{value: net}(
                INadFunRouter.BuyParams({ amountOutMin: minOut, token: token, to: user, deadline: deadline })
            );
        } else {
            require(IERC20(token).approve(router, net), "approve failed"); // exact-amount, never MAX
            INadFunRouter(router).sell(
                INadFunRouter.SellParams({ amountIn: net, amountOutMin: minOut, token: token, to: user, deadline: deadline })
            );
            require(IERC20(token).approve(router, 0), "approve reset failed");
        }

        // Refund any residual input the router did not consume (defensive;
        // exact-input should leave none — Nad.Fun's buy/sell take the full
        // amount specified, unlike Kuru's underfill-capable market orders).
        _refundResidualInput(tokenIn, user);

        amountOut = _balanceOf(tokenOut, user) - userOutBefore;
        require(amountOut >= minOut, "insufficient output");
        _assertZeroRetention(tokenIn, tokenOut);
    }
}
