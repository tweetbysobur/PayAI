// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * Test-only Nad.Fun router fixture for PayAITradeExecutorV2 (Gate 7). Nad.Fun's
 * BondingCurveRouter and DexRouter expose IDENTICAL buy/sell struct shapes (see
 * PayAITradeExecutorV2's own doc and lib/monad/nadfun.ts's NADFUN_ROUTER_ABI),
 * so one mock stands in for either — tests allowlist this contract's address
 * under whichever role (bonding-curve or DEX) a given case needs. Never
 * deployed to a real network.
 */

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * `buy` mints the output token to the recipient — models a bonding-curve mint
 * or a DEX-pool payout without needing a pre-funded token balance (the mock
 * token, MockERC20, has an open `mint`). `sell` pulls the input token via
 * transferFrom (requires the caller's prior approval, exactly like the real
 * router) and pays native MON to the recipient — this contract must be
 * pre-funded with native for sell tests, same as MockKuruMarket's convention.
 *
 * `misdeliver` lets a test simulate a misbehaving ALLOWLISTED router that pays
 * someone other than the requested recipient — proving the executor's own
 * balance-delta check (never trusting the router's `to` field being honored)
 * still catches the shortfall and reverts.
 */
contract MockNadFunRouter {
    uint256 public rateNum = 5;
    uint256 public rateDen = 1;
    bool public shouldRevert;
    bool public misdeliver;
    address public misdeliverTarget;

    function setRate(uint256 n, uint256 d) external { rateNum = n; rateDen = d; }
    function setRevert(bool v) external { shouldRevert = v; }
    function setMisdeliver(bool v, address target) external { misdeliver = v; misdeliverTarget = target; }
    receive() external payable {}

    struct BuyParams { uint256 amountOutMin; address token; address to; uint256 deadline; }
    struct SellParams { uint256 amountIn; uint256 amountOutMin; address token; address to; uint256 deadline; }

    function buy(BuyParams calldata params) external payable {
        require(!shouldRevert, "NADFUN_FAIL");
        uint256 amountOut = (msg.value * rateNum) / rateDen;
        require(amountOut >= params.amountOutMin, "nadfun: minOut");
        address recipient = misdeliver ? misdeliverTarget : params.to;
        IMintableERC20(params.token).mint(recipient, amountOut);
    }

    function sell(SellParams calldata params) external {
        require(!shouldRevert, "NADFUN_FAIL");
        require(IMintableERC20(params.token).transferFrom(msg.sender, address(this), params.amountIn), "nadfun: pull");
        uint256 amountOut = (params.amountIn * rateNum) / rateDen;
        require(amountOut >= params.amountOutMin, "nadfun: minOut");
        address recipient = misdeliver ? misdeliverTarget : params.to;
        (bool ok, ) = recipient.call{value: amountOut}("");
        require(ok, "nadfun: pay native");
    }
}
