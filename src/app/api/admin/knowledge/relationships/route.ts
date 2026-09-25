// /api/admin/knowledge/relationships — the edges between knowledge objects.
//   GET   ?status=suggested|confirmed|rejected|all&objectId=&limit=
//   POST  { sourceRef|sourceId, targetRef|targetId, type, note? }   → confirmed (user)
//   PATCH { id, action: "confirm" | "reject", type? }              → review a suggestion
//   PATCH { ids: uuid[] (1..200), action, type? }                   → review many at once:
//         one org-scoped set update + one batched decision-log insert
//         → { ok, updated, ids, failed: [{ id, error }] }

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { getObjectByRef, upsertRelationship, logDecision } from "@/lib/knowledge-store";
import { isRelationshipType } from "@/lib/intelligence-taxonomy";
import { BULK_MAX_IDS, type BulkFailure } from "@/lib/bulk";
import type { AdminSession } from "@/lib/auth/session";
import { guard, dbError, objectStubs, str, uuid } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// Bulk review is a single set update (plus a per-row fallback on a type
// collision): bounded DB work, far below this.
export const maxDuration = 60;

const DUPLICATE_LINK = "A link of this type already exists between these objects";

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: unknown }).code === "23505";
}

/** `ids` of a bulk request: 1..BULK_MAX_IDS uuids (deduped), or why not. */
function parseIds(v: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(v) || v.length === 0) return { error: "ids must be a non-empty array of ids" };
  const ids = new Set<string>();
  for (const x of v) {
    const id = uuid(x);
    if (!id) return { error: "ids must be uuids" };
    ids.add(id);
  }
  if (ids.size > BULK_MAX_IDS) return { error: `At most ${BULK_MAX_IDS} ids per request` };
  return { ids: Array.from(ids) };
}

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
  const action = str(body.action, 20);
  const type = str(body.type, 40);
  const patch: Record<string, unknown> = { status: action === "confirm" ? "confirmed" : "rejected" };
  if (type && isRelationshipType(type)) patch.relationship_type = type;
  const typeUsed = typeof patch.relationship_type === "string" ? patch.relationship_type : "";

  if (body.ids !== undefined) {
    if (!["confirm", "reject"].includes(action)) return Response.json({ error: "ids and action (confirm|reject) required" }, { status: 400 });
    const parsed = parseIds(body.ids);
    if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
    try {
      return await bulkReview(supabaseAdmin(), admin, parsed.ids, action, patch, typeUsed);
    } catch (e) {
      return dbError(e);
    }
  }

  const id = uuid(body.id);
  if (!id || !["confirm", "reject"].includes(action)) return Response.json({ error: "id and action (confirm|reject) required" }, { status: 400 });
  const db = supabaseAdmin();
  try {
    const { data, error } = await db.from("knowledge_relationships").update(patch).eq("id", id).eq("org_id", admin.orgId).select("*").single();
    if (error) {
      if (isUniqueViolation(error)) return Response.json({ error: DUPLICATE_LINK }, { status: 409 });
      throw error;
    }
    await logDecision(db, admin.orgId, { objectId: (data as { source_object_id?: string })?.source_object_id ?? null, stage: "relationships", decision: `user_${action}`, input: { id, type: type || undefined }, output: { by: admin.email } });
    return Response.json({ ok: true, edge: data });
  } catch (e) {
    return dbError(e);
  }
}

interface ReviewedEdge {
  id: string;
  source_object_id: string | null;
}

/**
 * Confirm / reject many edges: ONE update scoped to the admin's org (ids from
 * another org, or unknown ids, simply don't come back in `ids`), then ONE
 * batched decision-log insert. Re-typing can collide with an existing link
 * (unique source/type/target), which fails the whole statement: only then are
 * the ids applied one by one, so only the colliding ones fail.
 */
async function bulkReview(
  db: SupabaseClient,
  admin: AdminSession,
  ids: string[],
  action: string,
  patch: Record<string, unknown>,
  type: string
): Promise<Response> {
  const table = () => db.from("knowledge_relationships");
  const failed: BulkFailure[] = [];
  let rows: ReviewedEdge[] = [];

  const { data, error } = await table().update(patch).in("id", ids).eq("org_id", admin.orgId).select("id, source_object_id");
  if (!error) {
    rows = (data ?? []) as ReviewedEdge[];
  } else if (isUniqueViolation(error)) {
    for (const id of ids) {
      const r = await table().update(patch).eq("id", id).eq("org_id", admin.orgId).select("id, source_object_id");
      if (r.error) {
        failed.push({ id, error: isUniqueViolation(r.error) ? DUPLICATE_LINK : r.error.message || "Update failed" });
        continue;
      }
      rows.push(...((r.data ?? []) as ReviewedEdge[]));
    }
  } else {
    throw error;
  }

  if (rows.length > 0) {
    // Best-effort, like logDecision: the review itself already succeeded.
    try {
      await db.from("ingestion_decisions").insert(
        rows.map((r) => ({
          org_id: admin.orgId,
          object_id: r.source_object_id ?? null,
          stage: "relationships",
          decision: `user_${action}`,
          input: type ? { id: r.id, type, bulk: true } : { id: r.id, bulk: true },
          output: { by: admin.email },
        }))
      );
    } catch {
      /* best-effort */
    }
  }

  return Response.json({ ok: true, updated: rows.length, ids: rows.map((r) => r.id), failed });
}
