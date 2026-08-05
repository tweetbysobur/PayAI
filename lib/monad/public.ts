/**
 * Browser-safe Monad config (chain id, RPC, USDC address) — mirrors lib/monad/config.ts
 * but exposed via NEXT_PUBLIC_ env vars so the customer-wallet checkout flow (which runs
 * entirely in the browser, no server round-trip) can target the right network and token.
 * Nothing here is a secret: chain ids, RPC URLs, and contract addresses are all public.
 */
export const MONAD_CHAIN_ID = Number(process.env.NEXT_PUBLIC_MONAD_CHAIN_ID ?? 10143);
export const MONAD_CHAIN_NAME = process.env.NEXT_PUBLIC_MONAD_CHAIN_NAME || "Monad Testnet";
export const MONAD_RPC = process.env.NEXT_PUBLIC_MONAD_RPC || "https://testnet-rpc.monad.xyz";
export const MONAD_EXPLORER = process.env.NEXT_PUBLIC_MONAD_EXPLORER || "https://testnet.monadexplorer.com";
export const MONAD_USDC = (process.env.NEXT_PUBLIC_MONAD_USDC || "") as `0x${string}`;
export const MONAD_USDC_DECIMALS = Number(process.env.NEXT_PUBLIC_MONAD_USDC_DECIMALS ?? 6);

export const MONAD_CHAIN_ID_HEX = `0x${MONAD_CHAIN_ID.toString(16)}`;

/**
 * The sentinel that stands in for the chain's own asset, which has no
 * contract address. Lives here rather than in tokenRegistry because the
 * browser needs it too, and tokenRegistry reaches for a server-side RPC
 * client — importing it from a client hook drags the whole server module into
 * the bundle. tokenRegistry re-exports this so the two can never disagree.
 */
export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Every configured RPC URL (primary + optional comma-separated backups) — the
 * browser-side wallet bar and checkout flow pass the full list into
 * wallet_addEthereumChain and into the read-only client used to await receipts,
 * so a backup dropped into NEXT_PUBLIC_MONAD_RPC_BACKUP activates automatically.
 */
export const MONAD_RPC_URLS: string[] = [
  MONAD_RPC,
  ...(process.env.NEXT_PUBLIC_MONAD_RPC_BACKUP || "").split(",").map((s) => s.trim()).filter((u) => u && u !== MONAD_RPC),
];
