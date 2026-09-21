// GET /api/admin/knowledge/objects — list knowledge objects with filters + counts.
//   ?class=&domain=&type=&subtype=&status=&endorsement=&validation=&bucket=&q=&limit=
// Returns { objects: [...], counts: { byClass, byStatus }, total }.

import { supabaseAdmin } from "@/lib/supabase";
import { OBJECT_COLUMNS, type KnowledgeObjectRow } from "@/lib/knowledge-store";
import { INTELLIGENCE_CLASSES, realityBucketOf } from "@/lib/intelligence-taxonomy";
import { guard, dbError, str } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function GET(req: Request) {
  const g = await guard();
  if ("response" in g) return g.response;
  const { admin } = g;
  const url = new URL(req.url);
  const p = (k: string) => str(url.searchParams.get(k), 120);
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 300)));
  const db = supabaseAdmin();

  try {
    let q = db.from("knowledge_objects").select(OBJECT_COLUMNS).eq("org_id", admin.orgId);
    if (p("class")) q = q.eq("intelligence_class", p("class"));
    if (p("domain")) q = q.eq("domain", p("domain"));
    if (p("type")) q = q.eq("object_type", p("type"));
    if (p("subtype")) q = q.eq("subtype", p("subtype"));
    if (p("status")) q = q.eq("status", p("status"));
    if (p("endorsement")) q = q.eq("founder_endorsement", p("endorsement"));
    if (p("validation")) q = q.eq("internal_validation", p("validation"));
    if (p("q")) {
      const term = p("q").replace(/[%,()]/g, " ");
      q = q.or(`name.ilike.%${term}%,ref.ilike.%${term}%,summary.ilike.%${term}%`);
    }
    const { data, error } = await q.order("updated_at", { ascending: false }).limit(limit);
    if (error) throw error;
    let objects = (data ?? []) as unknown as KnowledgeObjectRow[];
    const bucket = p("bucket");
    if (bucket) objects = objects.filter((o) => o.intelligence_class === "business_reality" && realityBucketOf(o) === bucket);

    // Counts per class (parallel head counts) + per status for the tab badges.
    const classes = INTELLIGENCE_CLASSES.map((c) => c.id);
    const counts = await Promise.all(
      classes.map(async (c) => {
        const { count } = await db.from("knowledge_objects").select("id", { count: "exact", head: true }).eq("org_id", admin.orgId).eq("intelligence_class", c);
        return [c, count ?? 0] as const;
      })
    );
    const byClass = Object.fromEntries(counts);
    const total = counts.reduce((a, [, n]) => a + n, 0);
    const byStatus: Record<string, number> = {};
    for (const o of objects) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

    return Response.json({
      objects: objects.map((o) => ({ ...o, bucket: o.intelligence_class === "business_reality" ? realityBucketOf(o) : null })),
      counts: { byClass, byStatus },
      total,
    });
  } catch (e) {
    return dbError(e);
  }
}
