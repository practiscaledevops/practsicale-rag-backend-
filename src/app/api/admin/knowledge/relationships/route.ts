// /api/admin/knowledge/relationships — the edges between knowledge objects.
//   GET   ?status=suggested|confirmed|rejected|all&objectId=&limit=
//   POST  { sourceRef|sourceId, targetRef|targetId, type, note? }   → confirmed (user)
//   PATCH { id, action: "confirm" | "reject", type? }              → review a suggestion

import { supabaseAdmin } from "@/lib/supabase";
import { getObjectByRef, upsertRelationship, logDecision } from "@/lib/knowledge-store";
import { isRelationshipType } from "@/lib/intelligence-taxonomy";
import { guard, dbError, objectStubs, str, uuid } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function GET(req: Request) {
  const g = await guard();
  if ("response" in g) return g.response;
  const { admin } = g;
  const url = new URL(req.url);
  const status = str(url.searchParams.get("status"), 20) || "all";
  const objectId = uuid(url.searchParams.get("objectId"));
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 300)));
  const db = supabaseAdmin();
  try {
    let q = db.from("knowledge_relationships").select("*").eq("org_id", admin.orgId);
    if (status !== "all") q = q.eq("status", status);
    if (objectId) q = q.or(`source_object_id.eq.${objectId},target_object_id.eq.${objectId}`);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    const edges = (data ?? []) as { source_object_id: string; target_object_id: string }[];
    const objects = await objectStubs(admin.orgId, edges.flatMap((e) => [e.source_object_id, e.target_object_id]));
    const counts = await Promise.all(
      (["suggested", "confirmed", "rejected"] as const).map(async (s) => {
        const { count } = await db.from("knowledge_relationships").select("id", { count: "exact", head: true }).eq("org_id", admin.orgId).eq("status", s);
        return [s, count ?? 0] as const;
      })
    );
    return Response.json({ edges: data ?? [], objects, counts: Object.fromEntries(counts) });
  } catch (e) {
    return dbError(e);
  }
}

export async function POST(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const type = str(body.type, 40);
  if (!isRelationshipType(type)) return Response.json({ error: "Unknown relationship type" }, { status: 400 });
  const db = supabaseAdmin();
  try {
    const resolve = async (idKey: string, refKey: string) => {
      const id = uuid(body[idKey]);
      if (id) return id;
      const ref = str(body[refKey], 32);
      if (!ref) return null;
      const o = await getObjectByRef(db, admin.orgId, ref);
      return o?.id ?? null;
    };
    const sourceId = await resolve("sourceId", "sourceRef");
    const targetId = await resolve("targetId", "targetRef");
    if (!sourceId || !targetId) return Response.json({ error: "source and target objects are required (id or ref)" }, { status: 400 });
    const row = await upsertRelationship(db, admin.orgId, { sourceId, type, targetId, status: "confirmed", origin: "user", note: str(body.note, 500) || null });
    if (!row) return Response.json({ error: "Could not create the relationship" }, { status: 500 });
    await logDecision(db, admin.orgId, { objectId: sourceId, stage: "relationships", decision: "user_confirmed", input: { type, targetId }, output: { by: admin.email } });
    return Response.json({ ok: true, edge: row });
  } catch (e) {
    return dbError(e);
  }
}

export async function PATCH(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = str(body.id, 64);
  const action = str(body.action, 20);
  if (!id || !["confirm", "reject"].includes(action)) return Response.json({ error: "id and action (confirm|reject) required" }, { status: 400 });
  const db = supabaseAdmin();
  try {
    const patch: Record<string, unknown> = { status: action === "confirm" ? "confirmed" : "rejected" };
    const type = str(body.type, 40);
    if (type && isRelationshipType(type)) patch.relationship_type = type;
    const { data, error } = await db.from("knowledge_relationships").update(patch).eq("id", id).eq("org_id", admin.orgId).select("*").single();
    if (error) throw error;
    await logDecision(db, admin.orgId, { objectId: (data as { source_object_id?: string })?.source_object_id ?? null, stage: "relationships", decision: `user_${action}`, input: { id, type: type || undefined }, output: { by: admin.email } });
    return Response.json({ ok: true, edge: data });
  } catch (e) {
    return dbError(e);
  }
}
