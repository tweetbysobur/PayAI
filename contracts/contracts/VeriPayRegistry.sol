// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title VeriPayRegistry
 * @notice On-chain audit trail for PayAI. Every payment that clears the
 *         off-chain pipeline (intent parsing → validation → risk scoring) is
 *         anchored here, binding the validation decision and risk score to an
 *         immutable on-chain record.
 *
 *         Two ways to record:
 *           - recordPayment(): anchor an already-settled transfer (audit only).
 *           - payAndRecord():  pull USDC from the agent and pay the recipient in
 *                              the same transaction it's recorded (atomic).
 *
 *         Only authorized agents may write. The deployer is the owner and can
 *         add/remove agents and pause writes.
 */
interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract VeriPayRegistry {
    /* ── Roles ──────────────────────────────────────────────────────────── */
    address public owner;
    mapping(address => bool) public isAgent;
    bool public paused;

    /* ── Storage ────────────────────────────────────────────────────────── */
    struct Payment {
        address agent;       // the PayAI agent wallet that submitted it
        address recipient;   // payee
        address token;       // stablecoin contract (USDC/aUSDC)
        uint256 amount;      // base units
        uint16 riskScore;    // 0–100, from PayAI risk engine
        uint64 timestamp;    // block time
        bytes32 purposeHash; // keccak256 of the payment purpose / memo
        bytes32 ref;         // off-chain reference (intent id / invoice)
    }

    Payment[] private _payments;
    /// recipient => indices into _payments
    mapping(address => uint256[]) private _byRecipient;

    /* ── Events ─────────────────────────────────────────────────────────── */
    event PaymentRecorded(
        uint256 indexed id,
        address indexed agent,
        address indexed recipient,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 purposeHash,
        bytes32 ref
    );
    event AgentSet(address indexed agent, bool allowed);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);

    /* ── Modifiers ──────────────────────────────────────────────────────── */
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }
    modifier onlyAgent() {
        require(isAgent[msg.sender], "not agent");
        require(!paused, "paused");
        _;
    }

    constructor() {
        owner = msg.sender;
        isAgent[msg.sender] = true; // deployer is the first agent
        emit OwnershipTransferred(address(0), msg.sender);
        emit AgentSet(msg.sender, true);
    }

    /* ── Admin ──────────────────────────────────────────────────────────── */
    function setAgent(address agent, bool allowed) external onlyOwner {
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /* ── Writes ─────────────────────────────────────────────────────────── */

    /// @notice Anchor a payment that already settled elsewhere (audit only).
    function recordPayment(
        address recipient,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 purposeHash,
        bytes32 ref
    ) external onlyAgent returns (uint256 id) {
        return _record(recipient, token, amount, riskScore, purposeHash, ref);
    }

    /// @notice Pay `recipient` `amount` of `token` from the agent and record it
    ///         atomically. Agent must have approved this contract for `amount`.
    function payAndRecord(
        address recipient,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 purposeHash,
        bytes32 ref
    ) external onlyAgent returns (uint256 id) {
        require(recipient != address(0), "zero recipient");
        require(amount > 0, "zero amount");
        bool ok = IERC20(token).transferFrom(msg.sender, recipient, amount);
        require(ok, "transfer failed");
        return _record(recipient, token, amount, riskScore, purposeHash, ref);
    }

    function _record(
        address recipient,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 purposeHash,
        bytes32 ref
    ) internal returns (uint256 id) {
        require(riskScore <= 100, "risk>100");
        id = _payments.length;
        _payments.push(
            Payment({
                agent: msg.sender,
                recipient: recipient,
                token: token,
                amount: amount,
                riskScore: riskScore,
                timestamp: uint64(block.timestamp),
                purposeHash: purposeHash,
                ref: ref
            })
        );
        _byRecipient[recipient].push(id);
        emit PaymentRecorded(id, msg.sender, recipient, token, amount, riskScore, purposeHash, ref);
    }

    /* ── Views ──────────────────────────────────────────────────────────── */
    function paymentsCount() external view returns (uint256) {
        return _payments.length;
    }

    function getPayment(uint256 id) external view returns (Payment memory) {
        require(id < _payments.length, "bad id");
        return _payments[id];
    }

    function paymentsOf(address recipient) external view returns (uint256[] memory) {
        return _byRecipient[recipient];
    }
}
