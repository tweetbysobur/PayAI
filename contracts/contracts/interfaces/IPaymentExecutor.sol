// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IPaymentExecutor
 * @notice Interface for the PayAI on-chain execution layer: stablecoin and
 *         native MON payments with embedded AI/compliance metadata, replay
 *         protection, and per-transaction/daily/merchant spend limits.
 *
 * @custom:security-property INVARIANT-1: Payment Idempotency
 *   Every payment carries a unique `requestId`. No `requestId` can ever be executed
 *   more than once. Re-submitting a previously executed `requestId` must revert.
 *
 * @custom:security-property INVARIANT-2: Daily Spend Ceiling
 *   The cumulative volume executed by an agent in a single UTC day must never exceed
 *   `dailyCap` (for ERC-20) or `dailyCapNative` (for MON).
 *
 * @custom:security-property INVARIANT-3: Per-Transaction Ceiling
 *   No single payment can exceed `merchantMaxTx[merchant]` (if set) or `maxTxAmount`
 *   (or native equivalents).
 *
 * @custom:security-property INVARIANT-4: Merchant Registry Gate for Pull Payments
 *   `executePaymentFrom` (pulling funds from an approving user) MUST ALWAYS revert if
 *   the target merchant is not registered and active in `MerchantRegistry`.
 *
 * @custom:security-property INVARIANT-5: Role Separation
 *   Only authorized agents (`isAgent[msg.sender] == true`) can call execution methods.
 *   The owner cannot execute payments, and agents cannot alter contract configuration.
 */
interface IPaymentExecutor {
    enum Compliance {
        None,
        Approved,
        Rejected
    }

    struct Payment {
        address agent;          // PayAI agent wallet that executed
        address merchant;       // Payee address
        address token;          // Token contract address, or address(0) for native MON
        uint256 amount;         // Payment amount in base units (wei for native MON)
        uint16 riskScore;       // 0–100 risk score from PayAI risk engine
        Compliance compliance; // Compliance outcome (Approved or Rejected)
        bytes32 aiDecisionHash; // Hash of the off-chain AI decision metadata
        bytes32 ref;            // External reference (intent ID or invoice hash)
        bytes32 requestId;      // Idempotency key — unique per logical transaction
        uint64 timestamp;       // Block timestamp of execution
    }

    struct PaymentRequest {
        address merchant;    // Intended payee address
        address token;       // Token contract address or address(0) for native MON
        uint256 amount;      // Requested payment amount
        bytes32 ref;         // External invoice/order reference
        bool paid;           // Settlement status flag
        uint256 paymentId;   // Index into payments array once paid
        uint64 createdAt;    // Block timestamp of creation
    }

    event PaymentExecuted(
        uint256 indexed id,
        address indexed agent,
        address indexed merchant,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    );
    event PaymentRequested(uint256 indexed requestId, address indexed merchant, address token, uint256 amount, bytes32 ref);
    event RequestPaid(uint256 indexed requestId, uint256 indexed paymentId);
    event ComplianceApproved(uint256 indexed id, uint16 riskScore);
    event ComplianceRejected(address indexed agent, address indexed merchant, uint256 amount, uint16 riskScore, bytes32 ref);

    /// @notice Execute an ERC-20 payment funded directly by the caller agent.
    /// @dev Pulls `amount` of `token` from `msg.sender` to `merchant`.
    /// @param merchant Payee address receiving funds.
    /// @param token Address of ERC-20 token contract.
    /// @param amount Amount to transfer in base units.
    /// @param riskScore Risk evaluation score (0..100).
    /// @param aiDecisionHash Cryptographic hash of off-chain decision log.
    /// @param ref Business reference identifier.
    /// @param requestId Unique idempotency key.
    /// @return id Index of the recorded payment in storage.
    function executePayment(
        address merchant,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    ) external returns (uint256 id);

    /// @notice Execute an ERC-20 payment pulling funds from an approving user wallet (`from`).
    /// @dev Pulls `amount` of `token` from `from` directly to `merchant`.
    ///      Requires `merchant` to be registered and active in MerchantRegistry.
    /// @param from Wallet address authorizing the pull transfer.
    /// @param merchant Payee address receiving funds.
    /// @param token Address of ERC-20 token contract.
    /// @param amount Amount to transfer in base units.
    /// @param riskScore Risk evaluation score (0..100).
    /// @param aiDecisionHash Cryptographic hash of off-chain decision log.
    /// @param ref Business reference identifier.
    /// @param requestId Unique idempotency key.
    /// @return id Index of the recorded payment in storage.
    function executePaymentFrom(
        address from,
        address merchant,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    ) external returns (uint256 id);

    /// @notice Execute a native MON payment.
    /// @dev Forwards `msg.value` directly to `merchant`.
    /// @param merchant Payee address receiving MON.
    /// @param riskScore Risk evaluation score (0..100).
    /// @param aiDecisionHash Cryptographic hash of off-chain decision log.
    /// @param ref Business reference identifier.
    /// @param requestId Unique idempotency key.
    /// @return id Index of the recorded payment in storage.
    function executePaymentNative(
        address merchant,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    ) external payable returns (uint256 id);

    /// @notice Record a rejected payment intent for audit log purposes.
    /// @param merchant Intended merchant address.
    /// @param amount Payment amount that was evaluated.
    /// @param riskScore Risk score that triggered rejection (or high risk rating).
    /// @param ref External reference ID.
    function recordRejection(
        address merchant,
        uint256 amount,
        uint16 riskScore,
        bytes32 ref
    ) external;

    /// @notice Create an on-chain payment invoice/request.
    /// @param merchant Payee address.
    /// @param token Token contract or address(0) for native.
    /// @param amount Payment amount.
    /// @param ref Invoice reference.
    /// @return requestId Index of the created payment request.
    function createPaymentRequest(
        address merchant,
        address token,
        uint256 amount,
        bytes32 ref
    ) external returns (uint256 requestId);

    /// @notice Settle an existing payment request.
    /// @param requestId ID of payment request to settle.
    /// @param riskScore Risk score for the settlement.
    /// @param aiDecisionHash Hash of AI approval log.
    /// @param idempotencyRequestId Unique idempotency key for this settlement.
    /// @return id Payment index.
    function payRequest(
        uint256 requestId,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 idempotencyRequestId
    ) external returns (uint256 id);

    /// @notice Returns the total count of executed payments.
    function paymentsCount() external view returns (uint256);

    /// @notice Returns the total count of created payment requests.
    function requestsCount() external view returns (uint256);

    /// @notice Fetch full details for a recorded payment by ID.
    function getPayment(uint256 id) external view returns (Payment memory);

    /// @notice Fetch full details for a payment request by ID.
    function getRequest(uint256 requestId) external view returns (PaymentRequest memory);

    /// @notice Check if a specific requestId idempotency key has already been executed.
    function isRequestProcessed(bytes32 requestId) external view returns (bool);
}
