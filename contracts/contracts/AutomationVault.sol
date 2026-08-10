// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title AutomationVault
 * @notice PayAI's "Reserved Funds" execution model. A user reserves funds for
 *         a specific automation up front; those funds are held here, isolated
 *         per automation, and can only ever be (a) released to the recipient
 *         the user committed to, or (b) refunded to the original depositor.
 *
 *         This guarantees a scheduled payment can't fail for insufficient
 *         balance — the money is already committed. Custody is explicit,
 *         user-initiated, isolated per automation, and directionally locked:
 *         the agent can TRIGGER a release but can never choose a different
 *         recipient, exceed the reserved balance, or divert funds to itself.
 *
 * @custom:security-property INVARIANT-AV-1: Reserve Balance Solvency
 *   For any token T, contract balance(T) >= sum(r.balance for all reservations of T).
 *   The vault can never be insolvent for active reservations.
 *
 * @custom:security-property INVARIANT-AV-2: Directional Fund Lock
 *   `release()` MUST send funds to `r.recipient` ONLY.
 *   `refund()` MUST send funds to `r.depositor` ONLY.
 *   No parameter or role can override the committed recipient or depositor target.
 *
 * @custom:security-property INVARIANT-AV-3: Idempotent Execution
 *   Every release carries a unique `requestId`. `usedRequestId[requestId]` prevents
 *   duplicate settlements. Replaying a `requestId` MUST revert.
 *
 * @custom:security-property INVARIANT-AV-4: Immutable Terms on Top-up
 *   When topping up an existing reservation, `depositor`, `token`, and `recipient`
 *   MUST match the original parameters exactly, preventing parameter hijacking.
 *
 * @custom:security-property INVARIANT-AV-5: Reentrancy & Checks-Effects-Interactions
 *   Reservation balances are decremented/zeroed BEFORE external transfers, secured by
 *   a `nonReentrant` mutex.
 *
 * @custom:security-property INVARIANT-AV-6: Strict Role Isolation
 *   `owner != agent` is enforced at deploy and setAgent/transferOwnership.
 *   Owner NEVER signs or releases funds. Agent NEVER has admin privileges.
 *
 * @custom:security-property INVARIANT-AV-7: Actual Delivery, Not Requested Amount
 *   `reserve()`, `release()`, and `refund()` MUST verify the relevant party's ERC-20
 *   balance changed by EXACTLY the stated amount (via before/after `balanceOf`), not
 *   merely that `transferFrom`/`transfer` returned true. A fee-on-transfer or otherwise
 *   non-standard token delivering less than the stated amount MUST revert the whole
 *   operation, never be booked as if the full amount moved.
 *
 * @custom:security-property INVARIANT-AV-8: Outbound Debit Matches Ledger, Not Just Delivery
 *   `release()` and `refund()` MUST ALSO verify the vault's OWN ERC-20 balance fell by
 *   EXACTLY `amount` when it calls `transfer()` as sender. INVARIANT-AV-7 alone only
 *   catches a token shorting the RECIPIENT; it does not catch a token that charges a
 *   surcharge on the SENDER (the vault) while still delivering the recipient's side in
 *   full. Without this check, a sender-surcharge token would debit the vault for more
 *   than `amount`, silently eating into the pooled custody backing OTHER depositors'
 *   active reservations and breaking INVARIANT-AV-1 for them. Added 2026-08 after
 *   Ultrafuzz M-01.
 */
