import { describe, it, expect } from "vitest";
import { encodeAbiParameters, decodeFunctionData, parseEther, parseUnits, toEventHash, pad, numberToHex } from "viem";
import {
  PAYAI_FORWARDER_ABI,
  ERC20_ALLOWANCE_APPROVE_ABI,
  buildForwardNativeTx,
  buildForwardErc20Tx,
  buildApproveForwarderTx,
  forwardAmountUnits,
  decodePaymentForwarded,
  verifyPaymentForwarded,
  toRef,
} from "@/lib/monad/forwarder";

const FWD = "0x7777777777777777777777777777777777777777" as `0x${string}`;
const WALLET = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const RECIP = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const TOKEN = "0x3333333333333333333333333333333333333333" as `0x${string}`;

describe("forwarder calldata builders", () => {
  it("native: targets the forwarder, attaches the value, encodes forwardPaymentNative(recipient, amount, ref)", () => {
    const tx = buildForwardNativeTx(FWD, WALLET, RECIP, 1.5, "intent-1");
    expect(tx.to.toLowerCase()).toBe(FWD.toLowerCase());
    expect(tx.from).toBe(WALLET);
    expect(BigInt(tx.value)).toBe(parseEther("1.5"));
    const decoded = decodeFunctionData({ abi: PAYAI_FORWARDER_ABI, data: tx.data });
    expect(decoded.functionName).toBe("forwardPaymentNative");
    expect((decoded.args as readonly unknown[])[0]).toBe(RECIP);
    expect((decoded.args as readonly unknown[])[1]).toBe(parseEther("1.5"));
    expect((decoded.args as readonly unknown[])[2]).toBe(toRef("intent-1"));
  });

  it("native: value equals the encoded amount arg exactly (no mismatch the contract would reject)", () => {
    const tx = buildForwardNativeTx(FWD, WALLET, RECIP, 0.0000001, "x"); // sub-1e-6, exponential-notation trap
    const decoded = decodeFunctionData({ abi: PAYAI_FORWARDER_ABI, data: tx.data });
    expect(BigInt(tx.value)).toBe((decoded.args as readonly unknown[])[1]);
  });

  it("erc20: zero value, encodes forwardPayment(token, recipient, amount, ref) in token units", () => {
    const tx = buildForwardErc20Tx(FWD, WALLET, TOKEN, RECIP, 50, 6, "intent-2");
    expect(tx.to.toLowerCase()).toBe(FWD.toLowerCase());
    expect(tx.value).toBe("0x0");
    const decoded = decodeFunctionData({ abi: PAYAI_FORWARDER_ABI, data: tx.data });
    expect(decoded.functionName).toBe("forwardPayment");
    expect((decoded.args as readonly unknown[])[0]).toBe(TOKEN);
    expect((decoded.args as readonly unknown[])[1]).toBe(RECIP);
    expect((decoded.args as readonly unknown[])[2]).toBe(parseUnits("50", 6));
  });

  it("ref: empty -> zero ref; non-empty -> deterministic non-zero bytes32", () => {
    expect(toRef("")).toBe(`0x${"0".repeat(64)}`);
    expect(toRef(null)).toBe(`0x${"0".repeat(64)}`);
    const a = toRef("same");
    const b = toRef("same");
    expect(a).toBe(b);
    expect(a).not.toBe(`0x${"0".repeat(64)}`);
    expect(toRef("different")).not.toBe(a);
  });
});

describe("buildApproveForwarderTx (exact-amount ERC-20 approval)", () => {
  const MAX_UINT256 = (2n ** 256n) - 1n;

  it("approves the FORWARDER as spender for the EXACT amount, never MAX_UINT256", () => {
    const tx = buildApproveForwarderTx(TOKEN, WALLET, FWD, 50, 6);
    expect(tx.to.toLowerCase()).toBe(TOKEN.toLowerCase()); // approval targets the token
    expect(tx.from).toBe(WALLET);
    expect(tx.value).toBe("0x0");
    const decoded = decodeFunctionData({ abi: ERC20_ALLOWANCE_APPROVE_ABI, data: tx.data });
    expect(decoded.functionName).toBe("approve");
    const [spender, amount] = decoded.args as readonly unknown[];
    expect((spender as string).toLowerCase()).toBe(FWD.toLowerCase()); // spender is ALWAYS the forwarder
    expect(amount).toBe(parseUnits("50", 6)); // exact
    expect(amount).not.toBe(MAX_UINT256); // never unlimited
  });

  it("the approved amount exactly equals what the forward will pull (no drift)", () => {
    const approve = buildApproveForwarderTx(TOKEN, WALLET, FWD, 50, 6);
    const [, approvedAmount] = decodeFunctionData({ abi: ERC20_ALLOWANCE_APPROVE_ABI, data: approve.data }).args as readonly unknown[];
    expect(approvedAmount).toBe(forwardAmountUnits(50, 6));
    // ...and the forward tx encodes that same amount.
    const forward = buildForwardErc20Tx(FWD, WALLET, TOKEN, RECIP, 50, 6, "r");
    const forwardAmount = (decodeFunctionData({ abi: PAYAI_FORWARDER_ABI, data: forward.data }).args as readonly unknown[])[2];
    expect(forwardAmount).toBe(approvedAmount);
  });
});

