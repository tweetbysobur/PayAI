const hre = require("hardhat");

/**
 * Deploys PayAIRoomEscrow — NOT RUN. Written for the eventual, approved
 * deployment (see docs/rooms/ESCROW_ROOMS.md "Before switching on"). It
 * refuses to run unless DEPLOY_ROOM_ESCROW_CONFIRM=I_UNDERSTAND is set, so it
 * can't be triggered by accident.
 *
 * Fixed product terms, asserted on-chain after deploy:
 *   - feeBps = 50 (PayAI Rooms platform fee, 0.5%; the contract's MAX_FEE_BPS
 *     is also 50, so no room can ever be created above it);
 *   - owner  = the PayAI Safe from block zero (never the deployer EOA);
 *   - treasury = ROOM_ESCROW_TREASURY, required explicitly (no default) and,
 *     on mainnet, required to be a contract (the Safe treasury);
 *   - native MON minimum contribution = 1 MON (10^18 wei), PA-05.
 *
 * This deploys the contract and NOTHING else: no token is allowlisted (the
 * Safe calls setTokenSupported(USDC, true) and setMinContributionFloor(USDC,
 * 500000) afterwards — USDC rooms fail closed until both are done), no env var or Vercel
 * setting changes, and the app keeps escrow Rooms OFF until
 * MONAD_MAINNET_ROOM_ESCROW + PAYAI_ROOM_ESCROW_ENABLED=true are set.
 *
 * Usage (after audit + sign-off):
 *   DEPLOY_ROOM_ESCROW_CONFIRM=I_UNDERSTAND \
 *   ROOM_ESCROW_EXPECTED_CHAIN_ID=143 \
 *   ROOM_ESCROW_TREASURY=0x… ROOM_ESCROW_TREASURY_CONFIRM=0x… \
 *     npx hardhat run scripts/deploy-room-escrow.js --network monad
 *
 * Guards against the wrong target: the connected chain must equal
 * ROOM_ESCROW_EXPECTED_CHAIN_ID (no default), and the treasury must be typed
 * twice (ROOM_ESCROW_TREASURY == ROOM_ESCROW_TREASURY_CONFIRM). The result —
 * address, tx hash, block, chain, owner, treasury, fee, compiler — is written
 * to deployed-room-escrow-<chainId>.json for the record. Nothing else is
 * changed.
 */

const fs = require("fs");
const path = require("path");
const PAYAI_SAFE = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
const ROOM_FEE_BPS = 50;
// PA-05 platform minimum contribution (approved 2026-10-10). Contribution
// minimums, not gas reserves. USDC's value is only valid for 6 decimals.
const MON_MIN_CONTRIBUTION = 10n ** 18n; // 1 MON
const USDC_MIN_CONTRIBUTION = 500000n;   // 0.5 USDC
const USDC_DECIMALS = 6n;

