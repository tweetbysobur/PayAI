// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IPaymentExecutor
 * @notice Interface for the VeriPAY on-chain execution layer: stablecoin and
 *         native MON payments with embedded AI/compliance metadata, replay
 *         protection, and per-transaction/daily/merchant spend limits.
 */
interface IPaymentExecutor {
    enum Compliance {
        None,
        Approved,
        Rejected
    }

    struct Payment {
        address agent;        // VeriPAY agent wallet that executed
        address merchant;     // recipient
        address token;        // stablecoin contract, or address(0) for native MON
        uint256 amount;       // base units (wei for native MON)
        uint16 riskScore;     // 0–100 from VeriGate
        Compliance compliance;
        bytes32 aiDecisionHash; // hash of the AI decision metadata
        bytes32 ref;            // off-chain reference (intent / invoice id)
        bytes32 requestId;      // idempotency key — unique per logical payment
        uint64 timestamp;
    }

    struct PaymentRequest {
        address merchant;
        address token;
        uint256 amount;
        bytes32 ref;
        bool paid;
        uint256 paymentId; // index into payments once paid
        uint64 createdAt;
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

    function executePayment(
        address merchant,
        address token,
        uint256 amount,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    ) external returns (uint256 id);

    function executePaymentNative(
        address merchant,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 ref,
        bytes32 requestId
    ) external payable returns (uint256 id);

    function recordRejection(
        address merchant,
        uint256 amount,
        uint16 riskScore,
        bytes32 ref
    ) external;

    function createPaymentRequest(
        address merchant,
        address token,
        uint256 amount,
        bytes32 ref
    ) external returns (uint256 requestId);

    function payRequest(
        uint256 requestId,
        uint16 riskScore,
        bytes32 aiDecisionHash,
        bytes32 idempotencyRequestId
    ) external returns (uint256 id);

    function paymentsCount() external view returns (uint256);

    function requestsCount() external view returns (uint256);

    function getPayment(uint256 id) external view returns (Payment memory);

    function getRequest(uint256 requestId) external view returns (PaymentRequest memory);

    function isRequestProcessed(bytes32 requestId) external view returns (bool);
}
