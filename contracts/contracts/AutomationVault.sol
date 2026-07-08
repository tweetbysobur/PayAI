// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
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
 *         Roles mirror PaymentExecutor for operational safety:
 *           - owner:  cold wallet / multisig. Adds/removes agents, pauses.
 *                     NEVER releases funds.
 *           - agent:  dedicated hot wallet. Can ONLY call release() (and
 *                     refund() on cancel) — no admin power, and release is
 *                     bounded + recipient-locked per the user's reservation.
 *
 *         Every release carries a `requestId` (idempotency key) usable once,
 *         so a retried/duplicated cron invocation can never pay twice.
 *
 *         Works for both native MON (token == address(0)) and ERC-20 (USDC).
 */
contract AutomationVault {
    address public owner;
    mapping(address => bool) public isAgent;
    bool public paused;

    struct Reservation {
        address depositor; // who funded it — the ONLY refund target
        address token;     // address(0) = native MON, else ERC-20
        address recipient; // the ONLY address release can pay
        uint256 balance;   // remaining reserved amount
        bool exists;
    }

    /// automationId (app's schedule id, hashed to bytes32) => reservation.
    mapping(bytes32 => Reservation) public reservations;
    /// release idempotency — a given requestId can settle at most once.
    mapping(bytes32 => bool) public usedRequestId;

    bool private _locked; // reentrancy mutex

    event AgentSet(address indexed agent, bool allowed);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);
    event Reserved(bytes32 indexed automationId, address indexed depositor, address token, address recipient, uint256 amount, uint256 newBalance);
    event Released(bytes32 indexed automationId, address indexed recipient, address token, uint256 amount, uint256 remaining, bytes32 requestId);
    event Refunded(bytes32 indexed automationId, address indexed depositor, address token, uint256 amount);

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

    /// @param initialOwner Cold wallet / multisig — admin only, never a signer for releases.
    /// @param initialAgent Dedicated hot wallet — release/refund only, no admin power.
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

    /* ── Reserve ────────────────────────────────────────────────────────── */
    /**
     * Reserve funds for `automationId`, payable to `recipient` only. Callable
     * by the user (the depositor). Top-ups are allowed but must match the
     * original depositor, token, and recipient so a reservation's terms can
     * never be mutated by a second deposit.
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
            bool ok = IERC20(token).transferFrom(msg.sender, address(this), amount);
            require(ok, "transferFrom failed");
        }

        r.balance += amount;
        emit Reserved(automationId, msg.sender, token, recipient, amount, r.balance);
    }

    /* ── Release (agent-triggered, recipient-locked, idempotent) ─────────── */
    function release(bytes32 automationId, uint256 amount, bytes32 requestId) external onlyAgent nonReentrant {
        require(requestId != bytes32(0), "requestId required");
        require(!usedRequestId[requestId], "duplicate requestId");
        Reservation storage r = reservations[automationId];
        require(r.exists, "no reservation");
        require(amount > 0 && amount <= r.balance, "amount exceeds reserved");

        // checks-effects-interactions: claim id + debit before sending.
        usedRequestId[requestId] = true;
        r.balance -= amount;
        address recipient = r.recipient;
        address token = r.token;

        if (token == address(0)) {
            (bool sent, ) = recipient.call{value: amount}("");
            require(sent, "native send failed");
        } else {
            bool ok = IERC20(token).transfer(recipient, amount);
            require(ok, "transfer failed");
        }
        emit Released(automationId, recipient, token, amount, r.balance, requestId);
    }

    /* ── Refund (to original depositor, on cancel) ──────────────────────── */
    /**
     * Return the remaining reserved balance to the ORIGINAL depositor. Callable
     * by the depositor themselves, or by an agent (when an automation is
     * cancelled server-side). Funds always go to the depositor regardless of
     * caller. Balance is zeroed before transfer (checks-effects-interactions +
     * nonReentrant + amount>0 guard) so it can never double-refund.
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
            bool ok = IERC20(token).transfer(depositor, amount);
            require(ok, "refund failed");
        }
        emit Refunded(automationId, depositor, token, amount);
    }

    /* ── Views ──────────────────────────────────────────────────────────── */
    function reservedBalance(bytes32 automationId) external view returns (uint256) {
        return reservations[automationId].balance;
    }

    function isReleaseProcessed(bytes32 requestId) external view returns (bool) {
        return usedRequestId[requestId];
    }
}
