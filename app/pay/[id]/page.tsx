import { getLinkGlobal } from "@/lib/platform/store";
import { PayWithWallet } from "@/components/PayWithWallet";
import { Logo } from "@/components/Logo";

const STATUS_TONE: Record<string, string> = {
  active: "border-primary/30 bg-primary/10 text-primary",
  paid: "border-success/30 bg-success/10 text-success",
};

/**
 * Hosted checkout page for a payment link (/pay/{id}).
 * Server component — reads the link from the store and renders a clean summary
 * with live status. Full customer wallet-connect payment is the next milestone;
 * this resolves shared links (previously 404) and shows what's owed + status.
 */
export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const link = await getLinkGlobal(id);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="rounded-lg border border-border bg-panel p-7">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Logo size={20} /> PayAI <span className="text-muted-foreground">· Payment request</span>
        </div>

        {!link ? (
          <div className="mt-6 text-center">
            <p className="text-lg text-foreground">Payment link not found</p>
            <p className="mt-1 text-sm text-muted-foreground">This link may have been removed or never existed.</p>
          </div>
        ) : (
          <>
            <div className="mt-6 text-center">
              <p className="text-4xl font-semibold tracking-tight text-foreground">
                {link.amount} <span className="text-2xl text-muted-foreground">{link.token}</span>
              </p>
              {link.memo && <p className="mt-2 text-sm text-muted-foreground">{link.memo}</p>}
            </div>

            <dl className="mt-6 space-y-2 border-t border-border pt-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium ${STATUS_TONE[link.status] ?? "border-border bg-input text-muted-foreground"}`}>
                    {link.status}
                  </span>
                </dd>
              </div>
              {link.expiresAt && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Expires</dt>
                  <dd className="text-foreground">{new Date(link.expiresAt).toLocaleString()}</dd>
                </div>
              )}
            </dl>

            <div className="mt-6">
              {link.status === "active" ? (
                link.recipient ? (
                  <>
                    <PayWithWallet linkId={link.id} amount={link.amount} recipient={link.recipient as `0x${string}`} />
                    <p className="mt-2 text-center text-xs text-muted-foreground">
                      Pays directly from your wallet on Monad — no funds pass through us.
                    </p>
                  </>
                ) : (
                  <>
                    <button disabled className="w-full cursor-not-allowed rounded-md bg-primary/40 px-4 py-2.5 text-sm font-medium text-primary-foreground">
                      Pay with wallet
                    </button>
                    <p className="mt-2 text-center text-xs text-muted-foreground">
                      This merchant hasn&apos;t connected a payout wallet yet.
                    </p>
                  </>
                )
              ) : link.status === "paid" ? (
                <p className="text-center text-sm text-success">✓ This payment has been completed.</p>
              ) : (
                <p className="text-center text-sm text-muted-foreground">This payment link has expired.</p>
              )}
            </div>
          </>
        )}
      </div>
      <p className="mt-4 text-center text-xs text-muted-foreground">Compliance-screened · settled on Monad</p>
    </main>
  );
}
