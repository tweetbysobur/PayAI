// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title AutomationVaultV2
 * @notice PayAI's "Reserved Funds" execution model — identical to
 *         AutomationVault (V1) in every respect EXCEPT that `release()` now
 *         collects a PayAI service fee, taken from the released `amount`,
 *         with the remainder delivered to the recipient. `reserve()` and
 *         `refund()` are UNCHANGED and fee-free: depositing your own money
 *         is not a transaction PayAI charges for, and neither is getting
 *         your own unspent money back.
 *
 *         V1 is NOT modified or redeployed and keeps working exactly as
 *         before for as long as it stays wired in the app — same pattern as
 *         every other V1 -> V2 pair in this suite.
 *
 *         `r.balance` and `totalReservedByToken` are still debited by the
 *         FULL `amount` on release, exactly as V1 — the fee is a split of
 *         where that amount's real custody goes, never a change to how much
 *         leaves the reservation ledger. Solvency (INVARIANT-AV-1) is
 *         therefore unaffected: total custody debited on release still
 *         equals the ledger reduction, split across two destinations
 *         instead of one.
 *
 * @custom:security-property (all V1 invariants AV-1 through AV-8, unchanged)
 *   Reserve balance solvency, directional fund lock (release -> recipient
 *   only, refund -> depositor only — the fee's destination, `treasury`, is
 *   Safe-controlled config, never a per-call parameter), idempotent release,
 *   immutable terms on top-up, reentrancy/CEI, role isolation, and actual-
 *   delivery verification all carry over verbatim. Actual-delivery
 *   verification (AV-7/AV-8) is now applied to BOTH the recipient's net
 *   share and the treasury's fee share independently.
 *
 * @custom:security-property INVARIANT-AV2-1: Fee Is Bounded, Safe-Only, and Release-Only
 *   `feeBps` can only be set by `owner` (the Safe), can never exceed
 *   `MAX_FEE_BPS` (1.00%), and is only ever applied inside `release()` —
 *   `reserve()` and `refund()` never reference it at all.
 *
 * @custom:security-property INVARIANT-AV2-2: Fee Never Exceeds the Ledger Debit
 *   `fee + net == amount` exactly (integer subtraction, no independent
 *   rounding), so the two real transfers issued by `release()` always sum to
 *   precisely the `amount` already debited from `r.balance` /
 *   `totalReservedByToken` — no over- or under-debit is possible.
 */
