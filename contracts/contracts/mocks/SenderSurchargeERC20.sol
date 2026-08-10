// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * Verification-only fixture for the Ultrafuzz M-01 finding (private-02-r5-
 * 20260806-2148): a token that charges its fee on the SENDER's own balance
 * rather than shorting the recipient. `transfer`/`transferFrom` debit
 * `amount + fee` from `from` while crediting `to` with exactly `amount` --
 * so AutomationVault's actual-delivery check (which verifies the RECIPIENT
 * received `amount`) passes, even though the vault's own holdings just fell
 * by more than the reservation ledger accounts for.
 */
contract SenderSurchargeERC20 {
    string public name = "Sender Surcharge Token";
    string public symbol = "SURCHARGE";
    uint8 public decimals = 6;
    uint256 internal constant FEE_BPS = 1_000;
    uint256 internal constant BPS = 10_000;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function feeFor(uint256 amount) public pure returns (uint256) {
        return (amount * FEE_BPS) / BPS;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transferWithSurcharge(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "allowance");
        allowance[from][msg.sender] = approved - amount;
        _transferWithSurcharge(from, to, amount);
        return true;
    }

    function _transferWithSurcharge(address from, address to, uint256 amount) private {
        uint256 debit = amount + feeFor(amount);
        require(balanceOf[from] >= debit, "balance");
        balanceOf[from] -= debit;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
