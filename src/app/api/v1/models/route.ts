// GET /api/v1/models — the selectable model catalog + per-model availability,
// so a consumer app can build a model dropdown for /api/v1/chat's `model` field.
//
// Auth:  Authorization: Bearer psk_...  (any valid key)
// Scope: NONE beyond a valid key — this is catalog metadata, not org data, so
//        there is no capability gate. org_id is still resolved server-side.
// Returns: { models: CatalogModel[] }  (id, provider, label, tier?, availability)

import { getCatalog } from "@/lib/models-catalog";
import { resolveContext, AuthError } from "@/lib/auth/context";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function GET(req: Request) {
  // Require a valid key (resolves + records usage), but no capability check.
  try {
    await resolveContext(req);
  } catch (e) {
    const err = e as AuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  return Response.json({ models: getCatalog() });
}
