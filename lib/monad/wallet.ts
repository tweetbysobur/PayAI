/**
 * Monad wallet support (server-side agent signer).
 *
 * An autonomous payment agent signs with its OWN wallet — the user is not in the
 * loop to approve each transfer. The private key is read only from the server
 * env (MONAD_AGENT_PRIVATE_KEY) and is NEVER returned to the client; callers can
 * only obtain the public address and balance. createWalletClient is built lazily
 * so the app boots fine with no key (mock mode).
 *
 * Server-only.
 */
import "server-only";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain, getTransport } from "./config";

let _public: PublicClient | null = null;

/** Read-only client for the active Monad network (no key required). */
export function getPublicClient(): PublicClient {
  if (!_public) {
    _public = createPublicClient({ chain: getChain(), transport: getTransport() });
  }
  return _public;
}

function normalizeKey(raw: string): `0x${string}` {
  const k = raw.trim();
  return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
}

/** The agent's signing account, or null when no key is configured. */
export function getAgentAccount() {
  const key = process.env.MONAD_AGENT_PRIVATE_KEY;
  if (!key) return null;
  try {
    return privateKeyToAccount(normalizeKey(key));
  } catch {
    return null;
  }
}

export function isSignerConfigured(): boolean {
  return getAgentAccount() !== null;
}

/** Wallet client for signing/sending. Throws a clear error if no signer. */
export function getWalletClient(): WalletClient {
  const account = getAgentAccount();
  if (!account) {
    throw new Error(
      "No Monad signer configured. Set MONAD_AGENT_PRIVATE_KEY to enable on-chain execution.",
    );
  }
  return createWalletClient({ account, chain: getChain(), transport: getTransport() });
}

/** Public, safe-to-expose wallet info for the dashboard / health endpoint. */
export async function getWalletInfo(): Promise<{
  configured: boolean;
  address: string | null;
  network: string;
  chainId: number;
  nativeBalance: string | null;
  symbol: string;
}> {
  const chain = getChain();
  const account = getAgentAccount();
  const base = {
    configured: !!account,
    address: account?.address ?? null,
    network: chain.name,
    chainId: chain.id,
    symbol: chain.nativeCurrency.symbol,
    nativeBalance: null as string | null,
  };
  if (!account) return base;
  try {
    const bal = await getPublicClient().getBalance({ address: account.address });
    return { ...base, nativeBalance: formatEther(bal) };
  } catch {
    return base; // RPC unreachable — still report the configured address
  }
}
