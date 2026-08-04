/**
 * Mera embedded-wallet provider adapter.
 *
 * This is the ONLY file in PayAI allowed to know Mera's API shape. Every
 * other caller (API routes, the automation engine, the dashboard) goes
 * through `lib/wallet-service/index.ts`'s `getEmbeddedProvider()` — never
 * imports this module directly — so swapping or adding an embedded-wallet
 * vendor later touches this one file plus its registration in registry.ts.
 *
 * Follows the same "configured vs not" convention as lib/monad/wallet.ts's
 * MONAD_AGENT_PRIVATE_KEY: without MERA_API_KEY set, every method throws a
 * clear "not configured" error instead of fabricating a wallet address or
 * balance (see CLAUDE.md — no fabricated data on real surfaces). The
 * architecture is complete and ready; Mera plugs in the moment credentials
 * exist.
 *
 * Server-only.
 */
import "server-only";
import type { AuthMethod, EmbeddedWalletProvider, UnsignedTx } from "../types";

const MERA_API_BASE = process.env.MERA_API_BASE || "https://api.mera.money";

function meraConfig(): { apiKey: string; projectId: string } | null {
  const apiKey = process.env.MERA_API_KEY?.trim();
  const projectId = process.env.MERA_PROJECT_ID?.trim();
  if (!apiKey || !projectId) return null;
  return { apiKey, projectId };
}

function requireConfig(): { apiKey: string; projectId: string } {
  const cfg = meraConfig();
  if (!cfg) {
    throw new Error(
      "Mera is not configured. Set MERA_API_KEY and MERA_PROJECT_ID to enable embedded wallets.",
    );
  }
  return cfg;
}

/** Thin fetch wrapper — centralizes auth headers and error surfacing so every
 *  method below stays a one-liner once Mera's real endpoints are wired in. */
async function meraFetch(cfg: { apiKey: string; projectId: string }, path: string, init?: RequestInit) {
  const res = await fetch(`${MERA_API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
      "x-mera-project": cfg.projectId,
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mera API error (${res.status}): ${body || res.statusText}`);
  }
  return res.json();
}

export const meraProvider: EmbeddedWalletProvider = {
  id: "mera",
  kind: "embedded",
  label: "PayAI Wallet (Embedded)",

  isAvailable() {
    return meraConfig() !== null;
  },

  /** Create-or-recover is idempotent on userId at Mera's end — the same
   *  logged-in user always gets back the same address, no local mapping to
   *  maintain on PayAI's side.
   *
   *  `created` is taken from the response rather than inferred: only the
   *  provider knows whether this call minted a wallet or returned an
   *  existing one. If the field is absent it degrades to `false`, so a
   *  returning user is never wrongly told their wallet was just created —
   *  the safe direction to be wrong in. */
  async createOrRecoverWallet({ userId, authMethod }: { userId: string; authMethod: AuthMethod }) {
    const cfg = requireConfig();
    const json = await meraFetch(cfg, "/v1/wallets", {
      method: "POST",
      body: JSON.stringify({ userId, authMethod, chain: "monad" }),
    });
    return {
      address: json.address as string,
      recoveryMethod: (json.recoveryMethod as string) ?? authMethod,
      created: json.created === true,
    };
  },

  async signMessage({ userId, address, message }: { userId: string; address: string; message: string }) {
    const cfg = requireConfig();
    const json = await meraFetch(cfg, `/v1/wallets/${address}/sign-message`, {
      method: "POST",
      body: JSON.stringify({ userId, message }),
    });
    return json.signature as string;
  },

  async sendTransaction({ userId, address, tx, chainId }: { userId: string; address: string; tx: UnsignedTx; chainId: number }) {
    const cfg = requireConfig();
    const json = await meraFetch(cfg, `/v1/wallets/${address}/send-transaction`, {
      method: "POST",
      body: JSON.stringify({ userId, chainId, to: tx.to, data: tx.data ?? "0x", value: tx.value ?? "0x0" }),
    });
    return json.txHash as string;
  },
};
