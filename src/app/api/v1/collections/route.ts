// GET /api/v1/collections — the collections a scoped key may search, so a
// consumer app can offer a "source scope" selector for /api/v1/chat's
// `collectionIds`.
//
// Auth:  Authorization: Bearer psk_...  (any valid key)
// Scope: constrained to the key's own collection scope — if the key is limited to
//        specific collections, only those are returned; an unrestricted key sees
//        every collection in its org. org_id is resolved SERVER-SIDE.
// Returns: { collections: [{ id, name }] }

import { supabaseAdmin } from "@/lib/supabase";
import { resolveContext, AuthError } from "@/lib/auth/context";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function GET(req: Request) {
  let ctx;
  try {
    ctx = await resolveContext(req);
  } catch (e) {
    const err = e as AuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const scoped = ctx.key.collection_ids ?? [];
  let q = supabaseAdmin()
    .from("collections")
    .select("id, name")
    .eq("org_id", ctx.orgId)
    .order("name", { ascending: true });
  // A non-empty key scope restricts to exactly those collections.
  if (scoped.length > 0) q = q.in("id", scoped);

  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const collections = ((data ?? []) as { id: string; name: string | null }[]).map((c) => ({
    id: c.id,
    name: c.name ?? "Untitled",
  }));
  return Response.json({ collections });
}