contract AutomationVault {
    /// @notice Cold wallet / multisig owner address with administrative power only.
    address public owner;

    /// @notice Set of authorized hot-wallet agent accounts allowed to trigger releases.
    mapping(address => bool) public isAgent;

    /// @notice Global emergency stop toggle.
    bool public paused;

    /// @notice Reservation state structure holding isolated deposit commitments.
    struct Reservation {
        address depositor; // Who funded it — the ONLY refund target
        address token;     // address(0) = native MON, else ERC-20 token contract
        address recipient; // The ONLY address release can pay
        uint256 balance;   // Remaining reserved balance in base units
        bool exists;       // Existence flag for initial reservation check
    }

    /// @notice automationId (schedule hash) => Reservation details
    mapping(bytes32 => Reservation) public reservations;

    /// @notice Release idempotency key registry — prevents double-settlement
    mapping(bytes32 => bool) public usedRequestId;

    /// @dev Reentrancy mutex state variable
    bool private _locked;

    /* ── Events ─────────────────────────────────────────────────────────── */
    event AgentSet(address indexed agent, bool allowed);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);
    event Reserved(bytes32 indexed automationId, address indexed depositor, address token, address recipient, uint256 amount, uint256 newBalance);
    event Released(bytes32 indexed automationId, address indexed recipient, address token, uint256 amount, uint256 remaining, bytes32 requestId);
    event Refunded(bytes32 indexed automationId, address indexed depositor, address token, uint256 amount);

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

    /// @notice Contract constructor setting initial admin owner and hot wallet agent.
    /// @param initialOwner Cold wallet / multisig admin.
    /// @param initialAgent Dedicated hot wallet execution agent.
    constructor(address initialOwner, address initialAgent) {
        require(initialOwner != address(0), "zero owner");
        require(initialAgent != address(0), "zero agent");
        require(initialOwner != initialAgent, "owner and agent must differ");
        owner = initialOwner;
        isAgent[initialAgent] = true;
        emit OwnershipTransferred(address(0), initialOwner);
        emit AgentSet(initialAgent, true);
    }

    /* ── Admin (owner only) ─────────────────────────────────────────────── */

    /// @notice Grant or revoke agent execution status.
    /// @dev Owner can never be made an agent to preserve strict role isolation.
    /// @param agent Target agent address.
    /// @param allowed True to grant, false to revoke.
    function setAgent(address agent, bool allowed) external onlyOwner {
        require(!allowed || agent != owner, "owner cannot be agent");
        require(agent != address(0), "zero agent");
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    /// @notice Toggle global pause state.
    /// @param p True to pause agent releases, false to unpause.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Transfer administrative ownership to a new account.
    /// @param to New owner address.
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        require(!isAgent[to], "owner cannot be agent");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /* ── Reserve ────────────────────────────────────────────────────────── */

    /**
     * @notice Reserve funds for `automationId`, payable to `recipient` only.
     * @dev Callable by any user (the depositor). Subsequent top-ups must match
     *      the original depositor, token, and recipient terms exactly.
     * @param automationId Unique schedule identifier hash.
     * @param token Address of ERC-20 token or address(0) for native MON.
     * @param recipient Payee address locked to receive releases.
     * @param amount Amount to deposit.
     */
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
            // Verify the vault's balance actually grew by `amount`, not just
            // that transferFrom returned true (see INVARIANT-AV-7). Without
            // this, a fee-on-transfer token could deliver less than `amount`
            // while r.balance is still credited with the full requested
            // figure -- INVARIANT-AV-1 (solvency) would then be violated
            // silently, and a later release()/refund() for the full booked
            // balance would revert against real custody the vault never had.
            uint256 balBefore = IERC20(token).balanceOf(address(this));
            bool ok = IERC20(token).transferFrom(msg.sender, address(this), amount);
            require(ok, "transferFrom failed");
            require(IERC20(token).balanceOf(address(this)) - balBefore == amount, "token did not deliver full amount");
        }

        r.balance += amount;
        emit Reserved(automationId, msg.sender, token, recipient, amount, r.balance);
    }

    /* ── Release (agent-triggered, recipient-locked, idempotent) ─────────── */

    /**
     * @notice Release reserved funds to the pre-committed recipient.
     * @dev Triggered by authorized agent. Idempotent per `requestId`.
     * @param automationId Schedule identifier hash.
     * @param amount Amount to release (must be <= reserved balance).
     * @param requestId Unique idempotency key.
     */
    function release(bytes32 automationId, uint256 amount, bytes32 requestId) external onlyAgent nonReentrant {
        require(requestId != bytes32(0), "requestId required");
        require(!usedRequestId[requestId], "duplicate requestId");
        Reservation storage r = reservations[automationId];
        require(r.exists, "no reservation");
        require(amount > 0 && amount <= r.balance, "amount exceeds reserved");

        // Checks-Effects-Interactions: record request ID and debit balance first
        usedRequestId[requestId] = true;
        r.balance -= amount;
        address recipient = r.recipient;
        address token = r.token;

        if (token == address(0)) {
            (bool sent, ) = recipient.call{value: amount}("");
            require(sent, "native send failed");
        } else {
            // Same actual-delivery check as reserve() -- see INVARIANT-AV-7 --
            // plus the vault-side debit check from INVARIANT-AV-8. If the
            // recipient's token shorts the transfer OR surcharges the vault's
            // own balance, this reverts the WHOLE release: state is unwound
            // (r.balance/usedRequestId), funds stay safely in the vault, and
            // neither the automation's records nor other depositors' pooled
            // custody are corrupted.
            uint256 vaultBalBefore = IERC20(token).balanceOf(address(this));
            uint256 recipientBalBefore = IERC20(token).balanceOf(recipient);
            bool ok = IERC20(token).transfer(recipient, amount);
            require(ok, "transfer failed");
            require(IERC20(token).balanceOf(recipient) - recipientBalBefore == amount, "token did not deliver full amount");
            require(vaultBalBefore - IERC20(token).balanceOf(address(this)) == amount, "token debited more than amount from vault");
        }
        emit Released(automationId, recipient, token, amount, r.balance, requestId);
    }

    /* ── Refund (to original depositor, on cancel) ──────────────────────── */

    /**
     * @notice Return remaining reserved funds to the ORIGINAL depositor.
     * @dev Callable by original depositor or authorized agent (on server-side cancel).
     *      Funds ALWAYS go to `r.depositor` regardless of who calls.
     * @param automationId Schedule identifier hash.
     */
    function refund(bytes32 automationId) external nonReentrant {
        Reservation storage r = reservations[automationId];
        require(r.exists, "no reservation");
        require(msg.sender == r.depositor || isAgent[msg.sender], "not authorized");
        uint256 amount = r.balance;
        require(amount > 0, "nothing to refund");

        r.balance = 0;
        address depositor = r.depositor;
        address token = r.token;

        if (token == address(0)) {
            (bool sent, ) = depositor.call{value: amount}("");
            require(sent, "native refund failed");
        } else {
            // Same actual-delivery + vault-debit checks as release() -- see
            // INVARIANT-AV-7 and INVARIANT-AV-8.
            uint256 vaultBalBefore = IERC20(token).balanceOf(address(this));
            uint256 depositorBalBefore = IERC20(token).balanceOf(depositor);
            bool ok = IERC20(token).transfer(depositor, amount);
            require(ok, "refund failed");
            require(IERC20(token).balanceOf(depositor) - depositorBalBefore == amount, "token did not deliver full amount");
            require(vaultBalBefore - IERC20(token).balanceOf(address(this)) == amount, "token debited more than amount from vault");
        }
        emit Refunded(automationId, depositor, token, amount);
    }

    /* ── Views ──────────────────────────────────────────────────────────── */

    /// @notice Returns the remaining reserved balance for an automation schedule.
    function reservedBalance(bytes32 automationId) external view returns (uint256) {
        return reservations[automationId].balance;
    }

    /// @notice Returns whether a release requestId idempotency key has been used.
    function isReleaseProcessed(bytes32 requestId) external view returns (bool) {
        return usedRequestId[requestId];
    }
}
