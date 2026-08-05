import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { GET, PUT, DELETE } from "@/app/api/linked-wallets/route";
import { linkMessage, unlinkMessage } from "@/lib/platform/linkMessages";
import { MAX_LINKED_WALLETS } from "@/lib/platform/linkedWallets";

/**
 * Attaching a wallet to an account takes proof from BOTH ends.
 *
 * The external wallet has to prove it is held by whoever is asking — obvious.
 * The account has to prove it meant to attach it — less obvious, and the one
 * that matters more: every address is public, so without it an attacker needs
 * nothing but a victim's address to staple their own wallet onto that
 * victim's account. A wallet the user doesn't recognise showing up under
 * "your wallets" is the setup for "just move it to your linked wallet".
 */

const ACCOUNT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const EXTERNAL_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const ATTACKER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

const account = privateKeyToAccount(ACCOUNT_KEY);
const externalWallet = privateKeyToAccount(EXTERNAL_KEY);
const attacker = privateKeyToAccount(ATTACKER_KEY);

function put(body: unknown): NextRequest {
  return new NextRequest("https://usepayai.xyz/api/linked-wallets", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function del(body: unknown): NextRequest {
  return new NextRequest("https://usepayai.xyz/api/linked-wallets", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function get(addr: string): NextRequest {
  return new NextRequest(`https://usepayai.xyz/api/linked-wallets?account=${addr}`);
}

async function bothSigned(externalAddr = externalWallet.address, signer = externalWallet) {
  const message = linkMessage(account.address, externalAddr);
  return {
    account: account.address,
    external: externalAddr,
    label: "My MetaMask",
    accountSignature: await account.signMessage({ message }),
    externalSignature: await signer.signMessage({ message }),
  };
}

describe("linking a wallet to a PayAI account", () => {
  beforeEach(() => {
    const g = globalThis as unknown as { __payaiLinkedWallets?: Map<string, unknown>; __veripayRL?: Map<string, unknown> };
    g.__payaiLinkedWallets?.clear();
    g.__veripayRL?.clear();
  });

  it("links when both wallets have approved", async () => {
    const res = await PUT(put(await bothSigned()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wallets).toHaveLength(1);
    expect(body.wallets[0].address).toBe(externalWallet.address.toLowerCase());
    expect(body.wallets[0].label).toBe("My MetaMask");
  });

  it("refuses without the account's approval — nobody may attach a wallet to a stranger's account", async () => {
    const payload = await bothSigned();
    const res = await PUT(put({ ...payload, accountSignature: "" }));
    expect(res.status).toBe(401);

    const listed = await (await GET(get(account.address))).json();
    expect(listed.wallets, "an unapproved link must leave no trace").toHaveLength(0);
  });

  it("refuses an account signature produced by someone else", async () => {
    // The attacker holds the wallet being linked and signs the account side
    // with their own key, hoping the server only checks that *a* signature
    // verifies rather than that it verifies against the account.
    const message = linkMessage(account.address, attacker.address);
    const res = await PUT(put({
      account: account.address,
      external: attacker.address,
      label: "Definitely yours",
      accountSignature: await attacker.signMessage({ message }),
      externalSignature: await attacker.signMessage({ message }),
    }));
    expect(res.status).toBe(401);
    const listed = await (await GET(get(account.address))).json();
    expect(listed.wallets).toHaveLength(0);
  });

  it("refuses without the external wallet's approval", async () => {
    const payload = await bothSigned();
    const res = await PUT(put({ ...payload, externalSignature: "" }));
    expect(res.status).toBe(401);
  });

  it("refuses a signature that names a different pair of wallets", async () => {
    // A signature captured from one link attempt must not be replayable to
    // attach that wallet somewhere else — which is why the message names both
    // addresses.
    const otherMessage = linkMessage(attacker.address, externalWallet.address);
    const res = await PUT(put({
      account: account.address,
      external: externalWallet.address,
      label: "Replayed",
      accountSignature: await account.signMessage({ message: otherMessage }),
      externalSignature: await externalWallet.signMessage({ message: otherMessage }),
    }));
    expect(res.status).toBe(401);
  });

  it("is idempotent — re-linking the same wallet does not add a second row", async () => {
    await PUT(put(await bothSigned()));
    const res = await PUT(put(await bothSigned()));
    const body = await res.json();
    expect(body.wallets).toHaveLength(1);
    expect(body.alreadyLinked).toBe(true);
  });

  it("refuses to link an account to itself", async () => {
    const message = linkMessage(account.address, account.address);
    const sig = await account.signMessage({ message });
    const res = await PUT(put({
      account: account.address, external: account.address, label: "Me",
      accountSignature: sig, externalSignature: sig,
    }));
    expect(res.status).toBe(409);
  });

  it("caps how many wallets one account can carry", async () => {
    const keys = [
      "0x0000000000000000000000000000000000000000000000000000000000000011",
      "0x0000000000000000000000000000000000000000000000000000000000000012",
      "0x0000000000000000000000000000000000000000000000000000000000000013",
      "0x0000000000000000000000000000000000000000000000000000000000000014",
      "0x0000000000000000000000000000000000000000000000000000000000000015",
      "0x0000000000000000000000000000000000000000000000000000000000000016",
    ] as const;
    let lastStatus = 0;
    for (const k of keys) {
      const signer = privateKeyToAccount(k);
      const res = await PUT(put(await bothSigned(signer.address, signer)));
      lastStatus = res.status;
    }
    expect(keys.length).toBeGreaterThan(MAX_LINKED_WALLETS);
    expect(lastStatus, "the wallet past the cap must be refused").toBe(409);
    const listed = await (await GET(get(account.address))).json();
    expect(listed.wallets).toHaveLength(MAX_LINKED_WALLETS);
  });
});

describe("unlinking", () => {
  beforeEach(async () => {
    const g = globalThis as unknown as { __payaiLinkedWallets?: Map<string, unknown>; __veripayRL?: Map<string, unknown> };
    g.__payaiLinkedWallets?.clear();
    g.__veripayRL?.clear();
    await PUT(put(await bothSigned()));
  });

  it("removes a wallet when the account approves", async () => {
    const message = unlinkMessage(account.address, externalWallet.address);
    const res = await DELETE(del({
      account: account.address,
      external: externalWallet.address,
      accountSignature: await account.signMessage({ message }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).wallets).toHaveLength(0);
  });

  it("needs no signature from the wallet being removed", async () => {
    // Someone who has lost access to an external wallet still has to be able
    // to take it off their account. Requiring its signature would strand them.
    const message = unlinkMessage(account.address, externalWallet.address);
    const res = await DELETE(del({
      account: account.address,
      external: externalWallet.address,
      accountSignature: await account.signMessage({ message }),
    }));
    expect(res.status).toBe(200);
  });

  it("refuses an unlink nobody approved", async () => {
    const res = await DELETE(del({
      account: account.address,
      external: externalWallet.address,
      accountSignature: "",
    }));
    expect(res.status).toBe(401);
    const listed = await (await GET(get(account.address))).json();
    expect(listed.wallets).toHaveLength(1);
  });

  it("refuses a link signature replayed as an unlink", async () => {
    // The two messages are worded differently precisely so one cannot stand
    // in for the other.
    const res = await DELETE(del({
      account: account.address,
      external: externalWallet.address,
      accountSignature: await account.signMessage({
        message: linkMessage(account.address, externalWallet.address),
      }),
    }));
    expect(res.status).toBe(401);
  });
});
