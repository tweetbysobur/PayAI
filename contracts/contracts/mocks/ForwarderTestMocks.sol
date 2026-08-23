// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * Test-only fixtures for PayAIForwarder. Kept in one file alongside the other
 * mocks. None of these are ever deployed to a real network.
 */

/** An ERC-20 whose `transferFrom` returns `false` without moving anything —
 *  proves PayAIForwarder's `require(ok)` rejects a false-returning token. */
contract FalseReturningERC20 {
    string public name = "False Returning Token";
    string public symbol = "FALSE";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// Silently does nothing and reports failure.
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/** An ERC-20 whose `transferFrom` always reverts — proves the revert
 *  propagates through PayAIForwarder and reverts the whole payment. */
contract RevertingERC20 {
    string public name = "Reverting Token";
    string public symbol = "REVERT";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert("token transfer reverted");
    }
}

/** A payee contract that reverts on receiving native MON — proves a native
 *  forward to a rejecting recipient reverts the whole payment (no partial). */
contract RevertingReceiver {
    receive() external payable {
        revert("i reject MON");
    }
}

/** Attempts to reenter PayAIForwarder.forwardPaymentNative from its own
 *  native-receive hook — proves the nonReentrant guard blocks it. */
interface IPayAIForwarder {
    function forwardPaymentNative(address recipient, uint256 amount, bytes32 ref) external payable returns (uint256);
}

contract ReentrantReceiver {
    IPayAIForwarder public immutable forwarder;
    address public immutable victim;
    bool internal _attacked;

    constructor(address forwarder_, address victim_) {
        forwarder = IPayAIForwarder(forwarder_);
        victim = victim_;
    }

    receive() external payable {
        if (!_attacked) {
            _attacked = true;
            // Re-enter mid-forward. The guard must make this revert, which
            // (because the outer call requires the forward to succeed) reverts
            // the entire original payment.
            forwarder.forwardPaymentNative{value: msg.value}(victim, msg.value, bytes32(0));
        }
    }
}
