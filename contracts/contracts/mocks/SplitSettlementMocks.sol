// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * Test-only fixtures for SplitSettlement. None are ever deployed to a real
 * network. Standard-token / false-return / reverting-token / short-transfer
 * cases reuse the existing mocks (MockERC20, FalseReturningERC20,
 * RevertingERC20, ShortTransferERC20, RevertingReceiver); these cover the
 * cases those don't.
 */

/** An ERC-20 whose `transferFrom` returns NO data (old USDT-style
 *  non-compliant token). SplitSettlement decodes a `bool` return, so a
 *  no-return token makes the ABI decode revert — proving the documented,
 *  accepted v1 behavior (a no-return token reverts, it is not silently
 *  accepted). */
contract NoReturnERC20 {
    string public name = "No Return Token";
    string public symbol = "NORET";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// Actually moves the funds, but returns NOTHING (no `returns` clause).
    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/** Re-enters SplitSettlement.splitPayment from its own native-receive hook —
 *  proves the nonReentrant guard blocks a recursive split (the reentrant call
 *  reverts, and because the outer split requires every native send to succeed,
 *  the whole original split reverts). */
interface ISplitSettlement {
    function splitPayment(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts,
        bytes32 ref
    ) external payable returns (uint256);
}

contract ReentrantSplitRecipient {
    ISplitSettlement public immutable target;
    bool internal _attacked;

    constructor(address target_) {
        target = ISplitSettlement(target_);
    }

    receive() external payable {
        if (!_attacked) {
            _attacked = true;
            address[] memory rs = new address[](1);
            uint256[] memory as_ = new uint256[](1);
            rs[0] = address(this);
            as_[0] = msg.value;
            // Re-enter mid-split. The guard must make this revert.
            target.splitPayment{value: msg.value}(address(0), rs, as_, bytes32(0));
        }
    }
}

/** Force native MON into a target with NO code running there — via
 *  `selfdestruct` in the constructor. Proves SplitSettlement tolerates a
 *  pre-existing forced balance (delta-based zero-retention, INVARIANT-SS-7). */
contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
