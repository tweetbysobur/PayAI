/**
 * GET /api/assistant/context?wallet=0x… — what the assistant knows before it
 * is asked anything.
 *
 * A chatbot opens empty and waits to be told everything. A payment operator
 * opens already knowing the state of the desk: whose wallet this is, what it
 * holds, what is scheduled, what needs attention. That difference is entirely
 * this endpoint — the same conversation reads completely differently when the
 * thing you are talking to already has the file open.
 *
 * It assembles from the sources that already exist and records nothing new, so
 * it can never disagree with the pages the user can go and check. Every part
 * is best-effort: a briefing missing one section is still a briefing, whereas
 * one that 500s because the price feed hiccuped is not.
 */
import { NextRequest, NextResponse } from "next/server";
import type { ScheduledPayment, TxLogEntry } from "@/lib/platform/types";
import type { WalletNotification } from "@/lib/wallet-service/types";
import type { LinkedWallet } from "@/lib/platform/linkedWallets";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Never let one slow source hold up the whole briefing. */
async function within<T>(work: Promise<T>, fallback: T, ms = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => fallback),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet") ?? "";
  if (!ADDR_RE.test(wallet)) {
    // No wallet means no scope. An operator with no file open says so rather
    // than reciting someone else's.
    return NextResponse.json({ known: false });
  }

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);
  const { denyPrivateRead } = await import("@/lib/auth/walletGrant");
  const denied = await denyPrivateRead(req, wallet);
  if (denied) return denied;

  // No balance read here on purpose. It is the only chain call in this
  // briefing, it is the slowest thing by an order of magnitude, and
  // Promise.all means it would gate everything else — a slow RPC would leave
  // the assistant staring blankly for seconds before saying anything. The
  // browser already holds live balances (useWalletBalances), so the client
  // fills that in and this stays a fast, local-only read.
  const [automations, walletEvents, linked, txs] = await Promise.all([
    within<ScheduledPayment[]>(
      import("@/lib/platform/schedules").then((m) => m.listSchedules(merchantId, { sender: wallet })),
      [],
    ),
    within<WalletNotification[]>(
      import("@/lib/platform/walletEvents").then((m) => m.listWalletEvents(merchantId, wallet)),
      [],
    ),
    within<LinkedWallet[]>(
      import("@/lib/platform/linkedWallets").then((m) => m.listLinkedWallets(wallet)),
      [],
    ),
    within<TxLogEntry[]>(
      import("@/lib/platform/store").then((m) => m.listTx(merchantId, { sender: wallet })),
      [],
    ),
  ]);

  const live = automations.filter(
    (a) => a.status === "active" || a.status === "scheduled" || a.status === "executing",
  );
  const next = live.slice().sort((a, b) => a.nextRun - b.nextRun)[0] ?? null;
  const needsAttention = automations.filter((a) => a.status === "failed" || a.status === "paused");

  const settled = txs.filter((t) => t.decision === "executed");
  const recentSwaps = settled
    .filter((t) => t.action === "swap")
    .slice(0, 3)
    .map((t) => ({ at: t.at, summary: t.summary, txHash: t.txHash ?? null }));

  const DAY = 86_400_000;
  const unseen = walletEvents.filter((e) => Date.now() - e.at < DAY).length;

  const { TEMPLATES } = await import("@/lib/automation/templates");

  return NextResponse.json({
    known: true,
    wallet,
    linkedWallets: linked.map((w) => ({ address: w.address, label: w.label })),
    automations: {
      live: live.length,
      total: automations.length,
      needsAttention: needsAttention.length,
      next: next
        ? {
            id: next.id,
            at: next.nextRun,
            amount: next.amount,
            token: next.token,
            recipient: next.domain ?? next.recipient,
          }
        : null,
    },
    // How much has actually happened here — the difference between greeting a
    // first-time user and greeting someone with a running operation.
    activity: {
      settledPayments: settled.filter((t) => t.action !== "swap").length,
      recentSwaps,
    },
    notifications: { recent: unseen },
    templates: TEMPLATES.slice(0, 6).map((t) => ({ id: t.id, name: t.name })),
  });
}
