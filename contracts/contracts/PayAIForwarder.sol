// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title PayAIForwarder
 * @notice PayAI's on-chain footprint for INTERACTIVE, user-signed payments.
 *
 *         Interactive native-MON and ERC-20 payments used to execute as a
 *         raw `User -> recipient` transfer (native) or a raw
 *         `User -> token.transfer(recipient)` call (ERC-20), so the chain
 *         showed no PayAI interaction at all. This contract restores that
 *         footprint WITHOUT changing the trust model: the user is still the
 *         payer, still signs from their own wallet, and PayAI never custodies
 *         funds. The forwarder simply sits in the middle of the one payment it
 *         is explicitly asked to make, emits a canonical `PaymentForwarded`
 *         event, and forwards the funds through to the recipient in the SAME
 *         transaction.
 *
 *         This is deliberately SEPARATE from PaymentExecutor and does not
 *         touch it. PaymentExecutor's every fund-moving entry point is
 *         `onlyAgent` (a user's own wallet can never call it); this contract
 *         is the opposite by design — callable by anyone, because the payment
 *         is always funded by `msg.sender` and can only ever move `msg.sender`'s
 *         own funds. There is no agent role here at all.
 *
 * ── What this contract is NOT ────────────────────────────────────────────────
 *   - NOT custodial: it holds no balance between calls and books no internal
 *     ledger. Native MON is forwarded out in full in the same call it arrives;
 *     ERC-20 `transferFrom` moves tokens straight from the user to the
 *     recipient and never to this contract.
 *   - NOT a generic executor: there is no `execute(target, data)`, no
 *     `bytes calldata` parameter, no user-supplied call target, and no
 *     user-supplied spender anywhere. The only two operations are the two
 *     typed payment functions below.
 *   - NOT upgradeable: no proxy, no delegatecall, immutable behavior. A bug
 *     found post-deploy is handled by pause + redeploy, exactly like every
 *     other contract in this suite.
 *
 * @custom:security-property INVARIANT-FW-1: Payer Is Always msg.sender
 *   Neither payment function accepts a `from`/`payer` parameter. Native MON is
 *   funded by `msg.value`; ERC-20 is pulled via `transferFrom(msg.sender, ...)`.
 *   No caller can ever cause another wallet's funds to move.
 *
 * @custom:security-property INVARIANT-FW-2: No Retained Funds
 *   After any successful call, this contract's native balance and its balance
 *   of the paid token are unchanged from before the call (both remain whatever
 *   they were — in normal operation, zero). Native MON is forwarded in full;
 *   ERC-20 moves user -> recipient directly and never transits this contract.
 *
 * @custom:security-property INVARIANT-FW-3: Actual Delivery, Not Requested Amount
 *   `forwardPayment` verifies the RECIPIENT's ERC-20 balance rose by EXACTLY
 *   `amount` (before/after `balanceOf`), mirroring PaymentExecutor's
 *   INVARIANT-PE-8. A fee-on-transfer or otherwise short-delivering token MUST
 *   revert the whole payment rather than be recorded as a full settlement.
 *
 * @custom:security-property INVARIANT-FW-4: Atomic, No Partial Payment
 *   Any failure (bad recipient, mismatched value, failed forward, short
 *   delivery, reentrancy) reverts the entire transaction. There is no code path
 *   that half-completes a payment or leaves funds stranded here.
 *
 * @custom:security-property INVARIANT-FW-5: Reentrancy & Checks-Effects-Interactions
 *   Both payment functions are `nonReentrant`. The execution-id counter (the
 *   only mutable state a payment touches) is incremented BEFORE any external
 *   transfer, so a reentrant call can neither observe a stale id nor re-enter
 *   the guarded body.
 *
 * @custom:security-property INVARIANT-FW-6: Owner Cannot Move Funds
 *   `owner` is an admin role limited to pause/unpause and ownership transfer.
 *   There is no owner-callable function that moves, sweeps, or redirects any
 *   user's funds. The owner cannot set a payer, a recipient, or a spender.
 *   Intended to be a cold wallet / multisig, matching this suite's convention.
 *
 * @custom:security-property INVARIANT-FW-7: Execution ID Is Not Replay Protection
 *   `paymentCount` is a monotonic correlation/label counter emitted per
 *   payment. It is NOT a replay gate: the user's own transaction nonce already
 *   prevents replay of a signed transaction, and `ref` is an opaque correlation
 *   identifier only. Nothing here keys execution on `ref` or on the id.
 */
contract PayAIForwarder {
    /// @notice Cold wallet / multisig admin. Holds ONLY pause + ownership-transfer
    ///         power — can never move, sweep, or redirect any user's funds.
    address public owner;

    /// @notice Emergency stop. When true, both payment functions revert. Does not
    ///         affect any funds (there are none held); only blocks new payments.
    bool public paused;

    /// @notice Monotonic execution-id counter — the id emitted with each payment.
    ///         Correlation/label only; NOT replay protection (see INVARIANT-FW-7).
    uint256 public paymentCount;

    /// @dev Reentrancy lock mutex state.
    bool private _locked;

    /* ── Events ─────────────────────────────────────────────────────────── */

    /// @notice Canonical PayAI interactive-payment event. `token == address(0)`
    ///         for native MON. `amount` is the ACTUAL amount forwarded/delivered,
    ///         not merely a requested figure. The emitting contract address is
    ///         itself the PayAI attribution — no branding-only fields.
    event PaymentForwarded(
        uint256 indexed id,
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 amount,
        bytes32 ref
    );
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);

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

    /// @param initialOwner Cold wallet / multisig admin address (pause + ownership only).
    constructor(address initialOwner) {
        require(initialOwner != address(0), "zero owner");
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    /* ── Admin (owner only — never touches funds) ──────────────────────────── */

    /// @notice Toggle the emergency pause. Blocks new payments; moves no funds.
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

    /* ── Interactive payments (callable by anyone; funded by msg.sender) ───── */

    /**
     * @notice Forward a native-MON payment through PayAI to `recipient`.
     *         `User -> PayAIForwarder -> recipient`, atomically, in one tx.
     * @dev The payer is ALWAYS `msg.sender` — there is no `from` parameter.
     *      The full `msg.value` is forwarded; this contract retains nothing.
     * @param recipient The payee. Must be non-zero.
     * @param amount    Must equal `msg.value` (a guard against a UI/calldata
     *                  mismatch between the intended amount and the attached
     *                  value). Must be > 0.
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

        // Effect before interaction: claim the id first (CEI + reentrancy).
        id = paymentCount;
        paymentCount = id + 1;

        // Forward the FULL value to the recipient. If the recipient rejects it
        // (reverting receiver, out-of-gas), the whole tx reverts and the user
        // keeps their MON — no partial payment, no retained balance, no refund
        // path needed because nothing was ever held.
        (bool sent, ) = recipient.call{value: msg.value}("");
        require(sent, "native forward failed");

        emit PaymentForwarded(id, msg.sender, recipient, address(0), msg.value, ref);
    }

    /**
     * @notice Forward an ERC-20 payment through PayAI to `recipient`.
     *         Requires the payer to have approved this contract for `amount`
     *         of `token` first. Tokens move `user -> recipient` directly via
     *         `transferFrom`; they never transit this contract.
     * @dev The payer is ALWAYS `msg.sender` — there is no `from` parameter, and
     *      the spender in the underlying allowance is always THIS contract, not
     *      a user-supplied address. Delivery is verified by the recipient's
     *      actual balance delta (INVARIANT-FW-3), so a short-delivering
     *      (fee-on-transfer) token reverts rather than being recorded as full.
     *
     *      Non-standard tokens: a token whose `transferFrom` returns `false`
     *      is rejected (`require(ok)`); one that reverts propagates the revert.
     *      This mirrors PaymentExecutor's existing raw-`transferFrom` +
     *      balance-delta convention exactly, and deliberately does not add a
     *      low-level SafeERC20-style wrapper: a token that returns NO data at
     *      all (an old USDT-style non-compliant token) would revert here, same
     *      as it already does everywhere else in this suite. The interactive
     *      payment path this serves is MON/USDC today, both of which are
     *      return-value compliant; broadening to no-return-data tokens is a
     *      deliberate future decision, not a silent gap.
     * @param token     ERC-20 contract address. Must be non-zero.
     * @param recipient The payee. Must be non-zero.
     * @param amount    Amount to deliver, in the token's base units. Must be > 0.
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

        // Effect before interaction: claim the id first (CEI + reentrancy).
        id = paymentCount;
        paymentCount = id + 1;

        // Pull straight from the payer to the recipient — this contract is
        // never `to`, so it can never retain the token. Verify by the
        // recipient's real balance delta, not the boolean alone: a
        // fee-on-transfer token that returns true while delivering less MUST
        // revert (INVARIANT-FW-3), mirroring PaymentExecutor's INVARIANT-PE-8.
        uint256 balBefore = IERC20(token).balanceOf(recipient);
        bool ok = IERC20(token).transferFrom(msg.sender, recipient, amount);
        require(ok, "transfer failed");
        require(IERC20(token).balanceOf(recipient) - balBefore == amount, "token did not deliver full amount");

        emit PaymentForwarded(id, msg.sender, recipient, token, amount, ref);
    }
}