async function main() {
  if (process.env.DEPLOY_ROOM_ESCROW_CONFIRM !== "I_UNDERSTAND") {
    throw new Error("Refusing to deploy: set DEPLOY_ROOM_ESCROW_CONFIRM=I_UNDERSTAND after the audit and product sign-off.");
  }
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer key configured.");
  const owner = process.env.ROOM_ESCROW_OWNER || PAYAI_SAFE;
  const treasury = process.env.ROOM_ESCROW_TREASURY;
  if (!hre.ethers.isAddress(owner)) throw new Error(`Bad owner: ${owner}`);
  if (!treasury || !hre.ethers.isAddress(treasury)) throw new Error("ROOM_ESCROW_TREASURY must be set explicitly.");
  if ((process.env.ROOM_ESCROW_TREASURY_CONFIRM || "").toLowerCase() !== treasury.toLowerCase()) {
    throw new Error("ROOM_ESCROW_TREASURY_CONFIRM must repeat ROOM_ESCROW_TREASURY exactly.");
  }

  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const expected = Number(process.env.ROOM_ESCROW_EXPECTED_CHAIN_ID);
  if (!Number.isInteger(expected) || expected <= 0) throw new Error("ROOM_ESCROW_EXPECTED_CHAIN_ID must be set (143 for Monad mainnet).");
  if (chainId !== expected) throw new Error(`Connected to chain ${chainId}, expected ${expected}. Refusing to deploy.`);
  const isMainnet = chainId === 143;
  console.log(`Network ${hre.network.name} (chainId ${chainId}) · deployer ${deployer.address}`);
  console.log(`Owner ${owner} · treasury ${treasury} · feeBps ${ROOM_FEE_BPS} · MON minimum ${MON_MIN_CONTRIBUTION} wei`);
  // Optional pre-check of the USDC the Safe will allowlist: its decimals must be
  // 6, or 0.5 USDC != 500,000 base units and the minimum would be wrong.
  const usdc = process.env.ROOM_ESCROW_USDC;
  if (usdc) {
    if (!hre.ethers.isAddress(usdc)) throw new Error(`Bad ROOM_ESCROW_USDC: ${usdc}`);
    const dec = await new hre.ethers.Contract(usdc, ["function decimals() view returns (uint8)"], hre.ethers.provider).decimals();
    if (BigInt(dec) !== USDC_DECIMALS) throw new Error(`USDC at ${usdc} reports ${dec} decimals; the 0.5 USDC = ${USDC_MIN_CONTRIBUTION} units minimum assumes 6. Refusing.`);
    console.log(`USDC ${usdc}: ${dec} decimals — 0.5 USDC = ${USDC_MIN_CONTRIBUTION} base units confirmed.`);
  }
  if (isMainnet) {
    if (owner.toLowerCase() === deployer.address.toLowerCase()) throw new Error("On mainnet the owner must be the Safe, never the deployer EOA.");
    if ((await hre.ethers.provider.getCode(owner)) === "0x") throw new Error("On mainnet the owner must be a contract (the Safe).");
    if ((await hre.ethers.provider.getCode(treasury)) === "0x") throw new Error("On mainnet the treasury must be a contract (the Safe treasury).");
  }

  const E = await hre.ethers.getContractFactory("PayAIRoomEscrow");
  const escrow = await E.deploy(owner, treasury, ROOM_FEE_BPS, MON_MIN_CONTRIBUTION);
  const deployTx = escrow.deploymentTransaction();
  const receipt = await deployTx.wait();
  const address = await escrow.getAddress();

  // Post-deploy assertions — read back from the chain, never assumed.
  const checks = {
    owner: (await escrow.owner()).toLowerCase() === owner.toLowerCase(),
    treasury: (await escrow.treasury()).toLowerCase() === treasury.toLowerCase(),
    feeBps: Number(await escrow.feeBps()) === ROOM_FEE_BPS,
    maxFeeBps: Number(await escrow.MAX_FEE_BPS()) === ROOM_FEE_BPS,
    notPaused: (await escrow.paused()) === false,
    noRooms: (await escrow.roomCount()) === 0n,
    monMinimum: (await escrow.minContributionFloor(hre.ethers.ZeroAddress)) === MON_MIN_CONTRIBUTION,
  };
  console.log("Deployed PayAIRoomEscrow at", address, checks);
  const record = {
    contract: "PayAIRoomEscrow", address, chainId, network: hre.network.name,
    deployTx: deployTx.hash, block: receipt.blockNumber, deployer: deployer.address,
    owner, treasury, feeBps: ROOM_FEE_BPS, monMinContribution: MON_MIN_CONTRIBUTION.toString(), compiler: hre.config.solidity.compilers?.[0] ?? hre.config.solidity,
    checks, recordedAt: new Date().toISOString(),
  };
  const out = path.join(__dirname, "..", `deployed-room-escrow-${chainId}.json`);
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
  console.log("Recorded", out);
  if (Object.values(checks).some((v) => !v)) throw new Error("Post-deploy check failed — do NOT configure the app with this address.");
  console.log(`Next (from the Safe): confirm USDC decimals() == 6, then setTokenSupported(<USDC>, true) and setMinContributionFloor(<USDC>, ${USDC_MIN_CONTRIBUTION}). Then verify on Sourcify (constructor args: ${owner} ${treasury} ${ROOM_FEE_BPS} ${MON_MIN_CONTRIBUTION}) and record in contracts/LIVE_CONTRACTS.md.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
