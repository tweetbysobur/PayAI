#!/usr/bin/env node
/**
 * Verifies the already-deployed MerchantRegistry (0x3e5F94168B6748E0396d1BBB9151bC62236f4DEb,
 * Monad mainnet) via the one-call verification API, which publishes to all
 * three explorers (MonadVision, Socialscan, Monadscan) at once.
 *
 * standard-input.json and metadata.json in this folder were extracted
 * directly from the Hardhat build-info (artifacts/build-info/*.json) that
 * produced the live contract — same compiler input/output the deployed
 * bytecode came from, no need to re-run Foundry.
 *
 * MerchantRegistry's constructor takes no arguments, so no constructorArgs
 * field is needed here.
 *
 * Run this from wherever you have real network access to agents.devnads.com
 * (this sandbox's network to that host was unreliable when this was written):
 *
 *   node contracts/verification/verify-merchant-registry.js
 */
const fs = require("fs");
const path = require("path");

const standardJsonInput = JSON.parse(fs.readFileSync(path.join(__dirname, "merchant-registry", "standard-input.json"), "utf8"));
const foundryMetadata = JSON.parse(fs.readFileSync(path.join(__dirname, "merchant-registry", "metadata.json"), "utf8"));

const body = {
  chainId: 143,
  contractAddress: "0x3e5F94168B6748E0396d1BBB9151bC62236f4DEb",
  contractName: "contracts/MerchantRegistry.sol:MerchantRegistry",
  compilerVersion: "v0.8.24+commit.e11b9ed9",
  standardJsonInput,
  foundryMetadata,
};

fetch("https://agents.devnads.com/v1/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})
  .then(async (res) => {
    const text = await res.text();
    console.log(`HTTP ${res.status}`);
    console.log(text);
    if (!res.ok) process.exitCode = 1;
  })
  .catch((e) => {
    console.error("Request failed:", e.message);
    process.exitCode = 1;
  });
