import { ethers } from "ethers";

export type Network = "mainnet" | "testnet";

interface ChainInfo {
  chainId: number;
  name: string;
  symbol: string;
  rpc: string;
  explorer: string;
}

export function getNetwork(): Network {
  return process.env.MONAD_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

export function getChain(): ChainInfo {
  if (getNetwork() === "mainnet") {
    return {
      chainId: 143,
      name: "Monad",
      symbol: "MON",
      rpc: process.env.MONAD_MAINNET_RPC || "https://rpc.monad.xyz",
      explorer: "https://monadexplorer.com",
    };
  }
  return {
    chainId: 10143,
    name: "Monad Testnet",
    symbol: "MON",
    rpc: process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz",
    explorer: "https://testnet.monadexplorer.com",
  };
}

let cached: ethers.JsonRpcProvider | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  const chain = getChain();
  if (!cached) {
    cached = new ethers.JsonRpcProvider(chain.rpc, {
      chainId: chain.chainId,
      name: chain.name,
    });
  }
  return cached;
}

export function txUrl(hash: string): string {
  return `${getChain().explorer}/tx/${hash}`;
}

export function addressUrl(addr: string): string {
  return `${getChain().explorer}/address/${addr}`;
}
