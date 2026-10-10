// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * Test-only fixtures for PayAIRoomEscrow. Never deployed to a real network.
 */

interface IRoomEscrowForMocks {
    function contribute(uint256 roomId, uint256 amount) external payable;
    function refund(uint256 roomId) external;
    function claim(uint256 roomId) external;
    function claimTo(uint256 roomId, address to) external;
    function refundTo(uint256 roomId, address to) external;
    function withdrawFees(address treasury, address token) external;
    function cancel(uint256 roomId) external;
    function createRoom(uint8 kind, address token, address beneficiary, uint256 share, uint32 slots, uint256 target, uint256 minContribution, uint64 deadline, bytes32 termsHash) external returns (uint256);
}

/** A contributor / creator contract that can toggle whether it accepts native
 *  MON, and optionally re-enters the escrow from its receive hook. */
contract RoomEscrowActor {
    IRoomEscrowForMocks public immutable escrow;
    bool public acceptNative = true;
    uint8 public reenter; // 0 none, 1 refund, 2 claim
    uint256 public reenterRoom;
    bool public reentryBlocked;

    constructor(address escrow_) {
        escrow = IRoomEscrowForMocks(escrow_);
    }

    function setAcceptNative(bool a) external { acceptNative = a; }
    function setReenter(uint8 mode, uint256 roomId) external { reenter = mode; reenterRoom = roomId; }

    function create(uint8 kind, address token, address beneficiary, uint256 share, uint32 slots, uint256 target, uint256 minContribution, uint64 deadline) external returns (uint256) {
        return escrow.createRoom(kind, token, beneficiary, share, slots, target, minContribution, deadline, bytes32(0));
    }

    function contribute(uint256 roomId, uint256 amount) external payable {
        escrow.contribute{value: msg.value}(roomId, amount);
    }

    function refund(uint256 roomId) external { escrow.refund(roomId); }
    function claim(uint256 roomId) external { escrow.claim(roomId); }
    function claimTo(uint256 roomId, address to) external { escrow.claimTo(roomId, to); }
    function refundTo(uint256 roomId, address to) external { escrow.refundTo(roomId, to); }

    receive() external payable {
        require(acceptNative, "rejecting native");
        if (reenter == 1) {
            try escrow.refund(reenterRoom) { } catch { reentryBlocked = true; }
        } else if (reenter == 2) {
            try escrow.claim(reenterRoom) { } catch { reentryBlocked = true; }
        }
    }
}

/** A USDC-like token with an issuer-controlled pause and blocklist (both
 *  `from` and `to` are checked, like Circle's FiatToken). Test-only. */
contract PausableBlocklistERC20 {
    string public name = "Blocklist USD";
    string public symbol = "bUSD";
    uint8 public decimals = 6;
    bool public paused;
    mapping(address => bool) public blocked;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setPaused(bool p) external { paused = p; }
    function setBlocked(address a, bool b) external { blocked[a] = b; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }

    function _move(address from, address to, uint256 amount) private {
        require(!paused, "token paused");
        require(!blocked[from] && !blocked[to], "blocklisted");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }
}

/** An ERC-20 whose transferFrom/transfer call back into the escrow (an
 *  ERC-777-style hook), trying to re-enter. Records whether the re-entry was
 *  blocked. Test-only. */
contract ReentrantHookERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    IRoomEscrowForMocks public escrow;
    uint8 public mode; // 0 none, 1 contribute, 2 refund, 3 claim, 4 createRoom, 5 claimTo, 6 refundTo, 7 withdrawFees, 8 cancel
    uint256 public roomId;
    bool public reentryBlocked;
    bool public reentrySucceeded;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function configure(address e, uint8 m, uint256 id) external { escrow = IRoomEscrowForMocks(e); mode = m; roomId = id; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }

    function _hook() private {
        if (mode == 0 || address(escrow) == address(0)) return;
        uint8 m = mode;
        mode = 0; // one attempt
        if (m == 1) { try escrow.contribute(roomId, 1) { reentrySucceeded = true; } catch { reentryBlocked = true; } }
        else if (m == 2) { try escrow.refund(roomId) { reentrySucceeded = true; } catch { reentryBlocked = true; } }
        else if (m == 3) { try escrow.claim(roomId) { reentrySucceeded = true; } catch { reentryBlocked = true; } }
        else if (m == 4) { try escrow.createRoom(1, address(0), address(this), 0, 0, 1, 0, uint64(block.timestamp + 2 hours), bytes32(0)) { reentrySucceeded = true; } catch { reentryBlocked = true; } }
        else if (m == 5) { try escrow.claimTo(roomId, address(this)) { reentrySucceeded = true; } catch { reentryBlocked = true; } }
        else if (m == 6) { try escrow.refundTo(roomId, address(this)) { reentrySucceeded = true; } catch { reentryBlocked = true; } }
        else if (m == 7) { try escrow.withdrawFees(address(this), address(this)) { reentrySucceeded = true; } catch { reentryBlocked = true; } }
        else if (m == 8) { try escrow.cancel(roomId) { reentrySucceeded = true; } catch { reentryBlocked = true; } }
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount;
        _hook();
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount && balanceOf[from] >= amount, "allowance/balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount; balanceOf[to] += amount;
        _hook();
        return true;
    }
}
