/**
 * Tenant resolution. Maps an incoming request to a merchant id, which scopes all
 * platform data. Resolution order:
 *   1. `x-merchant-key: <apiKey>`  → the owning merchant (authenticated)
 *   2. `x-merchant-id: <id>`       → explicit tenant (dashboard, after sign-in)
 *   3. DEMO_TENANT                 → shared public-demo workspace
 *
 * Server-only.
 */
import "server-only";
import { NextRequest } from "next/server";
import { DEMO_TENANT, getMerchantByApiKey, getMerchantById } from "./merchants";

export async function resolveTenantId(req: NextRequest): Promise<string> {
  const key = req.headers.get("x-merchant-key");
  if (key) {
    const m = await getMerchantByApiKey(key.trim());
    if (m) return m.id;
  }
  const id = req.headers.get("x-merchant-id")?.trim();
  if (id) {
    const m = await getMerchantById(id);
    if (m) return m.id;
  }
  return DEMO_TENANT;
}
