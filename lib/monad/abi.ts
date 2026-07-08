/**
 * Contract ABIs for the PayAI on-chain execution suite (deliverable).
 *
 * Plain module (no "server-only") so it can be imported by server code, scripts,
 * or external integrations. The minimal ABIs cover the functions/events the app
 * and dashboard use. Full ABIs are emitted by Hardhat to
 * contracts/artifacts/contracts/*.sol/*.json on compile.
 */

export const PAYMENT_EXECUTOR_ABI = [
  {
    type: "function", name: "executePayment", stateMutability: "nonpayable",
    inputs: [
      { name: "merchant", type: "address" }, { name: "token", type: "address" },
      { name: "amount", type: "uint256" }, { name: "riskScore", type: "uint16" },
      { name: "aiDecisionHash", type: "bytes32" }, { name: "ref", type: "bytes32" },
      { name: "requestId", type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function", name: "executePaymentNative", stateMutability: "payable",
    inputs: [
      { name: "merchant", type: "address" }, { name: "riskScore", type: "uint16" },
      { name: "aiDecisionHash", type: "bytes32" }, { name: "ref", type: "bytes32" },
      { name: "requestId", type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    // Wallet Automation: pull the approved ERC-20 from `from` (the user) to the merchant.
    type: "function", name: "executePaymentFrom", stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" }, { name: "merchant", type: "address" },
      { name: "token", type: "address" }, { name: "amount", type: "uint256" },
      { name: "riskScore", type: "uint16" }, { name: "aiDecisionHash", type: "bytes32" },
      { name: "ref", type: "bytes32" }, { name: "requestId", type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function", name: "isRequestProcessed", stateMutability: "view",
    inputs: [{ name: "requestId", type: "bytes32" }], outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "addAgent", stateMutability: "nonpayable",
    inputs: [{ name: "agent", type: "address" }], outputs: [],
  },
  {
    type: "function", name: "removeAgent", stateMutability: "nonpayable",
    inputs: [{ name: "agent", type: "address" }], outputs: [],
  },
  {
    type: "function", name: "setMaxTxAmount", stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }], outputs: [],
  },
  {
    type: "function", name: "setMerchantMaxTx", stateMutability: "nonpayable",
    inputs: [{ name: "merchant", type: "address" }, { name: "amount", type: "uint256" }], outputs: [],
  },
  { type: "function", name: "maxTxAmount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "merchantMaxTx", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "recordRejection", stateMutability: "nonpayable",
    inputs: [
      { name: "merchant", type: "address" }, { name: "amount", type: "uint256" },
      { name: "riskScore", type: "uint16" }, { name: "ref", type: "bytes32" },
    ], outputs: [],
  },
  {
    type: "function", name: "createPaymentRequest", stateMutability: "nonpayable",
    inputs: [
      { name: "merchant", type: "address" }, { name: "token", type: "address" },
      { name: "amount", type: "uint256" }, { name: "ref", type: "bytes32" },
    ],
    outputs: [{ name: "requestId", type: "uint256" }],
  },
  {
    type: "function", name: "payRequest", stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "uint256" }, { name: "riskScore", type: "uint16" },
      { name: "aiDecisionHash", type: "bytes32" }, { name: "idempotencyRequestId", type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  { type: "function", name: "requestsCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "getRequest", stateMutability: "view", inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [{
      type: "tuple", components: [
        { name: "merchant", type: "address" }, { name: "token", type: "address" },
        { name: "amount", type: "uint256" }, { name: "ref", type: "bytes32" },
        { name: "paid", type: "bool" }, { name: "paymentId", type: "uint256" },
        { name: "createdAt", type: "uint64" },
      ],
    }],
  },
  { type: "function", name: "paymentsCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "stats", stateMutability: "view", inputs: [],
    outputs: [
      { name: "payments", type: "uint256" }, { name: "volume", type: "uint256" },
      { name: "approved", type: "uint256" }, { name: "rejected", type: "uint256" },
      { name: "requests", type: "uint256" },
    ],
  },
  {
    type: "function", name: "getPayment", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }],
    outputs: [{
      type: "tuple", components: [
        { name: "agent", type: "address" }, { name: "merchant", type: "address" },
        { name: "token", type: "address" }, { name: "amount", type: "uint256" },
        { name: "riskScore", type: "uint16" }, { name: "compliance", type: "uint8" },
        { name: "aiDecisionHash", type: "bytes32" }, { name: "ref", type: "bytes32" },
        { name: "requestId", type: "bytes32" }, { name: "timestamp", type: "uint64" },
      ],
    }],
  },
  {
    type: "event", name: "PaymentExecuted", anonymous: false,
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "riskScore", type: "uint16", indexed: false },
      { name: "aiDecisionHash", type: "bytes32", indexed: false },
      { name: "ref", type: "bytes32", indexed: false },
      { name: "requestId", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event", name: "PaymentRequested", anonymous: false,
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "ref", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event", name: "RequestPaid", anonymous: false,
    inputs: [{ name: "requestId", type: "uint256", indexed: true }, { name: "paymentId", type: "uint256", indexed: true }],
  },
  {
    type: "event", name: "ComplianceApproved", anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "riskScore", type: "uint16", indexed: false }],
  },
  {
    type: "event", name: "ComplianceRejected", anonymous: false,
    inputs: [
      { name: "agent", type: "address", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "riskScore", type: "uint16", indexed: false },
      { name: "ref", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const MERCHANT_REGISTRY_ABI = [
  {
    type: "function", name: "registerMerchant", stateMutability: "nonpayable",
    inputs: [{ name: "wallet", type: "address" }, { name: "name", type: "string" }], outputs: [],
  },
  { type: "function", name: "merchantCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allMerchants", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "isRegistered", stateMutability: "view", inputs: [{ name: "w", type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "getMerchant", stateMutability: "view", inputs: [{ name: "w", type: "address" }],
    outputs: [{
      type: "tuple", components: [
        { name: "wallet", type: "address" }, { name: "name", type: "string" },
        { name: "active", type: "bool" }, { name: "volume", type: "uint256" },
        { name: "paymentCount", type: "uint256" }, { name: "registeredAt", type: "uint64" },
      ],
    }],
  },
  {
    type: "event", name: "MerchantRegistered", anonymous: false,
    inputs: [{ name: "wallet", type: "address", indexed: true }, { name: "name", type: "string", indexed: false }],
  },
] as const;

/** AutomationVault — Reserved Funds mode. reserve() is user-signed; release()/refund() are agent-triggered. */
export const AUTOMATION_VAULT_ABI = [
  {
    type: "function", name: "reserve", stateMutability: "payable",
    inputs: [
      { name: "automationId", type: "bytes32" }, { name: "token", type: "address" },
      { name: "recipient", type: "address" }, { name: "amount", type: "uint256" },
    ], outputs: [],
  },
  {
    type: "function", name: "release", stateMutability: "nonpayable",
    inputs: [
      { name: "automationId", type: "bytes32" }, { name: "amount", type: "uint256" },
      { name: "requestId", type: "bytes32" },
    ], outputs: [],
  },
  {
    type: "function", name: "refund", stateMutability: "nonpayable",
    inputs: [{ name: "automationId", type: "bytes32" }], outputs: [],
  },
  { type: "function", name: "reservedBalance", stateMutability: "view", inputs: [{ name: "automationId", type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isReleaseProcessed", stateMutability: "view", inputs: [{ name: "requestId", type: "bytes32" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "reservations", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "depositor", type: "address" }, { name: "token", type: "address" },
      { name: "recipient", type: "address" }, { name: "balance", type: "uint256" }, { name: "exists", type: "bool" },
    ],
  },
  {
    type: "event", name: "Released", anonymous: false,
    inputs: [
      { name: "automationId", type: "bytes32", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "remaining", type: "uint256", indexed: false },
      { name: "requestId", type: "bytes32", indexed: false },
    ],
  },
] as const;

/** Minimal WMON (canonical wrapped-native) interface — deposit to wrap MON→WMON. */
export const WMON_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
