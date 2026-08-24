// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * Test-only fixtures for PayAITradeExecutor. Never deployed to a real network.
 * They reproduce the venue behaviors VERIFIED on live Monad in Gate 2.1/2.2:
 *   - Uniswap V3 has a `recipient`: output goes wherever the caller names.
 *   - Kuru has NO recipient: output is paid to `msg.sender` (the executor),
 *     and a Kuru BUY pays NATIVE MON.
 */

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/** Minimal WETH9 (stands in for WMON): wrap/unwrap + ERC-20. */
contract MockWETH9 {
    string public name = "Wrapped MON";
    string public symbol = "WMON";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function deposit() public payable { balanceOf[msg.sender] += msg.value; }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "wmon: insufficient");
        balanceOf[msg.sender] -= wad;
        (bool ok, ) = msg.sender.call{value: wad}("");
        require(ok, "wmon: withdraw fail");
    }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { return _xfer(msg.sender, to, a); }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        require(al >= a, "wmon: allowance");
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        return _xfer(f, to, a);
    }
    function _xfer(address f, address to, uint256 a) private returns (bool) {
        require(balanceOf[f] >= a, "wmon: balance");
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/**
 * Mock Uniswap V3 SwapRouter02. `exactInputSingle` pulls `amountIn` of tokenIn
 * from the caller, mints `amountIn * rateNum / rateDen` of tokenOut, and sends
 * it to `params.recipient` — matching the real router's recipient semantics.
 * Holds unlimited tokenOut via the mocks that mint to it, or (for WMON out) is
 * funded with native and wraps on demand.
 */
contract MockUniswapRouter {
    uint256 public rateNum = 2;
    uint256 public rateDen = 1;
    bool public shouldRevert;
    MockWETH9 public immutable wmon;

    constructor(address wmon_) { wmon = MockWETH9(payable(wmon_)); }
    function setRate(uint256 n, uint256 d) external { rateNum = n; rateDen = d; }
    function setRevert(bool v) external { shouldRevert = v; }
    receive() external payable {}

    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        require(!shouldRevert, "DEX_FAIL");
        require(IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn), "router: pull");
        amountOut = (p.amountIn * rateNum) / rateDen;
        require(amountOut >= p.amountOutMinimum, "Too little received");
        if (p.tokenOut == address(wmon)) {
            // Deliver WMON: wrap native the router was pre-funded with.
            wmon.deposit{value: amountOut}();
            require(wmon.transfer(p.recipient, amountOut), "router: wmon out");
        } else {
            require(IERC20(p.tokenOut).transfer(p.recipient, amountOut), "router: out");
        }
    }
}

/**
 * Mock Kuru market. NO recipient parameter — output is paid to msg.sender.
 * base/quote may be an ERC-20 or native MON (address(0)). A BUY spends quote
 * and pays base; a SELL spends base and pays quote. `underfillBps` lets a test
 * simulate Kuru consuming less than the approved input (residual-refund test).
 */
contract MockKuruMarket {
    address public base;
    address public quote;
    uint256 public rateNum = 3;
    uint256 public rateDen = 1;
    uint16 public underfillBps; // 0 = consume all approved/attached input
    bool public shouldRevert;

    constructor(address base_, address quote_) { base = base_; quote = quote_; }
    function setRate(uint256 n, uint256 d) external { rateNum = n; rateDen = d; }
    function setUnderfill(uint16 bps) external { underfillBps = bps; }
    function setRevert(bool v) external { shouldRevert = v; }
    receive() external payable {}

    // spend quote -> receive base
    function placeAndExecuteMarketBuy(uint96, uint256 minAmountOut, bool, bool) external payable returns (uint256) {
        require(!shouldRevert, "KURU_FAIL");
        uint256 spent = _take(quote);
        uint256 out = (spent * rateNum) / rateDen;
        require(out >= minAmountOut, "kuru: minOut");
        _pay(base, out);
        return out;
    }
    // spend base -> receive quote
    function placeAndExecuteMarketSell(uint96, uint256 minAmountOut, bool, bool) external payable returns (uint256) {
        require(!shouldRevert, "KURU_FAIL");
        uint256 spent = _take(base);
        uint256 out = (spent * rateNum) / rateDen;
        require(out >= minAmountOut, "kuru: minOut");
        _pay(quote, out);
        return out;
    }
    function _take(address token) private returns (uint256 spent) {
        if (token == address(0)) {
            spent = msg.value;
            if (underfillBps > 0) { // refund the unconsumed portion to caller
                uint256 refund = (msg.value * underfillBps) / 10000;
                spent = msg.value - refund;
                (bool ok, ) = msg.sender.call{value: refund}(""); require(ok, "kuru: refund");
            }
        } else {
            uint256 avail = IERC20(token).allowance(msg.sender, address(this));
            spent = underfillBps > 0 ? avail - (avail * underfillBps) / 10000 : avail;
            require(IERC20(token).transferFrom(msg.sender, address(this), spent), "kuru: pull");
        }
    }
    function _pay(address token, uint256 amount) private {
        if (token == address(0)) { (bool ok, ) = msg.sender.call{value: amount}(""); require(ok, "kuru: pay native"); }
        else require(IERC20(token).transfer(msg.sender, amount), "kuru: pay erc20");
    }
}

/** A contract that reverts when it receives native MON — proves a failed
 *  output/refund transfer reverts the whole trade. It initiates trades itself. */
contract NativeRejecter {
    // no receive/fallback -> any native transfer to this contract reverts
    function approveToken(address token, address spender, uint256 amount) external { IERC20(token).approve(spender, amount); }
    function callExec(address exec, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = exec.call{value: msg.value}(data);
        if (!ok) { assembly { revert(add(ret, 0x20), mload(ret)) } }
    }
}

/** A plain contract "wallet" so native-output deltas can be measured exactly
 *  (gas is paid by the EOA that calls it, not by this wallet). */
contract UserWallet {
    function exec(address target, uint256 value, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) { assembly { revert(add(ret, 0x20), mload(ret)) } }
        return ret;
    }
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }
    receive() external payable {}
}

/** Reentrancy attacker: on receiving native from the executor's delivery, it
 *  re-enters the executor — must trip nonReentrant. */
contract ReentrantAttacker {
    address public exec;
    bytes public payload;
    bool private armed;
    constructor(address exec_) { exec = exec_; }
    function approveToken(address token, address spender, uint256 amount) external { IERC20(token).approve(spender, amount); }
    function arm(bytes calldata p) external { payload = p; armed = true; }
    function go(bytes calldata firstCall) external payable {
        (bool ok, bytes memory ret) = exec.call{value: msg.value}(firstCall);
        if (!ok) { assembly { revert(add(ret, 0x20), mload(ret)) } }
    }
    receive() external payable {
        if (armed) { armed = false; (bool ok, ) = exec.call(payload); require(ok, "reentry blocked"); }
    }
}
