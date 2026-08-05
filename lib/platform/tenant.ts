/**
 * Tenant resolution. Maps an incoming request to a merchant id, which scopes all
 * platform data. Resolution order:
 *   1. `x-merchant-key: <apiKey>`  → the owning merchant (authenticated)
 *   2. DEMO_TENANT                 → shared public-demo workspace
 *
 * There is deliberately no way to name a tenant without proving you own it.
 * An `x-merchant-id` header used to be honoured on its own, which meant a
 * merchant id — not a secret, and partly derived from the merchant's own name
 * — was enough to read and write another tenant's transaction log, payment
 * links and analytics. The secret apiKey is the only credential that selects
 * a tenant now.
 *
 * Server-only.
 */
import "server-only";
import { NextRequest } from "next/server";
import { DEMO_TENANT, getMerchantByApiKey } from "./merchants";

export async function resolveTenantId(req: NextRequest): Promise<string> {
  const key = req.headers.get("x-merchant-key");
  if (key) {
    const m = await getMerchantByApiKey(key.trim());
    if (m) return m.id;
  }
  return DEMO_TENANT;
}
