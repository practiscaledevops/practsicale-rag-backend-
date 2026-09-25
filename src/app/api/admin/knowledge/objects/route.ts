// /api/admin/knowledge/objects
//   GET    — list knowledge objects with filters + counts.
//            ?class=&domain=&type=&subtype=&status=&endorsement=&validation=&bucket=&q=&limit=
//            Returns { objects: [...], counts: { byClass, byStatus }, total }.
//   PATCH  — bulk governance edit. Body { ids: uuid[] (1..200), patch: { status?,
//            priority?, founder_endorsement? (null clears), implementation_status?,
//            internal_validation?, evidence_level?, verify_now?: true } }.
//            Each object gets the single-object side effects (authority recompute,
//            frontmatter rebuild, decision log); no names, taxonomy or markdown.
//            Returns { ok, updated: ids, objects: [governance fields], failed:
//            [{ id, error, status? }], remaining: ids } — `remaining` = not started
//            within the time budget; send them again.
//   DELETE — bulk delete. Body { ids: uuid[] (1..200) }. Removes each object's
//            compiled + raw documents (chunks cascade), then the objects (edges,
//            mentions and learning records cascade). Returns { ok, deleted: ids,
//            deletedDocuments, failed: [{ id, error, status }] }.
// Every statement is scoped to the admin's org; the per-object routes live in [id].

import { supabaseAdmin } from "@/lib/supabase";
import { OBJECT_COLUMNS, type KnowledgeObjectRow } from "@/lib/knowledge-store";
import { INTELLIGENCE_CLASSES, realityBucketOf } from "@/lib/intelligence-taxonomy";
import { guard, dbError, str } from "../_shared";
import { bulkApplyGovernance, bulkGovernancePatch, parseBulkIds, BULK_MAX_IDS, type BulkFailureOut } from "./_governance";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// A bulk governance edit touches up to 200 objects (~3 statements each) and
// stops starting new ones after 80s; the time budget keeps it well inside this.
export const maxDuration = 120;

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

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body = (await req.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export async function PATCH(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Expected a JSON body { ids, patch }" }, { status: 400 });
  const parsed = parseBulkIds(body.ids, BULK_MAX_IDS);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const patch = bulkGovernancePatch(body.patch);
  if (Object.keys(patch).length === 0) {
    return Response.json(
      { error: "Nothing to change: set status, priority, founder_endorsement, implementation_status, internal_validation, evidence_level or verify_now" },
      { status: 400 }
    );
  }
  const db = supabaseAdmin();
  try {
    const r = await bulkApplyGovernance(db, admin.orgId, parsed.ids, patch, admin.email);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return dbError(e);
  }
}

/** `in (…)` filters travel in the URL: keep each statement's id list short. */
const DELETE_BATCH = 100;
/** Objects per delete slice: at most 2 documents each, so one slice's documents fit one statement. */
const OBJECT_DELETE_SLICE = DELETE_BATCH / 2;

export async function DELETE(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Expected a JSON body { ids }" }, { status: 400 });
  const parsed = parseBulkIds(body.ids, BULK_MAX_IDS);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const { ids } = parsed;
  const db = supabaseAdmin();
  try {
    const { data, error } = await db
      .from("knowledge_objects")
      .select("id, document_id, raw_document_id")
      .eq("org_id", admin.orgId)
      .in("id", ids);
    if (error) throw error;
    const rows = (data ?? []) as { id: string; document_id: string | null; raw_document_id: string | null }[];
    const found = rows.map((r) => r.id);
    const failed: BulkFailureOut[] = ids.filter((id) => !found.includes(id)).map((id) => ({ id, error: "Not found", status: 404 }));
    if (found.length === 0) return Response.json({ ok: true, deleted: [], deletedDocuments: 0, failed });

    // Slice by slice: a slice's compiled + raw documents first (chunks cascade),
    // as the single DELETE does, then its objects. A failing slice is reported
    // in `failed` and the next one still runs, so the response always says
    // exactly which objects are gone (never a 500 after some were deleted).
    const deleted: string[] = [];
    let deletedDocuments = 0;
    for (let i = 0; i < rows.length; i += OBJECT_DELETE_SLICE) {
      const slice = rows.slice(i, i + OBJECT_DELETE_SLICE);
      const sliceIds = slice.map((r) => r.id);
      const sliceDocs = Array.from(
        new Set(slice.flatMap((r) => [r.document_id, r.raw_document_id]).filter((x): x is string => !!x))
      );
      try {
        if (sliceDocs.length > 0) {
          const { data: gone, error: docError } = await db
            .from("documents")
            .delete()
            .eq("org_id", admin.orgId)
            .in("id", sliceDocs)
            .select("id");
          if (docError) throw docError;
          deletedDocuments += (gone ?? []).length;
        }
        const { data: removed, error: objError } = await db
          .from("knowledge_objects")
          .delete()
          .eq("org_id", admin.orgId)
          .in("id", sliceIds)
          .select("id");
        if (objError) throw objError;
        const done = new Set(((removed ?? []) as { id: string }[]).map((r) => r.id));
        for (const id of sliceIds) {
          if (done.has(id)) deleted.push(id);
          else failed.push({ id, error: "Not found or already deleted", status: 404 });
        }
      } catch (e) {
        const raw = e instanceof Error ? e.message : (e as { message?: unknown } | null)?.message;
        const msg = typeof raw === "string" && raw ? raw : "Delete failed";
        for (const id of sliceIds) failed.push({ id, error: msg, status: 500 });
      }
    }
    return Response.json({ ok: true, deleted, deletedDocuments, failed });
  } catch (e) {
    return dbError(e);
  }
}
