// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title PayAIForwarderV2
 * @notice PayAI's on-chain footprint for INTERACTIVE, user-signed payments —
 *         identical to PayAIForwarder in every respect EXCEPT that it now
 *         collects a PayAI service fee, taken from the gross amount the
 *         payer sends, with the remainder delivered to the recipient.
 *
 *         V1 (`PayAIForwarder.sol`) is NOT modified or redeployed and keeps
 *         working exactly as before for as long as it stays wired in the
 *         app; this is a new, separate, opt-in contract, exactly the same
 *         pattern used for PayAITradeExecutor -> V2 (see LIVE_CONTRACTS.md).
 *
 *         The fee mechanism is the SAME one already live and audited on
 *         PayAITradeExecutorV2: a Safe-settable `feeBps` (capped at
 *         `MAX_FEE_BPS`) and `treasury` address, fee = floor(gross * feeBps
 *         / 10000), never rounds up, never exceeds the cap. `feeBps = 0` is
 *         valid and makes this contract behave exactly like V1.
 *
 * @custom:security-property INVARIANT-FW2-1: Payer Is Always msg.sender
 *   Unchanged from V1 — neither payment function accepts a `from`/`payer`
 *   parameter.
 *
 * @custom:security-property INVARIANT-FW2-2: No Retained Funds
 *   Unchanged from V1's guarantee, extended to the fee split: this contract's
 *   balance of the paid asset is unchanged before/after any call. For
 *   native MON, the two outbound sends (recipient + treasury) together
 *   account for the entire `msg.value`. For ERC-20, BOTH legs (recipient's
 *   share and the treasury's share) are pulled directly from the payer via
 *   two separate `transferFrom` calls — the token never transits this
 *   contract's own balance at all, an even stricter property than V1 needed
 *   to state (V1 also never held ERC-20, but only because there was a single
 *   leg; this preserves that with two).
 *
 * @custom:security-property INVARIANT-FW2-3: Actual Delivery, Not Requested Amount
 *   Both the recipient's net share AND the treasury's fee share are verified
 *   by an actual balance-delta check (mirrors V1's INVARIANT-FW-3 and
 *   PaymentExecutor's INVARIANT-PE-8). A fee-on-transfer or otherwise
 *   short-delivering token reverts the WHOLE payment, never a partial one.
 *
 * @custom:security-property INVARIANT-FW2-4: Fee Is Bounded and Safe-Only
 *   `feeBps` can only be set by `owner` (the Safe) and can never exceed
 *   `MAX_FEE_BPS` (1.00%), enforced both at construction and in `setFeeBps`.
 *   No payer or recipient can influence the fee for their own payment.
 *
 * @custom:security-property INVARIANT-FW2-5: Owner Cannot Move Funds Outside the Fee
 *   `owner` can only pause, transfer ownership, and adjust `feeBps`/`treasury`
 *   within the capped range — never sweep funds, never redirect a specific
 *   payment's recipient, never bypass the payer-signed call.
 *
 * @custom:security-property INVARIANT-FW2-6 (from V1, unchanged): Reentrancy & CEI
 *   Both payment functions are `nonReentrant`; the execution-id counter is
 *   incremented before any external transfer.
 *
 * @custom:security-property INVARIANT-FW2-7 (from V1, unchanged): Execution ID Is Not Replay Protection
 *   `paymentCount` is a correlation/label counter only.
 */
contract PayAIForwarderV2 {
    /// @notice Cold wallet / multisig admin. Pause, ownership, and fee config only.
    address public owner;

    /// @notice Emergency stop. When true, both payment functions revert.
    bool public paused;

    /// @notice Monotonic execution-id counter — correlation/label only, NOT replay protection.
    uint256 public paymentCount;

    /// @notice Hard ceiling on `feeBps`, matching PayAITradeExecutorV2's cap exactly.
    uint16 public constant MAX_FEE_BPS = 100; // 1.00%

    /// @notice Where the fee is sent. Safe-controlled.
    address public treasury;

    /// @notice Current fee in basis points (25 = 0.25%). Never exceeds MAX_FEE_BPS.
    uint16 public feeBps;

    /// @dev Reentrancy lock mutex state.
    bool private _locked;

    /* ── Events ─────────────────────────────────────────────────────────── */

    /// @notice Canonical PayAI interactive-payment event. `token == address(0)`
    ///         for native MON. `amount` is the GROSS amount the payer sent —
    ///         the recipient's actual delivered share is `amount - feeAmount`,
    ///         emitted separately by `FeeCollected` for the same `id`.
    event PaymentForwarded(
        uint256 indexed id,
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 amount,
        bytes32 ref
    );
    event FeeCollected(uint256 indexed id, address token, uint256 feeAmount, address treasury);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);
    event TreasurySet(address treasury);
    event FeeBpsSet(uint16 feeBps);

    /* ── Modifiers ──────────────────────────────────────────────────────── */
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    modifier nonReentrant() {
        require(!_locked, "reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    /// @param initialOwner Cold wallet / multisig admin address (pause + ownership + fee config).
    /// @param treasury_    Where the fee is sent. Safe-controlled. Must be non-zero even if feeBps_ is 0.
    /// @param feeBps_      Initial fee in basis points. Must be <= MAX_FEE_BPS.
    constructor(address initialOwner, address treasury_, uint16 feeBps_) {
        require(initialOwner != address(0), "zero owner");
        require(treasury_ != address(0), "zero treasury");
        require(feeBps_ <= MAX_FEE_BPS, "fee too high");
        owner = initialOwner;
        treasury = treasury_;
        feeBps = feeBps_;
        emit OwnershipTransferred(address(0), initialOwner);
        emit TreasurySet(treasury_);
        emit FeeBpsSet(feeBps_);
    }

    /* ── Admin (owner only — never touches a specific payment's routing) ──── */

    /// @notice Toggle the emergency pause. Blocks new payments; moves no funds.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Update the treasury address the fee is sent to.
    function setTreasury(address t) external onlyOwner {
        require(t != address(0), "zero treasury");
        treasury = t;
        emit TreasurySet(t);
    }

    /// @notice Update the fee, capped at MAX_FEE_BPS. Applies to payments made AFTER this call.
    function setFeeBps(uint16 b) external onlyOwner {
        require(b <= MAX_FEE_BPS, "fee too high");
        feeBps = b;
        emit FeeBpsSet(b);
    }

    /// @notice Transfer administrative ownership.
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /* ── Fee math ───────────────────────────────────────────────────────── */

    /// @dev Floors down; a payment can never be overcharged by rounding.
    ///      `net + fee == gross` always holds exactly (integer subtraction,
    ///      no separate rounding on the two halves).
    function _split(uint256 gross) private view returns (uint256 fee, uint256 net) {
        fee = (gross * feeBps) / 10000;
        net = gross - fee;
    }

    /* ── Interactive payments (callable by anyone; funded by msg.sender) ───── */

    /**
     * @notice Forward a native-MON payment through PayAI to `recipient`,
     *         taking the PayAI fee from the gross amount sent.
     *         `User -> [recipient gets net, treasury gets fee]`, atomically.
     * @param recipient The payee. Must be non-zero.
     * @param amount    Must equal `msg.value`. Must be > 0.
     * @param ref       Opaque PayAI correlation/intent reference. Never secret.
     * @return id The execution id emitted with the event.
     */
    function forwardPaymentNative(
        address recipient,
        uint256 amount,
        bytes32 ref
    ) external payable whenNotPaused nonReentrant returns (uint256 id) {
        require(recipient != address(0), "zero recipient");
        require(msg.value > 0, "zero amount");
        require(msg.value == amount, "value mismatch");

        id = paymentCount;
        paymentCount = id + 1;

        (uint256 fee, uint256 net) = _split(msg.value);

        if (fee > 0) {
            (bool feeSent, ) = treasury.call{value: fee}("");
            require(feeSent, "fee forward failed");
        }
        (bool sent, ) = recipient.call{value: net}("");
        require(sent, "native forward failed");

        emit PaymentForwarded(id, msg.sender, recipient, address(0), msg.value, ref);
        emit FeeCollected(id, address(0), fee, treasury);
    }

    /**
     * @notice Forward an ERC-20 payment through PayAI to `recipient`, taking
     *         the PayAI fee from the gross `amount`. Requires the payer to
     *         have approved this contract for `amount` of `token` first.
     *         Both the recipient's net share and the treasury's fee share
     *         are pulled DIRECTLY from the payer via two separate
     *         `transferFrom` calls against the same allowance — the token
     *         never transits this contract's own balance.
     * @param token     ERC-20 contract address. Must be non-zero.
     * @param recipient The payee. Must be non-zero.
     * @param amount    Gross amount to charge, in the token's base units. Must be > 0.
     * @param ref       Opaque PayAI correlation/intent reference. Never secret.
     * @return id The execution id emitted with the event.
     */
    function forwardPayment(
        address token,
        address recipient,
        uint256 amount,
        bytes32 ref
    ) external whenNotPaused nonReentrant returns (uint256 id) {
        require(token != address(0), "zero token");
        require(recipient != address(0), "zero recipient");
        require(amount > 0, "zero amount");

        id = paymentCount;
        paymentCount = id + 1;

        (uint256 fee, uint256 net) = _split(amount);

        uint256 recipientBalBefore = IERC20(token).balanceOf(recipient);
        bool ok = IERC20(token).transferFrom(msg.sender, recipient, net);
        require(ok, "transfer failed");
        require(IERC20(token).balanceOf(recipient) - recipientBalBefore == net, "token did not deliver full amount");

        if (fee > 0) {
            uint256 treasuryBalBefore = IERC20(token).balanceOf(treasury);
            bool feeOk = IERC20(token).transferFrom(msg.sender, treasury, fee);
            require(feeOk, "fee transfer failed");
            require(IERC20(token).balanceOf(treasury) - treasuryBalBefore == fee, "fee token did not deliver full amount");
        }

        emit PaymentForwarded(id, msg.sender, recipient, token, amount, ref);
        emit FeeCollected(id, token, fee, treasury);
    }
}
