/**
 * Builds public/deploy/room-escrow.html: a one-time page where the deployer
 * wallet signs the PayAIRoomEscrow deploy itself, so no private key ever
 * touches a server, a script or a chat. Same fixed terms as
 * deploy-room-escrow.js (Safe as owner and treasury, 50 bps, 1 MON minimum).
 *
 *   npx hardhat compile && node scripts/build-escrow-deploy-page.js
 *
 * The page embeds the exact creation bytecode compiled from the reviewed
 * source and prints its sha256 so it can be checked against this build.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const PAYAI_SAFE = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
const DEPLOYER = "0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const ROOM_FEE_BPS = 50;
const MON_MIN_CONTRIBUTION = 10n ** 18n;
const USDC_MIN_CONTRIBUTION = 500000n;

const root = path.join(__dirname, "..");
const art = require(path.join(root, "artifacts/contracts/PayAIRoomEscrow.sol/PayAIRoomEscrow.json"));
const source = fs.readFileSync(path.join(root, "contracts/PayAIRoomEscrow.sol"));
const iface = new ethers.Interface(art.abi);

const args = iface.encodeDeploy([PAYAI_SAFE, PAYAI_SAFE, ROOM_FEE_BPS, MON_MIN_CONTRIBUTION]);
const createData = art.bytecode + args.slice(2);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const cfg = {
  chainId: 143,
  deployer: DEPLOYER,
  safe: PAYAI_SAFE,
  usdc: USDC,
  createData,
  bytecodeSha256: sha(art.bytecode),
  sourceSha256: sha(source),
  constructorArgs: args,
  reads: {
    owner: iface.encodeFunctionData("owner"),
    treasury: iface.encodeFunctionData("treasury"),
    feeBps: iface.encodeFunctionData("feeBps"),
    maxFeeBps: iface.encodeFunctionData("MAX_FEE_BPS"),
    paused: iface.encodeFunctionData("paused"),
    roomCount: iface.encodeFunctionData("roomCount"),
    monMinimum: iface.encodeFunctionData("minContributionFloor", [ethers.ZeroAddress]),
  },
  expect: {
    owner: PAYAI_SAFE.toLowerCase(),
    treasury: PAYAI_SAFE.toLowerCase(),
    feeBps: ROOM_FEE_BPS,
    maxFeeBps: ROOM_FEE_BPS,
    monMinimum: MON_MIN_CONTRIBUTION.toString(),
  },
  safeCalls: [
    { label: "setTokenSupported(USDC, true)", data: iface.encodeFunctionData("setTokenSupported", [USDC, true]) },
    { label: "setMinContributionFloor(USDC, 500000)", data: iface.encodeFunctionData("setMinContributionFloor", [USDC, USDC_MIN_CONTRIBUTION]) },
  ],
};

const template = fs.readFileSync(path.join(__dirname, "escrow-deploy-page.template.html"), "utf8");
const out = path.join(root, "..", "public", "deploy", "room-escrow.html");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, template.replace("/*__CONFIG__*/null", JSON.stringify(cfg)));
console.log(`Wrote ${out}\nsource sha256 ${cfg.sourceSha256}\nbytecode sha256 ${cfg.bytecodeSha256}`);
