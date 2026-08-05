import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { GET, PUT, PATCH } from "@/app/api/linked-wallets/route";
import { linkMessage, walletSettingsMessage } from "@/lib/platform/linkMessages";

/**
 * Wallet settings are account settings, so they need the account's signature.
 *
 * A default automation wallet is not cosmetic: it decides which wallet a
 * recurring payment is proposed to draw from, at 3am, with nobody watching.
 * Without a signature, anyone knowing a public address could point a
 * stranger's default at a wallet that stranger cannot sign with — turning
 * every scheduled payment into a silent failure — or rename their wallets to
 * something misleading.
 */
const ACCOUNT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const EXTERNAL_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const ATTACKER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

const account = privateKeyToAccount(ACCOUNT_KEY);
const externalWallet = privateKeyToAccount(EXTERNAL_KEY);
const attacker = privateKeyToAccount(ATTACKER_KEY);

function req(method: string, body: unknown): NextRequest {
  return new NextRequest("https://usepayai.xyz/api/linked-wallets", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function get(addr: string): NextRequest {
  return new NextRequest(`https://usepayai.xyz/api/linked-wallets?account=${addr}`);
}

/** Signs a PATCH body the way the browser does — over the exact change. */
async function signed(body: Record<string, unknown>, signer = account) {
  const payload = { account: account.address, ...body };
  return { ...payload, accountSignature: await signer.signMessage({ message: walletSettingsMessage(account.address, payload) }) };
}

async function linkExternal() {
  const message = linkMessage(account.address, externalWallet.address);
  await PUT(req("PUT", {
    account: account.address,
    external: externalWallet.address,
    label: "My MetaMask",
    accountSignature: await account.signMessage({ message }),
    externalSignature: await externalWallet.signMessage({ message }),
  }));
}

beforeEach(async () => {
  const g = globalThis as unknown as {
    __payaiLinkedWallets?: Map<string, unknown>;
    __payaiWalletDefaults?: Map<string, unknown>;
    __veripayRL?: Map<string, unknown>;
  };
  g.__payaiLinkedWallets?.clear();
  g.__payaiWalletDefaults?.clear();
  g.__veripayRL?.clear();
  await linkExternal();
});

describe("renaming a linked wallet", () => {
  it("renames when the account approves", async () => {
    const res = await PATCH(req("PATCH", await signed({ rename: { external: externalWallet.address, label: "Hardware wallet" } })));
    expect(res.status).toBe(200);
    const { wallets } = await res.json();
    expect(wallets[0].label).toBe("Hardware wallet");
  });

  it("refuses a rename nobody approved", async () => {
    const res = await PATCH(req("PATCH", {
      account: account.address,
      rename: { external: externalWallet.address, label: "Hacked" },
      accountSignature: "",
    }));
    expect(res.status).toBe(401);
    const { wallets } = await (await GET(get(account.address))).json();
    expect(wallets[0].label).toBe("My MetaMask");
  });

  it("refuses a rename signed by someone else", async () => {
    const body = await signed({ rename: { external: externalWallet.address, label: "Hacked" } }, attacker);
    const res = await PATCH(req("PATCH", body));
    expect(res.status).toBe(401);
  });

  it("refuses a signature that covered a different change", async () => {
    // The signed message embeds the exact edit, so approving one rename must
    // not authorise a different one.
    const approved = await signed({ rename: { external: externalWallet.address, label: "Cold storage" } });
    const swapped = { ...approved, rename: { external: externalWallet.address, label: "Something else entirely" } };
    const res = await PATCH(req("PATCH", swapped));
    expect(res.status).toBe(401);
  });

  it("refuses to rename a wallet that isn't linked to this account", async () => {
    const res = await PATCH(req("PATCH", await signed({ rename: { external: attacker.address, label: "Mine now" } })));
    expect(res.status).toBe(404);
  });
});

describe("default payment and automation wallets", () => {
  it("sets each independently", async () => {
    // A payment you watch and an automation that runs unattended are separate
    // decisions; one must never quietly become the other.
    await PATCH(req("PATCH", await signed({ defaults: { payment: externalWallet.address } })));
    const res = await PATCH(req("PATCH", await signed({ defaults: { automation: account.address } })));
    const { defaults } = await res.json();

    expect(defaults.payment).toBe(externalWallet.address);
    expect(defaults.automation).toBe(account.address);
  });

  it("refuses a default pointing at a wallet this account cannot sign with", async () => {
    // Otherwise every payment would fail at the last step, with the cause
    // buried in a setting nobody would think to check.
    const res = await PATCH(req("PATCH", await signed({ defaults: { automation: attacker.address } })));
    expect(res.status).toBe(409);
    const { defaults } = await (await GET(get(account.address))).json();
    expect(defaults.automation).toBeNull();
  });

  it("lets a default be cleared back to 'whichever is active'", async () => {
    await PATCH(req("PATCH", await signed({ defaults: { payment: externalWallet.address } })));
    const res = await PATCH(req("PATCH", await signed({ defaults: { payment: null } })));
    const { defaults } = await res.json();
    expect(defaults.payment).toBeNull();
  });

  it("refuses a default change nobody approved", async () => {
    const res = await PATCH(req("PATCH", {
      account: account.address,
      defaults: { automation: externalWallet.address },
      accountSignature: "",
    }));
    expect(res.status).toBe(401);
  });

  it("starts with no defaults, so nothing is chosen on the user's behalf", async () => {
    const { defaults } = await (await GET(get(account.address))).json();
    expect(defaults).toEqual({ payment: null, automation: null });
  });
});

describe("last connected", () => {
  it("records a connection only when one is actually reported", async () => {
    const before = await (await GET(get(account.address))).json();
    expect(before.wallets[0].lastConnectedAt).toBeUndefined();

    await GET(new NextRequest(
      `https://usepayai.xyz/api/linked-wallets?account=${account.address}&connected=${externalWallet.address}`,
    ));

    const after = await (await GET(get(account.address))).json();
    expect(after.wallets[0].lastConnectedAt).toBeGreaterThan(0);
  });
});
