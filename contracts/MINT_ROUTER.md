# MintRouter

A fee-taking router for NFT mints. A buyer pays the mint price plus a service
fee (default 10%) to the router. The router mints from the target NFT, delivers
the NFT to the buyer, sends the fee to your wallet, and refunds any excess.

## Why a router

Non-custodial minting sends funds straight to the NFT contract, so there is no
way to skim a fee. The router sits in the middle: it collects payment, forwards
the exact mint price, keeps the fee, and passes the NFT on to the buyer.

## Compatibility

The target NFT must mint via the ERC-721 safe path (`_safeMint`), which calls
`onERC721Received` on the router so it learns the token id and can forward it.
Most standard collections do this. Confirm the live contract before pointing the
router at it. A contract that mints with the non-safe `_mint` will revert on the
router's `TokenNotReceived` guard.

## Flow

1. `quote()` returns the total the buyer must send (price + fee).
2. Buyer (or the bot on their behalf) calls `mintFor(buyer)` with that value.
3. Router calls the target mint with `mintPrice`, receives the NFT, forwards it
   to `buyer`, pays the fee, refunds excess.

## Deploy

```bash
# testnet first — always
FEE_RECIPIENT=0xYourFeeWallet \
  npx hardhat run scripts/deploy-mint-router.js --network monadTestnet
```

## Configure when the live NFT is known

```solidity
router.setTarget(nftAddress, mintPriceWei);   // price the NFT charges per mint
router.setMintCalldata(mintCalldata);          // e.g. the selector of mint()
```

`mintCalldata` is the exact bytes sent to the NFT's mint function. For a
mint-to-caller `mint()` it is just that function's 4-byte selector. For other
shapes, encode the full call. Ask before setting this on mainnet.

## Safety

- Owner is a cold wallet. It configures target/price/fee but never takes user
  funds. `mintFor` is the only user path.
- Fee is capped at 50% in the constructor and `setFeeConfig`.
- `sweep` / `sweepNFT` let the owner rescue anything stuck from a failed forward.
- Reentrancy guarded. Funds are pushed each mint; the router holds nothing
  between calls.

## Tests

`test/mint-router.test.js` covers quoting, minting + delivery + fee, refunds,
underpayment, unconfigured revert, access control, and the fee cap. Run them on
a machine with Solidity compiler access (this repo's CI, or local):

```bash
npx hardhat test test/mint-router.test.js
```

## Not yet audited

This handles real funds. Deploy to testnet, run one real mint end to end, and
review before pointing it at a mainnet drop.
