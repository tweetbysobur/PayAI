// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

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
 * @custom:security-property INVARIANT-VR-1: Agent-Only Audit Logging
 *   Only authorized agents (`isAgent[msg.sender] == true`) can call `recordPayment` or `payAndRecord`.
 *   Unauthorized callers MUST revert.
 *
 * @custom:security-property INVARIANT-VR-2: Risk Score Ceiling
 *   `riskScore` MUST be strictly <= 100. Any value > 100 MUST revert.
 *
 * @custom:security-property INVARIANT-VR-3: Pause Compliance
 *   When `paused == true`, write operations MUST revert.
 */
contract VeriPayRegistry {
    /* ── Roles ──────────────────────────────────────────────────────────── */
    /// @notice Admin owner address.
    address public owner;

    /// @notice Authorized agent wallets.
    mapping(address => bool) public isAgent;

    /// @notice Global pause status.
    bool public paused;

    /* ── Storage ────────────────────────────────────────────────────────── */
    struct Payment {
        address agent;       // PayAI agent wallet that submitted it
        address recipient;   // Payee address
        address token;       // Stablecoin contract (USDC/aUSDC)
        uint256 amount;      // Base units
        uint16 riskScore;    // 0–100, from PayAI risk engine
        uint64 timestamp;    // Block time
        bytes32 purposeHash; // keccak256 of payment purpose/memo
        bytes32 ref;         // Off-chain reference (intent ID / invoice)
    }

    Payment[] private _payments;
    /// Recipient wallet => array of indices into _payments
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
        isAgent[msg.sender] = true; // Deployer is the first agent
        emit OwnershipTransferred(address(0), msg.sender);
        emit AgentSet(msg.sender, true);
    }

    /* ── Admin ──────────────────────────────────────────────────────────── */

    /// @notice Grant or revoke agent authorization.
    function setAgent(address agent, bool allowed) external onlyOwner {
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    /// @notice Toggle global pause state.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Transfer administrative ownership.
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /* ── Writes ─────────────────────────────────────────────────────────── */

    /// @notice Anchor a payment that already settled elsewhere (audit log only).
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

    /// @notice Pay `recipient` `amount` of `token` from agent and record it atomically.
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
        // Verify the recipient's balance actually grew by `amount`, not just
        // that transferFrom returned true -- matches the actual-delivery
        // check PaymentExecutor and AutomationVault already enforce. Without
        // it, a fee-on-transfer/non-standard token could deliver less than
        // `amount` while this audit record still claims the nominal amount
        // settled. Added 2026-08 after Ultrafuzz's non-production outcome on
        // this same gap.
        uint256 balBefore = IERC20(token).balanceOf(recipient);
        bool ok = IERC20(token).transferFrom(msg.sender, recipient, amount);
        require(ok, "transfer failed");
        require(IERC20(token).balanceOf(recipient) - balBefore == amount, "token did not deliver full amount");
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

    /// @notice Total count of recorded payments.
    function paymentsCount() external view returns (uint256) {
        return _payments.length;
    }

    /// @notice Fetch recorded payment details by ID.
    function getPayment(uint256 id) external view returns (Payment memory) {
        require(id < _payments.length, "bad id");
        return _payments[id];
    }

    /// @notice Get array of payment IDs for a recipient.
    function paymentsOf(address recipient) external view returns (uint256[] memory) {
        return _byRecipient[recipient];
    }
}
