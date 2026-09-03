import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Runtime contract config. Seeded from env, then overridable live with
 * /setcontract so the operator can paste the address the moment the NFT
 * goes live, with no redeploy. Persisted to a JSON file so a restart keeps it.
 */
export type MintArgs = "none" | "quantity" | "to" | "to_quantity";

export interface ContractConfig {
  address: string;
  mintFunction: string;
  mintArgs: MintArgs;
  /** Price per mint in MON, as a decimal string. */
  price: string;
}

// DATA_DIR lets a host mount a persistent volume (e.g. a Railway volume at
// /app/data) so /setcontract survives restarts. Defaults to ./data.
const FILE = resolve(process.env.DATA_DIR || resolve(process.cwd(), "data"), "contract.json");

function seedFromEnv(): ContractConfig {
  return {
    address: (process.env.NFT_CONTRACT_ADDRESS || "").trim(),
    mintFunction: (process.env.NFT_MINT_FUNCTION || "mint").trim(),
    mintArgs: (process.env.NFT_MINT_ARGS as MintArgs) || "none",
    price: (process.env.NFT_MINT_PRICE || "0").trim(),
  };
}

let current: ContractConfig = load();

function load(): ContractConfig {
  if (existsSync(FILE)) {
    try {
      return { ...seedFromEnv(), ...JSON.parse(readFileSync(FILE, "utf8")) };
    } catch {
      // fall through to env seed
    }
  }
  return seedFromEnv();
}

export function getContract(): ContractConfig {
  return current;
}

export function isConfigured(): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(current.address);
}

export function updateContract(patch: Partial<ContractConfig>): ContractConfig {
  current = { ...current, ...patch };
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(current, null, 2));
  return current;
}
