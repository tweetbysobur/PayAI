require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Reuse the agent key (or a dedicated deployer key) for deployment.
const PRIVATE_KEY =
  process.env.MONAD_AGENT_PRIVATE_KEY || process.env.PRIVATE_KEY;
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
    // Per-file override, scoped to the NEW Gate 3 trade executor only. Its two
    // typed adapters carry too many live locals for the legacy (non-IR) codegen
    // to fit the EVM stack, so it needs the IR pipeline. Every already-deployed
    // contract (PayAIForwarder, PaymentExecutor, …) keeps the exact settings it
    // was verified with — no viaIR — so their re-verification bytecode is
    // unchanged. This override affects PayAITradeExecutor and nothing else.
    overrides: {
      "contracts/PayAITradeExecutor.sol": {
        version: "0.8.24",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
    },
  },
  networks: {
    // Monad mainnet — chain ID 143
    monad: {
      url: process.env.MONAD_MAINNET_RPC || "https://rpc.monad.xyz",
      chainId: 143,
      accounts,
    },
    // Monad testnet — chain ID 10143 (deploy here first, it's free)
    monadTestnet: {
      url: process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts,
    },
  },
  // Monad's own Sourcify instance — lets `npx hardhat verify --network monad
  // <address>` verify source automatically instead of the explorer's manual
  // web form. No API key needed (see hardhat-verify's Sourcify docs).
  sourcify: {
    enabled: true,
    apiUrl: "https://sourcify-api-monad.blockvision.org/",
    browserUrl: "https://monadexplorer.com",
  },
};