contract AutomationVaultV2 {
    /// @notice Cold wallet / multisig owner address with administrative power only.
    address public owner;

    /// @notice Set of authorized hot-wallet agent accounts allowed to trigger releases.
    mapping(address => bool) public isAgent;

    /// @notice Global emergency stop toggle.
    bool public paused;

    /// @notice Hard ceiling on `feeBps`, matching every other fee-collecting PayAI contract.
    uint16 public constant MAX_FEE_BPS = 100; // 1.00%

    /// @notice Where the release fee is sent. Safe-controlled.
    address public treasury;

    /// @notice Current release fee in basis points (25 = 0.25%). Never exceeds MAX_FEE_BPS.
    uint16 public feeBps;

    struct Reservation {
        address depositor;
        address token;
        address recipient;
        uint256 balance;
        bool exists;
    }

    mapping(bytes32 => Reservation) public reservations;
    mapping(address => uint256) public totalReservedByToken;
    mapping(bytes32 => bool) public usedRequestId;

    bool private _locked;

    /* ── Events ─────────────────────────────────────────────────────────── */
    event AgentSet(address indexed agent, bool allowed);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);
    event Reserved(bytes32 indexed automationId, address indexed depositor, address token, address recipient, uint256 amount, uint256 newBalance);
    /// @notice `amount` is the GROSS amount debited from the reservation;
    ///         the recipient's actual delivered share is `amount - feeAmount`
    ///         (see the FeeCollected event emitted alongside, for the same
    ///         `automationId` + `requestId`).
    event Released(bytes32 indexed automationId, address indexed recipient, address token, uint256 amount, uint256 remaining, bytes32 requestId);
    event Refunded(bytes32 indexed automationId, address indexed depositor, address token, uint256 amount);
    event TreasurySet(address treasury);
    event FeeBpsSet(uint16 feeBps);
    event FeeCollected(bytes32 indexed automationId, bytes32 indexed requestId, address token, uint256 feeAmount, address treasury);

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

    modifier nonReentrant() {
        require(!_locked, "reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    /// @param initialOwner Cold wallet / multisig admin.
    /// @param initialAgent Dedicated hot wallet execution agent.
    /// @param treasury_ Where the release fee is sent. Safe-controlled. Must be non-zero even if feeBps_ is 0.
    /// @param feeBps_ Initial release fee in basis points. Must be <= MAX_FEE_BPS.
    constructor(address initialOwner, address initialAgent, address treasury_, uint16 feeBps_) {
        require(initialOwner != address(0), "zero owner");
        require(initialAgent != address(0), "zero agent");
        require(initialOwner != initialAgent, "owner and agent must differ");
        require(treasury_ != address(0), "zero treasury");
        require(feeBps_ <= MAX_FEE_BPS, "fee too high");
        owner = initialOwner;
        isAgent[initialAgent] = true;
        treasury = treasury_;
        feeBps = feeBps_;
        emit OwnershipTransferred(address(0), initialOwner);
        emit AgentSet(initialAgent, true);
        emit TreasurySet(treasury_);
        emit FeeBpsSet(feeBps_);
    }

    /* ── Admin (owner only) ─────────────────────────────────────────────── */

    function setAgent(address agent, bool allowed) external onlyOwner {
        require(!allowed || agent != owner, "owner cannot be agent");
        require(agent != address(0), "zero agent");
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        require(!isAgent[to], "owner cannot be agent");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /// @notice Update the treasury address the release fee is sent to.
    function setTreasury(address t) external onlyOwner {
        require(t != address(0), "zero treasury");
        treasury = t;
        emit TreasurySet(t);
    }

    /// @notice Update the release fee, capped at MAX_FEE_BPS. Applies to releases made AFTER this call.
    function setFeeBps(uint16 b) external onlyOwner {
        require(b <= MAX_FEE_BPS, "fee too high");
        feeBps = b;
        emit FeeBpsSet(b);
    }

    /* ── Reserve (unchanged from V1 — fee-free) ────────────────────────────── */

    function reserve(bytes32 automationId, address token, address recipient, uint256 amount) external payable nonReentrant {
        require(automationId != bytes32(0), "bad automationId");
        require(recipient != address(0), "zero recipient");
        require(amount > 0, "zero amount");

        Reservation storage r = reservations[automationId];
        if (r.exists) {
            require(r.depositor == msg.sender, "not depositor");
            require(r.token == token, "token mismatch");
            require(r.recipient == recipient, "recipient mismatch");
        } else {
            r.exists = true;
            r.depositor = msg.sender;
            r.token = token;
            r.recipient = recipient;
        }

        if (token == address(0)) {
            require(msg.value == amount, "bad msg.value");
        } else {
            require(msg.value == 0, "no native for erc20");
            uint256 balBefore = IERC20(token).balanceOf(address(this));
            bool ok = IERC20(token).transferFrom(msg.sender, address(this), amount);
            require(ok, "transferFrom failed");
            require(IERC20(token).balanceOf(address(this)) - balBefore == amount, "token did not deliver full amount");
        }

        r.balance += amount;
        totalReservedByToken[token] += amount;
        _assertSolvent(token);
        emit Reserved(automationId, msg.sender, token, recipient, amount, r.balance);
    }

    /* ── Release (agent-triggered, recipient-locked, idempotent, FEE HERE) ─ */

    /// @dev Floors down; a release can never over-collect by rounding.
    ///      `net + fee == amount` always holds exactly.
    function _split(uint256 amount) private view returns (uint256 fee, uint256 net) {
        fee = (amount * feeBps) / 10000;
        net = amount - fee;
    }

    /**
     * @notice Release reserved funds to the pre-committed recipient, taking
     *         the PayAI fee from `amount` first.
     * @dev Triggered by authorized agent. Idempotent per `requestId`. The
     *      full `amount` is still debited from `r.balance` /
     *      `totalReservedByToken`, exactly as V1 — only where the real
     *      custody goes is split.
     */
    function release(bytes32 automationId, uint256 amount, bytes32 requestId) external onlyAgent nonReentrant {
        require(requestId != bytes32(0), "requestId required");
        require(!usedRequestId[requestId], "duplicate requestId");
        Reservation storage r = reservations[automationId];
        require(r.exists, "no reservation");
        require(amount > 0 && amount <= r.balance, "amount exceeds reserved");

        usedRequestId[requestId] = true;
        r.balance -= amount;
        totalReservedByToken[r.token] -= amount;
        address recipient = r.recipient;
        address token = r.token;

        (uint256 fee, uint256 net) = _split(amount);

        if (token == address(0)) {
            if (fee > 0) {
                (bool feeSent, ) = treasury.call{value: fee}("");
                require(feeSent, "fee send failed");
            }
            (bool sent, ) = recipient.call{value: net}("");
            require(sent, "native send failed");
        } else {
            uint256 vaultBalBefore = IERC20(token).balanceOf(address(this));
            uint256 recipientBalBefore = IERC20(token).balanceOf(recipient);
            bool ok = IERC20(token).transfer(recipient, net);
            require(ok, "transfer failed");
            require(IERC20(token).balanceOf(recipient) - recipientBalBefore == net, "token did not deliver full amount");
            require(vaultBalBefore - IERC20(token).balanceOf(address(this)) == net, "token debited more than amount from vault");

            if (fee > 0) {
                uint256 vaultBalBefore2 = IERC20(token).balanceOf(address(this));
                uint256 treasuryBalBefore = IERC20(token).balanceOf(treasury);
                bool feeOk = IERC20(token).transfer(treasury, fee);
                require(feeOk, "fee transfer failed");
                require(IERC20(token).balanceOf(treasury) - treasuryBalBefore == fee, "fee token did not deliver full amount");
                require(vaultBalBefore2 - IERC20(token).balanceOf(address(this)) == fee, "fee token debited more than amount from vault");
            }
        }
        _assertSolvent(token);
        emit Released(automationId, recipient, token, amount, r.balance, requestId);
        emit FeeCollected(automationId, requestId, token, fee, treasury);
    }

    /* ── Refund (unchanged from V1 — fee-free) ──────────────────────────── */

    function refund(bytes32 automationId) external nonReentrant {
        Reservation storage r = reservations[automationId];
        require(r.exists, "no reservation");
        require(msg.sender == r.depositor || isAgent[msg.sender], "not authorized");
        uint256 amount = r.balance;
        require(amount > 0, "nothing to refund");

        r.balance = 0;
        totalReservedByToken[r.token] -= amount;
        address depositor = r.depositor;
        address token = r.token;

        if (token == address(0)) {
            (bool sent, ) = depositor.call{value: amount}("");
            require(sent, "native refund failed");
        } else {
            uint256 vaultBalBefore = IERC20(token).balanceOf(address(this));
            uint256 depositorBalBefore = IERC20(token).balanceOf(depositor);
            bool ok = IERC20(token).transfer(depositor, amount);
            require(ok, "refund failed");
            require(IERC20(token).balanceOf(depositor) - depositorBalBefore == amount, "token did not deliver full amount");
            require(vaultBalBefore - IERC20(token).balanceOf(address(this)) == amount, "token debited more than amount from vault");
        }
        _assertSolvent(token);
        emit Refunded(automationId, depositor, token, amount);
    }

    /* ── Internal ───────────────────────────────────────────────────────── */

    function _assertSolvent(address token) private view {
        uint256 custody = token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
        require(custody >= totalReservedByToken[token], "vault insolvent for token");
    }

    /* ── Views ──────────────────────────────────────────────────────────── */

    function reservedBalance(bytes32 automationId) external view returns (uint256) {
        return reservations[automationId].balance;
    }

    function isReleaseProcessed(bytes32 requestId) external view returns (bool) {
        return usedRequestId[requestId];
    }
}
