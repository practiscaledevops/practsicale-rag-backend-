// GET    /api/admin/documents      — list this org's documents + chunk counts
//                                    + Operating Intelligence lane (class/domain/object).
// DELETE /api/admin/documents?id=…  — delete one document (chunks cascade).
// DELETE /api/admin/documents  { ids: uuid[] (1..200) }
//                                  — bulk delete in ONE org-scoped statement.
//                                    → { ok, deleted, ids: [deleted ids], failed: [{ id, error }] }
//
// org_id is resolved SERVER-SIDE from the admin session and every query is
// filtered by it, so a request can only ever read or delete documents within the
// caller's own tenant. Deleting a document cascades to its chunks and collection
// memberships via the FK `on delete cascade` rules (see migrations 0001 / 0008);
// a knowledge object that points at it keeps its record (`on delete set null`, 0017).

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { isDemo } from "@/lib/demo/mode";
import { isMissingRelation } from "@/lib/knowledge-store";
import { objectStubs } from "@/app/api/admin/knowledge/_shared";
import { BULK_MAX_IDS } from "@/lib/bulk";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// A bulk delete is one set-based statement (≤200 documents plus their cascading
// chunks): seconds, not minutes.
export const maxDuration = 60;

// Embedded aggregate: PostgREST returns chunks as [{ count: n }] for each doc.
const SELECT = "id, title, source_type, uri, created_at, chunks(count)";
// Lane identity added by migration 0017 (documents.intelligence_class / domain /
// object_id). Selected when present; the list falls back to SELECT without them.
const LANE_SELECT = `${SELECT}, intelligence_class, domain, object_id`;

// Documents scale with ingested records (a pull sync writes one document per
// record), so bound the list. 1000 comfortably covers a single-org back office;
// pagination is the follow-up if a tenant ever outgrows it.
const LIST_LIMIT = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The in-memory demo store uses short ids ("doc-1"); only demo mode accepts them.
const DEMO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface DocRow {
  id: string;
  title: string | null;
  source_type: string;
  uri: string | null;
  created_at: string;
  chunks: { count: number }[] | null;
  intelligence_class?: string | null;
  domain?: string | null;
  object_id?: string | null;
}

export async function GET() {
  let admin;
  try {
    admin = await requireAdmin("documents:read");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const db = supabaseAdmin();
  const list = (select: string) =>
    db.from("documents").select(select).eq("org_id", admin.orgId).order("created_at", { ascending: false }).limit(LIST_LIMIT);

  const first = await list(LANE_SELECT);
  // Pre-migration 0017 (42703 undefined_column): list without the lane columns.
  const { data, error } = first.error && isMissingRelation(first.error) ? await list(SELECT) : first;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as DocRow[];
  const objects = await objectStubs(admin.orgId, rows.map((d) => d.object_id ?? ""));

  const documents = rows.map((d) => {
    const object = d.object_id ? objects[d.object_id] : undefined;
    return {
      id: d.id,
      title: d.title,
      source_type: d.source_type,
      uri: d.uri,
      created_at: d.created_at,
      chunk_count: d.chunks?.[0]?.count ?? 0,
      intelligence_class: d.intelligence_class ?? null,
      domain: d.domain ?? null,
      object_id: d.object_id ?? null,
      object_ref: object?.ref ?? null,
      object_name: object?.name ?? null,
    };
  });

  return Response.json({ documents });
}

/**
 * Validate a bulk id list: 1..BULK_MAX_IDS UUIDs, deduped and lower-cased (the
 * form Postgres returns them in, so the response ids match the request's).
 */
function parseIds(value: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: "ids must be a non-empty array of document ids" };
  if (value.length > BULK_MAX_IDS) return { error: `At most ${BULK_MAX_IDS} ids per request` };
  const ids = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string" || !(isDemo() ? DEMO_ID_RE : UUID_RE).test(v.trim())) return { error: "Every id must be a document UUID" };
    ids.add(v.trim().toLowerCase());
  }
  return { ids: [...ids] };
}

export async function DELETE(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("documents:write");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return deleteMany(req, admin.orgId);

  const db = supabaseAdmin();
  // Scope the delete to this org — a foreign id simply matches nothing (count 0).
  const { error, count } = await db
    .from("documents")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", admin.orgId);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!count) return Response.json({ error: "Document not found" }, { status: 404 });

  return Response.json({ ok: true });
}

/** Bulk form: `{ ids }` in the JSON body. One statement, scoped to the caller's org. */
async function deleteMany(req: Request, orgId: string): Promise<Response> {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const raw = body && typeof body === "object" ? (body as { ids?: unknown }).ids : undefined;
  if (raw === undefined) {
    return Response.json({ error: "id query param (or an ids array in the body) is required" }, { status: 400 });
  }
  const parsed = parseIds(raw);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });

  const db = supabaseAdmin();
  // A foreign or already-deleted id matches nothing and is reported as failed.
  const { data, error } = await db
    .from("documents")
    .delete()
    .in("id", parsed.ids)
    .eq("org_id", orgId)
    .select("id");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const deleted = ((data ?? []) as { id: string }[]).map((r) => r.id);
  const gone = new Set(deleted);
  const failed = parsed.ids.filter((i) => !gone.has(i)).map((i) => ({ id: i, error: "Document not found" }));

  return Response.json({ ok: true, deleted: deleted.length, ids: deleted, failed });
}
