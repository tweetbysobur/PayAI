// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * Test-only fixture reproducing the Ultrafuzz M-02 finding: a non-standard
 * ERC-20 that returns `true` from transfer/transferFrom while crediting the
 * recipient only 90% of the requested amount (a fee-on-transfer /
 * deflationary token shape). Used to prove that PaymentExecutor and
 * AutomationVault now verify actual balance delta rather than trusting the
 * boolean return value or the nominal `amount` parameter.
 */
contract ShortTransferERC20 {
    string public name = "Short Transfer Token";
    string public symbol = "SHORT";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @dev Only 90% of `amount` is actually delivered; the sender's balance
    /// is still debited the full nominal `amount` (the "fee" is burned).
    function _creditedAmount(uint256 amount) private pure returns (uint256) {
        return (amount * 9) / 10;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += _creditedAmount(amount);
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += _creditedAmount(amount);
        emit Transfer(from, to, amount);
        return true;
    }
}
