/**
 * Wallet Service registry — the single place that knows which embedded
 * providers exist. Everything else (API routes, the dashboard) asks the
 * registry for "the active embedded provider," never imports Mera by name.
 *
 * Adding a second embedded provider: implement EmbeddedWalletProvider in a
 * new providers/<name>.ts, add it to EMBEDDED_PROVIDERS below. Nothing else
 * in the app needs to change.
 *
 * Server-only.
 */
import "server-only";
import { meraProvider } from "./providers/mera";
import type { EmbeddedWalletProvider, WalletProviderId } from "./types";

const EMBEDDED_PROVIDERS: EmbeddedWalletProvider[] = [meraProvider];

/** The embedded provider PayAI currently offers users. Today there is only
 *  one (Mera); when a second ships, this becomes a real selection (per-tenant
 *  config, feature flag, or user choice) instead of "the only one." */
export function getEmbeddedProvider(): EmbeddedWalletProvider {
  return EMBEDDED_PROVIDERS[0];
}

export function findEmbeddedProvider(id: WalletProviderId): EmbeddedWalletProvider | null {
  return EMBEDDED_PROVIDERS.find((p) => p.id === id) ?? null;
}

export async function listAvailableEmbeddedProviders(): Promise<EmbeddedWalletProvider[]> {
  const flags = await Promise.all(EMBEDDED_PROVIDERS.map((p) => p.isAvailable()));
  return EMBEDDED_PROVIDERS.filter((_, i) => flags[i]);
}
