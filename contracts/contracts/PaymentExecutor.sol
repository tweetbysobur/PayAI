// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPaymentExecutor} from "./interfaces/IPaymentExecutor.sol";
import {IMerchantRegistry} from "./interfaces/IMerchantRegistry.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title PaymentExecutor
 * @notice PayAI's on-chain execution layer. Authorized agents execute
 *         stablecoin or native MON payments that carry their AI/compliance
 *         metadata (risk score, decision hash, compliance status), so every
 *         settlement is an auditable on-chain record.
 *
 *         Roles are split for production safety:
 *           - owner:  cold wallet / multisig. Adds/removes agents, pauses,
 *                     updates spend limits. NEVER signs payments.
 *           - agent:  dedicated hot wallet(s). Can ONLY call executePayment /
 *                     executePaymentNative / payRequest / createPaymentRequest
 *                     / recordRejection — no admin power at all.
 *
 * @custom:security-property INVARIANT-PE-1: Payment Idempotency
 *   Every payment execution claims a `requestId`. `usedRequestId[requestId]` ensures
 *   no `requestId` can ever be executed twice. Duplicate resubmissions MUST revert.
 *
 * @custom:security-property INVARIANT-PE-2: Single-Transaction Spend Ceiling
 *   No single payment can exceed `min(maxTxAmount, merchantMaxTx[merchant])` (or the
 *   native MON equivalent), where a cap of 0 means "no cap" for that side. A
 *   merchant-specific cap can only ever NARROW the global ceiling -- it can never
 *   raise a merchant above what `maxTxAmount` allows every other merchant. If no
 *   merchant-specific cap is set, the global cap applies. Exceeding transfers MUST
 *   revert. Enforced once in `_effectiveCap`, used by every entry point that moves
 *   funds (`executePayment`, `executePaymentFrom`, `executePaymentNative`, and
 *   `payRequest` via `_settleErc20`/`_settleNative`), so the execution path can never
 *   bypass it. Corrected 2026-08 -- `merchantMaxTx`/`merchantMaxTxNative` previously
 *   REPLACED the global cap instead of bounding it, letting a merchant-specific
 *   setting exceed `maxTxAmount`, contradicting this documented invariant.
 *
 * @custom:security-property INVARIANT-PE-3: Per-Agent Daily Spend Ceiling
 *   The cumulative amount spent by `agent` on UTC day `block.timestamp / 1 days` MUST NOT
 *   exceed `dailyCap` (or `dailyCapNative`).
 *
 * @custom:security-property INVARIANT-PE-4: Pull Payment Merchant Registration Gate
 *   `executePaymentFrom` (pulling funds from a user's approval) MUST ALWAYS check that
 *   `merchantRegistry` recognizes `merchant` as registered AND active (when registry is set).
 *
 * @custom:security-property INVARIANT-PE-5: Risk Score Boundary
 *   `riskScore` MUST be strictly <= 100. Any value > 100 MUST revert.
 *
 * @custom:security-property INVARIANT-PE-6: Strict Role Isolation
 *   `owner != agent` is enforced. Owner CANNOT execute payments, and agents CANNOT
 *   modify limits, pause state, or agent sets.
 *
 * @custom:security-property INVARIANT-PE-7: Reentrancy & Checks-Effects-Interactions
 *   `_claimRequestId` and limit accounting happen BEFORE external ERC-20 transfers or
 *   native MON transfers, protected by `nonReentrant`.
 *
 * @custom:security-property INVARIANT-PE-8: Actual Delivery, Not Requested Amount
 *   `executePayment` / `executePaymentFrom` MUST verify the merchant's ERC-20 balance
 *   increased by EXACTLY `amount` (via before/after `balanceOf`), not merely that
 *   `transferFrom` returned true. A fee-on-transfer or otherwise non-standard token
 *   delivering less than `amount` MUST revert the whole payment rather than being
 *   recorded as a full settlement.
 *
 * @custom:security-property INVARIANT-PE-9: Uniform Request Lifecycle Across Token Types
 *   A payment request's lifecycle is `created` (createPaymentRequest) -> `paid`/
 *   `settled` (payRequest, atomically) for EVERY token, including the native MON
 *   sentinel `address(0)`. `payRequest` MUST settle a native request through the
 *   same `_settleNative` core `executePaymentNative` uses (limits, idempotency,
 *   transfer, `_recordPayment`), requiring `msg.value == r.amount` since native MON
 *   has no allowance to pull later -- never leave a created request permanently
 *   stuck unpaid because its token happens to be native. Added 2026-08 after
 *   Ultrafuzz L-01: `payRequest` previously only ever called the ERC-20 path, so a
 *   request created with `token == address(0)` could never transition to paid.
 */
contract PaymentExecutor is IPaymentExecutor {
    /// @notice Cold wallet / multisig contract owner address.
    address public owner;

    /// @notice Set of authorized hot-wallet execution agent addresses.
    mapping(address => bool) public isAgent;

    /// @notice Emergency stop flag preventing execution.
    bool public paused;

    /// @notice Reference to the MerchantRegistry contract for payee validation.
    IMerchantRegistry public immutable merchantRegistry;

    /// @dev Internal store of executed payments.
    Payment[] private _payments;

    /// @dev Internal store of created payment requests.
    PaymentRequest[] private _requests;

    /// @dev Merchant wallet => array of payment IDs.
    mapping(address => uint256[]) private _paymentsByMerchant;

    /* ── Idempotency ───────────────────────────────────────────────────────── */
    /// @notice Idempotency key registry — maps requestId to execution status.
    mapping(bytes32 => bool) public usedRequestId;

    /* ── Analytics counters (cheap reads for dashboards) ─────────────────── */
    /// @notice Cumulative volume executed across all payment types in base units.
    uint256 public totalVolume;

    /// @notice Cumulative count of approved payments.
    uint256 public approvedCount;

    /// @notice Cumulative count of rejected payment intents.
    uint256 public rejectedCount;

    /* ── On-chain spend limits (defense-in-depth beyond app guardrails) ──── */
    /// @notice Per-agent daily cap on ERC-20 spend (0 = unlimited).
    uint256 public dailyCap;

    /// @notice Hard ceiling on any single ERC-20 payment (0 = unlimited).
    uint256 public maxTxAmount;

    /// @notice Optional per-merchant single payment ERC-20 ceiling override (0 = default).
    mapping(address => uint256) public merchantMaxTx;

    /// @notice agent => day index (timestamp / 1 days) => ERC-20 amount spent that day.
    mapping(address => mapping(uint256 => uint256)) public spentPerDay;

    /// @notice Per-agent daily cap on native MON spend in wei (0 = unlimited).
    uint256 public dailyCapNative;

    /// @notice Hard ceiling on any single native MON payment in wei (0 = unlimited).
    uint256 public maxTxAmountNative;

    /// @notice Optional per-merchant single payment native MON ceiling override in wei.
    mapping(address => uint256) public merchantMaxTxNative;

    /// @notice agent => day index (timestamp / 1 days) => native MON amount spent that day.
    mapping(address => mapping(uint256 => uint256)) public spentPerDayNative;

    /// @dev Reentrancy lock mutex state.
    bool private _locked;

    /* ── Events ─────────────────────────────────────────────────────────── */
    event AgentSet(address indexed agent, bool allowed);
    event PausedSet(bool paused);
    event DailyCapSet(uint256 cap);
    event MaxTxAmountSet(uint256 amount);
    event MerchantMaxTxSet(address indexed merchant, uint256 amount);
    event DailyCapNativeSet(uint256 cap);
    event MaxTxAmountNativeSet(uint256 amount);
    event MerchantMaxTxNativeSet(address indexed merchant, uint256 amount);
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

    modifier nonReentrant() {
        require(!_locked, "reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    /// @notice Contract constructor initializing roles, merchant registry, and initial limits.
    /// @param registry Address of MerchantRegistry contract.
    /// @param cap Initial ERC-20 daily cap (0 = unlimited).
    /// @param initialOwner Cold wallet / multisig admin address.
    /// @param initialAgent Dedicated hot wallet execution agent address.
    /// @param maxTx Initial single transaction ERC-20 max (0 = unlimited).
    /// @param capNative Initial native MON daily cap in wei (0 = unlimited).
    /// @param maxTxNative Initial single transaction native MON max in wei (0 = unlimited).
    constructor(
        address registry,
        uint256 cap,
        address initialOwner,
        address initialAgent,
        uint256 maxTx,
        uint256 capNative,
        uint256 maxTxNative
    ) {
        require(initialOwner != address(0), "zero owner");
        require(initialAgent != address(0), "zero agent");
        require(initialOwner != initialAgent, "owner and agent must differ");

        owner = initialOwner;
        isAgent[initialAgent] = true;
        merchantRegistry = IMerchantRegistry(registry);
        dailyCap = cap;
        maxTxAmount = maxTx;
        dailyCapNative = capNative;
        maxTxAmountNative = maxTxNative;
        emit OwnershipTransferred(address(0), initialOwner);
        emit AgentSet(initialAgent, true);
        emit DailyCapSet(cap);
        emit MaxTxAmountSet(maxTx);
        emit DailyCapNativeSet(capNative);
        emit MaxTxAmountNativeSet(maxTxNative);
    }

    /* ── Admin (owner only — cold wallet / multisig) ───────────────────────── */

    /// @notice Authorize a new hot wallet agent.
    function addAgent(address agent) external onlyOwner {
        require(agent != address(0), "zero agent");
        require(agent != owner, "owner cannot be agent");
        isAgent[agent] = true;
        emit AgentSet(agent, true);
    }

    /// @notice Revoke agent authorization.
    function removeAgent(address agent) external onlyOwner {
        isAgent[agent] = false;
        emit AgentSet(agent, false);
    }

    /// @notice Set agent authorization status (equivalent to addAgent/removeAgent).
    function setAgent(address agent, bool allowed) external onlyOwner {
        require(!allowed || agent != owner, "owner cannot be agent");
        require(!allowed || agent != address(0), "zero agent");
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    /// @notice Toggle emergency pause state.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Update global ERC-20 daily cap per agent.
    function setDailyCap(uint256 cap) external onlyOwner {
        dailyCap = cap;
        emit DailyCapSet(cap);
    }

    /// @notice Update global ERC-20 single-transaction max amount.
    function setMaxTxAmount(uint256 amount) external onlyOwner {
        maxTxAmount = amount;
        emit MaxTxAmountSet(amount);
    }

    /// @notice Set merchant-specific ERC-20 single-transaction max amount.
    /// @dev A narrowing override only -- see INVARIANT-PE-2. The effective cap
    ///      is min(maxTxAmount, amount); setting this above maxTxAmount has no
    ///      effect, since the global cap still binds. 0 clears the override.
    function setMerchantMaxTx(address merchant, uint256 amount) external onlyOwner {
        merchantMaxTx[merchant] = amount;
        emit MerchantMaxTxSet(merchant, amount);
    }

    /// @notice Update global native MON daily cap per agent.
    function setDailyCapNative(uint256 cap) external onlyOwner {
        dailyCapNative = cap;
        emit DailyCapNativeSet(cap);
    }

    /// @notice Update global native MON single-transaction max amount.
    function setMaxTxAmountNative(uint256 amount) external onlyOwner {
        maxTxAmountNative = amount;
        emit MaxTxAmountNativeSet(amount);
    }

    /// @notice Set merchant-specific native MON single-transaction max amount.
    /// @dev A narrowing override only -- see INVARIANT-PE-2. The effective cap
    ///      is min(maxTxAmountNative, amount); setting this above
    ///      maxTxAmountNative has no effect. 0 clears the override.
    function setMerchantMaxTxNative(address merchant, uint256 amount) external onlyOwner {
        merchantMaxTxNative[merchant] = amount;
        emit MerchantMaxTxNativeSet(merchant, amount);
    }

    /// @notice Transfer contract administrative ownership.
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        require(!isAgent[to], "owner cannot be agent");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /* ── Limit checks ───────────────────────────────────────────────────── */

    /// @dev INVARIANT-PE-2: min(globalCap, merchantCap), treating 0 as "no cap"
    ///      on either side independently. A merchant-specific cap can only ever
    ///      narrow the global ceiling, never raise a merchant above it.
    function _effectiveCap(uint256 globalCap, uint256 merchantCap) private pure returns (uint256) {
        if (globalCap == 0) return merchantCap;
        if (merchantCap == 0) return globalCap;
        return merchantCap < globalCap ? merchantCap : globalCap;
    }

    /**
     * @dev Internal helper to validate merchant status and enforce per-tx & daily limits.
     * @param agent Executing agent address.
     * @param merchant Target merchant recipient address.
     * @param amount Payment amount.
     * @param isNative True if payment is native MON, false if ERC-20.
     * @param requireRegisteredMerchant If true, verifies merchant registration in MerchantRegistry.
     */
    function _enforceLimits(
        address agent,
        address merchant,
        uint256 amount,
        bool isNative,
        bool requireRegisteredMerchant
    ) private {
        if (requireRegisteredMerchant && address(merchantRegistry) != address(0)) {
            require(merchantRegistry.isRegistered(merchant), "merchant not registered");
            require(merchantRegistry.isActive(merchant), "merchant not active");
        }

        uint256 perTxCap = isNative
            ? _effectiveCap(maxTxAmountNative, merchantMaxTxNative[merchant])
            : _effectiveCap(maxTxAmount, merchantMaxTx[merchant]);
        if (perTxCap > 0) require(amount <= perTxCap, "exceeds max tx amount");

        uint256 cap = isNative ? dailyCapNative : dailyCap;
        if (cap > 0) {
            uint256 day = block.timestamp / 1 days;
            if (isNative) {
                uint256 spent = spentPerDayNative[agent][day] + amount;
                require(spent <= cap, "daily cap exceeded");
                spentPerDayNative[agent][day] = spent;
            } else {
                uint256 spent = spentPerDay[agent][day] + amount;
                require(spent <= cap, "daily cap exceeded");
                spentPerDay[agent][day] = spent;
            }
        }
    }

    /// @dev Internal helper claiming a unique requestId or reverting if already used.
    function _claimRequestId(bytes32 requestId) private {
        require(requestId != bytes32(0), "requestId required");
        require(!usedRequestId[requestId], "duplicate requestId");
        usedRequestId[requestId] = true;
    }

    /* ── Execution: ERC-20 ──────────────────────────────────────────────── */

    /// @inheritdoc IPaymentExecutor
    function executePayment(
        address merchant,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    ) public onlyAgent nonReentrant returns (uint256 id) {
        id = _settleErc20(merchant, token, amount, riskScore, aiDecisionHash, ref, requestId);
    }

    /// @dev Shared ERC-20 settlement core for executePayment() and payRequest().
    ///      `msg.sender` is preserved unchanged from whichever external entry
    ///      point called this (a private call is a JUMP, not a CALL -- there is
    ///      no new call frame), so the pull always comes from the actual agent
    ///      who signed the transaction. Callers are responsible for their own
    ///      onlyAgent/nonReentrant guard -- this is `private` specifically so
    ///      it is never externally reachable without one, and so payRequest()
    ///      can settle through the SAME logic as a direct executePayment()
    ///      call without re-entering a second nonReentrant lock.
    function _settleErc20(
        address merchant,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    ) private returns (uint256 id) {
        require(merchant != address(0), "zero merchant");
        require(amount > 0, "zero amount");
        require(riskScore <= 100, "risk>100");

        _claimRequestId(requestId);
        _enforceLimits(msg.sender, merchant, amount, false, false);

        // Pull stablecoin from the agent and forward to the merchant. Verified
        // by actual balance delta, not just a truthy return value (see
        // INVARIANT-PE-8) -- a fee-on-transfer or otherwise non-standard
        // token could return true while delivering less than `amount`, which
        // would silently under-fund the merchant while every off-chain
        // record (totalVolume, MerchantRegistry volume, the app's own
        // execution log) still believes the full amount landed.
        uint256 balBefore = IERC20(token).balanceOf(merchant);
        bool ok = IERC20(token).transferFrom(msg.sender, merchant, amount);
        require(ok, "transfer failed");
        require(IERC20(token).balanceOf(merchant) - balBefore == amount, "token did not deliver full amount");

        id = _recordPayment(merchant, token, amount, riskScore, aiDecisionHash, ref, requestId);
    }

    /// @inheritdoc IPaymentExecutor
    function executePaymentFrom(
        address from,
        address merchant,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    ) external onlyAgent nonReentrant returns (uint256 id) {
        require(from != address(0), "zero from");
        require(merchant != address(0), "zero merchant");
        require(amount > 0, "zero amount");
        require(riskScore <= 100, "risk>100");

        _claimRequestId(requestId);
        _enforceLimits(msg.sender, merchant, amount, false, true);

        // Pull from the user (who approved this contract) directly to the
        // merchant. Same actual-delivery check as executePayment -- see
        // INVARIANT-PE-8.
        uint256 balBefore = IERC20(token).balanceOf(merchant);
        bool ok = IERC20(token).transferFrom(from, merchant, amount);
        require(ok, "transfer failed");
        require(IERC20(token).balanceOf(merchant) - balBefore == amount, "token did not deliver full amount");

        id = _recordPayment(merchant, token, amount, riskScore, aiDecisionHash, ref, requestId);
    }

    /* ── Execution: native MON ──────────────────────────────────────────── */

    /// @inheritdoc IPaymentExecutor
    function executePaymentNative(
        address merchant,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    ) external payable onlyAgent nonReentrant returns (uint256 id) {
        id = _settleNative(merchant, msg.value, riskScore, aiDecisionHash, ref, requestId);
    }

    /// @dev Shared native-MON settlement core for executePaymentNative() and
    ///      payRequest(). Native MON has no allowance mechanism -- there is no
    ///      way to "pull" it the way executePayment() pulls an ERC-20 via
    ///      transferFrom -- so funding and paying happen atomically: the agent
    ///      attaches `amount` as msg.value in the SAME call that settles it.
    ///      That is the native equivalent of the ERC-20 path's single pull-
    ///      and-settle step, not a separate persisted "funded" state. See
    ///      _settleErc20() for why this is `private` rather than adding a
    ///      second nonReentrant lock.
    function _settleNative(
        address merchant,
        uint256 amount,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    ) private returns (uint256 id) {
        require(merchant != address(0), "zero merchant");
        require(amount > 0, "zero amount");
        require(riskScore <= 100, "risk>100");

        _claimRequestId(requestId);
        _enforceLimits(msg.sender, merchant, amount, true, false);

        (bool sent, ) = merchant.call{value: amount}("");
        require(sent, "native transfer failed");

        id = _recordPayment(merchant, address(0), amount, riskScore, aiDecisionHash, ref, requestId);
    }

    /// @dev Internal recording helper emitting events and recording merchant volume.
    function _recordPayment(
        address merchant,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    ) private returns (uint256 id) {
        id = _payments.length;
        _payments.push(
            Payment({
                agent: msg.sender,
                merchant: merchant,
                token: token,
                amount: amount,
                riskScore: riskScore,
                compliance: Compliance.Approved,
                aiDecisionHash: aiDecisionHash,
                ref: ref,
                requestId: requestId,
                timestamp: uint64(block.timestamp)
            })
        );
        _paymentsByMerchant[merchant].push(id);

        totalVolume += amount;
        approvedCount += 1;

        if (address(merchantRegistry) != address(0)) {
            merchantRegistry.recordVolume(merchant, amount);
        }

        emit PaymentExecuted(id, msg.sender, merchant, token, amount, riskScore, aiDecisionHash, ref, requestId);
        emit ComplianceApproved(id, riskScore);
    }

    /// @inheritdoc IPaymentExecutor
    function recordRejection(
        address merchant,
        uint256 amount,
        uint16 riskScore,
        bytes32 ref
    ) external onlyAgent {
        require(riskScore <= 100, "risk>100");
        rejectedCount += 1;
        emit ComplianceRejected(msg.sender, merchant, amount, riskScore, ref);
    }

    /* ── Payment requests (invoices) ────────────────────────────────────── */

    /// @inheritdoc IPaymentExecutor
    function createPaymentRequest(
        address merchant,
        address token,
        uint256 amount,
        bytes32 ref
    ) external onlyAgent returns (uint256 requestId) {
        require(merchant != address(0), "zero merchant");
        require(amount > 0, "zero amount");
        // token == address(0) is native MON -- payRequest() settles it through
        // the same _settleNative() core executePaymentNative() uses, so a
        // native request follows the identical created -> paid/settled
        // lifecycle as an ERC-20 request. See payRequest() below.
        requestId = _requests.length;
        _requests.push(
            PaymentRequest({
                merchant: merchant,
                token: token,
                amount: amount,
                ref: ref,
                paid: false,
                paymentId: 0,
                createdAt: uint64(block.timestamp)
            })
        );
        emit PaymentRequested(requestId, merchant, token, amount, ref);
    }

    /// @inheritdoc IPaymentExecutor
    /// @dev Settles through the SAME core logic as a direct executePayment()/
    ///      executePaymentNative() call (_settleErc20/_settleNative), so a
    ///      request created with any token -- including the native address(0)
    ///      sentinel -- follows the identical created -> paid/settled
    ///      lifecycle. For a native request, the agent must attach exactly
    ///      `r.amount` as msg.value in this call: native MON has no allowance
    ///      mechanism to pull from later, so funding and paying are one
    ///      atomic step, same as executePaymentNative()'s own payable entry.
    function payRequest(
        uint256 requestId,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 idempotencyRequestId
    ) external payable onlyAgent nonReentrant returns (uint256 id) {
        require(requestId < _requests.length, "bad request");
        PaymentRequest storage r = _requests[requestId];
        require(!r.paid, "already paid");

        if (r.token == address(0)) {
            require(msg.value == r.amount, "native value must match request amount");
            id = _settleNative(r.merchant, r.amount, riskScore, aiDecisionHash, r.ref, idempotencyRequestId);
        } else {
            require(msg.value == 0, "no native value for erc20 request");
            id = _settleErc20(r.merchant, r.token, r.amount, riskScore, aiDecisionHash, r.ref, idempotencyRequestId);
        }
        r.paid = true;
        r.paymentId = id;
        emit RequestPaid(requestId, id);
    }

    /* ── Views ──────────────────────────────────────────────────────────── */
    function paymentsCount() external view returns (uint256) {
        return _payments.length;
    }

    function requestsCount() external view returns (uint256) {
        return _requests.length;
    }

    function getPayment(uint256 id) external view returns (Payment memory) {
        require(id < _payments.length, "bad id");
        return _payments[id];
    }

    function getRequest(uint256 requestId) external view returns (PaymentRequest memory) {
        require(requestId < _requests.length, "bad request");
        return _requests[requestId];
    }

    function paymentsOfMerchant(address merchant) external view returns (uint256[] memory) {
        return _paymentsByMerchant[merchant];
    }

    function isRequestProcessed(bytes32 requestId) external view returns (bool) {
        return usedRequestId[requestId];
    }

    /// @notice Returns dashboard summary metrics in a single RPC call.
    function stats()
        external
        view
        returns (uint256 payments, uint256 volume, uint256 approved, uint256 rejected, uint256 requests)
    {
        return (_payments.length, totalVolume, approvedCount, rejectedCount, _requests.length);
    }
}
