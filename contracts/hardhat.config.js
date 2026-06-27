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
};
