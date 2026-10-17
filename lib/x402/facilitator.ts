/**
 * PayAI's self-hosted x402 facilitator: the SDK instance and its signer.
 *
 * Built lazily on first use, once per process, from readFacilitatorConfig().
 * Registers ONLY the v2 exact EVM scheme on PayAI's one Monad network. No v1
 * schemes and no ERC-6492 factory deployments.
 *
 * Settlement retries reconcile through a Redis-backed PendingSettlementStore,
 * so a retry that lands on another serverless instance finds the already-
 * broadcast transaction instead of broadcasting a second one.
 *
 * Server-only.
 */
import "server-only";
import { createWalletClient, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  InMemoryPendingSettlementStore,
  PENDING_SETTLEMENT_TTL_MS,
  x402Facilitator,
  type PendingSettlementStore,
} from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner, type FacilitatorEvmSigner } from "@x402/evm";
import { getChain, getTransport } from "@/lib/monad/config";
import { getRedis } from "@/lib/platform/kv";
import type { FacilitatorConfig } from "./config";

/** Below Vercel's default function deadline, so a slow confirmation returns
 *  `settlement_pending` with the hash instead of the function being killed. */
const CONFIRMATION_TIMEOUT_MS = 20_000;

const PENDING_PREFIX = "payai:x402:pending:";

/** Shared pending-settlement store. Falls back to process memory only when KV
 *  isn't configured (local dev), matching the rest of the platform layer. */
export function createPendingStore(): PendingSettlementStore {
  const memory = new InMemoryPendingSettlementStore();
  const ttlSec = Math.max(1, Math.ceil(PENDING_SETTLEMENT_TTL_MS / 1000));
  return {
    async get(key) {
      const r = await getRedis();
      if (!r) return memory.get(key);
      const v = await r.get(PENDING_PREFIX + key);
      return typeof v === "string" && v ? v : undefined;
    },
    async set(key, txHash) {
      const r = await getRedis();
      if (!r) return memory.set(key, txHash);
      await r.set(PENDING_PREFIX + key, txHash, { ex: ttlSec });
    },
    async delete(key) {
      const r = await getRedis();
      if (!r) return memory.delete(key);
      await r.del(PENDING_PREFIX + key);
    },
  };
}

export function createFacilitatorSigner(cfg: FacilitatorConfig): FacilitatorEvmSigner {
  const account = privateKeyToAccount(cfg.privateKey);
  const client = createWalletClient({ account, chain: getChain(), transport: getTransport() }).extend(publicActions);
  return toFacilitatorEvmSigner(
    {
      address: account.address,
      readContract: (args) => client.readContract(args as Parameters<typeof client.readContract>[0]),
      verifyTypedData: (args) => client.verifyTypedData(args as Parameters<typeof client.verifyTypedData>[0]),
      writeContract: (args) => client.writeContract(args as Parameters<typeof client.writeContract>[0]),
      sendTransaction: (args) => client.sendTransaction(args),
      waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
      getCode: (args) => client.getCode(args),
    },
    { confirmationTimeoutMs: CONFIRMATION_TIMEOUT_MS },
  );
}

interface Built {
  key: string;
  facilitator: x402Facilitator;
  signerAddresses: readonly string[];
}
let _built: Built | null = null;

/** The facilitator for this config. Rebuilt only if the key, network or asset
 *  changes (tests; a redeploy starts a fresh process anyway). */
export function getFacilitator(cfg: FacilitatorConfig): Built {
  const key = `${cfg.privateKey}:${cfg.network}:${cfg.asset}`;
  if (_built?.key === key) return _built;
  _built = { key, ...buildFacilitator(cfg.network, createFacilitatorSigner(cfg)) };
  return _built;
}

/** The scheme settings every PayAI facilitator runs with. Exported so tests
 *  drive this exact configuration against a fake chain. */
export function buildFacilitator(network: FacilitatorConfig["network"], signer: FacilitatorEvmSigner): Omit<Built, "key"> {
  const scheme = new ExactEvmScheme(signer, {
    // No ERC-6492 counterfactual wallet deployments: PayAI would pay gas to
    // deploy arbitrary factory calldata.
    eip6492AllowedFactories: [],
    // Re-simulate right before broadcast, so a nonce spent or balance moved
    // since verify is caught as an eth_call instead of a paid-for revert.
    simulateInSettle: true,
    pendingSettlementStore: createPendingStore(),
  });
  const facilitator = new x402Facilitator().register(network, scheme);
  return { facilitator, signerAddresses: signer.getAddresses() };
}
