// GET /api/v1/models — the selectable model catalog + per-model availability,
// so a consumer app can build a model dropdown for /api/v1/chat's `model` field.
//
// Auth:  Authorization: Bearer psk_...  (any valid key)
// Scope: NONE beyond a valid key — this is catalog metadata, not org data, so
//        there is no capability gate. org_id is still resolved server-side.
// Returns: { models: CatalogModel[] }  (id, provider, label, tier?, availability)

import { getCatalog, type Provider } from "@/lib/models-catalog";
import { getProviderKey } from "@/lib/secrets";
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

  // Availability must reflect the RESOLVED provider key (DB store -> env), not
  // just the env var — otherwise a key set via the dashboard / DB (which
  // generation actually uses) would still show models as "unavailable" and the
  // consumer's switcher would disable a model that in fact works.
  const catalog = getCatalog();
  const providers = [...new Set(catalog.map((m) => m.provider))];
  const present = new Map<Provider, boolean>();
  await Promise.all(
    providers.map(async (p) => present.set(p, Boolean(await getProviderKey(p))))
  );

  const models = catalog.map((m) => ({
    ...m,
    availability: present.get(m.provider)
      ? { status: "available" as const }
      : { status: "unavailable" as const, reason: "no api key" },
  }));

  return Response.json({ models });
}
