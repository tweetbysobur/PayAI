/**
 * Monad network configuration.
 *
 * Testnet-first, mainnet-ready: both chains are defined; the active one is chosen
 * by MONAD_NETWORK (default "testnet"). RPC URLs, the stablecoin contract, and
 * explorer come from env so testnet/mainnet are fully separate configs with no
 * code change to switch — the production-readiness requirement.
 */
import { defineChain, fallback, http, type Transport } from "viem";

export type MonadNetwork = "testnet" | "mainnet";

/**
 * RPC URLs for a network: the primary plus any backups from a comma-separated
 * env var. A backup slot is wired up here even when empty — drop a second
 * working RPC into MONAD_TESTNET_RPC_BACKUP / MONAD_MAINNET_RPC_BACKUP and
 * failover activates with no code change. (As of this writing no second
 * public Monad testnet RPC could be confirmed reachable — see getTransport
 * for how reliability is still improved on a single endpoint.)
 */
function rpcUrls(primaryEnv: string | undefined, backupEnv: string | undefined, fallbackDefault: string): string[] {
  const primary = primaryEnv || fallbackDefault;
  const backups = (backupEnv || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [primary, ...backups.filter((u) => u !== primary)];
}

const TESTNET_RPC_URLS = rpcUrls(process.env.MONAD_TESTNET_RPC, process.env.MONAD_TESTNET_RPC_BACKUP, "https://testnet-rpc.monad.xyz");
const MAINNET_RPC_URLS = rpcUrls(process.env.MONAD_MAINNET_RPC, process.env.MONAD_MAINNET_RPC_BACKUP, "https://rpc.monad.xyz");

/** Monad Testnet — chain ID 10143. */
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: TESTNET_RPC_URLS },
  },
  blockExplorers: {
    default: { name: "MonadExplorer", url: "https://testnet.monadexplorer.com" },
  },
  testnet: true,
});

/** Monad Mainnet — chain ID 143. */
export const monadMainnet = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: MAINNET_RPC_URLS },
  },
  blockExplorers: {
    default: { name: "MonadExplorer", url: "https://monadexplorer.com" },
  },
});

export function getNetwork(): MonadNetwork {
  return (process.env.MONAD_NETWORK as MonadNetwork) === "mainnet"
    ? "mainnet"
    : "testnet";
}

export function getChain() {
  return getNetwork() === "mainnet" ? monadMainnet : monadTestnet;
}

/**
 * The transport every viem client should use — never call viem's bare
 * `http()` directly for Monad. With one RPC URL this is a single hardened
 * http transport (more retries + backoff + an explicit timeout than viem's
 * default); with 2+ URLs (once a backup is configured) it's a `fallback()`
 * transport that automatically tries the next endpoint when one fails.
 */
export function getTransport(): Transport {
  const urls = getNetwork() === "mainnet" ? MAINNET_RPC_URLS : TESTNET_RPC_URLS;
  const transports = urls.map((url) =>
    http(url, { retryCount: 4, retryDelay: 500, timeout: 12_000 }),
  );
  return transports.length > 1 ? fallback(transports, { rank: false }) : transports[0];
}

export function explorerTx(hash: string): string {
  return `${getChain().blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${getChain().blockExplorers.default.url}/address/${address}`;
}

/**
 * The stablecoin used for transfers, per network. Testnet defaults to the
 * Testnet defaults to a sandbox aUSDC (6 decimals); override per
 * network via env. USDC is 6 decimals on most chains.
 */
export function getStablecoin(): {
  address: `0x${string}`;
  decimals: number;
  symbol: string;
} {
  const net = getNetwork();
  const address = (
    net === "mainnet"
      ? process.env.MONAD_MAINNET_USDC
      : process.env.MONAD_TESTNET_USDC ||
        "0xaC0893567D43C3E7e6e35a72803df05416C1f20D"
  ) as `0x${string}` | undefined;

  // Never fall back to the zero address — a misconfigured mainnet deploy
  // would otherwise build real USDC transfers against 0x0 instead of failing
  // loudly. Throw so the issue surfaces at request time, not silently on-chain.
  if (!address) {
    throw new Error(
      net === "mainnet"
        ? "MONAD_MAINNET_USDC is not set — refusing to use a stablecoin address."
        : "MONAD_TESTNET_USDC is not set — refusing to use a stablecoin address.",
    );
  }

  return {
    address,
    decimals: Number(process.env.MONAD_USDC_DECIMALS ?? 6),
    symbol: "USDC",
  };
}

/**
 * VeriPayRegistry contract address (the on-chain audit registry). Optional:
 * when set, executed payments are anchored on-chain; when unset, execution still
 * works and anchoring is skipped.
 */
export function getRegistryAddress(): `0x${string}` | null {
  const a = process.env.MONAD_REGISTRY_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : null;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
function pickAddr(...candidates: (string | undefined)[]): `0x${string}` | null {
  for (const c of candidates) if (c && ADDR.test(c)) return c as `0x${string}`;
  return null;
}

/**
 * PaymentExecutor contract for the active network. Network-specific env
 * (MONAD_MAINNET_PAYMENT_EXECUTOR / MONAD_TESTNET_PAYMENT_EXECUTOR) wins. The
 * shared MONAD_PAYMENT_EXECUTOR only ever falls back for testnet — it predates
 * mainnet support and is a testnet deployment address, so it must never leak
 * into mainnet just because MONAD_MAINNET_PAYMENT_EXECUTOR isn't set yet.
 */
export function getPaymentExecutor(): `0x${string}` | null {
  const net = getNetwork();
  return net === "mainnet"
    ? pickAddr(process.env.MONAD_MAINNET_PAYMENT_EXECUTOR)
    : pickAddr(process.env.MONAD_TESTNET_PAYMENT_EXECUTOR, process.env.MONAD_PAYMENT_EXECUTOR);
}

/** MerchantRegistry contract for the active network — same mainnet-isolation rule as above. */
export function getMerchantRegistry(): `0x${string}` | null {
  const net = getNetwork();
  return net === "mainnet"
    ? pickAddr(process.env.MONAD_MAINNET_MERCHANT_REGISTRY)
    : pickAddr(process.env.MONAD_TESTNET_MERCHANT_REGISTRY, process.env.MONAD_MERCHANT_REGISTRY);
}

export const monadConfig = {
  getNetwork,
  getChain,
  getStablecoin,
  explorerTx,
  explorerAddress,
  getRegistryAddress,
};
