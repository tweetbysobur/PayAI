// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title PayAITradeExecutor
 * @notice PayAI's on-chain footprint for INTERACTIVE, user-signed TRADES on
 *         Monad, for the two venues cleared by Gate 2.2: Uniswap V3 and Kuru.
 *
 *         Separate from PayAIForwarder (payments) and non-upgradeable, exactly
 *         like the forwarder. It is NOT an arbitrary-call contract: there is no
 *         entry point that takes a caller-supplied target + calldata. Every
 *         trade goes through a TYPED adapter (Uniswap or Kuru) whose router is
 *         fixed at deploy (Uniswap) or held in a Safe-controlled allowlist
 *         (Kuru markets). The payer/beneficiary is ALWAYS `msg.sender`.
 *
 *         Trust model (mirrors the forwarder):
 *           - The user signs the trade from their own wallet; `msg.sender` is
 *             the payer AND the sole beneficiary — there is no `from`/`to`
 *             parameter a caller could point at someone else.
 *           - The contract retains ZERO user funds after a successful trade:
 *             input is pulled, the 0.25% fee goes to the Safe treasury, the net
 *             is swapped, and 100% of the output is delivered to the user. Any
 *             residue reverts the trade (INV-ZERO-RETENTION).
 *           - Output is measured by the USER's real balance delta, never a
 *             router's return value (INV-OUTPUT-DELTA), mirroring the
 *             forwarder's INVARIANT-FW-3.
 *           - Admin (owner) is the PayAI Safe multisig. The owner can only set
 *             the fee (capped), treasury, Kuru allowlist, and pause — it can
 *             NEVER move a user's funds.
 *
 *         Exact-input only. Exact-output is deliberately absent (no refund path
 *         to get wrong). Native MON is represented by address(0) in the
 *         token params; the contract wraps/unwraps via WMON (a WETH9) itself
 *         so it never depends on a router's native handling.
 *
 *         Venue output behavior (verified in Gate 2.1/2.2 against live Monad):
 *           - Uniswap V3: has a recipient — ERC-20 output is sent straight to
 *             the user; native output is produced as WMON to this contract,
 *             then unwrapped and forwarded.
 *           - Kuru: NO recipient parameter — output (ERC-20 quote, or NATIVE
 *             MON on a buy) lands in THIS contract (msg.sender) and MUST be
 *             forwarded to the user. Hence the `receive()` below.
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

contract PayAITradeExecutor {
    /* ── Venue tag (event only) ─────────────────────────────────────────── */
    uint8 public constant VENUE_UNISWAP = 0;
    uint8 public constant VENUE_KURU = 1;

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
     * @param treasury_     Where the 0.25% fee is sent. Safe-controlled.
     * @param feeBps_       Initial fee in basis points (<= MAX_FEE_BPS).
     * @param uniswapRouter_ Uniswap V3 SwapRouter02 (immutable).
     * @param wmon_         Wrapped MON (WETH9) used for native wrap/unwrap.
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
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /// Accept native MON: (a) native input attached to a trade, (b) native
    /// output that Kuru/our unwrap sends here before we forward it to the user.
    receive() external payable {}

    /* ── Internal helpers ────────────────────────────────────────────────── */

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

    /* ── Uniswap V3 adapter ──────────────────────────────────────────────── */
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
        address user = msg.sender;
        uint256 tradeId = tradeCount++;

        (uint256 fee, uint256 net) = _pullAndFee(tokenIn, grossAmountIn, tradeId);

        if (tokenIn == NATIVE) {
            wmon.deposit{value: net}(); // executor wraps the net itself
        }

        // Native out → send WMON here, then unwrap+forward. ERC-20 out → user directly.
        uint256 userOutBefore = _balanceOf(tokenOut, user);

        // Isolated stack frame (approve → swap → reset). Native legs use WMON on
        // the pool side; the recipient is set by THIS contract, never the caller.
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

        emit TradeExecuted(tradeId, user, VENUE_UNISWAP, tokenIn, tokenOut, grossAmountIn, amountOut, fee);
    }

    /* ── Kuru adapter ────────────────────────────────────────────────────── */
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
        address user = msg.sender;
        uint256 tradeId = tradeCount++;

        (uint256 fee, uint256 net) = _pullAndFee(tokenIn, grossAmountIn, tradeId);

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

        emit TradeExecuted(tradeId, user, VENUE_KURU, tokenIn, tokenOut, grossAmountIn, amountOut, fee);
    }
}
