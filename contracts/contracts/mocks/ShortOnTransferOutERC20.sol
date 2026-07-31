// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * Test-only fixture for the release()/refund()-side half of the M-02 finding:
 * a token that delivers the FULL amount via `transferFrom` (so it passes
 * AutomationVault.reserve()'s delivery check and a real reservation gets
 * booked) but only delivers 90% via `transfer` (the call release()/refund()
 * actually make when paying OUT of the vault). This is a realistic shape —
 * some fee/tax tokens apply their fee asymmetrically by call path or by
 * recipient — and it is the only way to reach release()/refund() with an
 * under-delivering token now that reserve() rejects short-delivery at the door.
 */
contract ShortOnTransferOutERC20 {
    string public name = "Short On Transfer Out Token";
    string public symbol = "SHORTOUT";
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

    /// @dev Full delivery — this is the call reserve() makes on the way IN.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    /// @dev Only 90% delivered — this is the call release()/refund() make on the way OUT.
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += (amount * 9) / 10;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
