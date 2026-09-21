// GET /api/admin/knowledge/entities — the entity directory (WHO and WHAT exist
// inside the knowledge). ?kind=&q=&limit=  → { entities, counts }
// ?id=<entityId> → { entity, mentions: [{role, value, object, document_id}] }

import { supabaseAdmin } from "@/lib/supabase";
import { guard, dbError, objectStubs, str } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function GET(req: Request) {
  const g = await guard();
  if ("response" in g) return g.response;
  const { admin } = g;
  const url = new URL(req.url);
  const id = str(url.searchParams.get("id"), 64);
  const kind = str(url.searchParams.get("kind"), 40);
  const q = str(url.searchParams.get("q"), 80).replace(/[%,()]/g, " ");
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 300)));
  const db = supabaseAdmin();
  try {
    if (id) {
      const { data: entity } = await db.from("entities").select("*").eq("org_id", admin.orgId).eq("id", id).maybeSingle();
      if (!entity) return Response.json({ error: "Not found" }, { status: 404 });
      const { data: mentions } = await db.from("entity_mentions").select("id, role, value, object_id, document_id, created_at").eq("org_id", admin.orgId).eq("entity_id", id).order("created_at", { ascending: false }).limit(200);
      const rows = (mentions ?? []) as { object_id: string | null }[];
      const stubs = await objectStubs(admin.orgId, rows.map((m) => m.object_id).filter((x): x is string => !!x));
      return Response.json({ entity, mentions: (mentions ?? []).map((m: { object_id: string | null }) => ({ ...m, object: m.object_id ? stubs[m.object_id] ?? null : null })) });
    }
    let query = db.from("entities").select("*").eq("org_id", admin.orgId);
    if (kind) query = query.eq("kind", kind);
    if (q) query = query.or(`name.ilike.%${q}%,slug.ilike.%${q}%`);
    const { data, error } = await query.order("mention_count", { ascending: false }).limit(limit);
    if (error) throw error;
    const counts: Record<string, number> = {};
    for (const e of (data ?? []) as { kind: string }[]) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    return Response.json({ entities: data ?? [], counts });
  } catch (e) {
    return dbError(e);
  }
}
