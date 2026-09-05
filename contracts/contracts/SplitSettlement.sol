// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title SplitSettlement
 * @notice PayAI's on-chain primitive for ONE thing: atomically splitting a
 *         user's OWN payment across several recipients in a single
 *         user-signed transaction.
 *
 *         It is the N-ary generalization of PayAIForwarder's user-signed,
 *         no-custody payment model — the user is always the payer
 *         (`msg.sender`), the contract never custodies funds between calls,
 *         there is no agent role, and there is no arbitrary-call surface.
 *         Native MON arrives as `msg.value` and is forwarded out in full in
 *         the same call; ERC-20 moves `payer -> each recipient` directly via
 *         `transferFrom` and never transits this contract.
 *
 * ── What this contract is NOT ────────────────────────────────────────────────
 *   - NOT a generic executor / router / proxy: there is no `execute`, no
 *     `multicall`, no `bytes calldata`, no user-supplied call target, and no
 *     user-supplied spender. The single state-changing operation is the one
 *     typed `splitPayment` below.
 *   - NOT custodial: it holds no balance between calls and books no internal
 *     ledger. It does not intentionally pull a total into itself and then
 *     redistribute — each recipient is paid directly.
 *   - NOT a fee engine: no fee, no treasury, no fee setter. v1 moves 100% of
 *     the user's declared amounts to the user's declared recipients.
 *   - NOT upgradeable: no proxy, no delegatecall, no implementation slot.
 *     Immutable behavior — a bug found post-deploy is handled by pause +
 *     redeploy at a new address, exactly like every other contract here.
 *
 * @custom:security-property INVARIANT-SS-1: Payer Is Always msg.sender
 *   `splitPayment` accepts no `from`/`payer` parameter. Native is funded by
 *   `msg.value`; ERC-20 is pulled via `transferFrom(msg.sender, ...)`. No
 *   caller can ever cause another wallet's funds to move.
 *
 * @custom:security-property INVARIANT-SS-2: No Retained Current-Call Funds
 *   For native MON the contract's balance after a successful split equals its
 *   balance BEFORE this call's own `msg.value` arrived (delta-based, see
 *   INVARIANT-SS-7). For ERC-20 the contract never becomes a token holder at
 *   all — tokens move payer -> recipient directly.
 *
 * @custom:security-property INVARIANT-SS-3: Actual Delivery, Not Requested Amount
 *   The ERC-20 path verifies each RECIPIENT's balance rose by EXACTLY its
 *   declared amount (before/after `balanceOf`), mirroring PayAIForwarder's
 *   INVARIANT-FW-3. A fee-on-transfer or otherwise short-delivering token MUST
 *   revert the whole split rather than be recorded as a full settlement.
 *
 * @custom:security-property INVARIANT-SS-4: Atomic, No Partial Split
 *   Any failure — bad length, bad recipient, bad amount, mismatched value, a
 *   failed transfer, a short delivery, or reentrancy — reverts the ENTIRE
 *   transaction. There is no code path that pays some recipients and not
 *   others, and no `try/catch` that swallows a per-recipient failure.
 *
 * @custom:security-property INVARIANT-SS-5: Reentrancy & Checks-Effects-Interactions
 *   `splitPayment` is `nonReentrant`, and the guard wraps the entire recipient
 *   loop. The `settlementCount` counter (the only mutable state a split
 *   touches) is incremented BEFORE any external transfer, so a reentrant call
 *   can neither observe a stale id nor re-enter the guarded body.
 *
 * @custom:security-property INVARIANT-SS-6: Owner Cannot Move Funds
 *   `owner` is an admin role limited to pause/unpause and ownership transfer.
 *   No owner-callable function moves, sweeps, redirects, or reconfigures any
 *   split, recipient, token, amount, or the recipient cap. Intended to be the
 *   PayAI Safe multisig, matching this suite's convention.
 *
 * @custom:security-property INVARIANT-SS-7: Tolerates a Pre-Existing Forced Balance
 *   MON can be force-sent to any address (e.g. selfdestruct) with no code
 *   running here. The native zero-retention check is therefore DELTA-based
 *   (`balance == balance-before-this-call`), never absolute (`balance == 0`).
 *   A pre-existing forced balance never bricks the contract, and there is
 *   deliberately NO sweep function to remove it (that would be owner fund
 *   movement, violating INVARIANT-SS-6).
 *
 * @custom:security-property INVARIANT-SS-8: settlementId Is Not Replay Protection
 *   `settlementCount` is a monotonic correlation/label counter emitted per
 *   split. It is NOT a replay gate, and there is NO `requestId` mapping. The
 *   user's own transaction nonce prevents replay of a signed transaction;
 *   `ref` is an opaque correlation field that never controls execution.
 *
 * @custom:security-property INVARIANT-SS-9: Bounded Worst-Case Gas
 *   `recipients.length` is capped at `MAX_RECIPIENTS` (an immutable compile
 *   constant, never owner-modifiable), checked before any external call, so
 *   the per-call cost is deterministically bounded.
 */
