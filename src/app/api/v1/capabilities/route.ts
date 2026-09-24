// GET /api/v1/capabilities — the capability manifest: what the Brain can do for
// a consumer app's users (chat features, work modes, knowledge sources, jobs,
// extraction, model tiers, connectors), so the spoke renders its permission
// editor from the Brain instead of a hard-coded list. See
// src/lib/capability-manifest.ts for the shape and how it is built.
//
// Auth:  Authorization: Bearer psk_...  (any valid key)
// Scope: the manifest is FILTERED to the calling key — it only lists what this
//        key's own scope could ever grant (no chat features for a retrieve-only
//        key, no call reviews / deep audits without transcripts in scope, only
//        the connectors granted to this key). org_id is resolved SERVER-SIDE.
// Returns: { version, generatedAt, groups: [{id,label}], capabilities: [...] }
//          No secrets, no org content. Cache: private, max-age=300.

import { supabaseAdmin } from "@/lib/supabase";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { buildCapabilityManifest, type ManifestConnector } from "@/lib/capability-manifest";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function GET(req: Request) {
  // Require a valid key (resolves + records usage); the key's scope then
  // decides what the manifest offers.
  let ctx;
  try {
    ctx = await resolveContext(req);
  } catch (e) {
    const err = e as AuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const connectors = await grantedConnectors(ctx.orgId, ctx.key.id);
  const manifest = buildCapabilityManifest({
    capabilities: ctx.key.capabilities ?? [],
    sourceTypes: ctx.key.source_types ?? [],
    dataSourceIds: ctx.key.data_source_ids ?? [],
    collectionIds: ctx.key.collection_ids ?? [],
    connectors,
  });

  return Response.json(manifest, { headers: { "cache-control": "private, max-age=300" } });
}

/**
 * Active connectors granted to this key (connector_grants → connectors), scoped
 * to the key's org. Best-effort: a lookup failure (or a database without the
 * connectors tables) just omits per-connector entries.
 */
async function grantedConnectors(orgId: string, keyId: string): Promise<ManifestConnector[]> {
  try {
    const db = supabaseAdmin();
    const { data: grants, error } = await db
      .from("connector_grants")
      .select("connector_id")
      .eq("org_id", orgId)
      .eq("api_key_id", keyId);
    if (error || !grants?.length) return [];
    const ids = (grants as { connector_id: string | null }[])
      .map((g) => g.connector_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return [];

    const { data: rows, error: rowsErr } = await db
      .from("connectors")
      .select("id, slug, name, kind, is_active")
      .eq("org_id", orgId)
      .in("id", ids);
    if (rowsErr || !rows) return [];
    return (rows as { id: string; slug: string | null; name: string | null; kind: string | null; is_active: boolean | null }[])
      .filter((r) => r.is_active !== false)
      .map((r) => ({ slug: r.slug || r.id, name: r.name ?? "", kind: r.kind ?? "http_api" }));
  } catch (e) {
    console.error("[v1/capabilities] connector lookup failed:", e instanceof Error ? e.message : e);
    return [];
  }
}
