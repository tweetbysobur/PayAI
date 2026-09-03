import { ethers } from "ethers";
import { getChain, getProvider } from "./chain.js";
import { getContract, type ContractConfig } from "./store.js";

/**
 * Builds the mint call for the configured contract. Supports the common
 * mint shapes without needing the full ABI:
 *   none        -> fn()
 *   quantity    -> fn(uint256 quantity)
 *   to          -> fn(address to)
 *   to_quantity -> fn(address to, uint256 quantity)
 */
function buildIface(cfg: ContractConfig): { iface: ethers.Interface; fragment: string } {
  const fn = cfg.mintFunction;
  let sig: string;
  switch (cfg.mintArgs) {
    case "quantity":
      sig = `function ${fn}(uint256 quantity) payable`;
      break;
    case "to":
      sig = `function ${fn}(address to) payable`;
      break;
    case "to_quantity":
      sig = `function ${fn}(address to, uint256 quantity) payable`;
      break;
    default:
      sig = `function ${fn}() payable`;
  }
  return { iface: new ethers.Interface([sig]), fragment: fn };
}

export interface PreparedMint {
  to: string;
  data: string;
  value: bigint;
  chainId: number;
}

/** Encodes a mint transaction (no signing). Used by both modes. */
export function prepareMint(recipient: string, quantity = 1): PreparedMint {
  const cfg = getContract();
  const { iface, fragment } = buildIface(cfg);
  let args: unknown[];
  switch (cfg.mintArgs) {
    case "quantity":
      args = [quantity];
      break;
    case "to":
      args = [recipient];
      break;
    case "to_quantity":
      args = [recipient, quantity];
      break;
    default:
      args = [];
  }
  const perMint = ethers.parseEther(cfg.price || "0");
  return {
    to: cfg.address,
    data: iface.encodeFunctionData(fragment, args),
    value: perMint * BigInt(quantity),
    chainId: getChain().chainId,
  };
}

/** Custodial mint: the server wallet signs and submits. Returns the tx hash. */
export async function custodialMint(
  privateKey: string,
  recipient: string,
  quantity = 1,
): Promise<string> {
  const cfg = getContract();
  const wallet = new ethers.Wallet(privateKey, getProvider());
  // When the contract mints to msg.sender, the server wallet would receive the
  // NFT. For "to" / "to_quantity" shapes the recipient is passed explicitly.
  const to = cfg.mintArgs === "to" || cfg.mintArgs === "to_quantity" ? recipient : wallet.address;
  const prepared = prepareMint(to, quantity);
  const tx = await wallet.sendTransaction({
    to: prepared.to,
    data: prepared.data,
    value: prepared.value,
  });
  await tx.wait(1);
  return tx.hash;
}

/**
 * Non-custodial mint: produce an EIP-681 URI the user opens in their own
 * wallet. The user signs. No key ever touches the server.
 * Format: ethereum:<addr>@<chainId>/<fn>?uint256=<q>&value=<wei>
 */
export function noncustodialUri(quantity = 1): string {
  const cfg = getContract();
  const prepared = prepareMint(ethers.ZeroAddress, quantity);
  const chainId = getChain().chainId;
  const parts: string[] = [];
  if (cfg.mintArgs === "quantity") parts.push(`uint256=${quantity}`);
  if (prepared.value > 0n) parts.push(`value=${prepared.value.toString()}`);
  const query = parts.length ? `?${parts.join("&")}` : "";
  const fnPath = cfg.mintArgs === "none" ? "" : `/${cfg.mintFunction}`;
  return `ethereum:${cfg.address}@${chainId}${fnPath}${query}`;
}
