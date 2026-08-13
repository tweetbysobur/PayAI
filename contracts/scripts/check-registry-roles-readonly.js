const hre = require("hardhat");

/**
 * READ-ONLY, fast alternative to snapshot-merchant-registry.js's event-log
 * replay for reconstructing isManager/isRecorder. Built after discovering
 * two things running the full scan against the live registry
 * (0x3e5F94168B6748E0396d1BBB9151bC62236f4DEb):
 *   1. It has ZERO registered merchants -- nothing to preserve there.
 *   2. The event scan itself fails with "error getting block header from
 *      triedb and archive" -- this RPC genuinely does not have historical
 *      state available for that range, not merely rate-limiting it.
 *
 * Instead of scanning ~92,000 windows to reconstruct role holders from
 * scratch, this checks isManager()/isRecorder() DIRECTLY for the specific
 * addresses this repo's own deploy records and this session's on-chain
 * checks already identify as candidates -- a handful of view calls instead
 * of a multi-hour (and apparently unreliable) block scan.
 *
 * This is NOT exhaustive -- if some address outside this candidate list was
 * ever granted a role, it won't be found here. It only tells you the
 * current status of KNOWN candidates. Add more addresses to CANDIDATES if
 * you know of others.
 *
 * SAFETY: read-only. Only isManager()/isRecorder() view calls. No signer,
 * no private key, no transaction.
 *
 * Required env:
 *   MERCHANT_REGISTRY_ADDRESS
 * Optional:
 *   MONAD_MAINNET_RPC -- defaults to https://rpc.monad.xyz
 *
 * Run with (from contracts/):
 *   npx hardhat run scripts/check-registry-roles-readonly.js --network monad
 */

const CANDIDATES = [
  { label: "Owner (cold wallet)", address: "0x8eed298c65887bb53a61e28c19a7252b9dc2364f" },
  { label: "Agent (hot wallet)", address: "0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a" },
  { label: "Executor v2 (historical, 2026-06-24)", address: "0x2919eAbbef3A56d9975821031e2C2764BBB085da" },
  { label: "Executor v3 (historical, 2026-07-08)", address: "0x990DdEc588Cb85B88A8d42d16B6a31FA66d7a8F7" },
  { label: "Executor v3-fresh (historical, 2026-07-08)", address: "0xCB847C0B15798233b8a18CE926eD8b6E4Cd1D873" },
  { label: "Executor v4 (OLD, pre-Ultrafuzz-fix, live until today's cutover)", address: "0x824050B7ef424a730779f676EA6863f908d82991" },
  { label: "Executor v4-ultrafuzz (historical, earlier fix round)", address: "0xB091a2E5cE8299B52cD5E2b785e0dBD52413505c" },
  { label: "Executor NEW (fixed source, live as of today's cutover)", address: "0x9Ab58088D925ecE2566292A2157702b25D6850De" },
];

const ABI = [
  "function isManager(address) view returns (bool)",
  "function isRecorder(address) view returns (bool)",
  "function owner() view returns (address)",
];

async function main() {
  const registryAddr = process.env.MERCHANT_REGISTRY_ADDRESS;
  if (!registryAddr) throw new Error("Set MERCHANT_REGISTRY_ADDRESS.");
  const rpcUrl = process.env.MONAD_MAINNET_RPC || "https://rpc.monad.xyz";

  const provider = new hre.ethers.JsonRpcProvider(rpcUrl, { chainId: 143, name: "monad" });
  const registry = new hre.ethers.Contract(registryAddr, ABI, provider);

  console.log("=".repeat(70));
  console.log("READ-ONLY DIRECT ROLE CHECK (no event scanning)");
  console.log("=".repeat(70));
  console.log(`Registry: ${registryAddr}`);
  const owner = await registry.owner();
  console.log(`owner(): ${owner}`);
  console.log("");

  const managers = [];
  const recorders = [];
  for (const c of CANDIDATES) {
    const [isMgr, isRec] = await Promise.all([registry.isManager(c.address), registry.isRecorder(c.address)]);
    console.log(`${c.label}`);
    console.log(`  ${c.address}`);
    console.log(`  isManager: ${isMgr}   isRecorder: ${isRec}`);
    if (isMgr) managers.push(c.address);
    if (isRec) recorders.push(c.address);
    console.log("");
  }

  console.log("=".repeat(70));
  console.log("SUMMARY (from known candidates only -- not exhaustive)");
  console.log("=".repeat(70));
  console.log("Current managers found:", managers.length ? managers : "(none of the candidates)");
  console.log("Current recorders found:", recorders.length ? recorders : "(none of the candidates)");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