contract SplitSettlement {
    /// @notice Sentinel token value for native MON.
    address public constant NATIVE = address(0);

    /// @notice Hard cap on recipients per split. Immutable compile constant —
    ///         never owner-modifiable, never caller-adjustable.
    uint256 public constant MAX_RECIPIENTS = 10;

    /// @notice Safe multisig admin. Holds ONLY pause + ownership-transfer power
    ///         — can never move, sweep, or redirect any user's funds.
    address public owner;

    /// @notice Emergency stop. When true, `splitPayment` reverts. Affects no
    ///         funds (there are none held); only blocks new splits.
    bool public paused;

    /// @notice Monotonic settlement-id counter — the id emitted with each
    ///         split. Correlation/label only; NOT replay protection
    ///         (see INVARIANT-SS-8). First split settles as id 0.
    uint256 public settlementCount;

    /// @dev Reentrancy lock mutex state.
    bool private _locked;

    /* ── Events ─────────────────────────────────────────────────────────── */

    /// @notice The single canonical split event. `token == address(0)` for
    ///         native MON. `totalAmount` is contract-computed from `amounts`
    ///         (never a caller-supplied field). Emitted ONLY after every
    ///         transfer has succeeded, so its presence is proof of the full
    ///         settlement — no raw ERC-20 Transfer logs need be consulted.
    event SplitPaymentExecuted(
        uint256 indexed settlementId,
        address indexed payer,
        address indexed token,
        bytes32 ref,
        uint256 totalAmount,
        address[] recipients,
        uint256[] amounts
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

    /**
     * @param initialOwner Safe multisig admin (pause + ownership only). Set at
     *        deploy and intended to be the Safe from block zero — no deployer
     *        EOA handoff.
     */
    constructor(address initialOwner) {
        require(initialOwner != address(0), "zero owner");
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    /* ── Admin (owner/Safe only — never moves user funds) ───────────────── */

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /* ── The one operation ──────────────────────────────────────────────── */

    /**
     * @notice Atomically split the caller's own payment across `recipients`.
     *         Native when `token == address(0)` (funded by `msg.value`); ERC-20
     *         otherwise (pulled from `msg.sender` per recipient, requires prior
     *         approval of this contract for the total). All-or-nothing.
     * @param token      address(0) for native MON, else the ERC-20 to split.
     * @param recipients Payees. 1..MAX_RECIPIENTS entries; none may be the zero
     *                   address or this contract. Duplicates are allowed.
     * @param amounts    Per-recipient amounts, parallel to `recipients`. Each > 0.
     * @param ref        Opaque PayAI correlation reference. Never secret, never
     *                   controls execution; zero is allowed.
     * @return settlementId The id emitted with the SplitPaymentExecuted event.
     */
    function splitPayment(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts,
        bytes32 ref
    ) external payable whenNotPaused nonReentrant returns (uint256 settlementId) {
        uint256 n = recipients.length;
        require(n > 0, "no recipients");
        require(n <= MAX_RECIPIENTS, "too many recipients");
        require(n == amounts.length, "length mismatch");

        // Validate every entry and compute the total up front — no external
        // calls in this pass, so nothing can reenter before validation is done.
        uint256 total = 0;
        for (uint256 i = 0; i < n; i++) {
            require(amounts[i] > 0, "zero amount");
            address r = recipients[i];
            require(r != address(0), "zero recipient");
            require(r != address(this), "self recipient");
            total += amounts[i]; // checked arithmetic (0.8.x) — overflow reverts
        }

        // Effects before interactions: claim the id first (CEI + reentrancy).
        settlementId = settlementCount;
        settlementCount = settlementId + 1;

        if (token == NATIVE) {
            require(msg.value == total, "bad msg.value");
            // DELTA-based zero-retention (INVARIANT-SS-7): the balance that
            // existed BEFORE this call's own inflow. A forced pre-existing
            // balance is tolerated and left untouched.
            uint256 preBalance = address(this).balance - msg.value;
            for (uint256 i = 0; i < n; i++) {
                (bool ok, ) = recipients[i].call{value: amounts[i]}("");
                require(ok, "native send failed");
            }
            require(address(this).balance == preBalance, "native retained");
        } else {
            require(msg.value == 0, "no native for erc20");
            for (uint256 i = 0; i < n; i++) {
                address r = recipients[i];
                uint256 amt = amounts[i];
                // Direct payer -> recipient; contract never holds the token.
                // Verify by the recipient's real balance delta, not the boolean
                // alone (INVARIANT-SS-3): a short-delivering (fee-on-transfer)
                // token MUST revert. Duplicate recipients are correct here —
                // each transfer's delta is measured around its own call.
                uint256 balBefore = IERC20(token).balanceOf(r);
                bool ok = IERC20(token).transferFrom(msg.sender, r, amt);
                require(ok, "transfer failed");
                require(IERC20(token).balanceOf(r) - balBefore == amt, "token did not deliver full amount");
            }
        }

        emit SplitPaymentExecuted(settlementId, msg.sender, token, ref, total, recipients, amounts);
    }
}
