// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPaymentExecutor} from "./interfaces/IPaymentExecutor.sol";
import {IMerchantRegistry} from "./interfaces/IMerchantRegistry.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title PaymentExecutorV2
 * @notice PayAI's on-chain execution layer — identical to PaymentExecutor
 *         (V1) in every respect EXCEPT that it now collects a PayAI service
 *         fee, taken from the gross `amount` requested, with the remainder
 *         delivered to the merchant. V1 is NOT modified or redeployed and
 *         keeps working exactly as before for as long as it stays wired in
 *         the app — same pattern as PayAITradeExecutor -> V2 and
 *         PayAIForwarder -> PayAIForwarderV2.
 *
 *         The fee mechanism mirrors PayAITradeExecutorV2's exactly: a
 *         Safe-settable `feeBps` (capped at `MAX_FEE_BPS`) and `treasury`
 *         address, fee = floor(amount * feeBps / 10000). `feeBps = 0` makes
 *         this contract behave exactly like V1.
 *
 *         Every on-chain spend limit (`maxTxAmount`, `dailyCap`, and their
 *         native/merchant-specific variants) is checked against the GROSS
 *         `amount` — unchanged from V1 — so a cap still bounds exactly what
 *         it always bounded: how much an agent can move on a payer's behalf
 *         in one call / one day. The fee is a deduction from what the
 *         merchant receives, not an addition on top of what was capped.
 *
 * @custom:security-property (all V1 invariants PE-1 through PE-9, unchanged)
 *   Every invariant in PaymentExecutor.sol's header carries over verbatim:
 *   idempotency, per-tx/daily ceilings on the gross amount, merchant
 *   registration gating for pull payments, risk-score bound, role
 *   isolation, reentrancy/CEI, actual-delivery verification (now applied to
 *   BOTH the merchant's net share and the treasury's fee share), and the
 *   uniform request lifecycle across token types.
 *
 * @custom:security-property INVARIANT-PE2-1: Fee Is Bounded and Safe-Only
 *   `feeBps` can only be set by `owner` (the Safe) and can never exceed
 *   `MAX_FEE_BPS` (1.00%), enforced both at construction and in `setFeeBps`.
 *   Neither the agent nor any payer/merchant can influence the fee.
 *
 * @custom:security-property INVARIANT-PE2-2: Fee Delivery Verified, Not Assumed
 *   The treasury's ERC-20 balance is verified to have risen by EXACTLY the
 *   fee amount (mirrors INVARIANT-PE-8), applied identically to the
 *   merchant's net share. A fee-on-transfer or otherwise short-delivering
 *   token reverts the WHOLE payment on EITHER leg.
 */
