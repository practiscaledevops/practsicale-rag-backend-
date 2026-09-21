// GET /api/admin/knowledge/decisions — the inspectable log of every automatic
// classification / dedup / taxonomy / relationship decision the compiler made.
//   ?objectId=&stage=&decision=&limit=

import { supabaseAdmin } from "@/lib/supabase";
import { guard, dbError, objectStubs, str } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function GET(req: Request) {
  const g = await guard();
  if ("response" in g) return g.response;
  const { admin } = g;
  const url = new URL(req.url);
  const objectId = str(url.searchParams.get("objectId"), 64);
  const stage = str(url.searchParams.get("stage"), 40);
  const decision = str(url.searchParams.get("decision"), 40);
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 200)));
  const db = supabaseAdmin();
  try {
    let q = db.from("ingestion_decisions").select("*").eq("org_id", admin.orgId);
    if (objectId) q = q.eq("object_id", objectId);
    if (stage) q = q.eq("stage", stage);
    if (decision) q = q.eq("decision", decision);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    const rows = (data ?? []) as { object_id: string | null; stage: string; decision: string }[];
    const objects = await objectStubs(admin.orgId, rows.map((r) => r.object_id).filter((x): x is string => !!x));
    const byStage: Record<string, number> = {};
    const byDecision: Record<string, number> = {};
    for (const r of rows) {
      byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
      byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
    }
    return Response.json({ decisions: data ?? [], objects, counts: { byStage, byDecision } });
  } catch (e) {
    return dbError(e);
  }
}
