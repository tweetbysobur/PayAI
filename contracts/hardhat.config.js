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
  // Verify via Sourcify ONLY. Newer @nomicfoundation/hardhat-verify also runs
  // an Etherscan pass by default, which hard-fails on Monad (chain 143 has no
  // Etherscan entry) with a "'<' … --list-networks" error before Sourcify ever
  // runs. Disabling the Etherscan verifier makes `npx hardhat verify` go
  // straight to Monad's Sourcify — the mechanism every contract in this suite
  // is verified through (see GATE8_RUNBOOK.md).
  etherscan: {
    enabled: false,
  },
};