contract PaymentExecutorV2 is IPaymentExecutor {
    /// @notice Cold wallet / multisig contract owner address.
    address public owner;

    /// @notice Set of authorized hot-wallet execution agent addresses.
    mapping(address => bool) public isAgent;

    /// @notice Emergency stop flag preventing execution.
    bool public paused;

    /// @notice Reference to the MerchantRegistry contract for payee validation.
    IMerchantRegistry public immutable merchantRegistry;

    /// @notice Hard ceiling on `feeBps`, matching every other fee-collecting PayAI contract.
    uint16 public constant MAX_FEE_BPS = 100; // 1.00%

    /// @notice Where the fee is sent. Safe-controlled.
    address public treasury;

    /// @notice Current fee in basis points (25 = 0.25%). Never exceeds MAX_FEE_BPS.
    uint16 public feeBps;

    /// @dev Internal store of executed payments. `Payment.amount` is the GROSS
    ///      amount requested/capped/recorded — the merchant's actual delivered
    ///      share is `amount - feeAmount`, emitted separately by `FeeCollected`
    ///      for the same payment id.
    Payment[] private _payments;

    /// @dev Internal store of created payment requests.
    PaymentRequest[] private _requests;

    /// @dev Merchant wallet => array of payment IDs.
    mapping(address => uint256[]) private _paymentsByMerchant;

    /* ── Idempotency ───────────────────────────────────────────────────────── */
    mapping(bytes32 => bool) public usedRequestId;

    /* ── Analytics counters (cheap reads for dashboards) ─────────────────── */
    /// @notice Cumulative GROSS volume executed across all payment types, in base units.
    uint256 public totalVolume;
    uint256 public approvedCount;
    uint256 public rejectedCount;
    /// @notice Cumulative fee collected, in the paid asset's own base units — NOT
    ///         comparable across tokens; a dashboard summing this across mixed
    ///         tokens would be meaningless. Kept per-payment in FeeCollected for
    ///         anyone who needs an accurate per-token breakdown.
    uint256 public totalFeeCollectedNative;

    /* ── On-chain spend limits (defense-in-depth beyond app guardrails) ──── */
    uint256 public dailyCap;
    uint256 public maxTxAmount;
    mapping(address => uint256) public merchantMaxTx;
    mapping(address => mapping(uint256 => uint256)) public spentPerDay;

    uint256 public dailyCapNative;
    uint256 public maxTxAmountNative;
    mapping(address => uint256) public merchantMaxTxNative;
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
    event TreasurySet(address treasury);
    event FeeBpsSet(uint16 feeBps);
    /// @notice `amount` here is the gross Payment.amount for id `id`; feeAmount
    ///         is what actually went to `treasury` from that same payment.
    event FeeCollected(uint256 indexed id, address token, uint256 feeAmount, address treasury);

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

    /// @param registry Address of MerchantRegistry contract.
    /// @param cap Initial ERC-20 daily cap (0 = unlimited).
    /// @param initialOwner Cold wallet / multisig admin address.
    /// @param initialAgent Dedicated hot wallet execution agent address.
    /// @param maxTx Initial single transaction ERC-20 max (0 = unlimited).
    /// @param capNative Initial native MON daily cap in wei (0 = unlimited).
    /// @param maxTxNative Initial single transaction native MON max in wei (0 = unlimited).
    /// @param treasury_ Where the fee is sent. Safe-controlled. Must be non-zero even if feeBps_ is 0.
    /// @param feeBps_ Initial fee in basis points. Must be <= MAX_FEE_BPS.
    constructor(
        address registry,
        uint256 cap,
        address initialOwner,
        address initialAgent,
        uint256 maxTx,
        uint256 capNative,
        uint256 maxTxNative,
        address treasury_,
        uint16 feeBps_
    ) {
        require(initialOwner != address(0), "zero owner");
        require(initialAgent != address(0), "zero agent");
        require(initialOwner != initialAgent, "owner and agent must differ");
        require(treasury_ != address(0), "zero treasury");
        require(feeBps_ <= MAX_FEE_BPS, "fee too high");

        owner = initialOwner;
        isAgent[initialAgent] = true;
        merchantRegistry = IMerchantRegistry(registry);
        dailyCap = cap;
        maxTxAmount = maxTx;
        dailyCapNative = capNative;
        maxTxAmountNative = maxTxNative;
        treasury = treasury_;
        feeBps = feeBps_;
        emit OwnershipTransferred(address(0), initialOwner);
        emit AgentSet(initialAgent, true);
        emit DailyCapSet(cap);
        emit MaxTxAmountSet(maxTx);
        emit DailyCapNativeSet(capNative);
        emit MaxTxAmountNativeSet(maxTxNative);
        emit TreasurySet(treasury_);
        emit FeeBpsSet(feeBps_);
    }

    /* ── Admin (owner only — cold wallet / multisig) ───────────────────────── */

    function addAgent(address agent) external onlyOwner {
        require(agent != address(0), "zero agent");
        require(agent != owner, "owner cannot be agent");
        isAgent[agent] = true;
        emit AgentSet(agent, true);
    }

    function removeAgent(address agent) external onlyOwner {
        isAgent[agent] = false;
        emit AgentSet(agent, false);
    }

    function setAgent(address agent, bool allowed) external onlyOwner {
        require(!allowed || agent != owner, "owner cannot be agent");
        require(!allowed || agent != address(0), "zero agent");
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function setDailyCap(uint256 cap) external onlyOwner {
        dailyCap = cap;
        emit DailyCapSet(cap);
    }

    function setMaxTxAmount(uint256 amount) external onlyOwner {
        maxTxAmount = amount;
        emit MaxTxAmountSet(amount);
    }

    function setMerchantMaxTx(address merchant, uint256 amount) external onlyOwner {
        merchantMaxTx[merchant] = amount;
        emit MerchantMaxTxSet(merchant, amount);
    }

    function setDailyCapNative(uint256 cap) external onlyOwner {
        dailyCapNative = cap;
        emit DailyCapNativeSet(cap);
    }

    function setMaxTxAmountNative(uint256 amount) external onlyOwner {
        maxTxAmountNative = amount;
        emit MaxTxAmountNativeSet(amount);
    }

    function setMerchantMaxTxNative(address merchant, uint256 amount) external onlyOwner {
        merchantMaxTxNative[merchant] = amount;
        emit MerchantMaxTxNativeSet(merchant, amount);
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

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        require(!isAgent[to], "owner cannot be agent");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /* ── Limit checks (unchanged from V1 — bound the GROSS amount) ─────────── */

    function _effectiveCap(uint256 globalCap, uint256 merchantCap) private pure returns (uint256) {
        if (globalCap == 0) return merchantCap;
        if (merchantCap == 0) return globalCap;
        return merchantCap < globalCap ? merchantCap : globalCap;
    }

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

    function _claimRequestId(bytes32 requestId) private {
        require(requestId != bytes32(0), "requestId required");
        require(!usedRequestId[requestId], "duplicate requestId");
        usedRequestId[requestId] = true;
    }

    /// @dev Floors down; a payment can never be overcharged by rounding.
    ///      `net + fee == gross` always holds exactly.
    function _split(uint256 gross) private view returns (uint256 fee, uint256 net) {
        fee = (gross * feeBps) / 10000;
        net = gross - fee;
    }

    /// @dev Shared two-leg ERC-20 delivery: `net` to `to`, `fee` to `treasury`,
    ///      both pulled from `payer` via separate `transferFrom` calls against
    ///      the same allowance, both verified by actual balance delta
    ///      (INVARIANT-PE-8 applied to each leg). Extracted into its own
    ///      function specifically to keep `_settleErc20`/`executePaymentFrom`'s
    ///      own local-variable count low enough for the Solidity legacy
    ///      codegen's stack-depth limit — the same fix already applied to
    ///      PayAITradeExecutor's Uniswap/Kuru calls (Gate 3), and the reason
    ///      this suite avoids `viaIR` rather than enabling it (see
    ///      LIVE_CONTRACTS.md's verification notes).
    function _payErc20WithFee(address payer, address to, address token, uint256 net, uint256 fee) private {
        uint256 toBalBefore = IERC20(token).balanceOf(to);
        bool ok = IERC20(token).transferFrom(payer, to, net);
        require(ok, "transfer failed");
        require(IERC20(token).balanceOf(to) - toBalBefore == net, "token did not deliver full amount");

        if (fee > 0) {
            uint256 treasuryBalBefore = IERC20(token).balanceOf(treasury);
            bool feeOk = IERC20(token).transferFrom(payer, treasury, fee);
            require(feeOk, "fee transfer failed");
            require(IERC20(token).balanceOf(treasury) - treasuryBalBefore == fee, "fee token did not deliver full amount");
        }
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
    ///      Pulls the GROSS `amount` split into two legs, both sourced from
    ///      `msg.sender` (the calling agent's own approval) via two separate
    ///      `transferFrom` calls: `merchant` gets `net`, `treasury` gets `fee`.
    ///      Both legs verified by actual balance delta (INVARIANT-PE-8,
    ///      applied to each leg independently) — see PaymentExecutor.sol's
    ///      _settleErc20 for why this is `private`.
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

        (uint256 fee, uint256 net) = _split(amount);
        _payErc20WithFee(msg.sender, merchant, token, net, fee);

        id = _recordPayment(merchant, token, amount, riskScore, aiDecisionHash, ref, requestId, fee);
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

        (uint256 fee, uint256 net) = _split(amount);
        _payErc20WithFee(from, merchant, token, net, fee);

        id = _recordPayment(merchant, token, amount, riskScore, aiDecisionHash, ref, requestId, fee);
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

        (uint256 fee, uint256 net) = _split(amount);

        if (fee > 0) {
            (bool feeSent, ) = treasury.call{value: fee}("");
            require(feeSent, "fee transfer failed");
        }
        (bool sent, ) = merchant.call{value: net}("");
        require(sent, "native transfer failed");

        id = _recordPayment(merchant, address(0), amount, riskScore, aiDecisionHash, ref, requestId, fee);
    }

    /// @dev Internal recording helper. `amount` recorded on the Payment struct
    ///      is the GROSS amount (unchanged field semantics from V1); `feeAmount`
    ///      actually collected is emitted separately via FeeCollected for the
    ///      same id, so `amount - feeAmount` is always the merchant's real
    ///      delivered share.
    function _recordPayment(
        address merchant,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId,
        uint256 feeAmount
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
        if (token == address(0)) totalFeeCollectedNative += feeAmount;

        if (address(merchantRegistry) != address(0)) {
            merchantRegistry.recordVolume(merchant, amount);
        }

        emit PaymentExecuted(id, msg.sender, merchant, token, amount, riskScore, aiDecisionHash, ref, requestId);
        emit ComplianceApproved(id, riskScore);
        emit FeeCollected(id, token, feeAmount, treasury);
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
    /// @dev The request's stored `amount` is treated as GROSS, same as every
    ///      other entry point — the fee is taken out of it at settlement time,
    ///      exactly as `executePayment`/`executePaymentNative` do.
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

    function stats()
        external
        view
        returns (uint256 payments, uint256 volume, uint256 approved, uint256 rejected, uint256 requests)
    {
        return (_payments.length, totalVolume, approvedCount, rejectedCount, _requests.length);
    }
}