describe("verifyPaymentForwarded (result verification — never trust client amounts)", () => {
  const base = () => ({
    ev: { id: 1n, payer: WALLET, recipient: RECIP, token: TOKEN, amount: parseUnits("50", 6), ref: toRef("r") },
    expected: { payer: WALLET, recipient: RECIP, token: TOKEN, amountUnits: parseUnits("50", 6) },
  });

  it("passes when payer, recipient, token and amount all match", () => {
    const { ev, expected } = base();
    expect(verifyPaymentForwarded(ev, expected)).toBe(true);
  });
  it("fails on a payer mismatch", () => {
    const { ev, expected } = base();
    expect(verifyPaymentForwarded(ev, { ...expected, payer: "0x4444444444444444444444444444444444444444" })).toBe(false);
  });
  it("fails on a recipient mismatch", () => {
    const { ev, expected } = base();
    expect(verifyPaymentForwarded(ev, { ...expected, recipient: "0x5555555555555555555555555555555555555555" })).toBe(false);
  });
  it("fails on a token mismatch", () => {
    const { ev, expected } = base();
    expect(verifyPaymentForwarded(ev, { ...expected, token: "0x6666666666666666666666666666666666666666" })).toBe(false);
  });
  it("fails on an amount mismatch (even off by one base unit)", () => {
    const { ev, expected } = base();
    expect(verifyPaymentForwarded(ev, { ...expected, amountUnits: parseUnits("50", 6) + 1n })).toBe(false);
  });
  it("is case-insensitive on addresses (checksummed vs lowercase both match)", () => {
    const { ev, expected } = base();
    expect(verifyPaymentForwarded(ev, { ...expected, payer: WALLET.toUpperCase().replace("0X", "0x") as `0x${string}` })).toBe(true);
  });
});

describe("decodePaymentForwarded", () => {
  const EVENT_SIG = toEventHash("PaymentForwarded(uint256,address,address,address,uint256,bytes32)");
  function makeLog(args: { id: bigint; payer: `0x${string}`; recipient: `0x${string}`; token: `0x${string}`; amount: bigint; ref: `0x${string}` }, address: `0x${string}`) {
    // Indexed topics (id, payer, recipient) are each 32-byte left-padded; the
    // three non-indexed fields (token, amount, ref) go in `data`.
    const topics = [
      EVENT_SIG,
      pad(numberToHex(args.id), { size: 32 }),
      pad(args.payer, { size: 32 }),
      pad(args.recipient, { size: 32 }),
    ] as [`0x${string}`, ...`0x${string}`[]];
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [args.token, args.amount, args.ref],
    );
    return { address, topics, data };
  }

  it("decodes a real PaymentForwarded log emitted by the forwarder", () => {
    const log = makeLog(
      { id: 7n, payer: WALLET, recipient: RECIP, token: "0x0000000000000000000000000000000000000000", amount: parseEther("2"), ref: toRef("r") },
      FWD,
    );
    const ev = decodePaymentForwarded([log], FWD);
    expect(ev).not.toBeNull();
    expect(ev!.id).toBe(7n);
    expect(ev!.payer.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(ev!.recipient.toLowerCase()).toBe(RECIP.toLowerCase());
    expect(ev!.token).toBe("0x0000000000000000000000000000000000000000");
    expect(ev!.amount).toBe(parseEther("2"));
  });

  it("ignores logs from a DIFFERENT address (only the configured forwarder counts)", () => {
    const other = "0x9999999999999999999999999999999999999999" as `0x${string}`;
    const log = makeLog(
      { id: 1n, payer: WALLET, recipient: RECIP, token: TOKEN, amount: 1n, ref: toRef("r") },
      other,
    );
    expect(decodePaymentForwarded([log], FWD)).toBeNull();
  });

  it("returns null when there is no PaymentForwarded event at all (must never read as success)", () => {
    expect(decodePaymentForwarded([], FWD)).toBeNull();
  });
});
