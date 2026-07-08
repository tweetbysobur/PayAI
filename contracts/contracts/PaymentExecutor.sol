// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPaymentExecutor} from "./interfaces/IPaymentExecutor.sol";
import {IMerchantRegistry} from "./interfaces/IMerchantRegistry.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
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
 *         Flow (ERC-20): agent approves this contract for `amount` of `token`,
 *         then calls executePayment() — the contract pulls the tokens, forwards
 *         them to the merchant, records the payment, accrues merchant volume,
 *         and emits PaymentExecuted + ComplianceApproved.
 *
 *         Flow (native MON): agent calls executePaymentNative() with `value`
 *         attached — the contract forwards it to the merchant directly.
 *
 *         Every payment carries a `requestId` (idempotency key, supplied by the
 *         caller) that can only ever be used once — replaying the same approved
 *         intent (API retry, UI double-click, client crash-and-resubmit) reverts
 *         instead of executing a second time.
 */
contract PaymentExecutor is IPaymentExecutor {
    address public owner;
    mapping(address => bool) public isAgent;
    bool public paused;

    IMerchantRegistry public immutable merchantRegistry;

    Payment[] private _payments;
    PaymentRequest[] private _requests;
    mapping(address => uint256[]) private _paymentsByMerchant;

    /* ── Idempotency ───────────────────────────────────────────────────────── */
    mapping(bytes32 => bool) public usedRequestId;

    /* ── Analytics counters (cheap reads for dashboards) ─────────────────── */
    uint256 public totalVolume;
    uint256 public approvedCount;
    uint256 public rejectedCount;

    /* ── On-chain spend limits (defense-in-depth beyond app guardrails) ──── */
    /// These apply to executePayment (ERC-20, e.g. USDC's 6 decimals). Kept
    /// separate from the *Native fields below because a single shared cap
    /// across token types with different decimals is meaningless — a limit
    /// sized for 6-decimal USDC base units is either near-zero or effectively
    /// unlimited when reused verbatim against 18-decimal native MON wei.
    /// Per-agent cap on total amount executed per UTC day (0 = unlimited).
    uint256 public dailyCap;
    /// Hard ceiling on any single payment, regardless of merchant (0 = unlimited).
    uint256 public maxTxAmount;
    /// Optional per-merchant override of the single-payment ceiling (0 = use maxTxAmount).
    mapping(address => uint256) public merchantMaxTx;
    /// agent => day index (block.timestamp / 1 days) => amount spent that day.
    mapping(address => mapping(uint256 => uint256)) public spentPerDay;

    /// Same shape as above, denominated in native MON wei (18 decimals) —
    /// used by executePaymentNative instead of the ERC-20 fields.
    uint256 public dailyCapNative;
    uint256 public maxTxAmountNative;
    mapping(address => uint256) public merchantMaxTxNative;
    mapping(address => mapping(uint256 => uint256)) public spentPerDayNative;

    bool private _locked; // reentrancy mutex

    event AgentSet(address indexed agent, bool allowed);
    event PausedSet(bool paused);
    event DailyCapSet(uint256 cap);
    event MaxTxAmountSet(uint256 amount);
    event MerchantMaxTxSet(address indexed merchant, uint256 amount);
    event DailyCapNativeSet(uint256 cap);
    event MaxTxAmountNativeSet(uint256 amount);
    event MerchantMaxTxNativeSet(address indexed merchant, uint256 amount);
    event OwnershipTransferred(address indexed from, address indexed to);

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

    /// @param registry MerchantRegistry address.
    /// @param cap Initial per-agent daily spend cap, ERC-20 base units (0 = unlimited).
    /// @param initialOwner Cold wallet / multisig — admin only, never a signer for payments.
    /// @param initialAgent Dedicated hot wallet — execution only, no admin power.
    /// @param capNative Initial per-agent daily spend cap, native MON wei (0 = unlimited).
    /// @param maxTxNative Initial per-payment ceiling, native MON wei (0 = unlimited).
    constructor(
        address registry,
        uint256 cap,
        address initialOwner,
        address initialAgent,
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
        dailyCapNative = capNative;
        maxTxAmountNative = maxTxNative;
        emit OwnershipTransferred(address(0), initialOwner);
        emit AgentSet(initialAgent, true);
        emit DailyCapSet(cap);
        emit DailyCapNativeSet(capNative);
        emit MaxTxAmountNativeSet(maxTxNative);
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

    /// @dev Kept for interface familiarity; equivalent to addAgent/removeAgent.
    function setAgent(address agent, bool allowed) external onlyOwner {
        require(!allowed || agent != owner, "owner cannot be agent");
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

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        require(!isAgent[to], "owner cannot be agent");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /* ── Limit checks ───────────────────────────────────────────────────── */
    function _enforceLimits(address agent, address merchant, uint256 amount, bool isNative) private {
        uint256 perTxCap = isNative
            ? (merchantMaxTxNative[merchant] > 0 ? merchantMaxTxNative[merchant] : maxTxAmountNative)
            : (merchantMaxTx[merchant] > 0 ? merchantMaxTx[merchant] : maxTxAmount);
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
        require(merchant != address(0), "zero merchant");
        require(amount > 0, "zero amount");
        require(riskScore <= 100, "risk>100");

        _claimRequestId(requestId);
        _enforceLimits(msg.sender, merchant, amount, false);

        // Pull stablecoin from the agent and forward to the merchant.
        bool ok = IERC20(token).transferFrom(msg.sender, merchant, amount);
        require(ok, "transfer failed");

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
        require(merchant != address(0), "zero merchant");
        require(msg.value > 0, "zero amount");
        require(riskScore <= 100, "risk>100");

        _claimRequestId(requestId);
        _enforceLimits(msg.sender, merchant, msg.value, true);

        (bool sent, ) = merchant.call{value: msg.value}("");
        require(sent, "native transfer failed");

        id = _recordPayment(merchant, address(0), msg.value, riskScore, aiDecisionHash, ref, requestId);
    }

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

        // Accrue merchant volume (no-op if the payee isn't a registered merchant).
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
    function payRequest(
        uint256 requestId,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 idempotencyRequestId
    ) external onlyAgent returns (uint256 id) {
        require(requestId < _requests.length, "bad request");
        PaymentRequest storage r = _requests[requestId];
        require(!r.paid, "already paid");

        id = executePayment(r.merchant, r.token, r.amount, riskScore, aiDecisionHash, r.ref, idempotencyRequestId);
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

    /// One-call analytics snapshot for the dashboard.
    function stats()
        external
        view
        returns (uint256 payments, uint256 volume, uint256 approved, uint256 rejected, uint256 requests)
    {
        return (_payments.length, totalVolume, approvedCount, rejectedCount, _requests.length);
    }
}
